// Images of a face with the mouth in each viseme shape (see visemes.js):
// - for the realistic avatar, real webcam frames kept while the user reads a sentence aloud;
// - for the 3D character, the Gemini-made images (saved/loaded with saveSampleSet/loadSampleSet).
import { VISEME_IDS, visemeOfBlendshapes } from './visemes.js';

const CROP_SIZE = 448;
const STORE_KEY = 'avatar.visemes';
// How many of the shapes the realistic avatar needs before it can read text.
export const SAMPLES_NEEDED = 6;

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

async function canvasFrom(src) {
  const img = await loadImage(src);
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas;
}

const serialize = (s) => ({
  img: s.canvas.toDataURL('image/jpeg', 0.85),
  landmarks: s.landmarks.map((q) => [+q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5)]),
  quality: s.quality,
});

async function deserialize(d) {
  return { canvas: await canvasFrom(d.img), landmarks: d.landmarks.map(([x, y, z]) => ({ x, y, z })), quality: d.quality };
}

export function saveSampleSet(key, set) {
  const data = Object.fromEntries(Object.entries(set).map(([id, s]) => [id, serialize(s)]));
  try {
    localStorage.setItem(key, JSON.stringify(data));
    return true;
  } catch {
    console.warn('Could not save mouth images in this browser');
    return false;
  }
}

export async function loadSampleSet(key) {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(key) || 'null');
  } catch { /* ignore broken data */ }
  if (!data || Array.isArray(data) || typeof data !== 'object') return {};
  const set = {};
  await Promise.all(Object.entries(data).map(async ([id, d]) => {
    if (!VISEME_IDS.includes(id)) return;
    try {
      set[id] = await deserialize(d);
    } catch { /* skip a broken image */ }
  }));
  return set;
}

// Real frames of the user's mouth, one per viseme, collected from the webcam.
export class MouthSamples {
  constructor() {
    this.set = {};
    this.lastGrab = 0;
    this.version = 0;
  }

  get count() {
    return Object.keys(this.set).length;
  }

  get ready() {
    return this.count >= SAMPLES_NEEDED;
  }

  clear() {
    this.set = {};
    this.version++;
    try {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem('avatar.mouths'); // older format
    } catch { /* storage unavailable */ }
  }

  /**
   * Considers the current video frame: when the mouth shows a viseme that is missing, or shows it
   * from a straighter angle than the frame already kept, the frame is kept. Returns true on change.
   * @param shapes MediaPipe blendshape scores by name
   * @param forced the viseme the user was asked to show, when the frame should count as that one
   */
  offer(video, landmarks, shapes, p, now, forced = null) {
    if (now - this.lastGrab < 100) return false;
    if (Math.abs(p.yaw) > 0.22 || Math.abs(p.pitch) > 0.22 || Math.abs(p.roll) > 0.2) return false;
    if (p.blinkA > 0.45 || p.blinkB > 0.45 || p.browUp > 0.6) return false;
    const id = forced || visemeOfBlendshapes(shapes);
    if (!id) return false;
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return false;
    const quality = 1 - (Math.abs(p.yaw) + Math.abs(p.pitch) + Math.abs(p.roll));
    const current = this.set[id];
    if (current && current.quality >= quality - 0.03) return false;
    this.lastGrab = now;

    // Head-and-shoulders crop around the face, so the frame covers what the avatar shows.
    const xs = landmarks.map((q) => q.x * W), ys = landmarks.map((q) => q.y * H);
    const faceH = Math.max(...ys) - Math.min(...ys);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2 + faceH * 0.3;
    const size = faceH * 3.2;
    const cw = Math.min(W, size), ch = Math.min(H, size);
    const x0 = Math.min(W - cw, Math.max(0, cx - cw / 2)), y0 = Math.min(H - ch, Math.max(0, cy - ch / 2));
    const scale = Math.min(1, CROP_SIZE / Math.max(cw, ch));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(cw * scale);
    canvas.height = Math.round(ch * scale);
    canvas.getContext('2d').drawImage(video, x0, y0, cw, ch, 0, 0, canvas.width, canvas.height);
    const local = landmarks.slice(0, 468).map((q) => ({ x: (q.x * W - x0) / cw, y: (q.y * H - y0) / ch, z: (q.z * W) / cw }));
    this.set[id] = { canvas, landmarks: local, quality };
    this.version++;
    return true;
  }

  save() {
    saveSampleSet(STORE_KEY, this.set);
  }

  async restore() {
    this.set = await loadSampleSet(STORE_KEY);
    this.version++;
  }
}
