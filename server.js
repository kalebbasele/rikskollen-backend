import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'
import pg from 'pg'

const { Pool } = pg
const app = express()
const PORT = process.env.PORT || 3001
app.use(cors())
app.use(express.json({ limit: '2mb' }))
app.use('/images', express.static('public/images', { maxAge: '7d', immutable: true }))

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
    ALTER TABLE debates ADD COLUMN IF NOT EXISTS pinned BOOLEAN DEFAULT FALSE;
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
    CREATE TABLE IF NOT EXISTS person_photos (
      id TEXT PRIMARY KEY,
      photo_data BYTEA NOT NULL,
      content_type TEXT DEFAULT 'image/jpeg',
      cached_at TIMESTAMPTZ DEFAULT NOW()
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
    .replace(/#xa0;/gi, ' ')                         // leftover non-breaking space artifact
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

const BACKEND_URL = 'https://web-production-1e2f2.up.railway.app'

// Only for people with manually uploaded photos (not in riksdagen's system at all)
const CUSTOM_PHOTOS = {
  '0397205342021': `${BACKEND_URL}/images/johan-britz.jpg`,    // Johan Britz — manually uploaded
  '0910272619521': `${BACKEND_URL}/images/benjamin-dousa.jpg`, // Benjamin Dousa — manually uploaded
  '0512510717328': `${BACKEND_URL}/images/ebba-busch.jpg`,     // Ebba Busch — manually uploaded
}

// Returns our own photo proxy URL — photos are downloaded once and stored in PostgreSQL
function personPhotoUrl(id) {
  if (!id) return ''
  return `${BACKEND_URL}/photos/${id}`
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
  // First pass: collect all actual debate section positions (those with Anf. nearby = real debates, not TOC)
  const debatePositions = []
  const pattern = /Svar på interpellation(?:erna)? ([\d/,: och]+?) om /gi
  let m
  while ((m = pattern.exec(protText)) !== null) {
    const after = protText.slice(m.index, m.index + 600)
    // Require actual speech content ("talman" = speaker address) — not just a TOC listing
    if (!/talman/i.test(after)) continue
    const ipNumbers = []
    const rmPattern = /\d{4}\/\d{2}:(\d+)/g
    let rm2
    while ((rm2 = rmPattern.exec(m[1])) !== null) ipNumbers.push(rm2[1])
    const remaining = m[1].replace(/\d{4}\/\d{2}:\d+/g, '')
    for (const n of (remaining.match(/\d{3,4}/g) || [])) {
      const v = parseInt(n); if (v >= 100 && v < 10000) ipNumbers.push(String(v))
    }
    if (!ipNumbers.length) continue
    debatePositions.push({ index: m.index, ipNumbers })
  }

  // Second pass: build sections with correct end boundaries
  const sections = []
  for (let i = 0; i < debatePositions.length; i++) {
    const { index, ipNumbers } = debatePositions[i]
    const start = Math.max(0, index - 2000)
    // End at the start of the next debate section (not TOC entry)
    const nextDebateStart = i + 1 < debatePositions.length ? debatePositions[i + 1].index : index + 25000
    const end = Math.min(nextDebateStart, index + 20000)
    const sectionText = protText.slice(start, end)
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

// Find the best riksdagen photo URL for a person — used internally by the /photos/:id proxy
// Tries numeric _192.jpg first (works for most), falls back to UUID from personlista API
async function resolveRiksdagenPhotoUrl(id) {
  const maxUrl = `https://data.riksdagen.se/filarkiv/bilder/ledamot/${id}_max.jpg`
  try {
    const check = await fetch(maxUrl, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
    if (check.ok) return maxUrl
  } catch {}
  // Max URL failed — fetch UUID-based URL from personlista
  try {
    const plRes = await fetchWithTimeout(`https://data.riksdagen.se/personlista/?iid=${id}&utformat=json`, 6000)
    const plData = await plRes.json()
    const url = plData?.personlista?.person?.bild_url_192
    if (url) return url
  } catch {}
  return maxUrl // last resort fallback
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
        photoUrl: personPhotoUrl(id) // points to our proxy — downloaded on first view
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
    const dateStr = (date || '').slice(0, 10) // Keep YYYY-MM-DD format — riksdagen API requires dashes
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
      model: 'claude-sonnet-4-6',
      max_tokens: 1400,
      messages: [{ role: 'user', content: `Du är politisk redaktör på SVT Nyheter. Din uppgift är att sammanfatta riksdagsdebatter sakligt, begripligt och intressant – utan att värdera eller ta ställning.\n\nSIDOTILLDELNING – så här bestämmer du vansterblocket och hogerblocket:\n\nVanliga partidebatten (flera partier från båda block):\n- Vänsterblocket (S, V, MP) → vansterblocket\n- Högerblocket (M, SD, KD, L, C) → hogerblocket\n- Om ett block saknas: {"parties":[],"summary":"Inget parti från detta block deltog.","keyArg":""}\n\nInterpellationer och frågestunder (en riksdagsledamot frågar en minister):\n- OBS: Dessa debatter är INTE alltid vänster mot höger. SD kan fråga KD, M kan fråga KD, osv.\n- Lägg frågeställaren (den som ställde interpellationen) i vansterblocket\n- Lägg den svarande ministern/regeringen i hogerblocket\n- Oavsett vilket parti de tillhör\n- Exempel: SD frågar KD → SD i vansterblocket, KD i hogerblocket\n\nSPRÅK OCH TON:\n- Saklig och neutral – återge vad som sades, inte vem som hade rätt\n- Tydligt och intressant – läsaren ska förstå vad frågan gäller och varför den spelar roll\n- Aktiv form: "SD anser att" inte "det anfördes att"\n- Konkret: nämn faktiska siffror, namn och förslag om de finns i texten\n- Max 15 ord per mening. En tanke i taget.\n\nFÖRBJUDET:\n- Värderande ord som "vägrar", "attackerade", "avslöjar", "erkänner"\n- "lyfte fram", "påpekade att", "framhöll"\n- "Med anledning av", "Till följd av", "Vad gäller"\n- "högerblocket", "vänsterblocket", "oppositionen", "regeringen" – använd alltid partinamn\n- "Debatten handlade om", "I debatten", "Riksdagen diskuterade"\n\nGRAMMATIK:\n- Perfekt particip: "tvingat" inte "tvingt", "tagit" inte "tagt"\n- Undvik långa bisatser och "som"-kedjor\n\nÖVRIGT:\n- Basera ENBART på texten nedan\n- Om texten uppenbart handlar om ett annat ämne än titeln: svara null\n\nTitel: ${title}\n\n${debateText.slice(0, 18000)}\n\nSvara ENDAST med JSON (eller null):\n{"ingress":"3-4 meningar. Beskriv sakfrågan, vad som utlöste debatten och den centrala oenigheten. Ta med konkreta detaljer om rapporter, siffror eller händelser om de är centrala.","vansterblocket":{"parties":["partiförkortningar för sida 1 / frågeställaren"],"summary":"3-4 meningar. Återge alla viktiga argument och ståndpunkter från denna sida – var specifik, nämn konkreta siffror, namn och händelser som nämndes.","keyArg":"3-4 meningar. Deras huvudposition och de mest konkreta argumenten – vad de vill uppnå, vilket problem de ser och vad de föreslår. Utelämna inget viktigt."},"hogerblocket":{"parties":["partiförkortningar för sida 2 / ministern"],"summary":"3-4 meningar. Återge alla viktiga argument och ståndpunkter från denna sida – var specifik, nämn konkreta siffror, namn och händelser som nämndes.","keyArg":"3-4 meningar. Deras huvudposition och de mest konkreta argumenten – vad de vill uppnå, vilket problem de ser och vad de föreslår. Utelämna inget viktigt."}}` }]
    })
  })
  const aiData = await aiRes.json()
  const text = (aiData.content?.[0]?.text ?? '').replace(/```json|```/g, '').trim()
  if (text === 'null' || text === '') return null
  // If Claude returned explanatory text instead of JSON (e.g. mismatch between title and content), treat as null
  if (!text.startsWith('{')) return null
  const result = JSON.parse(text)
  summaryCache.set(dokId, result)
  return result
}

// New main pipeline: fetch IP documents → group by debattdag → fetch each protocol once
async function saveIPDebatesFromProtocols(apiKey) {
  const rm = '2025/26'
  console.log(`saveIPDebatesFromProtocols: fetching 30 most recent IPs for rm=${rm}`)

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

  // 1. Fetch the most recent 30 IP documents (sorted by debattdag desc)
  const allIPDocs = []
  const limit = 20
  for (let page = 1; page <= 5 && allIPDocs.length < limit; page++) {
    try {
      const res = await fetchWithTimeout(
        `https://data.riksdagen.se/dokumentlista/?doktyp=ip&rm=${encodeURIComponent(rm)}&utformat=json&antal=20&sort=debattdag&sortorder=desc&p=${page}`,
        12000
      )
      const data = await res.json()
      const docs = data?.dokumentlista?.dokument ?? []
      const arr = Array.isArray(docs) ? docs : [docs]
      if (!arr.length || !arr[0]?.dok_id) break
      const withDate = arr.filter(d => d.debattdag)
      allIPDocs.push(...withDate)
    } catch (e) {
      console.error(`IP list page ${page} failed:`, e.message)
      break
    }
  }
  const recentDocs = allIPDocs.slice(0, limit)
  console.log(`saveIPDebatesFromProtocols: using ${recentDocs.length} most recent IP docs`)

  // 2. Group IPs by debattdag
  const byDate = new Map()
  for (const doc of recentDocs) {
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
        const existing = await pool.query('SELECT id, ingress, status FROM debates WHERE dok_id = $1', [dokId])
        if (existing.rows.length > 0 && (existing.rows[0].ingress || existing.rows[0].status === 'rejected')) continue // already done or intentionally rejected

        // Find the matching section
        const section = sections.find(s => s.ipNumbers.includes(ipNummer))
        if (!section) { console.log(`  No protocol section for IP ${ipNummer} (${ipDoc.titel?.slice(0, 40)})`); continue }

        const participants = buildParticipantsFromIntressenter(ipDoc.dokintressent)
        if (!participants.length) { console.log(`  No participants for ${dokId}`); continue }

        summaryCache.delete(dokId)
        const summary = await generateAndCache(dokId, ipDoc.titel || '', debateDate, apiKey, section.sectionText)

        if (!summary) {
          if (existing.rows.length > 0) {
            await pool.query("UPDATE debates SET status = 'rejected' WHERE dok_id = $1", [dokId])
            console.log(`  Rejected ${dokId} — no content`)
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

// ── Betänkande pipeline ────────────────────────────────────────────────────────

function extractBetSections(protText) {
  const debatePositions = []
  const pattern = /betänkande \d{4}\/\d{2}:([A-Z][a-zA-Z]*\d+)/g
  let m
  while ((m = pattern.exec(protText)) !== null) {
    const after = protText.slice(m.index, m.index + 600)
    // Require actual speech: "): Fru/Herr talman" — rules out TOC entries and "ingen talare" cases
    if (!/\)\s*:\s*(?:Fru|Herr) talman/i.test(after)) continue
    debatePositions.push({ index: m.index, beteckning: m[1] })
  }
  const sections = []
  for (let i = 0; i < debatePositions.length; i++) {
    const { index, beteckning } = debatePositions[i]
    const start = Math.max(0, index - 300)
    const nextStart = i + 1 < debatePositions.length ? debatePositions[i + 1].index : index + 25000
    const end = Math.min(nextStart, index + 20000)
    sections.push({ beteckning, sectionText: protText.slice(start, end) })
  }
  return sections
}

function parseBetParticipants(sectionText) {
  const seen = new Map()
  const anf = /Anf\. \d+ (.+?) \(([A-ZÅÄÖ]{1,5})\)\s*:\s*(?:Fru|Herr) talman/g
  let m
  while ((m = anf.exec(sectionText)) !== null) {
    const rawName = m[1].trim()
    const party = m[2]
    if (seen.has(rawName)) continue
    seen.set(rawName, party)
  }
  return Array.from(seen.entries()).map(([rawName, party]) => {
    // Convert ALL CAPS to Title Case
    const name = /^[A-ZÅÄÖÜ\-\s]+$/.test(rawName)
      ? rawName.toLowerCase().replace(/(?:^|\s|-)\w/g, c => c.toUpperCase())
      : rawName
    const parts = name.split(/\s+/)
    return {
      role: 'talare',
      person: { id: '', name, firstName: parts[0] || '', lastName: parts.slice(1).join(' ') || '', party, photoUrl: '' }
    }
  })
}

// Look up a riksdag member's intressent_id by first + last name
const personIdCache = new Map()
async function lookupPersonId(firstName, lastName) {
  const key = `${firstName}|${lastName}`
  if (personIdCache.has(key)) return personIdCache.get(key)
  try {
    const res = await fetchWithTimeout(
      `https://data.riksdagen.se/personlista/?fnamn=${encodeURIComponent(firstName)}&enamn=${encodeURIComponent(lastName)}&utformat=json&rdlstatus=samtliga`,
      6000
    )
    const data = await res.json()
    const persons = data?.personlista?.person ?? []
    const arr = Array.isArray(persons) ? persons : [persons]
    const id = arr[0]?.intressent_id ?? ''
    personIdCache.set(key, id)
    return id
  } catch { return '' }
}

async function enrichBetParticipants(participants) {
  return Promise.all(participants.map(async p => {
    if (p.person.id) return p // already has ID
    const id = await lookupPersonId(p.person.firstName, p.person.lastName)
    return {
      ...p,
      person: { ...p.person, id, photoUrl: id ? personPhotoUrl(id) : '' }
    }
  }))
}

async function fetchBetSectionForDebate(dokId, date) {
  try {
    if (!date) return ''
    const betMatch = dokId.match(/^HD\d{2}(.+)$/i)
    const beteckning = betMatch?.[1] ?? ''
    if (!beteckning) return ''
    const protRes = await fetchWithTimeout(
      `https://data.riksdagen.se/dokumentlista/?doktyp=prot&from=${date}&tom=${date}&utformat=json&antal=5`,
      10000
    )
    const protData = await protRes.json()
    const prots = protData?.dokumentlista?.dokument ?? []
    const protArr = Array.isArray(prots) ? prots : [prots]
    for (const prot of protArr.filter(p => p?.dok_id)) {
      const textRes = await fetchWithTimeout(`https://data.riksdagen.se/dokument/${prot.dok_id}.text`, 15000)
      const raw = await textRes.text()
      const protText = stripTags(raw)
      const sections = extractBetSections(protText)
      const section = sections.find(s => s.beteckning.toLowerCase() === beteckning.toLowerCase())
      if (section) return section.sectionText
    }
  } catch (e) { console.error('fetchBetSectionForDebate error:', e.message) }
  return ''
}

async function saveBetDebatesFromProtocols(apiKey) {
  const rm = '2025/26'
  const CUTOFF = '2026-05-06'
  console.log('saveBetDebatesFromProtocols: starting')

  // Build date → protocol map for dates >= CUTOFF
  const protDateMap = new Map()
  for (let page = 1; page <= 5; page++) {
    try {
      const res = await fetchWithTimeout(
        `https://data.riksdagen.se/dokumentlista/?doktyp=prot&rm=${encodeURIComponent(rm)}&utformat=json&antal=50&sort=datum&sortorder=desc&p=${page}`,
        12000
      )
      const data = await res.json()
      const docs = data?.dokumentlista?.dokument ?? []
      const arr = Array.isArray(docs) ? docs : [docs]
      if (!arr.length || !arr[0]?.dok_id) break
      let reachedCutoff = false
      for (const p of arr) {
        if (p?.dok_id && p.datum) {
          const date = p.datum.slice(0, 10)
          if (date < CUTOFF) { reachedCutoff = true; break }
          protDateMap.set(date, p.dok_id)
        }
      }
      if (reachedCutoff) break
    } catch (e) { console.error(`Bet protocol page ${page} failed:`, e.message); break }
  }
  console.log(`saveBetDebatesFromProtocols: ${protDateMap.size} protocols since ${CUTOFF}`)

  for (const [date, protDokId] of protDateMap) {
    let protText = ''
    try {
      const textRes = await fetchWithTimeout(`https://data.riksdagen.se/dokument/${protDokId}.text`, 15000)
      const raw = await textRes.text()
      protText = stripTags(raw)
    } catch (e) { console.error(`Protocol fetch failed for ${date}:`, e.message); continue }

    const sections = extractBetSections(protText)
    if (!sections.length) continue
    console.log(`  ${date}: ${sections.length} bet sections with actual debate`)

    for (const section of sections) {
      const dokId = `HD01${section.beteckning}`
      try {
        const existing = await pool.query('SELECT id, ingress, status FROM debates WHERE dok_id = $1', [dokId])
        if (existing.rows.length > 0 && (existing.rows[0].ingress || existing.rows[0].status === 'rejected')) continue

        const docRes = await fetchWithTimeout(`https://data.riksdagen.se/dokumentstatus/${dokId}.json`, 8000)
        const docData = await docRes.json()
        const titel = docData?.dokumentstatus?.dokument?.titel
        if (!titel) { console.log(`  Could not find doc ${dokId}`); continue }

        summaryCache.delete(dokId)
        const summary = await generateAndCache(dokId, titel, date, apiKey, section.sectionText)

        if (!summary) {
          if (existing.rows.length > 0) await pool.query("UPDATE debates SET status = 'rejected' WHERE dok_id = $1", [dokId])
          console.log(`  Skipping ${dokId} — no content`)
          continue
        }

        const participants = await enrichBetParticipants(parseBetParticipants(section.sectionText))
        const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
        const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }

        if (existing.rows.length > 0) {
          await pool.query('UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE dok_id = $4',
            [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), dokId])
          console.log(`  Updated "${titel.slice(0, 50)}"`)
        } else {
          await pool.query(
            `INSERT INTO debates (id, dok_id, dok_type, title, topic, topic_emoji, date, venue, participants, ingress, left_bloc, right_bloc, status)
             VALUES ($1,$2,'bet',$3,'Debatt om förslag','',$4,'Riksdagens kammare',$5,$6,$7,$8,'pending')
             ON CONFLICT (id) DO NOTHING`,
            [dokId, dokId, titel, date, JSON.stringify(participants), summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc)]
          )
          console.log(`  Saved "${titel.slice(0, 50)}" (${date})`)
        }
        await new Promise(r => setTimeout(r, 400))
      } catch (e) { console.error(`  Error processing ${dokId}:`, e.message) }
    }
  }
  console.log('saveBetDebatesFromProtocols: done')
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
    date: (firstVote.datum ?? doc.datum ?? '').slice(0, 10),
    partyVotes: Object.values(partyMap).filter(p => p.party !== '-').sort((a, b) => b.ja - a.ja),
    dokId: doc.dok_id ?? firstVote.dok_id ?? null,
  }
}

