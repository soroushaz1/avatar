import { spawn } from 'node:child_process';
import express from 'express';
import { config } from './config.js';
import { isSubscribed } from './db.js';
import { requireUser } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { msg } from './i18n.js';
import { retime } from './align.js';

export const ttsRouter = express.Router();

// Sentences anyone may hear, so visitors can try the talking avatar before subscribing.
export const DEMO_TEXTS = {
  fa: 'سلام! من آواتار شما هستم. با اشتراک، هر متنی را که بنویسید با صدای طبیعی می‌خوانم و می‌توانید ویدیوی آن را دانلود کنید.',
  en: 'Hi! I am your avatar. With a subscription, I can read any text you write in a natural voice, and you can download it as a video.',
};

// Piper voices (free, on this server). Piper has no female Persian voice, so Google's Gemini voices
// (paid per use, about $0.02 per minute of speech) add natural female voices for Persian and English.
const PIPER_VOICES = {
  'fa_IR-amir-medium': { name: 'Amir', gender: 'male' },
  'fa_IR-gyro-medium': { name: 'Gyro', gender: 'male' },
  'en_US-amy-medium': { name: 'Amy', gender: 'female' },
  'en_US-ryan-medium': { name: 'Ryan', gender: 'male' },
};
const GEMINI_PREFIX = 'gemini-';
const GEMINI_VOICES = ['Leda', 'Kore', 'Aoede', 'Zephyr'];

const languageOf = (text) => (/[؀-ۿ]/.test(text) ? 'fa' : 'en');

const fail = (status, key) => Object.assign(new Error(key), { status, key });

// Runs ffmpeg on a buffer; resolves with its output, or null when it fails.
function ffmpeg(input, args) {
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args]);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', () => resolve(null));
    ff.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
    ff.stdin.on('error', () => {});
    ff.stdin.end(input);
  });
}

// WAV or raw PCM -> MP3 (about ten times smaller, which matters on slow connections).
const toMp3 = (input, inputFormat) => ffmpeg(input, [...inputFormat, '-i', 'pipe:0', '-ac', '1', '-b:a', '64k', '-f', 'mp3', 'pipe:1']);

// The samples of a 16-bit mono WAV file.
function wavSamples(wav) {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const id = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4);
    if (id === 'data') return new Int16Array(wav.buffer.slice(wav.byteOffset + offset + 8, wav.byteOffset + offset + 8 + size));
    offset += 8 + size + (size % 2);
  }
  return new Int16Array(0);
}

async function listVoices() {
  const r = await fetch(`${config.tts.url}/voices`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`voices: HTTP ${r.status}`);
  return r.json();
}

// Every voice: { id, langs, name, gender, engine }.
async function allVoices() {
  const piper = (await listVoices()).map((v) => ({
    id: v.id,
    langs: [v.lang],
    name: PIPER_VOICES[v.id]?.name || v.name,
    gender: PIPER_VOICES[v.id]?.gender || '',
    engine: 'piper',
  }));
  const gemini = config.gemini.apiKey
    ? GEMINI_VOICES.map((name) => ({ id: GEMINI_PREFIX + name, langs: ['fa', 'en'], name, gender: 'female', engine: 'gemini' }))
    : [];
  return [...piper, ...gemini];
}

