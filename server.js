import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'

const app = express()
const PORT = process.env.PORT || 3001
app.use(cors())
app.use(express.json({ limit: '2mb' }))

const summaryCache = new Map()

function stripTags(s) {
  return (s ?? '').replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

async function fetchAnforanden(url) {
  try {
    const res = await fetch(url)
    const data = await res.json()
    const list = data?.anforandelista?.anforande ?? []
    const arr = Array.isArray(list) ? list : [list]
    return arr.map(a => `[${a.talare} (${a.parti})]: ${stripTags(a.anforandetext)}`).join('\n\n')
  } catch { return '' }
}

async function fetchProtocolSection(date, title) {
  try {
    const dateStr = date.replace(/-/g, '')
    const protRes = await fetch(`https://data.riksdagen.se/dokumentlista/?doktyp=prot&from=${dateStr}&tom=${dateStr}&utformat=json&antal=20`)
    const protData = await protRes.json()
    const protDocs = protData?.dokumentlista?.dokument ?? []
    const protArr = Array.isArray(protDocs) ? protDocs : [protDocs]
    // Filtrera på exakt debattdatum
    const matching = protArr.filter(p => p.datum === date)
    const candidates = matching.length > 0 ? matching : protArr.slice(0, 1)
    const searchWord = (title || '').split(' ').find(w => w.length > 4) || 'interpellation'
    for (const prot of candidates) {
      const res = await fetch(`https://data.riksdagen.se/dokument/${prot.dok_id}.text`)
      const raw = await res.text()
      const clean = stripTags(raw)
      const match = clean.search(new RegExp(searchWord, 'i'))
      if (match >= 0) {
        const section = clean.slice(Math.max(0, match - 300), match + 7000)
        if (section.length >= 200) {
          console.log(`Hittade protokollsavsnitt i ${prot.dok_id} (${section.length} chars)`)
          return section
        }
      }
    }
  } catch(e) { console.error('fetchProtocolSection error:', e.message) }
  return ''
}

async function fetchDebateText(dokId, date, title) {
  try {
    // Kör anforandelista-strategierna parallellt
    const [text1, text2] = await Promise.all([
      fetchAnforanden(`https://data.riksdagen.se/anforandelista/?rel_dok_id=${dokId}&utformat=json&antal=20`),
      fetchAnforanden(`https://data.riksdagen.se/anforandelista/?dokid=${dokId}&utformat=json&antal=20`),
    ])
    if (text1.length >= 200) { console.log(`anforanden via rel_dok_id (${text1.length} chars)`); return text1.slice(0, 8000) }
    if (text2.length >= 200) { console.log(`anforanden via dokid (${text2.length} chars)`); return text2.slice(0, 8000) }

    // Kör protokoll + interpellationstext parallellt
    const [protText, ipText] = await Promise.all([
      date ? fetchProtocolSection(date, title) : Promise.resolve(''),
      fetch(`https://data.riksdagen.se/dokument/${dokId}.text`).then(r => r.text()).then(stripTags).catch(() => ''),
    ])
    if (protText.length >= 200) return protText.slice(0, 8000)
    if (ipText.length >= 200) { console.log(`Fallback interpellationstext: ${ipText.length} chars`); return ipText.slice(0, 8000) }
  } catch(e) { console.error('fetchDebateText error:', e.message) }
  return ''
}

async function generateAndCache(dokId, title, date, apiKey) {
  if (summaryCache.has(dokId)) return summaryCache.get(dokId)
  const protocol = await fetchDebateText(dokId, date, title)
  console.log(`fetchDebateText(${dokId}) => ${protocol.length} chars`)
  if (!protocol || protocol.length < 100) return null
  const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      messages: [{role:'user',content:`Du är en politisk journalist. Sammanfatta denna riksdagsdebatt för unga väljare. Basera ENBART på texten nedan.\n\nTitel: ${title}\n\n${protocol}\n\nSvara ENDAST med JSON:\n{"ingress":"2-3 meningar.","vansterblocket":{"parties":["S"],"summary":"Vad de argumenterade för.","keyArg":"Starkaste argument."},"hogerblocket":{"parties":["M"],"summary":"Vad de argumenterade för.","keyArg":"Starkaste argument."}}`}]
    })
  })
  const aiData = await aiRes.json()
  const text = aiData.content?.[0]?.text ?? ''
  const result = JSON.parse(text.replace(/```json|```/g,'').trim())
  summaryCache.set(dokId, result)
  return result
}

