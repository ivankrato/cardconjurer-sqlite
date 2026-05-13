'use strict'

const express = require('express')
const Database = require('better-sqlite3')
const path = require('path')
const fs = require('fs')

const PORT     = process.env.PORT     || 3000   // public  – gallery + images only (tunnelled)
const API_PORT = process.env.API_PORT || 3001   // internal – /api/*  (nginx proxy only)
const DB_PATH  = process.env.DB_PATH  || path.join(__dirname, 'cards.db')
const IMAGES_DIR          = process.env.IMAGES_DIR     || path.join(__dirname, 'card_images')
const GALLERY_HEADER_PATH = process.env.GALLERY_HEADER || path.join(__dirname, 'gallery-header.html')

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
try { db.exec(`ALTER TABLE cards ADD COLUMN image_file TEXT`) } catch (_) {}

// ── Gallery helpers ─────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}

function getColors(manaCost) {
  const c = new Set()
  const symbols = manaCost.match(/\{[^}]+\}/g) || []
  if (symbols.length > 0) {
    // Braced format: {W}{B}, {W/U}, {2/W}, etc.
    for (const sym of symbols) {
      for (const p of sym.replace(/[{}]/g, '').split('/')) {
        if (p === 'W') c.add('W'); if (p === 'U') c.add('U'); if (p === 'B') c.add('B')
        if (p === 'R') c.add('R'); if (p === 'G') c.add('G')
      }
    }
  } else {
    // Plain format: WB, 2WU, etc. – extract individual WUBRG letters
    for (const p of manaCost.replace(/[^WUBRG]/g, '')) c.add(p)
  }
  return [...c]
}

function colorGroup(colors) {
  if (colors.length > 1) return 'M'
  if (colors.length === 1) return colors[0]
  return 'C'
}

const TYPE_ORDER = ['Creature', 'Sorcery', 'Instant', 'Enchantment', 'Artifact', 'Battle', 'Land']
const TYPE_LABEL = Object.fromEntries(TYPE_ORDER.map(t => [t, t]))
TYPE_LABEL['Other'] = 'Other'

function getTypeGroup(cardData) {
  const typeText = cardData.text?.type?.text || ''
  for (const t of TYPE_ORDER) {
    if (typeText.includes(t)) return t
  }
  // Fallback: scan all text fields (some frames use non-standard field names)
  if (cardData.text) {
    for (const field of Object.values(cardData.text)) {
      const txt = field?.text || ''
      for (const t of TYPE_ORDER) {
        if (txt.includes(t)) return t
      }
    }
  }
  return 'Other'
}

const GROUP_ORDER  = ['W',       'U',     'B',     'R',   'G',      'M',          'C']
const GROUP_LABEL  = { W:'White', U:'Blue', B:'Black', R:'Red', G:'Green', M:'Multicolor', C:'Colorless' }
const GROUP_BG     = { W:'#f5efc0', U:'#bdd4ee', B:'#1e1e1e', R:'#eec0b0', G:'#b8ddb8', M:'#ede0a0', C:'#d4d4d4' }
const GROUP_FG     = { W:'#111',    U:'#111',    B:'#e8e8e8', R:'#111',   G:'#111',    M:'#111',       C:'#111'   }
const GROUP_ACCENT = { W:'#c8a800', U:'#2255aa', B:'#8855cc', R:'#cc3300', G:'#228833', M:'#b8860b',   C:'#666'   }

// ── PUBLIC app – port 3000 ──────────────────────────────────────────────────
// Expose ONLY this port via the Cloudflare tunnel.
const publicApp = express()

publicApp.use('/card-images', express.static(IMAGES_DIR))

publicApp.get('/', (req, res) => res.redirect(301, '/cards'))