async function generateVoteSummaryServer(vote, apiKey) {
  const partyBreakdown = (vote.partyVotes || []).map(pv => `${pv.party}: ${pv.ja} ja, ${pv.nej} nej`).join('\n')
  const prompt = `Du är en erfaren svensk politisk journalist. Du skriver korrekt, flytande svenska för en bred publik. Inga engelska ord, inga direktöversättningar, inga byråkratiska fraser.

Omröstning: ${vote.title}
Datum: ${vote.date}
Resultat: ${vote.totalJa} ja, ${vote.totalNej} nej → ${vote.outcome === 'ja' ? 'BIFALLEN' : 'AVSLAGEN'}

Partier:
${partyBreakdown}

Fyll i fyra fält på korrekt svenska. Varje fält ska vara konkret och specifikt för just denna omröstning.

REGLER:
- Skriv alltid på korrekt, naturlig svenska – som en van journalist, inte en robot
- Undvik: "förslaget", "motionen", "bereds vidare", "riksdagen beslutade att", "implementeras"
- Undvik engelska lånord när det finns ett bra svenskt alternativ
- Varje mening ska handla om just DENNA omröstning – inga generiska formuleringar
- humanTitle ska vara en fråga som väcker nyfikenhet, max 8 ord

humanTitle: En engagerande fråga som fångar kärnan. Exempel: "Ska a-kassan höjas för deltidsarbetande?" eller "Får kommuner sälja ut LSS-boenden?"

jaMeaning: Vad ett JA-röst innebar i praktiken – beskriv konkret vad som händer eller förändras om förslaget går igenom. Förklara enkelt för någon som inte följer politik. 2–3 meningar, max 50 ord. Nämn INTE partier eller politiska block.

nejMeaning: Vad ett NEJ-röst innebar i praktiken – beskriv konkret vad det betyder att förslaget avslås, vad som bevaras eller inte förändras. Förklara enkelt för någon som inte följer politik. 2–3 meningar, max 50 ord. Nämn INTE partier eller politiska block.

consequence: Vad händer nu konkret? Beskriv den verkliga effekten för medborgare, kommuner eller samhälle. 1–2 meningar, max 35 ord.

Svara ENDAST med JSON:
{"humanTitle":"...","jaMeaning":"...","nejMeaning":"...","consequence":"...","topicEmoji":"[ett relevant emoji]"}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
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
  // Always recompute photoUrl from person ID so URL format changes apply to existing records
  const participants = (row.participants || []).map(p => ({
    ...p,
    person: { ...p.person, photoUrl: personPhotoUrl(p.person?.id) }
  }))
  return {
    id: row.id,
    dokId: row.dok_id,
    dokType: row.dok_type || 'ip',
    title: row.title,
    topic: row.topic,
    topicEmoji: row.topic_emoji || '',
    date: row.date,
    venue: row.venue,
    participants,
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

let autoFetchRunning = false

async function runAutoFetch() {
  if (autoFetchRunning) { console.log('Auto-fetch: already running, skipping'); return }
  autoFetchRunning = true
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) { autoFetchRunning = false; console.log('Auto-fetch: no ANTHROPIC_API_KEY, skipping'); return }
  console.log('Auto-fetch: starting...')

  // 1. IP Debates — scan protocols for interpellationsdebatter
  try {
    await saveIPDebatesFromProtocols(apiKey)
  } catch(e) { console.error('Auto-fetch IP debates error:', e.message) }

  // 2. Bet Debates — scan protocols for betänkandedebatter (from 2026-05-06)
  try {
    await saveBetDebatesFromProtocols(apiKey)
  } catch(e) { console.error('Auto-fetch bet debates error:', e.message) }

  // 2. Votes
  try {
    const listRes = await fetchWithTimeout('https://data.riksdagen.se/voteringlista/?rm=2025%2F26&sz=20&utformat=json&gruppering=votering_id&sort=datum&sortorder=desc')
    const listData = await listRes.json()
    const items = listData?.voteringlista?.votering ?? []
    const arr = (Array.isArray(items) ? items : [items]).slice(0, 10)

    const currentYear = new Date().getFullYear()
    for (const item of arr) {
      const existing = await pool.query('SELECT id FROM votes WHERE id = $1', [item.votering_id])
      if (existing.rows.length > 0) continue

      let title = item.beteckning || item.votering_id
      let date = (item.datum || '').slice(0, 10)
      if (date && new Date(date).getFullYear() < currentYear) continue
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
  autoFetchRunning = false
}

// ── Photo proxy ───────────────────────────────────────────────────────────────
// Downloads each person's photo once from riksdagen, stores in PostgreSQL, serves forever.
// This means photos never depend on riksdagen.se being up or changing URL formats.

app.get('/photos/:id', async (req, res) => {
  const id = req.params.id
  if (!id || !/^[\w\-]+$/.test(id)) return res.status(400).send('Invalid id')

  try {
    // Serve from PostgreSQL cache if available
    const cached = await pool.query('SELECT photo_data, content_type FROM person_photos WHERE id = $1', [id])
    if (cached.rows.length > 0) {
      res.set('Content-Type', cached.rows[0].content_type)
      res.set('Cache-Control', 'public, max-age=604800') // 1 week browser cache
      return res.send(cached.rows[0].photo_data)
    }

    // Not cached — check custom photos first, then riksdagen
    const photoUrl = CUSTOM_PHOTOS[id] ?? await resolveRiksdagenPhotoUrl(id)
    const photoRes = await fetchWithTimeout(photoUrl, 12000)
    if (!photoRes.ok) return res.status(404).send('Photo not found')

    const buffer = Buffer.from(await photoRes.arrayBuffer())
    const contentType = photoRes.headers.get('content-type') || 'image/jpeg'

    // Store permanently in PostgreSQL
    await pool.query(
      'INSERT INTO person_photos (id, photo_data, content_type) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
      [id, buffer, contentType]
    )
    console.log(`Photo cached: ${id} (${buffer.length} bytes)`)

    res.set('Content-Type', contentType)
    res.set('Cache-Control', 'public, max-age=604800')
    res.send(buffer)
  } catch(e) {
    console.error(`Photo proxy error for ${id}:`, e.message)
    res.status(502).send('Photo unavailable')
  }
})

// Clear photo cache so all photos are re-fetched at higher quality
app.post('/admin/photos/clear-cache', requireAdmin, async (req, res) => {
  const keepIds = Object.keys(CUSTOM_PHOTOS) // preserve manually uploaded photos
  const placeholders = keepIds.map((_, i) => `$${i + 1}`).join(',')
  const query = keepIds.length > 0
    ? `DELETE FROM person_photos WHERE id NOT IN (${placeholders})`
    : `DELETE FROM person_photos`
  const result = await pool.query(query, keepIds)
  res.json({ ok: true, deleted: result.rowCount })
})

// ── Public endpoints ──────────────────────────────────────────────────────────

app.get('/api/public/debates', async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM debates WHERE status = 'approved' ORDER BY pinned DESC, date DESC")
    res.json(rows.map(dbDebateToFrontend))
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/api/public/votes', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear()
    const { rows } = await pool.query("SELECT * FROM votes WHERE status = 'approved' AND date >= $1 ORDER BY date DESC", [`${currentYear}-01-01`])
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
    const { rows } = await pool.query("SELECT * FROM debates WHERE status != 'rejected' ORDER BY date DESC, created_at DESC")
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/admin/votes', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM votes ORDER BY created_at DESC')
    res.json(rows)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Find and delete duplicate votes (same voter_id or same dok_id).
// Keeps the best row per group: approved > pending > rejected, then newest created_at.
app.post('/admin/votes/deduplicate', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, voter_id, dok_id, title, status, created_at FROM votes ORDER BY created_at DESC')

    const statusRank = { approved: 0, pending: 1, rejected: 2 }
    const best = (a, b) => {
      const ra = statusRank[a.status] ?? 1
      const rb = statusRank[b.status] ?? 1
      if (ra !== rb) return ra < rb ? a : b
      return new Date(a.created_at) > new Date(b.created_at) ? a : b
    }

    // Group by voter_id first, then by dok_id for rows without voter_id
    const groups = {}
    for (const row of rows) {
      const key = row.voter_id || row.dok_id || row.id
      if (!groups[key]) groups[key] = []
      groups[key].push(row)
    }

    const toDelete = []
    for (const group of Object.values(groups)) {
      if (group.length < 2) continue
      let keeper = group[0]
      for (const row of group.slice(1)) keeper = best(keeper, row)
      for (const row of group) {
        if (row.id !== keeper.id) toDelete.push(row.id)
      }
    }

    if (toDelete.length === 0) return res.json({ deleted: 0, message: 'Inga dubletter hittades' })

    await pool.query(`DELETE FROM votes WHERE id = ANY($1)`, [toDelete])
    res.json({ deleted: toDelete.length, ids: toDelete })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Pre-warm the photo cache: downloads and stores all unique participant photos in PostgreSQL.
// Run once after deploy so photos are instantly available without depending on riksdagen.se.
app.post('/admin/prewarm-photo-cache', requireAdmin, async (req, res) => {
  res.json({ ok: true, message: 'Photo pre-warm started in background' })
  try {
    const { rows } = await pool.query("SELECT participants FROM debates WHERE participants IS NOT NULL AND status != 'rejected'")
    const ids = new Set()
    for (const row of rows) {
      for (const p of (row.participants || [])) {
        const id = p.person?.id
        if (id && !CUSTOM_PHOTOS[id]) ids.add(id)
      }
    }
    // Check which are already cached
    const { rows: cached } = await pool.query('SELECT id FROM person_photos')
    for (const r of cached) ids.delete(r.id)

    console.log(`Photo pre-warm: ${ids.size} photos to download`)
    let done = 0
    for (const id of ids) {
      try {
        const photoUrl = await resolveRiksdagenPhotoUrl(id)
        const photoRes = await fetchWithTimeout(photoUrl, 12000)
        if (!photoRes.ok) { console.log(`  Photo 404: ${id}`); continue }
        const buffer = Buffer.from(await photoRes.arrayBuffer())
        const contentType = photoRes.headers.get('content-type') || 'image/jpeg'
        await pool.query(
          'INSERT INTO person_photos (id, photo_data, content_type) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
          [id, buffer, contentType]
        )
        done++
        console.log(`  Cached photo ${done}: ${id} (${buffer.length}B)`)
        await new Promise(r => setTimeout(r, 200)) // rate limit
      } catch(e) { console.error(`  Photo error ${id}:`, e.message) }
    }
    console.log(`Photo pre-warm done: ${done}/${ids.size} downloaded`)
  } catch(e) { console.error('Photo pre-warm error:', e.message) }
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

// Force-save a specific IP debate by dok_id (for debates missed by pipeline)
app.post('/admin/debates/force-save', requireAdmin, async (req, res) => {
  const { dokId } = req.body
  if (!dokId) return res.status(400).json({ error: 'dokId required' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  try {
    // Fetch IP document via dokumentstatus (more complete data than dokumentlista)
    const statusRes = await fetchWithTimeout(`https://data.riksdagen.se/dokumentstatus/${dokId}.json`, 12000)
    const statusData = await statusRes.json()
    const ipDoc = statusData?.dokumentstatus?.dokument
    if (!ipDoc || !ipDoc.dok_id) return res.status(404).json({ error: 'IP document not found' })

    // Get debate date from dokaktivitet BESV (Besvarad) entry
    const aktiviteter = statusData?.dokumentstatus?.dokaktivitet?.aktivitet ?? []
    const aktivArr = Array.isArray(aktiviteter) ? aktiviteter : [aktiviteter]
    const besvEntry = aktivArr.find(a => a.kod === 'BESV' && a.status === 'inträffat')
    const debateDate = (besvEntry?.datum || '').slice(0, 10)
    if (!debateDate) return res.status(400).json({ error: 'No debate date found in dokaktivitet' })

    const participants = buildParticipantsFromIntressenter(statusData?.dokumentstatus?.dokintressent)
    if (!participants.length) return res.status(400).json({ error: 'No participants found' })

    summaryCache.delete(dokId)
    const debateText = await fetchIPSectionForDebate(dokId, debateDate, ipDoc.titel || '')
    if (!debateText) return res.status(404).json({ error: 'No protocol section found' })

    const summary = await generateAndCache(dokId, ipDoc.titel || '', debateDate, apiKey, debateText)
    if (!summary) return res.status(500).json({ error: 'AI returned null' })

    const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
    const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }

    await pool.query(
      `INSERT INTO debates (id, dok_id, dok_type, title, topic, topic_emoji, date, venue, participants, ingress, left_bloc, right_bloc, status)
       VALUES ($1,$2,'ip',$3,'Interpellationsdebatt','',$4,'Riksdagens kammare',$5,$6,$7,$8,'pending')
       ON CONFLICT (id) DO UPDATE SET ingress=$6, left_bloc=$7, right_bloc=$8`,
      [dokId, dokId, ipDoc.titel || dokId, debateDate, JSON.stringify(participants), summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc)]
    )
    res.json({ ok: true, dokId, title: ipDoc.titel, date: debateDate })
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
      await pool.query("UPDATE debates SET status = 'rejected' WHERE id = $1", [row.id])
      console.log(`reset-summary: rejected "${row.title}" — no debate content`)
      res.json({ ok: true, action: 'rejected' })
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

