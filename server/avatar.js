// Generates a stylised 3D-character version of the user's photo with Google Gemini.
// The browser then animates that image exactly like the realistic avatar.
import express from 'express';
import { config } from './config.js';
import { db, now, isSubscribed } from './db.js';
import { msg } from './i18n.js';

const IDENTITY = `The character must be instantly recognizable as this exact person: keep the same face shape, \
skin tone, eye color, eyebrows, nose, hairstyle and hair color, facial hair, glasses and accessories, and similar \
clothing. Keep the same head position, head size, camera framing and pose as the photo: head and shoulders, facing \
the camera and looking straight into the lens, with a neutral relaxed expression, mouth closed and eyes open. \
A single character only. No text, no watermark, no border.`;

export const AVATAR_STYLES = {
  animated: {
    name: '3D Animated',
    prompt: 'a stylized 3D animated movie character with a soft, friendly look: smooth clay-like skin with subtle subsurface scattering, slightly larger expressive eyes, gentle stylized proportions, soft cinematic studio lighting and a simple softly blurred warm indoor background',
  },
  elf: {
    name: 'Fantasy Elf',
    prompt: 'a stylized 3D animated fantasy elf: elegant pointed elf ears, a fantasy forest outfit with subtle glowing details, smooth stylized skin, slightly larger expressive eyes, soft magical lighting and a softly blurred enchanted forest background',
  },
  hero: {
    name: 'Superhero',
    prompt: 'a stylized 3D animated superhero: a sleek colorful superhero suit with an emblem on the chest, a confident look, smooth stylized skin, slightly larger expressive eyes, dramatic cinematic lighting and a softly blurred city skyline background',
  },
  anime: {
    name: 'Anime',
    prompt: 'a character in a polished modern anime film style: clean line art, soft cel shading, large expressive eyes, vibrant colors and a simple softly painted background',
  },
};

const DAY = 24 * 60 * 60 * 1000;
const inFlight = new Set();

async function callGemini(prompt, mimeType, data) {
  const { apiKey, model } = config.gemini;
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ inlineData: { mimeType, data } }, { text: prompt }] }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '3:4' } },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  const image = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!res.ok || !image) {
    const reason = json.error?.message || json.promptFeedback?.blockReason || json.candidates?.[0]?.finishReason || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Gemini returned no image: ${reason}`), { blocked: res.ok });
  }
  return image;
}

export const avatarRouter = express.Router();

avatarRouter.get('/styles', (_req, res) => {
  res.json({
    available: !!config.gemini.apiKey,
    styles: Object.entries(AVATAR_STYLES).map(([id, s]) => ({ id, name: s.name })),
  });
});

avatarRouter.post('/generate', express.json({ limit: '4mb' }), async (req, res) => {
  if (!config.gemini.apiKey) return res.status(503).json({ error: msg(req, 'generation_unavailable') });
  const style = AVATAR_STYLES[req.body?.style] ? req.body.style : 'animated';
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''));
  if (!m) return res.status(400).json({ error: msg(req, 'bad_photo') });

  // Quotas: per visitor (account or IP) per day, plus a site-wide daily cap to protect the API budget.
  const since = now() - DAY;
  const who = req.user ? ['user_id', req.user.id] : ['ip', req.ip];
  const key = `${who[0]}:${who[1]}`;
  const { gemini } = config;
  const total = db.prepare('SELECT COUNT(*) AS n FROM generations WHERE created_at > ?').get(since).n;
  if (total >= gemini.dailyLimit) {
    return res.status(429).json({ error: msg(req, 'daily_cap') });
  }
  const mine = db.prepare(`SELECT COUNT(*) AS n FROM generations WHERE ${who[0]} = ? AND created_at > ?`).get(who[1], since).n;
  const limit = isSubscribed(req.user) ? gemini.subscriberLimit : gemini.freeLimit;
  if (mine >= limit) {
    return res.status(429).json({
      error: msg(req, isSubscribed(req.user) ? 'subscriber_limit' : 'free_limit', { limit }),
      upgrade: !isSubscribed(req.user),
    });
  }
  if (inFlight.has(key)) return res.status(429).json({ error: msg(req, 'generation_in_progress') });

  inFlight.add(key);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO generations (user_id, ip, style, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user?.id ?? null, req.ip, style, now());
  try {
    const prompt = `Turn the person in this photo into ${AVATAR_STYLES[style].prompt}. ${IDENTITY}`;
    const image = await callGemini(prompt, m[1], m[2]);
    res.json({ image: `data:${image.mimeType || 'image/png'};base64,${image.data}`, style });
  } catch (err) {
    // Failed attempts do not count against the visitor's quota.
    db.prepare('DELETE FROM generations WHERE id = ?').run(Number(lastInsertRowid));
    console.error('Avatar generation failed:', err.message);
    res.status(err.blocked ? 422 : 502).json({
      error: msg(req, err.blocked ? 'generation_blocked' : 'generation_failed'),
    });
  } finally {
    inFlight.delete(key);
  }
});
