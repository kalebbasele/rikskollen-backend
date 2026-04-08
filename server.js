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

// ── Riksdagen speech fetchers ─────────────────────────────────────────────────

const summaryCache = new Map()

async function fetchAnforanden(url) {
  try {
    const res = await fetch(url)
    const data = await res.json()
    const list = data?.anforandelista?.anforande ?? []
    const arr = Array.isArray(list) ? list : [list]
    return arr.map(a => `[${a.talare} (${a.parti})]: ${stripTags(a.anforandetext)}`).join('\n\n')
  } catch { return '' }
}

async function fetchAnforandenByHtml(dokId) {
  try {
    const [r1, r2] = await Promise.all([
      fetch(`https://data.riksdagen.se/anforandelista/?rel_dok_id=${dokId}&utformat=json&antal=50`).then(r => r.json()).catch(() => ({})),
      fetch(`https://data.riksdagen.se/anforandelista/?dokid=${dokId}&utformat=json&antal=50`).then(r => r.json()).catch(() => ({})),
    ])
    const merge = new Map()
    for (const d of [r1, r2]) {
      const list = d?.anforandelista?.anforande ?? []
      const arr = Array.isArray(list) ? list : [list]
      for (const a of arr) { if (a.anforande_url_html) merge.set(a.anforande_url_html, a) }
    }
    const uniq = [...merge.values()]
    if (uniq.length === 0) return ''
    const results = await Promise.allSettled(
      uniq.slice(0, 8).map(async a => {
        const r = await fetch(a.anforande_url_html)
        const html = await r.text()
        const text = stripTags(html).trim()
        return text.length > 50 ? `[${a.talare} (${a.parti})]: ${text.slice(0, 1500)}` : ''
      })
    )
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).join('\n\n')
  } catch { return '' }
}

// Hittar rätt debattsektion i protokollet.
// Pass 1: letar efter förekomst följd av "föredrogs" inom 300 tecken (exakt debattstart).
// Pass 2: fallback — väljer förekomst med längst genomsnittliga ord (löptext vs TOC).
function findBestSectionInProtocol(clean, searchTerms) {
  for (const term of searchTerms) {
    if (!term) continue
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(escaped, 'i')
    let searchFrom = 0
    let m

    // Pass 1: "föredrogs" nearby = actual debate section
    while ((m = clean.slice(searchFrom).search(pattern)) >= 0) {
      const absoluteIdx = searchFrom + m
      if (/f\u00f6redrogs/i.test(clean.slice(absoluteIdx, absoluteIdx + 300))) {
        const section = clean.slice(absoluteIdx, absoluteIdx + 20000)
        if (section.length >= 200) return section
      }
      searchFrom = absoluteIdx + 1
      if (searchFrom >= clean.length) break
    }

    // Pass 2: pick occurrence with highest avg word length (actual text > TOC entries)
    let bestIdx = -1, bestScore = -1
    searchFrom = 0
    while ((m = clean.slice(searchFrom).search(pattern)) >= 0) {
      const absoluteIdx = searchFrom + m
      const words = clean.slice(absoluteIdx, absoluteIdx + 3000).split(/\s+/).filter(w => w.length > 0)
      const avgLen = words.reduce((s, w) => s + w.length, 0) / (words.length || 1)
      if (avgLen > bestScore) { bestScore = avgLen; bestIdx = absoluteIdx }
      searchFrom = absoluteIdx + 1
      if (searchFrom >= clean.length) break
    }
    if (bestIdx >= 0) {
      const section = clean.slice(Math.max(0, bestIdx - 500), bestIdx + 20000)
      if (section.length >= 200) return section
    }
  }
  return ''
}

async function fetchProtocolSection(date, title, dokId = '') {
  try {
    const dateStr = date.replace(/-/g, '')
    const protRes = await fetch(`https://data.riksdagen.se/dokumentlista/?doktyp=prot&from=${dateStr}&tom=${dateStr}&utformat=json&antal=20`)
    const protData = await protRes.json()
    const protDocs = protData?.dokumentlista?.dokument ?? []
    const protArr = Array.isArray(protDocs) ? protDocs : [protDocs]
    const matching = protArr.filter(p => p.datum === date)
    const candidates = matching.length > 0 ? matching : protArr.slice(0, 1)

    // Build search terms: beteckning first (most precise), then title words
    const beteckning = dokId ? dokId.replace(/^HD\d+/i, '') : ''  // e.g. 'HD01SoU19' → 'SoU19'
    const titleWords = (title || '').split(' ').filter(w => w.length > 4)
    const searchTerms = [beteckning, ...titleWords].filter(Boolean)

    for (const prot of candidates) {
      const res = await fetch(`https://data.riksdagen.se/dokument/${prot.dok_id}.text`)
      const raw = await res.text()
      const clean = stripTags(raw)
      const section = findBestSectionInProtocol(clean, searchTerms)
      if (section) return section
    }
  } catch {}
  return ''
}

