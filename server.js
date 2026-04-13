import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import pg from 'pg'

const { Pool } = pg
const app = express()
const PORT = process.env.PORT || 3001
app.use(cors())
app.use(express.json({ limit: '2mb' }))

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
})

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS debates (
      id TEXT PRIMARY KEY,
      dok_id TEXT UNIQUE,
      title TEXT,
      topic TEXT,
      topic_emoji TEXT,
      date TEXT,
      venue TEXT,
      participants JSONB,
      ingress TEXT,
      left_bloc JSONB,
      right_bloc JSONB,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      title TEXT,
      human_title TEXT,
      topic_emoji TEXT,
      date TEXT,
      total_ja INTEGER,
      total_nej INTEGER,
      total_avstar INTEGER,
      total_franvarande INTEGER,
      party_votes JSONB,
      dok_id TEXT,
      outcome TEXT,
      ja_meaning TEXT,
      nej_meaning TEXT,
      consequence TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
    ALTER TABLE votes ADD COLUMN IF NOT EXISTS voter_id TEXT;
    ALTER TABLE debates ADD COLUMN IF NOT EXISTS dok_type TEXT DEFAULT 'ip';
    CREATE TABLE IF NOT EXISTS fragstund (
      id TEXT PRIMARY KEY,
      dok_id TEXT UNIQUE,
      title TEXT,
      date TEXT,
      anforanden_count INTEGER DEFAULT 0,
      summary TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      approved_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS reactions (
      debate_id TEXT NOT NULL,
      bloc TEXT NOT NULL,
      reaction TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (debate_id, bloc, reaction)
    );
    CREATE TABLE IF NOT EXISTS valkompass_stats (
      party_id TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `)
  console.log('DB: tables ready')
}

// ── Auth middleware ───────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key']
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function stripTags(s) {
  return (s ?? '')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')  // decode entity-encoded HTML before stripping
    .replace(/<[^>]*>/g, ' ')                        // strip all tags
    .replace(/&[a-z#0-9]+;/gi, ' ')                 // remove remaining entities (&amp; &nbsp; etc.)
    .replace(/\s+/g, ' ').trim()
}

function cleanName(raw) {
  return (raw ?? '')
    .replace(/\s*\([^)]+\)\s*$/, '')
    .replace(/^.*minister\s+/i, '')
    .replace(/^Statssekreterare\s+/i, '')
    .replace(/^Talman\s+/i, '')
    .trim()
}

function personPhotoUrl(id) {
  return `https://data.riksdagen.se/filarkiv/bilder/ledamot/${id}_max.jpg`
}

function fetchWithTimeout(url, ms = 6000) {
  const ctrl = new AbortController()
  const id = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(id))
}

// ── Protocol-based IP debate pipeline ────────────────────────────────────────

const summaryCache = new Map()

// Find all "Svar på interpellation" debate sections in a stripped protocol text.
// Distinguishes actual debate sections from TOC entries by checking for "Anf." nearby.
function extractIPSections(protText) {
  const sections = []
  const pattern = /Svar på interpellation(?:erna)? ([\d/,: och]+?) om /gi
  let m
  while ((m = pattern.exec(protText)) !== null) {
    // Check if "Anf." appears within 600 chars — TOC entries don't have speeches directly after
    const after = protText.slice(m.index, m.index + 600)
    if (!/Anf\./i.test(after)) continue

    // Extract IP numbers from e.g. "2025/26:398, 401 och 406" → ["398", "401", "406"]
    // Must parse after colon to avoid capturing the year (2025) as a number
    const ipNumbers = []
    const rmPattern = /\d{4}\/\d{2}:(\d+)/g
    let rm2
    while ((rm2 = rmPattern.exec(m[1])) !== null) ipNumbers.push(rm2[1])
    // Also pick up continuation numbers like ", 401 och 406" in combined debates
    const remaining = m[1].replace(/\d{4}\/\d{2}:\d+/g, '')
    for (const n of (remaining.match(/\d{3,4}/g) || [])) {
      const v = parseInt(n); if (v >= 100 && v < 10000) ipNumbers.push(String(v))
    }
    if (!ipNumbers.length) continue

    // Include context before the heading (speaker labels appear before section header)
    const start = Math.max(0, m.index - 2000)
    const sectionText = protText.slice(start, m.index + 20000)
    sections.push({ ipNumbers, sectionText })
  }
  return sections
}

// Fetch IP document metadata from Riksdag API by nummer + riksmöte
async function fetchIPDocFromAPI(rm, nummer) {
  try {
    const res = await fetchWithTimeout(
      `https://data.riksdagen.se/dokumentlista/?doktyp=ip&nummer=${nummer}&rm=${encodeURIComponent(rm)}&utformat=json&antal=5`,
      10000
    )
    const data = await res.json()
    const docs = data?.dokumentlista?.dokument ?? []
    const arr = Array.isArray(docs) ? docs : [docs]
    return arr.find(d => String(d.nummer) === String(nummer)) ?? arr[0] ?? null
  } catch { return null }
}

// Build participants list from IP document's dokintressent
function buildParticipantsFromIntressenter(dokintressent) {
  const intressenter = dokintressent?.intressent ?? []
  const arr = Array.isArray(intressenter) ? intressenter : [intressenter]
  const seen = new Set()
  const participants = []
  // Prioritize undertecknare (questioner) and besvaradav (minister answering)
  const priority = ['undertecknare', 'besvaradav']
  const sorted = [
    ...priority.map(role => arr.find(i => i.roll === role)).filter(Boolean),
    ...arr.filter(i => !priority.includes(i.roll))
  ]
  for (const i of sorted) {
    const id = i.intressent_id || ''
    if (seen.has(id)) continue
    seen.add(id)
    const name = cleanName(i.namn || '')
    participants.push({
      role: i.roll || 'talare',
      person: {
        id,
        name,
        firstName: name.split(' ')[0] || '',
        lastName: name.split(' ').slice(1).join(' ') || '',
        party: i.partibet || '',
        photoUrl: personPhotoUrl(id)
      }
    })
  }
  return participants
}

// Fetch speech text for a frågestund from embedded anföranden (reliable — uses dokid not rel_dok_id)
async function fetchFragstundText(dokId) {
  try {
    const res = await fetchWithTimeout(`https://data.riksdagen.se/dokument/${dokId}?utformat=json`, 10000)
    const data = await res.json()
    const anforanden = data?.dokumentstatus?.dokument?.debatt?.anforande ?? []
    const arr = Array.isArray(anforanden) ? anforanden : [anforanden]
    if (!arr.length) return ''
    const results = await Promise.allSettled(
      arr.slice(0, 12).map(async a => {
        if (!a.anforande_url_html) return ''
        const r = await fetchWithTimeout(a.anforande_url_html, 8000)
        const html = await r.text()
        const text = stripTags(html).trim()
        return text.length > 50 ? `[${a.talare} (${a.parti})]: ${text.slice(0, 1500)}` : ''
      })
    )
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).join('\n\n')
  } catch { return '' }
}

