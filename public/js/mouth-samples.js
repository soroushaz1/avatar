// Collects real frames of the user's mouth at different openings while they talk to the camera.
// The realistic avatar replays these frames when it reads text, instead of painting a mouth.

// Lip gap (inner-lip distance / mouth width) boundaries; one frame is kept per bin.
const BIN_EDGES = [0.04, 0.1, 0.17, 0.25, 0.34, 0.44];
export const BIN_COUNT = BIN_EDGES.length + 1;
const CROP_SIZE = 448;
const STORE_KEY = 'avatar.mouths';

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function lipGap(landmarks, W, H) {
  const P = (i) => [landmarks[i].x * W, landmarks[i].y * H];
  return dist(P(13), P(14)) / Math.max(1, dist(P(78), P(308)));
}

const binOf = (gap) => {
  const i = BIN_EDGES.findIndex((edge) => gap < edge);
  return i < 0 ? BIN_EDGES.length : i;
};

export class MouthSamples {
  constructor() {
    this.bins = new Array(BIN_COUNT).fill(null);
    this.lastGrab = 0;
    this.version = 0;
  }

  get count() {
    return this.bins.filter(Boolean).length;
  }

  // Enough variety to speak: a closed mouth plus a few clearly open ones.
  get ready() {
    return !!this.bins[0] && this.count >= 4 && this.bins.some((s, i) => s && i >= 3);
  }

  list() {
    return this.bins.filter(Boolean);
  }

  clear() {
    this.bins.fill(null);
    this.version++;
    try { localStorage.removeItem(STORE_KEY); } catch { /* storage unavailable */ }
  }

  /**
   * Considers the current video frame. Keeps it when it fills an empty opening bin or is more
   * straight-on than the frame already kept there. Returns true when the set changed.
   */
  offer(video, landmarks, p, now) {
    if (now - this.lastGrab < 120) return false;
    if (Math.abs(p.yaw) > 0.22 || Math.abs(p.pitch) > 0.22 || Math.abs(p.roll) > 0.2) return false;
    if (p.blinkA > 0.45 || p.blinkB > 0.45) return false;
    // Keep ordinary speaking shapes only (no pursed lips, big grins or raised brows).
    if (p.pucker > 0.55 || p.smile > 0.6 || p.browUp > 0.6) return false;
    const W = video.videoWidth, H = video.videoHeight;
    if (!W || !H) return false;
    const gap = lipGap(landmarks, W, H);
    const bin = binOf(gap);
    const quality = 1 - (Math.abs(p.yaw) + Math.abs(p.pitch) + Math.abs(p.roll));
    const current = this.bins[bin];
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
    this.bins[bin] = { canvas, landmarks: local, gap, quality };
    this.version++;
    return true;
  }

  save() {
    const data = this.bins.map((s) => s && {
      img: s.canvas.toDataURL('image/jpeg', 0.85),
      landmarks: s.landmarks.map((q) => [+q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5)]),
      gap: s.gap,
      quality: s.quality,
    });
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
    } catch {
      console.warn('Could not save mouth samples in this browser');
    }
  }

  async restore() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    } catch { /* ignore broken data */ }
    if (!Array.isArray(data) || data.length !== BIN_COUNT) return;
    await Promise.all(data.map(async (d, i) => {
      if (!d) return;
      try {
        const img = await loadImage(d.img);
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        this.bins[i] = { canvas, landmarks: d.landmarks.map(([x, y, z]) => ({ x, y, z })), gap: d.gap, quality: d.quality };
      } catch { /* skip a broken sample */ }
    }));
    this.version++;
  }
}

const loadImage = (src) => new Promise((resolve, reject) => {
  const img = new Image();
  img.onload = () => resolve(img);
  img.onerror = reject;
  img.src = src;
});

// A sample made from a still image (e.g. a generated character with its mouth open).
export function sampleFromImage(canvas, landmarks) {
  return { canvas, landmarks, gap: lipGap(landmarks, canvas.width, canvas.height) };
}

export function saveSampleList(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list.map((s) => ({
      img: s.canvas.toDataURL('image/jpeg', 0.85),
      landmarks: s.landmarks.map((q) => [+q.x.toFixed(5), +q.y.toFixed(5), +q.z.toFixed(5)]),
    }))));
  } catch {
    console.warn('Could not save mouth samples in this browser');
  }
}

export async function loadSampleList(key) {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(key) || 'null');
  } catch { /* ignore broken data */ }
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const d of data) {
    try {
      const img = await loadImage(d.img);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      out.push(sampleFromImage(canvas, d.landmarks.map(([x, y, z]) => ({ x, y, z }))));
    } catch { /* skip a broken sample */ }
  }
  return out;
}