// Söker anföranden via nyckelord i titeln — hittar debatten även om dok_id-kopplingen saknas
async function fetchAnforandenByTitle(title, kammaraktivitet = '') {
  try {
    const words = (title || '').split(/\s+/).filter(w => w.length > 4).slice(0, 4)
    if (words.length === 0) return ''
    const today = new Date()
    const from = new Date(today); from.setMonth(from.getMonth() - 6)
    const fromStr = from.toISOString().slice(0, 10).replace(/-/g, '')
    const tomStr = today.toISOString().slice(0, 10).replace(/-/g, '')
    const kamUrl = kammaraktivitet ? `&kammaraktivitet=${encodeURIComponent(kammaraktivitet)}` : ''
    const res = await fetch(
      `https://data.riksdagen.se/anforandelista/?utformat=json&antal=200&from=${fromStr}&tom=${tomStr}${kamUrl}`
    )
    const data = await res.json()
    const list = data?.anforandelista?.anforande ?? []
    const arr = Array.isArray(list) ? list : [list]
    const relevant = arr.filter(a => {
      const rubrik = ((a.avsnittsrubrik || '') + ' ' + (a.kammaraktivitet || '')).toLowerCase()
      return words.some(w => rubrik.includes(w.toLowerCase()))
    })
    if (relevant.length === 0) return ''
    console.log(`fetchAnforandenByTitle(${kammaraktivitet}): ${relevant.length} träffar för "${words.join(' ')}"`)
    const results = await Promise.allSettled(
      relevant.slice(0, 8).map(async a => {
        if (!a.anforande_url_html) return ''
        const r = await fetch(a.anforande_url_html)
        const html = await r.text()
        const text = stripTags(html).trim()
        return text.length > 50 ? `[${a.talare} (${a.parti})]: ${text.slice(0, 1500)}` : ''
      })
    )
    return results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value).join('\n\n')
  } catch(e) { console.error('fetchAnforandenByTitle error:', e.message); return '' }
}

async function fetchDebateText(dokId, date, title, kammaraktivitet = '') {
  try {
    const results = await Promise.allSettled([
      fetchAnforanden(`https://data.riksdagen.se/anforandelista/?rel_dok_id=${dokId}&utformat=json&antal=20`),
      fetchAnforanden(`https://data.riksdagen.se/anforandelista/?dokid=${dokId}&utformat=json&antal=20`),
      fetchAnforandenByHtml(dokId),
      date ? fetchProtocolSection(date, title, dokId) : Promise.resolve(''),
      fetchAnforandenByTitle(title, kammaraktivitet),
    ])
    const texts = results.map(r => r.status === 'fulfilled' ? r.value : '')
    const best = texts.filter(t => t.length >= 200).sort((a, b) => b.length - a.length)[0]
    if (best) return best.slice(0, 8000)
  } catch {}
  return ''
}