// Find the protocol section for a specific IP debate (used by reset-summary)
async function fetchIPSectionForDebate(dokId, date, title) {
  try {
    const dateStr = (date || '').replace(/-/g, '')
    if (!dateStr) return ''
    // Extract IP nummer from dok_id (e.g. HD10356 → 356, HD01KU31 → no match → '')
    const nummerMatch = dokId.match(/^[A-Z]+\d{2}(\d+)$/i)
    const ipNummer = nummerMatch?.[1] ?? ''

    const protRes = await fetchWithTimeout(
      `https://data.riksdagen.se/dokumentlista/?doktyp=prot&from=${dateStr}&tom=${dateStr}&utformat=json&antal=5`,
      10000
    )
    const protData = await protRes.json()
    const prots = protData?.dokumentlista?.dokument ?? []
    const protArr = Array.isArray(prots) ? prots : [prots]

    for (const prot of protArr.filter(p => p?.dok_id)) {
      const textRes = await fetchWithTimeout(`https://data.riksdagen.se/dokument/${prot.dok_id}.text`, 15000)
      const raw = await textRes.text()
      const protText = stripTags(raw)
      const sections = extractIPSections(protText)

      // First try: match by IP nummer (most reliable)
      if (ipNummer) {
        const byNum = sections.find(s => s.ipNumbers.includes(ipNummer))
        if (byNum) return byNum.sectionText
      }
      // Fallback: match by title keywords
      const titleWords = title.toLowerCase().split(/\s+/).filter(w => w.length > 4)
      const byTitle = sections.find(s => titleWords.some(w => s.sectionText.toLowerCase().includes(w)))
      if (byTitle) return byTitle.sectionText
    }
  } catch (e) { console.error('fetchIPSectionForDebate error:', e.message) }
  return ''
}

// Generate and cache AI summary — accepts pre-loaded debate text
async function generateAndCache(dokId, title, date, apiKey, debateText = '') {
  if (summaryCache.has(dokId)) return summaryCache.get(dokId)
  if (!debateText || debateText.length < 100) return null
  if (/ingen talare var anm/i.test(debateText)) return null

  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 900,
      messages: [{ role: 'user', content: `Du är politisk reporter på Omni. Skriv om riksdagsdebatten nedan på korrekt, naturlig svenska.\n\nBLOCKTILLHÖRIGHET – strikt:\n- Vänsterblocket: S, V, MP — dessa partier hamnar ALLTID i vansterblocket\n- Högerblocket: M, SD, KD, L, C — dessa partier hamnar ALLTID i hogerblocket\n- Om ett block inte deltog: {"parties":[],"summary":"Inget parti från detta block deltog.","keyArg":""}\n\nMENINGSSTRUKTUR – kritiskt:\n- Max 15 ord per mening. En tanke per mening. Klipp, kombinera inte.\n- Upprepa ALDRIG samma preposition i en lista: inte "pekar på X, på Y, på Z" – skriv istället två separata meningar\n- Inga långa bisatser: inte "Han argumenterar för att utan X och Y och Z blir..."\n- Aktiv form: "SD kräver" inte "ett krav ställs av SD"\n- Inga nominaliseringar: "genomföra" inte "genomförandet av"\n\nGRAMMATIK – kontrollera:\n- Perfekt particip: "tvingat" inte "tvingt", "tagit" inte "tagt"\n- Subjekt-predikat-objekt i rätt ordning\n- Undvik "som"-kedjor längre än ett led\n\nFÖRBJUDET:\n- "lyfte fram", "påpekade att", "menade att", "argumenterar för att"\n- "Med anledning av", "Till följd av", "Vad gäller"\n- "högerblocket", "vänsterblocket", "oppositionen", "regeringen" – använd alltid partiförkortningar (S, M, SD, KD, L, C, V, MP)\n- "Debatten handlade om", "I debatten", "Riksdagen diskuterade"\n\nÖVRIGT:\n- Börja med en person, ett parti eller ett konkret faktum\n- Specifikt för just denna debatt – aldrig generiskt\n- Basera ENBART på texten nedan\n- Om texten uppenbart handlar om ett annat ämne än titeln: svara null\n\nTitel: ${title}\n\n${debateText.slice(0, 18000)}\n\nSvara ENDAST med JSON (eller null):\n{"ingress":"2-3 korta meningar. Det skarpaste från debatten – ett krav, en konflikt eller ett oväntat svar.","vansterblocket":{"parties":["partiförkortningar ur S/V/MP"],"summary":"2-3 korta meningar. En tanke per mening.","keyArg":"2-3 meningar som sammanfattar hela deras ståndpunkt – vad de vill, varför, och vad konsekvensen blir om de inte får igenom det. Läsaren ska förstå hela deras position utan att ha läst resten."},"hogerblocket":{"parties":["partiförkortningar ur M/SD/KD/L/C"],"summary":"2-3 korta meningar. En tanke per mening.","keyArg":"2-3 meningar som sammanfattar hela deras ståndpunkt – vad de vill, varför, och vad konsekvensen blir om de inte får igenom det. Läsaren ska förstå hela deras position utan att ha läst resten."}}` }]
    })
  })
  const aiData = await aiRes.json()
  const text = (aiData.content?.[0]?.text ?? '').replace(/```json|```/g, '').trim()
  if (text === 'null' || text === '') return null
  const result = JSON.parse(text)
  summaryCache.set(dokId, result)
  return result
}

