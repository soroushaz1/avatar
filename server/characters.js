// The 3D characters a user has made, kept on the server so they can be used again later (also on
// another device). Images live in DATA_DIR/characters/<id>/: the character, a thumbnail and one image
// per mouth shape. Only the owner can see them: they show the user's likeness.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import sharp from 'sharp';
import { config } from './config.js';
import { db, now } from './db.js';
import { requireUser } from './auth.js';
import { msg } from './i18n.js';
import { uploadedBody } from './uploads.js';

// Each user keeps their most recent characters; older ones are removed (about 1 MB each).
const KEEP = 30;
const VISEME_IDS = ['FF', 'SS', 'E', 'AA', 'AW', 'I', 'O', 'U'];
const DIR = path.join(config.dataDir, 'characters');

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    style      TEXT NOT NULL,
    mirrored   INTEGER NOT NULL DEFAULT 0,
    visemes    TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS characters_user ON characters(user_id, created_at);
`);

const dataUrlBuffer = (value) => {
  const m = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  return m && Buffer.from(m[1], 'base64');
};

const jpeg = (input, width) => {
  const img = sharp(input);
  return (width ? img.resize({ width }) : img).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
};

async function removeFiles(id) {
  await fs.rm(path.join(DIR, String(id)), { recursive: true, force: true });
}

/**
 * Saves a character for a user and returns its id (images are re-encoded, so only real images are kept).
 * @param image data URL of the character; visemes [{ id, image }] of its mouth shapes
 */
export async function saveCharacter(userId, { style, mirrored, image, visemes }) {
  const base = dataUrlBuffer(image);
  if (!base) throw new Error('bad image');
  const mouths = (visemes || []).filter((v) => VISEME_IDS.includes(v.id) && dataUrlBuffer(v.image));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO characters (user_id, style, mirrored, visemes, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, String(style).slice(0, 40), mirrored ? 1 : 0, JSON.stringify(mouths.map((v) => v.id)), now());
  const id = Number(lastInsertRowid);
  const dir = path.join(DIR, String(id));
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'base.jpg'), await jpeg(base));
    await fs.writeFile(path.join(dir, 'thumb.jpg'), await jpeg(base, 160));
    for (const v of mouths) await fs.writeFile(path.join(dir, `${v.id}.jpg`), await jpeg(dataUrlBuffer(v.image)));
  } catch (err) {
    db.prepare('DELETE FROM characters WHERE id = ?').run(id);
    await removeFiles(id);
    throw err;
  }
  // Keep only the most recent ones.
  const old = db.prepare('SELECT id FROM characters WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?').all(userId, KEEP);
  for (const row of old) {
    db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);
    await removeFiles(row.id);
  }
  return id;
}

const imageUrl = (id, name) => `/api/characters/${id}/${name}.jpg`;

function describe(row) {
  return {
    id: row.id,
    style: row.style,
    mirrored: !!row.mirrored,
    createdAt: row.created_at,
    thumb: imageUrl(row.id, 'thumb'),
    image: imageUrl(row.id, 'base'),
    visemes: JSON.parse(row.visemes).map((v) => ({ id: v, image: imageUrl(row.id, v) })),
  };
}

const ownCharacter = (req) => db.prepare('SELECT * FROM characters WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);

export const charactersRouter = express.Router();
charactersRouter.use(requireUser);

charactersRouter.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM characters WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(req.user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ characters: rows.map(describe), keep: KEEP });
});

// A character made before it could be kept on the server (or by a visitor who logged in later).
charactersRouter.post('/', express.json({ limit: '12mb' }), uploadedBody, async (req, res) => {
  try {
    const id = await saveCharacter(req.user.id, req.body || {});
    res.json({ character: describe(db.prepare('SELECT * FROM characters WHERE id = ?').get(id)) });
  } catch (err) {
    console.error('Saving a character failed:', err.message);
    res.status(400).json({ error: msg(req, 'bad_photo') });
  }
});

charactersRouter.get('/:id/:name.jpg', (req, res) => {
  const row = ownCharacter(req);
  const name = req.params.name;
  if (!row || !(name === 'base' || name === 'thumb' || JSON.parse(row.visemes).includes(name))) {
    return res.status(404).json({ error: msg(req, 'not_found') });
  }
  // Private to the owner; the files never change.
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.sendFile(path.join(DIR, String(row.id), `${name}.jpg`), (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: msg(req, 'not_found') });
  });
});

charactersRouter.delete('/:id', async (req, res) => {
  const row = ownCharacter(req);
  if (!row) return res.status(404).json({ error: msg(req, 'not_found') });
  db.prepare('DELETE FROM characters WHERE id = ?').run(row.id);
  await removeFiles(row.id);
  res.json({ ok: true });
});
