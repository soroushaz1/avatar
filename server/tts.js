import express from 'express';
import { config } from './config.js';
import { isSubscribed } from './db.js';
import { requireUser } from './auth.js';
import { rateLimit } from './ratelimit.js';

export const ttsRouter = express.Router();

ttsRouter.get('/voices', async (_req, res) => {
  try {
    const r = await fetch(`${config.tts.url}/voices`, { signal: AbortSignal.timeout(5000) });
    res.json({ voices: await r.json(), available: true });
  } catch {
    res.json({ voices: [], available: false });
  }
});

function requireSubscription(req, res, next) {
  if (!isSubscribed(req.user)) {
    return res.status(402).json({ error: 'This feature requires a subscription.' });
  }
  next();
}

ttsRouter.post(
  '/',
  requireUser,
  requireSubscription,
  rateLimit({ windowMs: 10 * 60 * 1000, max: 40, key: (req) => `u${req.user.id}` }),
  async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'Please enter some text.' });
    if (text.length > config.tts.maxChars) {
      return res.status(400).json({ error: `Text is limited to ${config.tts.maxChars} characters.` });
    }
    try {
      const r = await fetch(`${config.tts.url}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: String(req.body.voice || ''), speed: Number(req.body.speed) || 1 }),
        signal: AbortSignal.timeout(60000),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        return res.status(r.status === 404 ? 400 : 502).json({ error: err.error === 'unknown voice' ? 'That voice is not available.' : 'Speech generation failed.' });
      }
      res.set('Content-Type', 'audio/wav');
      res.set('Cache-Control', 'no-store');
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch {
      // The client falls back to the browser's own speech engine on 503.
      res.status(503).json({ error: 'The text-to-speech service is unavailable.', fallback: true });
    }
  },
);