publicApp.get('/cards', (req, res) => {
  const rows = db.prepare('SELECT name, data, image_file FROM cards ORDER BY name ASC').all()

  const parsed = rows.map(r => {
    let d = {}; try { d = JSON.parse(r.data) } catch (_) {}
    const manaCost = d.text?.mana?.text || ''
    const colors = getColors(manaCost)
    return {
      name: r.name,
      image_file: r.image_file || null,
      group: colorGroup(colors),
      typeGroup: getTypeGroup(d)
    }
  })

  const buckets = {}
  GROUP_ORDER.forEach(g => { buckets[g] = [] })
  parsed.forEach(c => buckets[c.group].push(c))

  let headerHtml = ''
  try { headerHtml = fs.readFileSync(GALLERY_HEADER_PATH, 'utf8') } catch (_) {}

  const ALL_TYPES = [...TYPE_ORDER, 'Other']

  const sectionsHtml = GROUP_ORDER.filter(g => buckets[g].length > 0).map(g => {
    // Sort the colour bucket: by type order, then alphabetically by name
    const colorCards = buckets[g].slice().sort((a, b) => {
      const ta = ALL_TYPES.indexOf(a.typeGroup)
      const tb = ALL_TYPES.indexOf(b.typeGroup)
      if (ta !== tb) return ta - tb
      return a.name.localeCompare(b.name)
    })

    // Build type sub-sections
    const typeSubSections = ALL_TYPES.map(t => {
      const cards = colorCards.filter(c => c.typeGroup === t)
      if (cards.length === 0) return ''
      const cardsHtml = cards.map(c => {
        const imgSrc = c.image_file ? `/card-images/${encodeURIComponent(c.image_file)}` : ''
        const visual = imgSrc
          ? `<img src="${escapeHtml(imgSrc)}" alt="${escapeHtml(c.name)}" loading="lazy">`
          : `<div class="no-img">No image</div>`
        const link = imgSrc ? `<a href="${escapeHtml(imgSrc)}" target="_blank">${visual}</a>` : visual
        return `<figure class="card-item">${link}<figcaption>${escapeHtml(c.name)}</figcaption></figure>`
      }).join('')
      return `<div class="type-group">
      <h3 class="type-heading">${escapeHtml(t)}<span class="count">${cards.length}</span></h3>
      <div class="card-grid">${cardsHtml}</div>
    </div>`
    }).join('')

    return `
  <section class="group" id="group-${g}"
           style="--bg:${GROUP_BG[g]};--fg:${GROUP_FG[g]};--accent:${GROUP_ACCENT[g]}">
    <h2 class="group-heading">${GROUP_LABEL[g]}<span class="count">${colorCards.length}</span></h2>
    ${typeSubSections}
  </section>`
  }).join('\n')

  const navHtml = GROUP_ORDER.filter(g => buckets[g].length > 0).map(g =>
    `<a href="#group-${g}" style="--accent:${GROUP_ACCENT[g]}">${GROUP_LABEL[g]} (${buckets[g].length})</a>`
  ).join('')

  const totalCards = parsed.length

  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Card Gallery</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Segoe UI', system-ui, sans-serif; background: #111; color: #eee; min-height: 100vh; }
#site-header { background: #1a1a1a; border-bottom: 2px solid #444; padding: 2rem 2rem 1.5rem; }
#site-header:empty { display: none; }
#color-nav {
  display: flex; flex-wrap: wrap; gap: .5rem;
  padding: 1rem 2rem; background: #181818; border-bottom: 1px solid #333;
  position: sticky; top: 0; z-index: 10;
}
#color-nav a {
  padding: .3rem .85rem; border-radius: 999px;
  border: 2px solid var(--accent); color: var(--accent);
  text-decoration: none; font-size: .85rem; font-weight: 600;
  transition: background .15s, color .15s;
}
#color-nav a:hover { background: var(--accent); color: #111; }
#color-nav .total { margin-left: auto; align-self: center; font-size: .85rem; color: #888; }
.group { background: var(--bg); color: var(--fg); padding: 2rem; border-bottom: 3px solid #111; }
.group-heading {
  font-size: 1.6rem; font-weight: 700; margin-bottom: 1.25rem; padding-bottom: .5rem;
  border-bottom: 2px solid var(--accent); display: flex; align-items: baseline; gap: .75rem;
}
.group-heading .count { font-size: 1rem; font-weight: 400; opacity: .7; }
.type-group { margin-bottom: 1.75rem; }
.type-group:last-child { margin-bottom: 0; }
.type-heading {
  font-size: 1.1rem; font-weight: 600; margin-bottom: .85rem;
  padding-left: .5rem; border-left: 3px solid var(--accent);
  display: flex; align-items: baseline; gap: .6rem; opacity: .9;
}
.type-heading .count { font-size: .85rem; font-weight: 400; opacity: .65; }
.card-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.25rem; }
.card-item { display: flex; flex-direction: column; align-items: center; gap: .5rem; }
.card-item a { display: block; }
.card-item img {
  width: 100%; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.45);
  transition: transform .15s, box-shadow .15s;
}
.card-item a:hover img { transform: scale(1.04); box-shadow: 0 8px 28px rgba(0,0,0,.6); }
.no-img {
  width: 100%; aspect-ratio: 5/7; background: rgba(0,0,0,.2); border-radius: 8px;
  display: flex; align-items: center; justify-content: center; font-size: .8rem; opacity: .5;
}
figcaption { font-size: .8rem; text-align: center; opacity: .85; word-break: break-word; }
</style>
</head>
<body>
<div id="site-header">${headerHtml}</div>
<nav id="color-nav">
  ${navHtml}
  <span class="total">${totalCards} card${totalCards === 1 ? '' : 's'} total</span>