async function generateAndCache(dokId, title, date, apiKey, dokType = 'ip') {
  if (summaryCache.has(dokId)) return summaryCache.get(dokId)
  const kammaraktivitet = dokType === 'bet' ? 'betankandedebatt' : 'interpellationsdebatt'
  const protocol = await fetchDebateText(dokId, date, title, kammaraktivitet)
  if (!protocol || protocol.length < 100) return null
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      messages: [{ role: 'user', content: `Du är en erfaren politisk reporter på en nyhetssajt. Din uppgift är att skriva en kort, intresseväckande nyhetsnotis om riksdagsdebatten nedan – som om du skriver ett nyhetsmail till läsare som snabbt vill veta vad som hände och varför det spelar roll.\n\nRegler:\n- Varje sammanfattning ska kännas unik och specifik för just denna debatt – aldrig generisk\n- Börja med det mest intressanta eller kontroversiella som framkom – en konkret ståndpunkt, ett krav, en konflikt\n- Nämn ALDRIG "högerblocket", "vänsterblocket", "oppositionen" eller "regeringen" – använd alltid partiförkortningar (S, M, SD, KD, L, C, V, MP)\n- Skriv INTE "Debatten handlade om", "I debatten", "Riksdagen diskuterade" – gå direkt på innehållet\n- Formellt men enkelt språk – inga krångliga meningar\n- Basera ENBART på texten nedan\n\nTitel: ${title}\n\n${protocol}\n\nSvara ENDAST med JSON:\n{"ingress":"2-3 meningar. Led med det mest konkreta från debatten – ett specifikt krav, en tydlig konflikt, eller ett oväntat svar. Namnge partier och personer när det tillför.","vansterblocket":{"parties":["partiförkortningar"],"summary":"Vad de drev för linje, med konkreta argument. 2-4 meningar.","keyArg":"Deras skarpaste argument eller krav, 1 mening."},"hogerblocket":{"parties":["partiförkortningar"],"summary":"Vad de drev för linje, med konkreta argument. 2-4 meningar.","keyArg":"Deras skarpaste argument eller krav, 1 mening."}}` }]
    })
  })
  const aiData = await aiRes.json()
  const text = aiData.content?.[0]?.text ?? ''
  const result = JSON.parse(text.replace(/```json|```/g, '').trim())
  summaryCache.set(dokId, result)
  return result
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

Regler:
- Skriv i aktiv, konkret form
- Börja inte med "Riksdagen beslutade" eller liknande kliché – gå direkt på vad beslutet innebär
- Formellt men tillgängligt språk

