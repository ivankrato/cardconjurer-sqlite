'use strict'

const express = require('express')
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const PORT = process.env.PORT || 3000
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'cards.db')
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, 'card_images')

// Ensure the images directory exists
fs.mkdirSync(IMAGES_DIR, { recursive: true })

// ── Database setup ──────────────────────────────────────────────────────────
const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS cards (
    name       TEXT PRIMARY KEY,
    data       TEXT NOT NULL,
    image_file TEXT,
    saved_at   TEXT NOT NULL DEFAULT (datetime('now'))
  )
`)

// Add image_file column if upgrading from an older schema
try {
  db.exec(`ALTER TABLE cards ADD COLUMN image_file TEXT`)
} catch (_) { /* column already exists */ }

// ── Express setup ───────────────────────────────────────────────────────────
const app = express()
app.use(express.json({ limit: '50mb' }))

// ── Routes ──────────────────────────────────────────────────────────────────

// GET /api/cards  →  list of card names (sorted) – kept as plain strings for compatibility
app.get('/api/cards', (req, res) => {
  const rows = db.prepare('SELECT name FROM cards ORDER BY name ASC').all()
  res.json(rows.map(r => r.name))
})

// GET /api/cards-meta  →  list of { name, image_file } for the gallery
app.get('/api/cards-meta', (req, res) => {
  const rows = db.prepare('SELECT name, image_file FROM cards ORDER BY name ASC').all()
  res.json(rows.map(r => ({ name: r.name, image_file: r.image_file || null })))
})

// GET /api/cards/:name  →  full card JSON
app.get('/api/cards/:name', (req, res) => {
  const row = db.prepare('SELECT data FROM cards WHERE name = ?').get(req.params.name)
  if (!row) return res.status(404).json({ error: 'Card not found' })
  // data is stored as a JSON string; send it parsed so the client receives an object
  res.json(JSON.parse(row.data))
})

// POST /api/cards/:name  →  upsert card (body = card JSON object, optional _imageData = base64 PNG)
app.post('/api/cards/:name', (req, res) => {
  const name = req.params.name
  const body = { ...req.body }

  // Extract and persist image if provided
  let imageFile = null
  if (body._imageData) {
    const imgBase64 = body._imageData
    delete body._imageData

    // Sanitise filename: replace characters that are dangerous in filenames
    const safeName = name.replace(/[/\\?%*:|"<>]/g, '_')
    imageFile = safeName + '.png'
    const imgPath = path.join(IMAGES_DIR, imageFile)
    try {
      fs.writeFileSync(imgPath, Buffer.from(imgBase64, 'base64'))
    } catch (err) {
      console.error('Failed to write image:', err)
      imageFile = null
    }
  } else {
    // Keep existing image_file if no new image was sent
    const existing = db.prepare('SELECT image_file FROM cards WHERE name = ?').get(name)
    imageFile = existing ? existing.image_file : null
  }

  const data = JSON.stringify(body)
  db.prepare(`
    INSERT INTO cards (name, data, image_file, saved_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET data = excluded.data, image_file = excluded.image_file, saved_at = excluded.saved_at
  `).run(name, data, imageFile)
  res.json({ ok: true, name, image_file: imageFile })
})

// DELETE /api/cards/:name  →  remove card (and its image)
app.delete('/api/cards/:name', (req, res) => {
  const row = db.prepare('SELECT image_file FROM cards WHERE name = ?').get(req.params.name)
  const info = db.prepare('DELETE FROM cards WHERE name = ?').run(req.params.name)
  if (info.changes === 0) return res.status(404).json({ error: 'Card not found' })
  if (row && row.image_file) {
    try { fs.unlinkSync(path.join(IMAGES_DIR, row.image_file)) } catch (_) {}
  }
  res.json({ ok: true })
})

// DELETE /api/cards  →  remove ALL cards (and their images)
app.delete('/api/cards', (req, res) => {
  const rows = db.prepare('SELECT image_file FROM cards').all()
  db.prepare('DELETE FROM cards').run()
  rows.forEach(r => {
    if (r.image_file) try { fs.unlinkSync(path.join(IMAGES_DIR, r.image_file)) } catch (_) {}
  })
  res.json({ ok: true })
})

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Card Conjurer API listening on port ${PORT}  (db: ${DB_PATH})`)
})

