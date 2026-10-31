// Large request bodies (photos, characters) are uploaded in small pieces: on some connections a long
// upload stalls and never arrives, while short requests get through. The pieces are kept in memory for
// a few minutes; the real request then names the upload instead of carrying the body.
import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from './ratelimit.js';
import { msg } from './i18n.js';

const TTL = 10 * 60 * 1000;
const MAX_SIZE = 8 * 1024 * 1024;
const MAX_PART = 64 * 1024;
const MAX_PARTS = 4000;

const uploads = new Map(); // id -> { owner, parts, size, expires }
const ownerOf = (req) => (req.user ? `u${req.user.id}` : `ip${req.ip}`);

setInterval(() => {
  const now = Date.now();
  for (const [id, u] of uploads) if (u.expires < now) uploads.delete(id);
}, 60 * 1000).unref();

export const uploadsRouter = express.Router();
uploadsRouter.use(express.json({ limit: '160kb' }));

uploadsRouter.post('/', rateLimit({ windowMs: 10 * 60 * 1000, max: 60 }), (req, res) => {
  const id = crypto.randomUUID();
  uploads.set(id, { owner: ownerOf(req), parts: [], size: 0, expires: Date.now() + TTL });
  res.json({ id });
});

uploadsRouter.post('/:id/:index', rateLimit({ windowMs: 10 * 60 * 1000, max: 3000 }), (req, res) => {
  const u = uploads.get(req.params.id);
  if (!u || u.owner !== ownerOf(req)) return res.status(404).json({ error: msg(req, 'not_found') });
  const index = Number(req.params.index);
  const data = req.body?.data;
  if (!Number.isInteger(index) || index < 0 || index >= MAX_PARTS || typeof data !== 'string' || data.length > MAX_PART) {
    return res.status(400).json({ error: msg(req, 'bad_photo') });
  }
  // A piece sent again (a retry) replaces the earlier one.
  u.size += data.length - (u.parts[index]?.length || 0);
  if (u.size > MAX_SIZE) {
    uploads.delete(req.params.id);
    return res.status(413).json({ error: msg(req, 'bad_photo') });
  }
  u.parts[index] = data;
  u.expires = Date.now() + TTL;
  res.json({ ok: true });
});

// For routes that accept { uploadId } in place of their JSON body: puts the uploaded body in req.body.
export function uploadedBody(req, res, next) {
  const id = req.body?.uploadId;
  if (!id) return next();
  const u = uploads.get(String(id));
  if (!u || u.owner !== ownerOf(req)) return res.status(400).json({ error: msg(req, 'bad_photo') });
  uploads.delete(String(id));
  const parts = Array.from(u.parts);
  if (parts.some((p) => p === undefined)) return res.status(400).json({ error: msg(req, 'bad_photo') });
  try {
    req.body = JSON.parse(parts.join(''));
  } catch {
    return res.status(400).json({ error: msg(req, 'bad_photo') });
  }
  next();
}
