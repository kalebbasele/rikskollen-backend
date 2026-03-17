import express from 'express'
import cors from 'cors'
import fetch from 'node-fetch'

const app = express()
const PORT = process.env.PORT || 3001

app.use(cors())
app.use(express.json())

// Webb-TV ligger på riksdagen.se (inte data.riksdagen.se)
app.get('/api/webbtv/*', async (req, res) => {
  const query = req.url.includes('?') ? req.url.split('?').slice(1).join('?') : ''
  const url = `https://riksdagen.se/api/videostream/search?${query}`
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RiksKollen/1.0', 'Accept': 'application/json' }
    })
    const data = await response.json()
    res.json(data)
  } catch (err) {
    // Fallback: prova webbtv-endpoint
    try {
      const url2 = `https://data.riksdagen.se/webbtv/?${query}`
      const r2 = await fetch(url2, {
        headers: { 'User-Agent': 'RiksKollen/1.0', 'Accept': 'application/json' }
      })
      const d2 = await r2.json()
      res.json(d2)
    } catch (err2) {
      res.status(500).json({ error: 'Kunde inte hämta debatter', details: String(err2) })
    }
  }
})

// Alla andra anrop går till data.riksdagen.se
app.get('/api/*', async (req, res) => {
  const path = req.params[0]
  const query = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : ''
  const url = `https://data.riksdagen.se/${path}${query}`

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'RiksKollen/1.0', 'Accept': 'application/json' }
    })
    const contentType = response.headers.get('content-type') ?? ''
    const data = contentType.includes('json') ? await response.json() : await response.text()
    res.status(response.status).json(data)
  } catch (err) {
    res.status(500).json({ error: 'Kunde inte nå riksdagens API', details: String(err) })
  }
})

app.get('/health', (_, res) => res.json({ ok: true }))

app.listen(PORT, () => console.log(`RiksKollen backend körs på port ${PORT}`))