// Piper speech: WAV plus the timing of every phoneme ([phoneme, start s, duration s]).
async function piperSpeech(text, voice, speed) {
  const r = await fetch(`${config.tts.url}/synthesize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, speed, alignments: true }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw fail(r.status === 404 ? 400 : 502, err.error === 'unknown voice' ? 'unknown_voice' : 'tts_failed');
  }
  const data = await r.json();
  let t = 0;
  const phonemes = data.phonemes.map(([p, n]) => {
    const item = [p, +(t / data.sample_rate).toFixed(4), +(n / data.sample_rate).toFixed(4)];
    t += n;
    return item;
  });
  return { wav: Buffer.from(data.wav, 'base64'), rate: data.sample_rate, phonemes };
}

// Gemini speech: raw 16-bit mono PCM.
async function geminiRequest(text, voice) {
  const { apiKey, apiBase, ttsModel } = config.gemini;
  const res = await fetch(`${apiBase}/v1beta/models/${encodeURIComponent(ttsModel)}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  const audio = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (res.ok && audio) return { pcm: Buffer.from(audio.data, 'base64'), rate: Number(/rate=(\d+)/.exec(audio.mimeType || '')?.[1]) || 24000 };
  console.error('Gemini speech failed:', json.error?.message || json.candidates?.[0]?.finishReason || `HTTP ${res.status}`);
  return null;
}

async function geminiSpeech(text, voice) {
  if (!config.gemini.apiKey) throw fail(400, 'unknown_voice');
  // A very short text (a single word) is sometimes taken as a question to answer rather than text to
  // read ("Model tried to generate text"); saying what to do fixes that.
  const spoken = (await geminiRequest(text, voice)) || (await geminiRequest(`Say: ${text}`, voice));
  if (!spoken) throw fail(502, 'tts_failed');
  return spoken;
}

// Speech plus the timing of every phoneme ([phoneme, start s, duration s]) for lip-sync.
async function synthesize(text, voice, speed) {
  if (!voice.startsWith(GEMINI_PREFIX)) {
    const { wav, phonemes } = await piperSpeech(text, voice, speed);
    const mp3 = await toMp3(wav, ['-f', 'wav']);
    return { audio: (mp3 || wav).toString('base64'), mime: mp3 ? 'audio/mpeg' : 'audio/wav', phonemes };
  }

  // Gemini reports no phoneme timings: Piper reads the same text too (in parallel), and its timings are
  // carried over to the Gemini recording by aligning the two (see align.js).
  const name = voice.slice(GEMINI_PREFIX.length);
  if (!GEMINI_VOICES.includes(name)) throw fail(400, 'unknown_voice');
  const lang = languageOf(text);
  const reference = (await listVoices().catch(() => [])).find((v) => v.lang === lang);
  const [spoken, ref] = await Promise.all([
    geminiSpeech(text, name).catch((err) => err),
    reference ? piperSpeech(text, reference.id, 1).catch(() => null) : null,
  ]);
  if (spoken instanceof Error) {
    // Gemini is unavailable: read the text with the server's own voice rather than not at all.
    if (!reference) throw spoken;
    console.error('Gemini speech unavailable; using', reference.id);
    return { ...(await synthesize(text, reference.id, speed)), substitute: true };
  }
  const raw = ['-f', 's16le', '-ar', String(spoken.rate), '-ac', '1'];
  let pcm = spoken.pcm;
  if (Math.abs(speed - 1) > 0.01) {
    pcm = (await ffmpeg(pcm, [...raw, '-i', 'pipe:0', '-af', `atempo=${Math.min(2, Math.max(0.5, speed))}`, ...raw, 'pipe:1'])) || pcm;
  }
  const samples = new Int16Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.length - (pcm.length % 2)));
  const phonemes = ref ? retime(ref.phonemes, wavSamples(ref.wav), ref.rate, samples, spoken.rate) : [];
  const mp3 = await toMp3(pcm, raw);
  if (!mp3) throw fail(502, 'tts_failed');
  return { audio: mp3.toString('base64'), mime: 'audio/mpeg', phonemes };
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
    res.json({ voices: await allVoices(), available: true, demo: DEMO_TEXTS });
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

// The demo sentence, for everyone (cached per voice, since it never changes). Without a voice for the
// requested language, the English sentence is read instead.
const demoCache = new Map();
ttsRouter.post('/demo', rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), async (req, res) => {
  try {
    let lang = DEMO_TEXTS[req.body?.lang] ? req.body.lang : 'fa';
    const voices = await allVoices();
    let voice = voices.find((v) => v.id === req.body?.voice && v.langs.includes(lang))
      || voices.find((v) => v.engine === 'piper' && v.langs.includes(lang));
    if (!voice) {
      lang = 'en';
      voice = voices.find((v) => v.langs.includes('en')) || voices[0];
    }
    if (!voice) throw new Error('no voices');
    const key = `${lang}:${voice.id}`;
    if (!demoCache.has(key)) {
      const speech = await synthesize(DEMO_TEXTS[lang], voice.id, 1);
      if (speech.substitute) return res.json(speech); // not cached: Gemini may answer next time
      demoCache.set(key, speech);
    }
    res.json(demoCache.get(key));
  } catch (err) {
    if (err.key) return res.status(err.status).json({ error: msg(req, err.key) });
    res.status(503).json({ error: msg(req, 'tts_unavailable'), fallback: true });
  }
});