// ── Votes cache ──────────────────────────────────────────────────────────────
const votesCache = { data: null, ts: 0 }
const VOTES_TTL = 5 * 60 * 1000

app.get('/votes', async (req, res) => {
  if (votesCache.data && Date.now() - votesCache.ts < VOTES_TTL) {
    return res.json(votesCache.data)
  }
  try {
    const listRes = await fetch('https://data.riksdagen.se/voteringlista/?sz=20&utformat=json&gruppering=votering_id')
    const listData = await listRes.json()
    const items = listData?.voteringlista?.votering ?? []
    const arr = Array.isArray(items) ? items : [items]

    const details = await Promise.allSettled(arr.slice(0, 10).map(async item => {
      const r = await fetch(`https://data.riksdagen.se/votering/${item.votering_id}/json`)
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
      const title = doc.titel ? `${doc.titel}${punkt ? ` (punkt ${punkt})` : ''}` : (firstVote.beteckning ?? 'Omröstning')
      return {
        id: item.votering_id, title,
        date: (doc.datum ?? firstVote.datum ?? '').slice(0, 10),
        totalJa: parseInt(item.Ja) || 0,
        totalNej: parseInt(item.Nej) || 0,
        totalAvstar: parseInt(item['Avstår']) || 0,
        totalFranvarande: parseInt(item['Frånvarande']) || 0,
        partyVotes: Object.values(partyMap).filter(p => p.party !== '-').sort((a, b) => b.ja - a.ja),
        dokId: doc.dok_id ?? firstVote.dok_id,
        outcome: (parseInt(item.Ja) || 0) >= (parseInt(item.Nej) || 0) ? 'ja' : 'nej',
      }
    }))

    const votes = details.filter(r => r.status === 'fulfilled').map(r => r.value)
    votesCache.data = votes
    votesCache.ts = Date.now()
    res.json(votes)
  } catch(e) { res.status(500).json({ error: e.message }) }
})

app.get('/summary/:dokId', async (req, res) => {
  const apiKey = req.headers['x-api-key'] || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(401).json({error:'Missing API key'})
  try {
    const result = await generateAndCache(req.params.dokId, req.query.title || req.params.dokId, req.query.date || '', apiKey)
    if (!result) return res.status(500).json({error:'Could not generate'})
    res.json({dok_id: req.params.dokId, ...result})
  } catch(e) { res.status(500).json({error: e.message}) }
})

app.get('/api/*', async (req, res) => {
  const path = req.params[0]
  const query = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''
  try {
    const r = await fetch(`https://data.riksdagen.se/${path}${query}`, {headers:{'User-Agent':'Civica/1.0'}})
    const ct = r.headers.get('content-type') ?? ''
    if (ct.includes('json')) {
      res.status(r.status).json(await r.json())
    } else {
      res.status(r.status).type(ct || 'text/plain').send(await r.text())
    }
  } catch(err) { res.status(500).json({error: String(err)}) }
})

app.post('/ai', async (req, res) => {
  const apiKey = req.headers['x-api-key']
  if (!apiKey) return res.status(401).json({error:'Missing API key'})
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify(req.body),
    })
    res.status(r.status).json(await r.json())
  } catch(e) { res.status(500).json({error: e.message}) }
})

app.get('/health', (_, res) => res.json({ok:true, cached:summaryCache.size}))
app.listen(PORT, () => console.log(`Civica backend på port ${PORT}`))
