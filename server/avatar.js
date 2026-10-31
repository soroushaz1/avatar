// Generates a stylised 3D-character version of the user's photo with Google Gemini, plus copies of
// that character with the mouth in each speech shape (viseme), so it talks with a real-looking mouth.
// The browser then animates these images exactly like the realistic avatar.
import express from 'express';
import sharp from 'sharp';
import { config } from './config.js';
import { db, now, isSubscribed } from './db.js';
import { msg } from './i18n.js';
import { normalizeLogin } from './auth.js';
import { saveCharacter } from './characters.js';
import { uploadedBody } from './uploads.js';

const identity = (who) => `${who} must be instantly recognizable as this exact person: keep the same face shape, \
skin tone, eye color, eyebrows, nose, lips, hairstyle and hair color, facial hair and similar clothing. Show only \
what the person actually wears in the photo and add nothing: glasses only if the person wears glasses in the photo \
(then the same glasses), otherwise no eyeglasses, sunglasses or goggles at all, and no hats, masks, jewelry or \
face paint that are not in the photo.`;

// Selfies are often tilted, off-centre or cut off by the edge of the picture; the avatar needs the whole head.
const COMPOSE = `Compose the picture as a centered head-and-shoulders portrait: the head upright (not tilted) and \
turned straight towards the camera, looking straight into the lens, the whole head and all of the hair inside the \
picture with a little space above it, and the shoulders visible. If any part of the head, hair, ears, neck or \
shoulders is cut off by the edge of the photo or hidden, complete it naturally and plausibly so it matches the \
rest. The expression is neutral and relaxed, with the mouth closed and the eyes open. A single person only. \
No text, no watermark, no border.`;

// The realistic avatar from an incomplete or tilted photo: the same photo, completed and straightened.
const COMPLETE_PROMPT = `Recreate this photo as a photorealistic portrait photograph of the same person. It must \
look like a real, unedited camera photo (not a drawing, painting or 3D render) with the same lighting, colors, \
skin texture and a similar background. ${identity('The person')} ${COMPOSE}`;

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

// The same character with the mouth in each viseme (see public/js/visemes.js); the browser morphs
// between them in time with the speech. The closed-mouth character itself is the "m/b/p" shape.
const KEEP = `Edit this image and change only the mouth. Keep everything else exactly the same: the same \
character, face, eyes (open, looking straight at the camera), eyebrows, hair, facial hair, clothing, colors, \
lighting, background, camera framing, head position and head size. Do not add or remove anything (no new \
glasses or accessories). The expression stays neutral and relaxed, as in the middle of calm, natural speech.`;
const VISEMES = {
  FF: 'The upper front teeth rest lightly on the lower lip, as when saying "f" or "v". The mouth is barely open.',
  SS: 'The lips are slightly parted and a little spread, with the upper and lower teeth together and visible, as when saying "s".',
  E: 'The mouth is half open as when saying "eh" in "bed": lips relaxed, upper teeth visible, a little of the tongue.',
  AA: 'The mouth is open as when saying "a" in "cat": the jaw lowered moderately, upper teeth and some lower teeth visible, the tongue low.',
  AW: 'The mouth is open wide as when saying "ah" in "father": the jaw dropped, lips slightly rounded, upper teeth and the tongue visible.',
  I: 'The lips are spread wide and pulled back towards the cheeks, with the teeth almost together and visible, as when saying "ee" in "see". Not a smile: the eyes and cheeks stay relaxed.',
  O: 'The lips are rounded into an "o" shape, open in the middle, as when saying "oh" in "go".',
  U: 'The lips are pushed forward and rounded into a small, tight circle, as when saying "oo" in "food".',
};

const DAY = 24 * 60 * 60 * 1000;
const inFlight = new Set();
const unlimitedLogins = new Set(config.gemini.unlimitedLogins.map(normalizeLogin).filter(Boolean));