// New main pipeline: fetch IP documents → group by debattdag → fetch each protocol once
async function saveIPDebatesFromProtocols(apiKey) {
  const rm = '2025/26'
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  console.log(`saveIPDebatesFromProtocols: fetching IPs for rm=${rm} since ${cutoff}`)

  // 0. Pre-build a map of date → protocol dok_id for the entire riksmöte (paginate all ~6 pages)
  const protDateMap = new Map()
  for (let page = 1; page <= 10; page++) {
    try {
      const res = await fetchWithTimeout(
        `https://data.riksdagen.se/dokumentlista/?doktyp=prot&rm=${encodeURIComponent(rm)}&utformat=json&antal=200&sort=datum&sortorder=desc&p=${page}`,
        12000
      )
      const data = await res.json()
      const docs = data?.dokumentlista?.dokument ?? []
      const arr = Array.isArray(docs) ? docs : [docs]
      if (!arr.length || !arr[0]?.dok_id) break
      for (const p of arr) { if (p?.dok_id && p.datum) protDateMap.set(p.datum, p.dok_id) }
    } catch (e) { console.error(`Protocol list page ${page} failed:`, e.message); break }
  }
  console.log(`saveIPDebatesFromProtocols: ${protDateMap.size} protocols in date map`)

  // 1. Paginate through all IP documents for this riksmöte
  const allIPDocs = []
  for (let page = 1; page <= 30; page++) {
    try {
      const res = await fetchWithTimeout(
        `https://data.riksdagen.se/dokumentlista/?doktyp=ip&rm=${encodeURIComponent(rm)}&utformat=json&antal=200&sort=debattdag&sortorder=desc&p=${page}`,
        12000
      )
      const data = await res.json()
      const docs = data?.dokumentlista?.dokument ?? []
      const arr = Array.isArray(docs) ? docs : [docs]
      if (!arr.length || !arr[0]?.dok_id) break
      // Only keep ones with debattdag within the last 90 days
      const recent = arr.filter(d => d.debattdag && d.debattdag >= cutoff)
      allIPDocs.push(...recent)
      // If the earliest on this page is older than cutoff, stop
      const earliest = arr[arr.length - 1]?.debattdag ?? ''
      if (earliest && earliest < cutoff) break
    } catch (e) {
      console.error(`IP list page ${page} failed:`, e.message)
      break
    }
  }
  console.log(`saveIPDebatesFromProtocols: ${allIPDocs.length} recent IP docs found`)

  // 2. Group IPs by debattdag
  const byDate = new Map()
  for (const doc of allIPDocs) {
    const date = doc.debattdag
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(doc)
  }

  // 3. For each debate date, fetch the protocol text once then process all IPs
  for (const [debateDate, ipDocs] of byDate) {
    console.log(`Processing ${debateDate}: ${ipDocs.length} IPs`)

    // Fetch the protocol for this date using the pre-built map
    let protText = ''
    try {
      const protDokId = protDateMap.get(debateDate)
      if (!protDokId) { console.log(`No protocol for ${debateDate} (not published yet?)`); continue }

      const textRes = await fetchWithTimeout(`https://data.riksdagen.se/dokument/${protDokId}.text`, 15000)
      const raw = await textRes.text()
      protText = stripTags(raw)
    } catch (e) {
      console.error(`Protocol fetch failed for ${debateDate}:`, e.message)
      continue
    }

    const sections = extractIPSections(protText)
    console.log(`  Protocol has ${sections.length} IP sections`)

    // 4. For each IP document, find its section and generate summary
    for (const ipDoc of ipDocs) {
      const dokId = ipDoc.dok_id
      if (!dokId) continue
      const ipNummer = String(ipDoc.nummer || '')

      try {
        const existing = await pool.query('SELECT id, ingress FROM debates WHERE dok_id = $1', [dokId])
        if (existing.rows.length > 0 && existing.rows[0].ingress) continue // already done

        // Find the matching section
        const section = sections.find(s => s.ipNumbers.includes(ipNummer))
        if (!section) { console.log(`  No protocol section for IP ${ipNummer} (${ipDoc.titel?.slice(0, 40)})`); continue }

        const participants = buildParticipantsFromIntressenter(ipDoc.dokintressent)
        if (!participants.length) { console.log(`  No participants for ${dokId}`); continue }

        summaryCache.delete(dokId)
        const summary = await generateAndCache(dokId, ipDoc.titel || '', debateDate, apiKey, section.sectionText)

        if (!summary) {
          if (existing.rows.length > 0) {
            await pool.query('DELETE FROM debates WHERE dok_id = $1', [dokId])
            console.log(`  Deleted ${dokId} — no content`)
          } else {
            console.log(`  Skipping ${dokId} — no content`)
          }
          continue
        }

        const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
        const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }

        if (existing.rows.length > 0) {
          await pool.query(
            'UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE dok_id = $4',
            [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), dokId]
          )
          console.log(`  Updated summary for "${ipDoc.titel?.slice(0, 50)}"`)
        } else {
          await pool.query(
            `INSERT INTO debates (id, dok_id, dok_type, title, topic, topic_emoji, date, venue, participants, ingress, left_bloc, right_bloc, status)
             VALUES ($1,$2,'ip',$3,'Interpellationsdebatt','',$4,'Riksdagens kammare',$5,$6,$7,$8,'pending')
             ON CONFLICT (id) DO NOTHING`,
            [dokId, dokId, ipDoc.titel || `Interpellation ${rm}:${ipNummer}`, debateDate,
             JSON.stringify(participants), summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc)]
          )
          console.log(`  Saved "${ipDoc.titel?.slice(0, 50)}" (${debateDate})`)
        }
        await new Promise(r => setTimeout(r, 400))
      } catch (e) {
        console.error(`  Error processing ${dokId}:`, e.message)
      }
    }
  }
  console.log('saveIPDebatesFromProtocols: done')
}

