'use strict'

const express = require('express')
const Database = require('better-sqlite3')
const path = require('path')

const PORT = process.env.PORT || 3000
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cards.db')

// ── Database setup ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    name  TEXT PRIMARY KEY,
    data  TEXT NOT NULL,
    saved_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// ── Express setup ───────────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit: '50mb' }))

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/cards  →  list of card names (sorted)
app.get('/api/cards', (req, res) => {
  const rows = db.prepare('SELECT name FROM cards ORDER BY name ASC').all()
  res.json(rows.map(r => r.name))
})

// GET /api/cards/:name  →  full card JSON
app.get('/api/cards/:name', (req, res) => {
  const row = db.prepare('SELECT data FROM cards WHERE name = ?').get(req.params.name)
  if (!row) return res.status(404).json({ error: 'Card not found' })
  // data is stored as a JSON string; send it parsed so the client receives an object
  res.json(JSON.parse(row.data))
})

// POST /api/cards/:name  →  upsert card (body = card JSON object)
app.post('/api/cards/:name', (req, res) => {
  const name = req.params.name
  const data = JSON.stringify(req.body)
  db.prepare(`
    INSERT INTO cards (name, data, saved_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET data = excluded.data, saved_at = excluded.saved_at
  `).run(name, data)
  res.json({ ok: true, name })
})

// DELETE /api/cards/:name  →  remove card
app.delete('/api/cards/:name', (req, res) => {
  const info = db.prepare('DELETE FROM cards WHERE name = ?').run(req.params.name)
  if (info.changes === 0) return res.status(404).json({ error: 'Card not found' })
  res.json({ ok: true })
})

// DELETE /api/cards  →  remove ALL cards
app.delete('/api/cards', (req, res) => {
  db.prepare('DELETE FROM cards').run()
  res.json({ ok: true })
})

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Card Conjurer API listening on port ${PORT}  (db: ${DB_PATH})`)
})