async function callGemini(prompt, mimeType, data) {
  const { apiKey, model, apiBase } = config.gemini;
  const res = await fetch(`${apiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
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
  return { mimeType: image.mimeType || 'image/png', data: image.data };
}

// Gemini returns ~1.5 MB PNGs; JPEG is about ten times smaller to download, which matters on slow links.
async function asJpegDataUrl(image) {
  try {
    const jpeg = await sharp(Buffer.from(image.data, 'base64')).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  } catch {
    return `data:${image.mimeType};base64,${image.data}`;
  }
}

// The character with the mouth in each viseme: [{ id, image }]. Shapes Gemini refuses or fails on are
// skipped (the browser uses the closest shape it has instead).
async function visemeImages(image) {
  const ids = Object.keys(VISEMES);
  const results = await Promise.allSettled(ids.map((id) => callGemini(`${KEEP} ${VISEMES[id]}`, image.mimeType, image.data)));
  const out = [];
  for (const [i, r] of results.entries()) {
    if (r.status === 'fulfilled') out.push({ id: ids[i], image: await asJpegDataUrl(r.value) });
    else console.error(`Mouth shape ${ids[i]} failed:`, r.reason.message);
  }
  return out;
}

const parseImage = (value) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
  return m && { mimeType: m[1], data: m[2] };
};

// Daily quotas per visitor (account or IP) and for the whole site, to protect the API budget; accounts in
// AVATAR_UNLIMITED_LOGINS have none. Runs the job when allowed; a failed job does not count.
async function withQuota(req, res, style, job) {
  if (!config.gemini.apiKey) return res.status(503).json({ error: msg(req, 'generation_unavailable') });
  const since = now() - DAY;
  const who = req.user ? ['user_id', req.user.id] : ['ip', req.ip];
  const key = `${who[0]}:${who[1]}`;
  const { gemini } = config;
  if (!unlimitedLogins.has(req.user?.login)) {
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
  }
  if (inFlight.has(key)) return res.status(429).json({ error: msg(req, 'generation_in_progress') });

  inFlight.add(key);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO generations (user_id, ip, style, created_at) VALUES (?, ?, ?, ?)')
    .run(req.user?.id ?? null, req.ip, style, now());
  try {
    res.json(await job());
  } catch (err) {
    db.prepare('DELETE FROM generations WHERE id = ?').run(Number(lastInsertRowid));
    console.error('Avatar generation failed:', err.message);
    res.status(err.blocked ? 422 : 502).json({
      error: msg(req, err.blocked ? 'generation_blocked' : 'generation_failed'),
    });
  } finally {
    inFlight.delete(key);
  }
}

export const avatarRouter = express.Router();

avatarRouter.get('/styles', (_req, res) => {
  res.json({
    available: !!config.gemini.apiKey,
    styles: Object.entries(AVATAR_STYLES).map(([id, s]) => ({ id, name: s.name })),
  });
});

// Photo -> character, plus its mouth shapes (one quota unit).
avatarRouter.post('/generate', express.json({ limit: '4mb' }), uploadedBody, async (req, res) => {
  const style = AVATAR_STYLES[req.body?.style] ? req.body.style : 'animated';
  const photo = parseImage(req.body?.image);
  if (!photo) return res.status(400).json({ error: msg(req, 'bad_photo') });
  await withQuota(req, res, style, async () => {
    const prompt = `Turn the person in this photo into ${AVATAR_STYLES[style].prompt}. ${identity('The character')} ${COMPOSE}`;
    const character = await callGemini(prompt, photo.mimeType, photo.data);
    const [image, visemes] = await Promise.all([asJpegDataUrl(character), visemeImages(character)]);
    // Kept in the user's account, to be used again later.
    const id = req.user
      ? await saveCharacter(req.user.id, { style, mirrored: !!req.body.mirrored, image, visemes }).catch((err) => {
        console.error('Saving a character failed:', err.message);
        return null;
      })
      : null;
    return { image, visemes, style, id };
  });
});

// Mouth shapes for a character made before they existed (one quota unit).
avatarRouter.post('/mouths', express.json({ limit: '4mb' }), uploadedBody, async (req, res) => {
  const character = parseImage(req.body?.image);
  if (!character) return res.status(400).json({ error: msg(req, 'bad_photo') });
  await withQuota(req, res, 'mouths', async () => ({ visemes: await visemeImages(character) }));
});

// A photo with part of the head cut off, or a tilted head, made complete and straight for the realistic avatar
// (one quota unit).
avatarRouter.post('/complete', express.json({ limit: '4mb' }), uploadedBody, async (req, res) => {
  const photo = parseImage(req.body?.image);
  if (!photo) return res.status(400).json({ error: msg(req, 'bad_photo') });
  await withQuota(req, res, 'complete', async () => ({
    image: await asJpegDataUrl(await callGemini(COMPLETE_PROMPT, photo.mimeType, photo.data)),
  }));
});