// ── Vote helpers ──────────────────────────────────────────────────────────────

async function parseVoteDetail(id) {
  const r = await fetchWithTimeout(`https://data.riksdagen.se/votering/${id}/json`)
  const d = await r.json()
  const doc = d?.votering?.dokument ?? {}
  const voteRows = d?.votering?.dokvotering?.votering ?? []
  const vArr = Array.isArray(voteRows) ? voteRows : [voteRows]
  const partyMap = {}
  for (const v of vArr) {
    const party = v.parti ?? 'Okänt'
    if (!partyMap[party]) partyMap[party] = { party, ja: 0, nej: 0, avstar: 0, franvarande: 0 }
    const rost = (v.rost ?? '').toLowerCase()
    if (rost === 'ja') partyMap[party].ja++
    else if (rost === 'nej') partyMap[party].nej++
    else if (rost === 'avstår') partyMap[party].avstar++
    else partyMap[party].franvarande++
  }
  const firstVote = vArr[0] ?? {}
  const punkt = firstVote.punkt ?? ''
  return {
    title: doc.titel ? `${doc.titel}${punkt ? ` (punkt ${punkt})` : ''}` : (firstVote.beteckning || id),
    date: (doc.datum ?? firstVote.datum ?? '').slice(0, 10),
    partyVotes: Object.values(partyMap).filter(p => p.party !== '-').sort((a, b) => b.ja - a.ja),
    dokId: doc.dok_id ?? firstVote.dok_id ?? null,
  }
}

