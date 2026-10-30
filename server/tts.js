import { spawn } from 'node:child_process';
import express from 'express';
import { config } from './config.js';
import { isSubscribed } from './db.js';
import { requireUser } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { msg } from './i18n.js';

export const ttsRouter = express.Router();

// Sentences anyone may hear, so visitors can try the talking avatar before subscribing.
export const DEMO_TEXTS = {
  fa: 'سلام! من آواتار شما هستم. با اشتراک، هر متنی را که بنویسید با صدای طبیعی می‌خوانم و می‌توانید ویدیوی آن را دانلود کنید.',
  en: 'Hi! I am your avatar. With a subscription, I can read any text you write in a natural voice, and you can download it as a video.',
};

// WAV -> MP3 (about ten times smaller, which matters on slow connections). Falls back to WAV.
function toMp3(wav) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(wav);
  });
}

// Speech plus the timing of every phoneme ([phoneme, start s, duration s]) for lip-sync.
async function synthesize(text, voice, speed) {
  const r = await fetch(`${config.tts.url}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed, alignments: true }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw Object.assign(new Error('tts failed'), { status: r.status === 404 ? 400 : 502, key: err.error === 'unknown voice' ? 'unknown_voice' : 'tts_failed' });
  }
  const data = await r.json();
  const wav = Buffer.from(data.wav, 'base64');
  let t = 0;
  const phonemes = data.phonemes.map(([p, n]) => {
    const item = [p, +(t / data.sample_rate).toFixed(4), +(n / data.sample_rate).toFixed(4)];
    t += n;
    return item;
  });
  const mp3 = await toMp3(wav);
  return {
    audio: (mp3 || wav).toString('base64'),
    mime: mp3 ? 'audio/mpeg' : 'audio/wav',
    phonemes,
  };
}

async function respond(req, res, text, voice, speed) {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await synthesize(text, voice, speed));
  } catch (err) {
    if (err.key) return res.status(err.status).json({ error: msg(req, err.key) });
    // The client falls back to the browser's own speech engine on 503.
    res.status(503).json({ error: msg(req, 'tts_unavailable'), fallback: true });
  }
}

ttsRouter.get('/voices', async (_req, res) => {
  try {
    res.json({ voices: await listVoices(), available: true, demo: DEMO_TEXTS });
  } catch {
    res.json({ voices: [], available: false, demo: DEMO_TEXTS });
  }
});

function requireSubscription(req, res, next) {
  if (!isSubscribed(req.user)) {
    return res.status(402).json({ error: msg(req, 'subscription_required') });
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
    if (!text) return res.status(400).json({ error: msg(req, 'empty_text') });
    if (text.length > config.tts.maxChars) {
      return res.status(400).json({ error: msg(req, 'text_too_long', { max: config.tts.maxChars }) });
    }
    await respond(req, res, text, String(req.body.voice || ''), Number(req.body.speed) || 1);
  },
);

async function listVoices() {
  const r = await fetch(`${config.tts.url}/voices`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`voices: HTTP ${r.status}`);
  return r.json();
}

// The demo sentence, for everyone (cached per voice, since it never changes). Without a voice for the
// requested language, the English sentence is read instead.
const demoCache = new Map();
ttsRouter.post('/demo', rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    let lang = DEMO_TEXTS[req.body?.lang] ? req.body.lang : 'fa';
    const voices = await listVoices();
    let voice = voices.find((v) => v.id === req.body?.voice && v.lang === lang) || voices.find((v) => v.lang === lang);
    if (!voice) {
      lang = 'en';
      voice = voices.find((v) => v.lang === 'en') || voices[0];
    }
    if (!voice) throw new Error('no voices');
    const key = `${lang}:${voice.id}`;
    if (!demoCache.has(key)) demoCache.set(key, await synthesize(DEMO_TEXTS[lang], voice.id, 1));
    res.json(demoCache.get(key));
  } catch (err) {
    if (err.key) return res.status(err.status).json({ error: msg(req, err.key) });
    res.status(503).json({ error: msg(req, 'tts_unavailable'), fallback: true });
  }
});