Svara ENDAST med JSON:
{"humanTitle":"[Kort fråga max 8 ord]","jaMeaning":"[Vad JA innebär konkret, en mening]","nejMeaning":"[Vad NEJ innebär konkret, en mening]","consequence":"[Vad utfallet betyder för vanliga människor, 1-2 meningar]","topicEmoji":"[ett emoji]"}`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
  })
  const data = await res.json()
  const text = data.content?.[0]?.text ?? ''
  return JSON.parse(text.replace(/```json|```/g, '').trim())
}

// ── Riksdagen debate parser ───────────────────────────────────────────────────

function parseParticipants(dok) {
  const intressenter = (() => { const i = dok.dokintressent?.intressent; if (!i) return []; return Array.isArray(i) ? i : [i] })()
  const anforanden = (() => { const a = dok.debatt?.anforande; if (!a) return []; return Array.isArray(a) ? a : [a] })()

  const anforMap = new Map()
  for (const a of anforanden) {
    if (a.intressent_id && !anforMap.has(a.intressent_id)) {
      anforMap.set(a.intressent_id, { name: cleanName(a.talare ?? ''), party: a.parti || a.partibet || '' })
    }
  }

  const makeParticipant = (i, role) => {
    const id = i.intressent_id ?? ''
    const fromAnf = anforMap.get(id)
    const name = fromAnf?.name || cleanName(i.namn ?? 'Okänd')
    const party = i.partibet || i.parti || fromAnf?.party || ''
    return { person: { id, name, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '), party, photoUrl: personPhotoUrl(id) }, role }
  }

  const seen = new Set()
  const participants = []

  const undertecknare = intressenter.find(i => i.roll === 'undertecknare')
  if (undertecknare?.intressent_id) { seen.add(undertecknare.intressent_id); participants.push(makeParticipant(undertecknare, 'undertecknare')) }

  const besvaradav = intressenter.find(i => i.roll === 'besvaradav')
  if (besvaradav?.intressent_id && !seen.has(besvaradav.intressent_id)) { seen.add(besvaradav.intressent_id); participants.push(makeParticipant(besvaradav, 'besvaradav')) }

  for (const a of anforanden) {
    const id = a.intressent_id
    if (!id || seen.has(id)) continue
    seen.add(id)
    const fromDok = intressenter.find(i => i.intressent_id === id)
    if (fromDok) {
      participants.push(makeParticipant(fromDok, 'talare'))
    } else {
      const name = cleanName(a.talare ?? 'Okänd')
      participants.push({ person: { id, name, firstName: name.split(' ')[0], lastName: name.split(' ').slice(1).join(' '), party: a.parti || a.partibet || '', photoUrl: personPhotoUrl(id) }, role: 'talare' })
    }
  }

  const seenNames = new Set()
  return participants.filter(p => {
    const key = p.person.name.toLowerCase().trim()
    if (seenNames.has(key)) return false
    seenNames.add(key)
    return true
  })
}

async function fetchDebatesFromRiksdagen() {
  const res = await fetch('https://data.riksdagen.se/dokumentlista/?doktyp=ip&utformat=json&antal=30&sort=debattdag&sortorder=desc')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const rawDok = data?.dokumentlista?.dokument ?? []
  const dokument = Array.isArray(rawDok) ? rawDok : [rawDok]
  const debates = []

  for (const dok of dokument) {
    if (debates.length >= 20) break
    if (!dok.debatt) continue
    const participants = parseParticipants(dok)
    if (participants.length === 0) continue
    const anforanden = (() => { const a = dok.debatt?.anforande; if (!a) return []; return Array.isArray(a) ? a : [a] })()
    const debattdag = dok.debattdag || anforanden[0]?.anf_datumtid?.slice(0, 10) || dok.datum || ''
    debates.push({
      id: dok.dok_id,
      dokId: dok.dok_id,
      dokType: 'ip',
      title: dok.titel ?? 'Debatt',
      topic: dok.debattnamn ?? 'Interpellationsdebatt',
      topicEmoji: '',
      date: debattdag,
      venue: 'Riksdagens kammare',
      participants,
    })
  }
  return debates.sort((a, b) => b.date > a.date ? 1 : -1)
}

async function fetchBetankandeDebates() {
  const res = await fetch('https://data.riksdagen.se/dokumentlista/?doktyp=bet&utformat=json&antal=50&sort=datum&sortorder=desc')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const rawDok = data?.dokumentlista?.dokument ?? []
  const dokument = Array.isArray(rawDok) ? rawDok : [rawDok]
  const debates = []

  for (const dok of dokument) {
    if (debates.length >= 20) break
    // Only include if there's an actual protocol with speeches
    const anforanden = (() => { const a = dok.debatt?.anforande; if (!a) return []; return Array.isArray(a) ? a : [a] })()
    if (anforanden.length === 0) continue
    const participants = parseParticipants(dok)
    if (participants.length === 0) continue
    const debattdag = dok.debattdag || anforanden[0]?.anf_datumtid?.slice(0, 10) || dok.datum || ''
    // Use committee/organ as topic
    const topic = dok.organ ? `Utskottsdebatt · ${dok.organ.toUpperCase()}` : (dok.debattnamn ?? 'Debatt om förslag')
    debates.push({
      id: dok.dok_id,
      dokId: dok.dok_id,
      dokType: 'bet',
      title: dok.titel ?? dok.notisrubrik ?? 'Betänkandedebatt',
      topic,
      topicEmoji: '',
      date: debattdag,
      venue: 'Riksdagens kammare',
      participants,
    })
  }
  return debates.sort((a, b) => b.date > a.date ? 1 : -1)
}

async function fetchFragstund() {
  const res = await fetch('https://data.riksdagen.se/dokumentlista/?doktyp=kam-fs&utformat=json&antal=50&sort=datum&sortorder=desc')
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  const rawDok = data?.dokumentlista?.dokument ?? []
  const dokument = Array.isArray(rawDok) ? rawDok : [rawDok]
  const result = []

  for (const dok of dokument) {
    // Only include frågestund that have a debate protocol with speeches
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
  const protocol = await fetchDebateText(dokId, date, title, 'fragstund')
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

  // 1. Debates (interpellationer + betänkandedebatter)
  async function saveDebates(debates) {
    for (const debate of debates) {
      const existing = await pool.query('SELECT id, ingress FROM debates WHERE id = $1', [debate.id])

      if (existing.rows.length > 0) {
        // Already saved — retry AI only if ingress is still missing
        if (existing.rows[0].ingress) continue
        let ingress = null, leftBloc = null, rightBloc = null
        try {
          const summary = await generateAndCache(debate.dokId, debate.title, debate.date, apiKey, debate.dokType ?? 'ip')
          if (summary) {
            ingress = summary.ingress
            leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
            rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
            await pool.query(
              'UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE id = $4',
              [ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), debate.id]
            )
            console.log(`Auto-fetch: filled in missing summary for "${debate.title}"`)
          }
        } catch(e) { console.error(`AI retry failed ${debate.id}:`, e.message) }
        continue
      }

      // New debate — generate summary and insert
      let ingress = null, leftBloc = null, rightBloc = null
      try {
        const summary = await generateAndCache(debate.dokId, debate.title, debate.date, apiKey, debate.dokType ?? 'ip')
        if (summary) {
          ingress = summary.ingress
          leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
          rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
        }
      } catch(e) { console.error(`AI debate failed ${debate.id}:`, e.message) }

      await pool.query(
        `INSERT INTO debates (id, dok_id, dok_type, title, topic, topic_emoji, date, venue, participants, ingress, left_bloc, right_bloc, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'pending') ON CONFLICT (id) DO NOTHING`,
        [debate.id, debate.dokId, debate.dokType ?? 'ip', debate.title, debate.topic, debate.topicEmoji, debate.date, debate.venue,
         JSON.stringify(debate.participants), ingress,
         leftBloc ? JSON.stringify(leftBloc) : null,
         rightBloc ? JSON.stringify(rightBloc) : null]
      )
      console.log(`Auto-fetch: saved debate "${debate.title}" (${debate.dokType ?? 'ip'})`)
    }
  }

  try {
    const [ipDebates, betDebates] = await Promise.allSettled([
      fetchDebatesFromRiksdagen(),
      fetchBetankandeDebates(),
    ])
    if (ipDebates.status === 'fulfilled') await saveDebates(ipDebates.value)
    else console.error('Auto-fetch ip debates error:', ipDebates.reason?.message)
    if (betDebates.status === 'fulfilled') await saveDebates(betDebates.value)
    else console.error('Auto-fetch bet debates error:', betDebates.reason?.message)
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
        // Already saved — retry AI only if summary is still missing
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
    const { rows } = await pool.query('SELECT * FROM debates ORDER BY created_at DESC')
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
  const force = req.query.force === 'true'
  try {
    const debateQuery = force
      ? "SELECT id, dok_id, dok_type, title, date FROM debates ORDER BY date DESC LIMIT 20"
      : "SELECT id, dok_id, dok_type, title, date FROM debates WHERE ingress IS NULL ORDER BY date DESC LIMIT 20"
    const { rows: debateRows } = await pool.query(debateQuery)
    let updatedDebates = 0
    for (const row of debateRows) {
      try {
        // Clear cache so old result doesn't block re-generation
        summaryCache.delete(row.dok_id)
        const summary = await generateAndCache(row.dok_id, row.title, row.date, apiKey, row.dok_type ?? 'ip')
        if (summary) {
          const leftBloc = { parties: summary.vansterblocket?.parties ?? [], summary: summary.vansterblocket?.summary ?? '', keyArg: summary.vansterblocket?.keyArg ?? '' }
          const rightBloc = { parties: summary.hogerblocket?.parties ?? [], summary: summary.hogerblocket?.summary ?? '', keyArg: summary.hogerblocket?.keyArg ?? '' }
          await pool.query(
            'UPDATE debates SET ingress = $1, left_bloc = $2, right_bloc = $3 WHERE id = $4',
            [summary.ingress, JSON.stringify(leftBloc), JSON.stringify(rightBloc), row.id]
          )
          updatedDebates++
        }
      } catch(e) { console.error(`regenerate debate ${row.id}:`, e.message) }
    }
    const fsQuery = force
      ? "SELECT id, dok_id, title, date FROM fragstund ORDER BY date DESC LIMIT 20"
      : "SELECT id, dok_id, title, date FROM fragstund WHERE summary IS NULL ORDER BY date DESC LIMIT 20"
    const { rows: fsRows } = await pool.query(fsQuery)
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

app.post('/admin/refetch-bet-debates', requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM debates WHERE dok_type = 'bet'")
    const debates = await fetchBetankandeDebates()
    let saved = 0
    for (const debate of debates) {
      await pool.query(
        `INSERT INTO debates (id, dok_id, dok_type, title, topic, topic_emoji, date, venue, participants, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending') ON CONFLICT (id) DO NOTHING`,
        [debate.id, debate.dokId, 'bet', debate.title, debate.topic, debate.topicEmoji, debate.date, debate.venue, JSON.stringify(debate.participants)]
      )
      saved++
    }
    res.json({ deleted: true, saved })
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
    // Return { left: { up: N, down: N }, right: { up: N, down: N } }
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

// ── Existing endpoints (kept) ─────────────────────────────────────────────────

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
    const result = await generateAndCache(req.params.dokId, req.query.title || req.params.dokId, req.query.date || '', apiKey)
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