async function generateVoteSummaryServer(vote, apiKey) {
  const partyBreakdown = (vote.partyVotes || []).map(pv => `${pv.party}: ${pv.ja} ja, ${pv.nej} nej`).join('\n')
  const prompt = `Du är en politisk redaktör som förklarar riksdagsbeslut sakligt och tillgängligt för unga svenska väljare.

Omröstning: ${vote.title}
Datum: ${vote.date}
Resultat: ${vote.totalJa} ja, ${vote.totalNej} nej → ${vote.outcome === 'ja' ? 'BIFALLEN' : 'AVSLAGEN'}

Partier:
${partyBreakdown}

De fyra fälten ska vara tydligt olika från varandra och inte upprepa samma information:

humanTitle: En kort, engagerande fråga (max 8 ord) som fångar kärnan i vad omröstningen gällde.

jaMeaning: Beskriv konkret vad en JA-röst stödde – den faktiska policyn eller förändringen, inte bara "förslaget godkänns". En mening.

nejMeaning: Beskriv vad en NEJ-röst stödde – vad som hade bevarats eller vilket alternativ man föredrog. Får INTE vara en spegelbild av jaMeaning med "avslås" inbytt. En mening.

consequence: Vad utfallet faktiskt innebär framåt för vanliga människor – konkret och framåtblickande. Ska tillföra ny information som inte redan finns i jaMeaning eller nejMeaning. Börja inte med "Det innebär att" eller "Riksdagen beslutade". 1–2 meningar.

Svara ENDAST med JSON:
{"humanTitle":"...","jaMeaning":"...","nejMeaning":"...","consequence":"...","topicEmoji":"[ett relevant emoji]"}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  })
  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

// ── Frågestund ────────────────────────────────────────────────────────────────

async function fetchFragstund() {
  const res = await fetch('https://data.riksdagen.se/dokumentlista/?doktyp=kam-fs&utformat=json&antal=50&sort=datum&sortorder=desc')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const rawDok = data?.dokumentlista?.dokument ?? []
  const dokument = Array.isArray(rawDok) ? rawDok : [rawDok]
  const result = []

  for (const dok of dokument) {
    const anforanden = (() => { const a = dok.debatt?.anforande; if (!a) return []; return Array.isArray(a) ? a : [a] })()
    if (anforanden.length === 0) continue
    const date = (dok.datum ?? '').slice(0, 10)
    result.push({
      id: dok.dok_id,
      dokId: dok.dok_id,
      title: dok.titel ?? 'Frågestund',
      date,
      anforandenCount: anforanden.length,
    })
  }
  return result.sort((a, b) => b.date > a.date ? 1 : -1)
}

async function generateFragstundSummary(dokId, title, date, apiKey) {
  const protocol = await fetchFragstundText(dokId)
  if (!protocol || protocol.length < 100) return null
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: `Du är en erfaren politisk reporter på en nyhetssajt. Skriv en kort, specifik nyhetsnotis om denna riksdagens frågestund – som om du skriver till läsare som vill veta vad som faktiskt frågades och vad svaret blev.\n\nRegler:\n- Lyft fram 1-2 av de mest intressanta frågorna och svaren – konkret, inte generellt\n- Nämn vem som frågade och vem som svarade om det tillför\n- Börja INTE med "Under frågestunden", "Riksdagen höll", "Frågestunden handlade om" eller liknande – gå direkt på det som hände\n- Varje sammanfattning ska kännas unik – aldrig generisk mall\n- Formellt men enkelt språk\n- Basera ENBART på texten nedan\n\nTitel: ${title}\n\n${protocol.slice(0, 6000)}\n\nSvara ENDAST med en JSON: {"summary":"2-3 meningar. Led med det mest konkreta – en specifik fråga, ett tydligt svar, eller en oenighet som framkom. Namnge gärna personer och partier om det tillför."}` }]
    })
  })
  const aiData = await res.json()
  const text = aiData.content?.[0]?.text ?? ''
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())
  return parsed.summary ?? null
}

// ── DB mappers ────────────────────────────────────────────────────────────────

function dbDebateToFrontend(row) {
  return {
    id: row.id,
    dokId: row.dok_id,
    dokType: row.dok_type || 'ip',
    title: row.title,
    topic: row.topic,
    topicEmoji: row.topic_emoji || '',
    date: row.date,
    venue: row.venue,
    participants: row.participants || [],
    ingress: row.ingress,
    leftBloc: row.left_bloc,
    rightBloc: row.right_bloc,
  }
}

function dbVoteToFrontend(row) {
  return {
    id: row.id,
    voterId: row.voter_id || null,
    title: row.title,
    humanTitle: row.human_title,
    topicEmoji: row.topic_emoji || '',
    date: row.date,
    totalJa: row.total_ja,
    totalNej: row.total_nej,
    totalAvstar: row.total_avstar,
    totalFranvarande: row.total_franvarande,
    partyVotes: row.party_votes || [],
    dokId: row.dok_id,
    outcome: row.outcome,
    jaMeaning: row.ja_meaning,
    nejMeaning: row.nej_meaning,
    consequence: row.consequence,
  }
}

function dbFragstundToFrontend(row) {
  return {
    id: row.id,
    dokId: row.dok_id,
    title: row.title,
    date: row.date,
    anforandenCount: row.anforanden_count || 0,
    summary: row.summary,
  }
}

// ── Auto-fetch job ────────────────────────────────────────────────────────────

async function runAutoFetch() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { console.log('Auto-fetch: no ANTHROPIC_API_KEY, skipping'); return }
  console.log('Auto-fetch: starting...')

  // 1. IP Debates — scan protocols for interpellationsdebatter
  try {
    await saveIPDebatesFromProtocols(apiKey)
  } catch(e) { console.error('Auto-fetch debates error:', e.message) }

  // 2. Votes
  try {
    const listRes = await fetchWithTimeout('https://data.riksdagen.se/voteringlista/?sz=8&utformat=json&gruppering=votering_id&sort=datum&sortorder=desc')
    const listData = await listRes.json()
    const items = listData?.voteringlista?.votering ?? []
    const arr = (Array.isArray(items) ? items : [items]).slice(0, 6)

    for (const item of arr) {
      const existing = await pool.query('SELECT id FROM votes WHERE id = $1', [item.votering_id])
      if (existing.rows.length > 0) continue

      let title = item.beteckning || item.votering_id
      let date = (item.datum || '').slice(0, 10)
      let partyVotes = []
      let dokId = item.beteckning || null

      try {
        const detail = await parseVoteDetail(item.votering_id)
        title = detail.title || title
        date = detail.date || date
        partyVotes = detail.partyVotes
        dokId = item.beteckning || detail.dokId || null
      } catch(e) { console.error(`Vote detail failed ${item.votering_id}:`, e.message) }

      const baseVote = {
        id: item.votering_id, title, date,
        totalJa: parseInt(item.Ja) || 0,
        totalNej: parseInt(item.Nej) || 0,
        totalAvstar: parseInt(item['Avstår']) || 0,
        totalFranvarande: parseInt(item['Frånvarande']) || 0,
        outcome: (parseInt(item.Ja) || 0) >= (parseInt(item.Nej) || 0) ? 'ja' : 'nej',
        partyVotes, dokId,
      }

      let humanTitle = null, jaMeaning = null, nejMeaning = null, consequence = null, topicEmoji = null
      try {
        const s = await generateVoteSummaryServer(baseVote, apiKey)
        if (s) { humanTitle = s.humanTitle; jaMeaning = s.jaMeaning; nejMeaning = s.nejMeaning; consequence = s.consequence; topicEmoji = s.topicEmoji }
      } catch(e) { console.error(`Vote AI failed ${item.votering_id}:`, e.message) }

      await pool.query(
        `INSERT INTO votes (id, voter_id, title, human_title, topic_emoji, date, total_ja, total_nej, total_avstar, total_franvarande, party_votes, dok_id, outcome, ja_meaning, nej_meaning, consequence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending') ON CONFLICT (id) DO NOTHING`,
        [baseVote.id, item.votering_id, baseVote.title, humanTitle, topicEmoji, baseVote.date,
         baseVote.totalJa, baseVote.totalNej, baseVote.totalAvstar, baseVote.totalFranvarande,
         JSON.stringify(baseVote.partyVotes), baseVote.dokId, baseVote.outcome,
         jaMeaning, nejMeaning, consequence]
      )
      console.log(`Auto-fetch: saved vote "${title}"`)
    }
  } catch(e) { console.error('Auto-fetch votes error:', e.message) }

  // 3. Frågestund
  try {
    const fragstundList = await fetchFragstund()
    for (const fs of fragstundList) {
      const existing = await pool.query('SELECT id, summary FROM fragstund WHERE id = $1', [fs.id])

      if (existing.rows.length > 0) {
        if (existing.rows[0].summary) continue
        try {
          const summary = await generateFragstundSummary(fs.dokId, fs.title, fs.date, apiKey)
          if (summary) {
            await pool.query('UPDATE fragstund SET summary = $1 WHERE id = $2', [summary, fs.id])
            console.log(`Auto-fetch: filled in missing summary for frågestund "${fs.title}"`)
          }
        } catch(e) { console.error(`AI fragstund retry failed ${fs.id}:`, e.message) }
        continue
      }

      let summary = null
      try {
        summary = await generateFragstundSummary(fs.dokId, fs.title, fs.date, apiKey)
      } catch(e) { console.error(`AI fragstund failed ${fs.id}:`, e.message) }

      await pool.query(
        `INSERT INTO fragstund (id, dok_id, title, date, anforanden_count, summary, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending') ON CONFLICT (id) DO NOTHING`,
        [fs.id, fs.dokId, fs.title, fs.date, fs.anforandenCount, summary]
      )
      console.log(`Auto-fetch: saved frågestund "${fs.title}" (${fs.date})`)
    }
  } catch(e) { console.error('Auto-fetch fragstund error:', e.message) }

  console.log('Auto-fetch: done')
}

