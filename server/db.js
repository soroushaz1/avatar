import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'app.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    login          TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    sub_expires_at INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan_id     TEXT NOT NULL,
    days        INTEGER NOT NULL,
    amount_rial INTEGER NOT NULL,
    authority   TEXT UNIQUE,
    status      TEXT NOT NULL DEFAULT 'pending',
    ref_id      TEXT,
    card_pan    TEXT,
    created_at  INTEGER NOT NULL,
    verified_at INTEGER
  );
`);

export function now() {
  return Date.now();
}

export function getUserById(id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

export function getUserByLogin(login) {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(login) || null;
}

export function isSubscribed(user) {
  return !!user && user.sub_expires_at > now();
}

// Extends from the later of "now" and the current expiry, so renewing early never loses days.
export function extendSubscription(userId, days) {
  const user = getUserById(userId);
  const base = Math.max(now(), user.sub_expires_at);
  const expires = base + days * 24 * 60 * 60 * 1000;
  db.prepare('UPDATE users SET sub_expires_at = ? WHERE id = ?').run(expires, userId);
  return expires;
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    login: user.login,
    subscribed: isSubscribed(user),
    subscriptionExpiresAt: user.sub_expires_at || null,
  };
}