</nav>
<main>${sectionsHtml}</main>
</body>
</html>`)
})

// ── INTERNAL API app – port 3001 ────────────────────────────────────────────
// Bound to 127.0.0.1 only. Reached via nginx proxy – never via the tunnel.
const apiApp = express()
apiApp.use(express.json({ limit: '50mb' }))

apiApp.get('/api/cards', (req, res) => {
  const rows = db.prepare('SELECT name FROM cards ORDER BY name ASC').all()
  res.json(rows.map(r => r.name))
})

apiApp.get('/api/cards-meta', (req, res) => {
  const rows = db.prepare('SELECT name, image_file FROM cards ORDER BY name ASC').all()
  res.json(rows.map(r => ({ name: r.name, image_file: r.image_file || null })))
})

apiApp.get('/api/cards/:name', (req, res) => {
  const row = db.prepare('SELECT data FROM cards WHERE name = ?').get(req.params.name)
  if (!row) return res.status(404).json({ error: 'Card not found' })
  res.json(JSON.parse(row.data))
})

apiApp.post('/api/cards/:name', (req, res) => {
  const name = req.params.name
  const body = { ...req.body }
  let imageFile = null
  if (body._imageData) {
    const imgBase64 = body._imageData
    delete body._imageData
    const safeName = name.replace(/[/\\?%*:|"<>]/g, '_')
    imageFile = safeName + '.png'
    try {
      fs.writeFileSync(path.join(IMAGES_DIR, imageFile), Buffer.from(imgBase64, 'base64'))
    } catch (err) {
      console.error('Failed to write image:', err)
      imageFile = null
    }
  } else {
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

apiApp.delete('/api/cards/:name', (req, res) => {
  const row = db.prepare('SELECT image_file FROM cards WHERE name = ?').get(req.params.name)
  const info = db.prepare('DELETE FROM cards WHERE name = ?').run(req.params.name)
  if (info.changes === 0) return res.status(404).json({ error: 'Card not found' })
  if (row?.image_file) try { fs.unlinkSync(path.join(IMAGES_DIR, row.image_file)) } catch (_) {}
  res.json({ ok: true })
})

apiApp.delete('/api/cards', (req, res) => {
  const rows = db.prepare('SELECT image_file FROM cards').all()
  db.prepare('DELETE FROM cards').run()
  rows.forEach(r => { if (r.image_file) try { fs.unlinkSync(path.join(IMAGES_DIR, r.image_file)) } catch (_) {} })
  res.json({ ok: true })
})

// ── Start both servers ───────────────────────────────────────────────────────
publicApp.listen(PORT, () => {
  console.log(`Card Conjurer  public gallery   :${PORT}   → /cards  /card-images/`)
})
apiApp.listen(API_PORT, '127.0.0.1', () => {
  console.log(`Card Conjurer  internal API     127.0.0.1:${API_PORT}  → /api/*`)
})