app.post('/admin/debates/:id/pin', requireAdmin, async (req, res) => {
  const { pinned } = req.body
  try {
    if (pinned) await pool.query('UPDATE debates SET pinned = FALSE') // unpin all first
    await pool.query('UPDATE debates SET pinned = $1 WHERE id = $2', [!!pinned, req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Reset and regenerate summary for a specific debate (dynamic path to bypass CDN cache)
app.post('/admin/debates/:id/reset', requireAdmin, async (req, res) => {
  const dokId = req.params.id
  const apiKey = process.env.ANTHROPIC_API_KEY
  try {
    summaryCache.delete(dokId)
    const { rows } = await pool.query('SELECT id, dok_id, title, date, dok_type FROM debates WHERE dok_id = $1', [dokId])
    if (rows.length === 0) return res.status(404).json({ error: 'Debate not found' })
    const row = rows[0]

    const debateText = row.dok_type === 'bet'
      ? await fetchBetSectionForDebate(row.dok_id, row.date)
      : await fetchIPSectionForDebate(row.dok_id, row.date, row.title)
    if (!debateText) return res.status(404).json({ error: 'No protocol section found' })

    const summary = await generateAndCache(row.dok_id, row.title, row.date, apiKey, debateText)
    if (summary) {
      const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
      const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
      await pool.query(
        "UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3, status = CASE WHEN status = 'rejected' THEN 'pending' ELSE status END WHERE id = $4",
        [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), row.id]
      )
      res.json({ ok: true, title: row.title, date: row.date })
    } else {
      await pool.query("UPDATE debates SET status = 'rejected' WHERE id = $1", [row.id])
      res.json({ ok: true, action: 'rejected', reason: 'no debate content' })
    }
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Unapprove (set back to pending) — dynamic path bypasses CDN cache
app.post('/admin/debates/:id/unapprove', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE debates SET status = 'pending', approved_at = NULL WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/votes/:id/approve', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE votes SET status = 'approved', approved_at = NOW() WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/votes/:id/unapprove', requireAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE votes SET status = 'pending', approved_at = NULL WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

// Bulk-fetch all unique votes from current riksmöte — responds immediately, processes in background
app.post('/admin/votes/regenerate-summaries', requireAdmin, async (req, res) => {
  res.json({ ok: true, message: 'Regenerating summaries in background' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return
  try {
    const { rows } = await pool.query("SELECT * FROM votes WHERE status = 'pending' ORDER BY date DESC")
    for (const row of rows) {
      try {
        const baseVote = { title: row.title, date: row.date, totalJa: row.total_ja, totalNej: row.total_nej, outcome: row.outcome, partyVotes: row.party_votes || [] }
        const s = await generateVoteSummaryServer(baseVote, apiKey)
        if (s) {
          await pool.query(
            'UPDATE votes SET human_title=$1, ja_meaning=$2, nej_meaning=$3, consequence=$4, topic_emoji=$5 WHERE id=$6',
            [s.humanTitle, s.jaMeaning, s.nejMeaning, s.consequence, s.topicEmoji, row.id]
          )
          console.log(`regenerated summary for "${row.title}"`)
        }
      } catch(e) { console.error(`regen failed ${row.id}:`, e.message) }
    }
    console.log('regenerate-summaries complete')
  } catch(e) { console.error('regenerate-summaries error:', e.message) }
})

app.post('/admin/votes/bulk-fetch', requireAdmin, async (req, res) => {
  res.json({ ok: true, message: 'Bulk fetch started in background' })
  const apiKey = process.env.ANTHROPIC_API_KEY
  const currentYear = new Date().getFullYear()
  try {
    const listRes = await fetchWithTimeout('https://data.riksdagen.se/voteringlista/?rm=2025%2F26&sz=500&utformat=json&gruppering=votering_id&sort=datum&sortorder=desc', 20000)
    const listData = await listRes.json()
    const items = listData?.voteringlista?.votering ?? []
    const arr = Array.isArray(items) ? items : [items]
    for (const item of arr) {
      const vid = item.votering_id
      if (!vid) continue
      const existing = await pool.query('SELECT id FROM votes WHERE id = $1', [vid])
      if (existing.rows.length > 0) continue
      let title = item.beteckning || vid
      let date = (item.datum || '').slice(0, 10)
      let partyVotes = [], dokId = item.beteckning || null
      try {
        const detail = await parseVoteDetail(vid)
        title = detail.title || title
        date = detail.date || date
        partyVotes = detail.partyVotes
        dokId = item.beteckning || detail.dokId || null
      } catch(e) { console.error(`bulk-fetch detail failed ${vid}:`, e.message) }
      if (date && new Date(date).getFullYear() < currentYear) continue
      const totalJa = parseInt(item.Ja) || 0
      const totalNej = parseInt(item.Nej) || 0
      const baseVote = { id: vid, title, date, totalJa, totalNej, totalAvstar: parseInt(item['Avstår']) || 0, totalFranvarande: parseInt(item['Frånvarande']) || 0, outcome: totalJa >= totalNej ? 'ja' : 'nej', partyVotes, dokId }
      let humanTitle = null, jaMeaning = null, nejMeaning = null, consequence = null, topicEmoji = null
      try {
        const s = await generateVoteSummaryServer(baseVote, apiKey)
        if (s) { humanTitle = s.humanTitle; jaMeaning = s.jaMeaning; nejMeaning = s.nejMeaning; consequence = s.consequence; topicEmoji = s.topicEmoji }
      } catch(e) { console.error(`bulk-fetch AI failed ${vid}:`, e.message) }
      await pool.query(
        `INSERT INTO votes (id, voter_id, title, human_title, topic_emoji, date, total_ja, total_nej, total_avstar, total_franvarande, party_votes, dok_id, outcome, ja_meaning, nej_meaning, consequence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'pending') ON CONFLICT (id) DO NOTHING`,
        [vid, vid, title, humanTitle, topicEmoji, date, baseVote.totalJa, baseVote.totalNej, baseVote.totalAvstar, baseVote.totalFranvarande, JSON.stringify(partyVotes), dokId, baseVote.outcome, jaMeaning, nejMeaning, consequence]
      )
      console.log(`bulk-fetch: saved vote "${title}" (${date})`)
    }
    console.log('bulk-fetch complete')
  } catch(e) { console.error('bulk-fetch error:', e.message) }
})

// Fix dates for all existing votes (use firstVote.datum instead of doc.datum)
app.post('/admin/votes/fix-dates', requireAdmin, async (req, res) => {
  res.json({ ok: true, message: 'Date fix started in background' })
  try {
    const { rows } = await pool.query('SELECT id FROM votes')
    let fixed = 0
    for (const row of rows) {
      try {
        const detail = await parseVoteDetail(row.id)
        if (detail.date) {
          await pool.query('UPDATE votes SET date = $1 WHERE id = $2', [detail.date, row.id])
          fixed++
        }
      } catch(e) { console.error(`fix-dates failed ${row.id}:`, e.message) }
    }
    console.log(`fix-dates complete: fixed ${fixed} votes`)
  } catch(e) { console.error('fix-dates error:', e.message) }
})

// Bulk-approve all pending votes
app.post('/admin/votes/approve-all-pending', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("UPDATE votes SET status = 'approved', approved_at = NOW() WHERE status = 'pending'")
    res.json({ ok: true, approved: result.rowCount })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/admin/debates/:id', requireAdmin, async (req, res) => {
  try {
    // Soft delete: set rejected so auto-fetch won't recreate it
    await pool.query("UPDATE debates SET status = 'rejected' WHERE id = $1", [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.delete('/admin/votes/:id', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM votes WHERE id = $1', [req.params.id])
    res.json({ ok: true })
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.post('/admin/votes/delete-old-pending', requireAdmin, async (req, res) => {
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM votes WHERE status = 'pending' AND date <= '2026-04-22'"
    )
    res.json({ deleted: rowCount })
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

app.post('/admin/bet/fetch', requireAdmin, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  res.json({ ok: true, message: 'Betänkandedebatter hämtas i bakgrunden…' })
  saveBetDebatesFromProtocols(apiKey).catch(e => console.error('saveBetDebatesFromProtocols error:', e.message))
})

// Re-enrich participants for existing bet debates that have empty person IDs
app.post('/admin/bet/enrich-participants', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id, participants FROM debates WHERE dok_type = 'bet' AND participants IS NOT NULL")
    let updated = 0
    for (const row of rows) {
      const participants = Array.isArray(row.participants) ? row.participants : []
      const needsEnrich = participants.some(p => !p.person?.id)
      if (!needsEnrich) continue
      const enriched = await enrichBetParticipants(participants)
      await pool.query('UPDATE debates SET participants = $1 WHERE id = $2', [JSON.stringify(enriched), row.id])
      updated++
    }
    res.json({ ok: true, updated })
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
          await pool.query("UPDATE debates SET status = 'rejected' WHERE id = $1", [row.id])
          console.log(`regenerate: rejected "${row.title}" — no debate content`)
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

// Radera alla pending debatter och kör pipeline från scratch (bevarar approved)
app.post('/admin/debates/clear-and-refetch', requireAdmin, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(400).json({ error: 'No ANTHROPIC_API_KEY' })
  try {
    const { rowCount } = await pool.query("DELETE FROM debates WHERE status = 'pending'")
    summaryCache.clear()
    console.log(`clear-and-refetch: deleted ${rowCount} pending debates, starting pipeline...`)
    res.json({ ok: true, deleted: rowCount, message: 'Pipeline started in background' })
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
            await pool.query("UPDATE debates SET status = 'rejected' WHERE id = $1", [row.id])
            console.log(`regenerate-all: rejected "${row.title}" — no content`)
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
    const listRes = await fetchWithTimeout('https://data.riksdagen.se/voteringlista/?rm=2025%2F26&sz=8&utformat=json&gruppering=votering_id&sort=datum&sortorder=desc')
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
