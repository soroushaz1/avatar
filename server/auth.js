import crypto from 'node:crypto';
import { promisify } from 'node:util';
import express from 'express';
import { config } from './config.js';
import { db, now, getUserById, getUserByLogin, publicUser } from './db.js';
import { rateLimit } from './ratelimit.js';

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE = 'sid';
const SESSION_DAYS = 30;

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 64);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Accepts an email or an Iranian mobile number (Persian/Arabic digits allowed).
export function normalizeLogin(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
       .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254) return s;
  const digits = s.replace(/[\s-]/g, '');
  const m = digits.match(/^(?:\+98|0098|98|0)?(9\d{9})$/);
  if (m) return `0${m[1]}`;
  return null;
}

function setSessionCookie(res, token) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  setSessionCookie(res, token);
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

// Attaches req.user (or null) for every request.
export function sessionMiddleware(req, _res, next) {
  req.user = null;
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const row = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(sha256(token));
    if (row && row.expires_at > now()) req.user = getUserById(row.user_id);
  }
  next();
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please log in first.' });
  next();
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });

export const authRouter = express.Router();

authRouter.post('/register', authLimiter, async (req, res) => {
  const login = normalizeLogin(req.body?.login);
  const password = req.body?.password;
  if (!login) return res.status(400).json({ error: 'Enter a valid email address or mobile number.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (getUserByLogin(login)) return res.status(409).json({ error: 'An account already exists for this login. Please log in.' });

  const hash = await hashPassword(password);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (login, password_hash, created_at) VALUES (?, ?, ?)')
    .run(login, hash, now());
  createSession(res, Number(lastInsertRowid));
  res.json({ user: publicUser(getUserById(Number(lastInsertRowid))) });
});

authRouter.post('/login', authLimiter, async (req, res) => {
  const login = normalizeLogin(req.body?.login);
  const password = req.body?.password;
  const user = login && getUserByLogin(login);
  if (!user || typeof password !== 'string' || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Wrong login or password.' });
  }
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

authRouter.post('/logout', (req, res) => {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Drop expired sessions once an hour.
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()), 60 * 60 * 1000).unref();
