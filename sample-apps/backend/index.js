const express = require('express')
const { Pool } = require('pg')

const app = express()
app.use(express.json())

const pool = new Pool({
  host:     process.env.POSTGRES_HOST     || 'localhost',
  port:     parseInt(process.env.POSTGRES_PORT || '5432'),
  database: process.env.POSTGRES_DB       || 'miniboard',
  user:     process.env.POSTGRES_USER     || 'miniboard',
  password: process.env.POSTGRES_PASSWORD || '',
})

const PORT = parseInt(process.env.PORT || '3000')

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'backend-svc' })
})

app.get('/api/db-check', async (_req, res) => {
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, database: 'connected' })
  } catch (err) {
    res.status(500).json({ ok: false, database: 'disconnected', error: err.message })
  }
})

app.get('/api/posts', async (_req, res) => {
  try {
    const result = await pool.query('SELECT * FROM posts ORDER BY created_at DESC')
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/posts', async (req, res) => {
  const { title, content } = req.body || {}
  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' })
  }
  try {
    const result = await pool.query(
      'INSERT INTO posts (title, content) VALUES ($1, $2) RETURNING *',
      [title, content]
    )
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => console.log(`backend-svc running on :${PORT}`))

async function initDB(retries = 10, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS posts (
          id         SERIAL PRIMARY KEY,
          title      TEXT NOT NULL,
          content    TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `)
      console.log('DB initialized')
      return
    } catch (err) {
      console.log(`DB init attempt ${i + 1}/${retries} failed: ${err.message}`)
      if (i < retries - 1) await new Promise(r => setTimeout(r, delay))
    }
  }
  console.error('DB init failed after all retries — API calls will return errors until DB is ready')
}

initDB()