// ── Public endpoints ──────────────────────────────────────────────────────────

app.get('/api/public/debates', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM debates WHERE status = 'approved' ORDER BY date DESC")
    res.json(rows.map(dbDebateToFrontend))
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/public/votes', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM votes WHERE status = 'approved' ORDER BY date DESC")
    res.json(rows.map(dbVoteToFrontend))
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/public/fragstund', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM fragstund WHERE status = 'approved' ORDER BY date DESC")
    res.json(rows.map(dbFragstundToFrontend))
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Admin endpoints ───────────────────────────────────────────────────────────

app.get('/admin/debates', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM debates ORDER BY date DESC, created_at DESC')
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/admin/votes', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM votes ORDER BY created_at DESC')
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/fix-vote-dokids', requireAdmin, async (req, res) => {
  try {
    const listRes = await fetchWithTimeout('https://data.riksdagen.se/voteringlista/?sz=50&utformat=json&gruppering=votering_id&sort=datum&sortorder=desc')
    const listData = await listRes.json()
    const items = listData?.voteringlista?.votering ?? []
    const arr = Array.isArray(items) ? items : [items]
    let updated = 0
    for (const item of arr) {
      if (!item.beteckning || !item.votering_id) continue
      const result = await pool.query(
        'UPDATE votes SET dok_id = $1 WHERE id = $2 AND (dok_id IS NULL OR dok_id = \'\')',
        [item.beteckning, item.votering_id]
      )
      updated += result.rowCount
    }
    res.json({ updated })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Reset a debate's summary — fetches protocol section and regenerates
app.post('/admin/debates/reset-summary', requireAdmin, async (req, res) => {
  const { dokId } = req.body
  if (!dokId) return res.status(400).json({ error: 'dokId required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  try {
    summaryCache.delete(dokId)
    const { rows } = await pool.query('SELECT id, dok_id, title, date FROM debates WHERE dok_id = $1', [dokId])
    if (rows.length === 0) return res.status(404).json({ error: 'Debate not found' })
    const row = rows[0]

    if (!apiKey) {
      await pool.query('UPDATE debates SET ingress = NULL, left_bloc = NULL, right_bloc = NULL WHERE dok_id = $1', [dokId])
      return res.json({ ok: true, action: 'reset' })
    }

    const debateText = await fetchIPSectionForDebate(row.dok_id, row.date, row.title)
    const summary = await generateAndCache(row.dok_id, row.title, row.date, apiKey, debateText)
    if (summary) {
      const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
      const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
      await pool.query(
        'UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE id = $4',
        [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), row.id]
      )
      res.json({ ok: true, action: 'updated' })
    } else {
      await pool.query('DELETE FROM debates WHERE id = $1', [row.id])
      console.log(`reset-summary: deleted "${row.title}" — no debate content`)
      res.json({ ok: true, action: 'deleted' })
    }
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/admin/debates/:id', requireAdmin, async (req, res) => {
  const { title, ingress, left_bloc, right_bloc, participants, topic_emoji } = req.body
  try {
    await pool.query(
      `UPDATE debates SET
        title = COALESCE($1, title),
        ingress = COALESCE($2, ingress),
        left_bloc = COALESCE($3::jsonb, left_bloc),
        right_bloc = COALESCE($4::jsonb, right_bloc),
        participants = COALESCE($5::jsonb, participants),
        topic_emoji = COALESCE($6, topic_emoji)
       WHERE id = $7`,
      [title ?? null, ingress ?? null,
       left_bloc ? JSON.stringify(left_bloc) : null,
       right_bloc ? JSON.stringify(right_bloc) : null,
       participants ? JSON.stringify(participants) : null,
       topic_emoji ?? null, req.params.id]
    )
    const { rows } = await pool.query('SELECT * FROM debates WHERE id = $1', [req.params.id])
    res.json(rows[0])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/admin/votes/:id', requireAdmin, async (req, res) => {
  const { human_title, ja_meaning, nej_meaning, consequence, topic_emoji } = req.body
  try {
    await pool.query(
      `UPDATE votes SET
        human_title = COALESCE($1, human_title),
        ja_meaning = COALESCE($2, ja_meaning),
        nej_meaning = COALESCE($3, nej_meaning),
        consequence = COALESCE($4, consequence),
        topic_emoji = COALESCE($5, topic_emoji)
       WHERE id = $6`,
      [human_title ?? null, ja_meaning ?? null, nej_meaning ?? null, consequence ?? null, topic_emoji ?? null, req.params.id]
    )
    const { rows } = await pool.query('SELECT * FROM votes WHERE id = $1', [req.params.id])
    res.json(rows[0])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/debates/:id/approve', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE debates SET status = 'approved', approved_at = NOW() WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/votes/:id/approve', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE votes SET status = 'approved', approved_at = NOW() WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/admin/debates/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM debates WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/admin/votes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM votes WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/admin/fragstund', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM fragstund ORDER BY created_at DESC')
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.patch('/admin/fragstund/:id', requireAdmin, async (req, res) => {
  const { title, summary } = req.body
  try {
    await pool.query(
      `UPDATE fragstund SET title = COALESCE($1, title), summary = COALESCE($2, summary) WHERE id = $3`,
      [title ?? null, summary ?? null, req.params.id]
    )
    const { rows } = await pool.query('SELECT * FROM fragstund WHERE id = $1', [req.params.id])
    res.json(rows[0])
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/fragstund/:id/approve', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE fragstund SET status = 'approved', approved_at = NOW() WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/admin/fragstund/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM fragstund WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/regenerate-summaries', requireAdmin, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  try {
    const { rows: debateRows } = await pool.query(
      "SELECT id, dok_id, title, date FROM debates WHERE ingress IS NULL ORDER BY date DESC LIMIT 20"
    )
    let updatedDebates = 0
    for (const row of debateRows) {
      try {
        summaryCache.delete(row.dok_id)
        const debateText = await fetchIPSectionForDebate(row.dok_id, row.date, row.title)
        const summary = await generateAndCache(row.dok_id, row.title, row.date, apiKey, debateText)
        if (summary) {
          const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
          const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
          await pool.query(
            'UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE id = $4',
            [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), row.id]
          )
          updatedDebates++
        } else {
          await pool.query('DELETE FROM debates WHERE id = $1', [row.id])
          console.log(`regenerate: deleted "${row.title}" — no debate content`)
        }
      } catch(e) { console.error(`regenerate debate ${row.id}:`, e.message) }
    }
    const { rows: fsRows } = await pool.query(
      "SELECT id, dok_id, title, date FROM fragstund WHERE summary IS NULL ORDER BY date DESC LIMIT 20"
    )
    let updatedFragstund = 0
    for (const row of fsRows) {
      try {
        const summary = await generateFragstundSummary(row.dok_id, row.title, row.date, apiKey)
        if (summary) {
          await pool.query('UPDATE fragstund SET summary = $1 WHERE id = $2', [summary, row.id])
          updatedFragstund++
        }
      } catch(e) { console.error(`regenerate fragstund ${row.id}:`, e.message) }
    }
    res.json({ updatedDebates, updatedFragstund, totalChecked: debateRows.length + fsRows.length })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Radera alla debatter och kör pipeline från scratch
app.post('/admin/debates/clear-and-refetch', requireAdmin, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  try {
    const { rowCount } = await pool.query('DELETE FROM debates')
    summaryCache.clear()
    console.log(`clear-and-refetch: deleted ${rowCount} debates, starting pipeline...`)
    res.json({ ok: true, deleted: rowCount, message: 'Pipeline started in background' })
    // Run pipeline in background
    saveIPDebatesFromProtocols(apiKey)
      .then(() => console.log('clear-and-refetch: pipeline done'))
      .catch(e => console.error('clear-and-refetch pipeline error:', e.message))
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Trigga auto-fetch manuellt utan att rensa
app.post('/admin/run-autofetch', requireAdmin, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  res.json({ ok: true, message: 'Auto-fetch started in background' })
  runAutoFetch().catch(e => console.error('manual autofetch error:', e.message))
})

// Regenererar ALLA debatter med ny prompt — även godkända
app.post('/admin/regenerate-all-summaries', requireAdmin, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  try {
    const { rows } = await pool.query(
      "SELECT id, dok_id, title, date FROM debates ORDER BY date DESC LIMIT 50"
    )
    res.json({ started: true, total: rows.length })
    // Run in background after responding
    ;(async () => {
      let updated = 0
      for (const row of rows) {
        try {
          summaryCache.delete(row.dok_id)
          const debateText = await fetchIPSectionForDebate(row.dok_id, row.date, row.title)
          const summary = await generateAndCache(row.dok_id, row.title, row.date, apiKey, debateText)
          if (summary) {
            const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
            const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
            await pool.query(
              'UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE id = $4',
              [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), row.id]
            )
            updated++
            console.log(`regenerate-all: updated ${updated}/${rows.length} — "${row.title}"`)
          } else {
            await pool.query('DELETE FROM debates WHERE id = $1', [row.id])
            console.log(`regenerate-all: deleted "${row.title}" — no content`)
          }
        } catch(e) { console.error(`regenerate-all ${row.id}:`, e.message) }
        await new Promise(r => setTimeout(r, 800)) // rate limit
      }
      console.log(`regenerate-all: done. ${updated} updated.`)
    })()
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Intro settings ────────────────────────────────────────────────────────────

const DEFAULT_INTRO = {
  badge: 'RIKSDAGEN · LIVE',
  headingPre: 'Vad händer i',
  words: ['Debatter', 'Omröstningar', 'Politik'],
  headingPost: 'just nu?',
  subtitle: 'Civica samlar riksdagens senaste debatter och omröstningar — utan krångel.',
  chips: [
    { icon: '🗣️', text: 'Debatter' },
    { icon: '🗳️', text: 'Omröstningar' },
    { icon: '⚖️', text: 'Valkompassen' },
  ],
}

app.get('/api/public/intro-settings', async (_req, res) => {
  try {
    const r = await pool.query("SELECT value FROM settings WHERE key = 'intro'")
    res.json(r.rows[0]?.value ?? DEFAULT_INTRO)
  } catch(e) { res.json(DEFAULT_INTRO) }
})

app.put('/admin/intro-settings', requireAdmin, async (req, res) => {
  try {
    const value = req.body
    await pool.query(`
      INSERT INTO settings (key, value, updated_at) VALUES ('intro', $1, NOW())
      ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    `, [JSON.stringify(value)])
    res.json(value)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Reactions ─────────────────────────────────────────────────────────────────

app.get('/api/public/reactions/:debateId', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT bloc, reaction, count FROM reactions WHERE debate_id = $1',
      [req.params.debateId]
    )
    const result = { left: { up: 0, down: 0 }, right: { up: 0, down: 0 } }
    for (const r of rows) {
      if (result[r.bloc] !== undefined && (r.reaction === 'up' || r.reaction === 'down')) {
        result[r.bloc][r.reaction] = r.count
      }
    }
    res.json(result)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/api/public/reactions/:debateId/:bloc/:reaction', async (req, res) => {
  const { debateId, bloc, reaction } = req.params
  if (!['left', 'right'].includes(bloc) || !['up', 'down'].includes(reaction)) {
    return res.status(400).json({ error: 'Invalid params' })
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO reactions (debate_id, bloc, reaction, count)
      VALUES ($1, $2, $3, 1)
      ON CONFLICT (debate_id, bloc, reaction) DO UPDATE SET count = reactions.count + 1
      RETURNING count
    `, [debateId, bloc, reaction])
    res.json({ count: rows[0].count })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Valkompass stats ──────────────────────────────────────────────────────────

app.post('/api/public/valkompass/:partyId', async (req, res) => {
  const { partyId } = req.params
  const validParties = ['S', 'M', 'SD', 'C', 'V', 'KD', 'L', 'MP']
  if (!validParties.includes(partyId.toUpperCase())) {
    return res.status(400).json({ error: 'Invalid party' })
  }
  try {
    const { rows } = await pool.query(`
      INSERT INTO valkompass_stats (party_id, count)
      VALUES ($1, 1)
      ON CONFLICT (party_id) DO UPDATE SET count = valkompass_stats.count + 1
      RETURNING count
    `, [partyId.toUpperCase()])
    res.json({ count: rows[0].count })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Admin stats ───────────────────────────────────────────────────────────────

app.get('/admin/stats/reactions', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT r.debate_id, d.title, r.bloc, r.reaction, r.count
      FROM reactions r
      LEFT JOIN debates d ON d.id = r.debate_id
      ORDER BY r.debate_id, r.bloc, r.reaction
    `)
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/admin/stats/valkompass', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT party_id, count FROM valkompass_stats ORDER BY count DESC')
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// ── Legacy / proxy endpoints ──────────────────────────────────────────────────

const votesCache = { data: null, ts: 0, building: false }
const VOTES_TTL = 8 * 60 * 60 * 1000

async function buildVotesCache() {
  if (votesCache.building) return
  votesCache.building = true
  try {
    const listRes = await fetchWithTimeout('https://data.riksdagen.se/voteringlista/?sz=8&utformat=json&gruppering=votering_id')
    const listData = await listRes.json()
    const items = listData?.voteringlista?.votering ?? []
    const arr = (Array.isArray(items) ? items : [items]).slice(0, 6)
    const details = await Promise.allSettled(arr.map(item => parseVoteDetail(item.votering_id)))
    const votes = arr.map((item, i) => {
      const base = { id: item.votering_id, totalJa: parseInt(item.Ja) || 0, totalNej: parseInt(item.Nej) || 0, totalAvstar: parseInt(item['Avstår']) || 0, totalFranvarande: parseInt(item['Frånvarande']) || 0, outcome: (parseInt(item.Ja) || 0) >= (parseInt(item.Nej) || 0) ? 'ja' : 'nej' }
      if (details[i].status === 'fulfilled') return { ...base, ...details[i].value }
      return { ...base, title: item.beteckning || item.votering_id, date: '', partyVotes: [], dokId: null }
    })
    votesCache.data = votes
    votesCache.ts = Date.now()
  } catch(e) { console.error('buildVotesCache:', e.message) } finally { votesCache.building = false }
}

app.get('/votes', async (req, res) => {
  if (votesCache.data) {
    res.json(votesCache.data)
    if (Date.now() - votesCache.ts > VOTES_TTL) buildVotesCache()
    return
  }
  await buildVotesCache()
  if (votesCache.data) return res.json(votesCache.data)
  res.status(503).json({ error: 'Votes not ready' })
})

app.get('/summary/:dokId', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' })
  try {
    const debateText = await fetchIPSectionForDebate(req.params.dokId, req.query.date || '', req.query.title || req.params.dokId)
    const result = await generateAndCache(req.params.dokId, req.query.title || req.params.dokId, req.query.date || '', apiKey, debateText)
    if (!result) return res.status(500).json({ error: 'Could not generate' })
    res.json({ dok_id: req.params.dokId, ...result })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/*', async (req, res) => {
  const path = req.params[0]
  const query = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''
  try {
    const r = await fetch(`https://data.riksdagen.se/${path}${query}`, { headers: { 'User-Agent': 'Civica/1.0' } })
    const ct = r.headers.get('content-type') ?? ''
    if (ct.includes('json')) { res.status(r.status).json(await r.json()) }
    else { res.status(r.status).type(ct || 'text/plain').send(await r.text()) }
  } catch(err) { res.status(500).json({ error: String(err) }) }
})

app.post('/ai', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) return res.status(401).json({ error: 'Missing API key' })
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(req.body),
    })
    res.status(r.status).json(await r.json())
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/health', (_, res) => res.json({ ok: true, summaries: summaryCache.size, dbReady, hasUrl: !!process.env.DATABASE_URL }))

app.get('/debug/db', requireAdmin, async (req, res) => {
  const urlSnip = (process.env.DATABASE_URL || '').slice(0, 40) + '...'
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, urlSnip })
  } catch(e) {
    const msg = e?.errors?.[0]?.message || e?.message || String(e)
    res.json({ ok: false, urlSnip, error: msg })
  }
})

// ── Startup ───────────────────────────────────────────────────────────────────

let dbReady = false

async function start() {
  // Start server immediately so Railway health checks pass
  app.listen(PORT, () => console.log(`Civica backend on port ${PORT}`))

  // Connect to DB (may not be available yet)
  try {
    await initDb()
    dbReady = true
    buildVotesCache()
    runAutoFetch()
    setInterval(runAutoFetch, 60 * 60 * 1000)
  } catch(e) {
    console.error('DB not available, running without CMS:', e.message)
  }
}

start()
