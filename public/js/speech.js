// Plays synthesized speech and turns the audio into mouth movement (jawOpen / wide / pucker).

const HOP = 0.01; // analysis frame step in seconds

// In-place radix-2 FFT (re, im have power-of-two length).
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// Precomputes a viseme-like track from the whole utterance so playback is perfectly in sync.
export function analyzeSpeech(buffer) {
  const data = buffer.getChannelData(0);
  const sr = buffer.sampleRate;
  const N = 1024;
  const hop = Math.round(sr * HOP);
  const frames = Math.max(1, Math.ceil(data.length / hop));
  const re = new Float32Array(N), im = new Float32Array(N);
  const win = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  const bin = (hz) => Math.min(N / 2 - 1, Math.round((hz / sr) * N));
  const bands = [[bin(250), bin(900)], [bin(900), bin(2600)], [bin(3000), bin(7500)]];

  const rms = new Float32Array(frames);
  const low = new Float32Array(frames), mid = new Float32Array(frames), high = new Float32Array(frames);
  let peak = 1e-6;
  for (let f = 0; f < frames; f++) {
    const start = f * hop - N / 2;
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const s = data[start + i] || 0;
      re[i] = s * win[i];
      im[i] = 0;
      sum += s * s;
    }
    rms[f] = Math.sqrt(sum / N);
    peak = Math.max(peak, rms[f]);
    fft(re, im);
    const energy = ([a, b]) => {
      let e = 0;
      for (let k = a; k < b; k++) e += re[k] * re[k] + im[k] * im[k];
      return e / Math.max(1, b - a);
    };
    low[f] = energy(bands[0]);
    mid[f] = energy(bands[1]);
    high[f] = energy(bands[2]);
  }

  const track = new Array(frames);
  let jaw = 0;
  for (let f = 0; f < frames; f++) {
    const level = rms[f] / peak;
    // Map loudness (dB relative to the loudest frame) to jaw opening.
    const db = 20 * Math.log10(level + 1e-6);
    let target = Math.min(1, Math.max(0, (db + 32) / 30));
    const voiced = low[f] + mid[f];
    const fricative = high[f] / (voiced + high[f] + 1e-9); // s, sh, f: teeth together
    target *= 1 - 0.6 * fricative;
    // Fast opening, slower closing looks natural.
    jaw += (target - jaw) * (target > jaw ? 0.6 : 0.3);
    const ratio = mid[f] / (low[f] + 1e-9); // high F2 -> "ee" (wide), low F2 -> "oo" (rounded)
    const wide = Math.min(1, Math.max(0, (Math.log10(ratio + 1e-9) + 0.2) * 0.9)) * Math.min(1, jaw * 2.5);
    const pucker = Math.min(1, Math.max(0, (-Math.log10(ratio + 1e-9) - 0.5) * 0.8)) * Math.min(1, jaw * 2.5);
    track[f] = { jawOpen: Math.min(1, jaw * 0.85), wide, pucker, energy: level };
  }
  return track;
}

let audioCtx = null;
const ctx = () => (audioCtx ??= new (window.AudioContext || window.webkitAudioContext)());

// Must be called from a user gesture (e.g. the "speak" button) so audio is allowed to play.
export function unlockAudio() {
  const c = ctx();
  if (c.state === 'suspended') c.resume();
}

export class Speaker {
  constructor() {
    this.current = null;
  }

  get speaking() {
    return !!this.current;
  }

  stop() {
    if (!this.current) return;
    try { this.current.stop(); } catch { /* already stopped */ }
    this.current = null;
  }

  // Plays a WAV/MP3 ArrayBuffer and resolves when playback ends.
  async playAudio(arrayBuffer) {
    this.stop();
    const c = ctx();
    const buffer = await c.decodeAudioData(arrayBuffer);
    const track = analyzeSpeech(buffer);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    const startAt = c.currentTime + 0.05;
    const latency = (c.outputLatency || c.baseLatency || 0);
    return new Promise((resolve) => {
      const handle = {
        stop: () => src.stop(),
        mouth: () => {
          // Lead the audio slightly: lips move just before the sound is heard.
          const t = c.currentTime - startAt - latency + 0.04;
          if (t < 0) return null;
          return track[Math.min(track.length - 1, Math.floor(t / HOP))];
        },
      };
      src.onended = () => {
        if (this.current === handle) this.current = null;
        resolve();
      };
      this.current = handle;
      src.start(startAt);
    });
  }

  // Fallback: the browser's own speech engine (no audio access, so the mouth is procedural).
  speakWithBrowser(text, lang) {
    this.stop();
    return new Promise((resolve, reject) => {
      if (!window.speechSynthesis) return reject(new Error('speechSynthesis unsupported'));
      const u = new SpeechSynthesisUtterance(text);
      u.lang = lang === 'fa' ? 'fa-IR' : 'en-US';
      const voice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(lang));
      if (voice) u.voice = voice;
      const t0 = performance.now();
      let burst = 0;
      u.onboundary = () => { burst = performance.now(); };
      const handle = {
        stop: () => speechSynthesis.cancel(),
        mouth: () => {
          const t = (performance.now() - t0) / 1000;
          const sinceWord = (performance.now() - burst) / 1000;
          const syllable = Math.abs(Math.sin(t * Math.PI * 4.2)) * (0.6 + 0.4 * Math.sin(t * 2.3));
          const jawOpen = Math.max(0.05, syllable * (sinceWord < 0.5 ? 0.7 : 0.45));
          return { jawOpen, wide: 0.2 + 0.2 * Math.sin(t * 3.1), pucker: Math.max(0, Math.sin(t * 1.7)) * 0.3, energy: jawOpen };
        },
      };
      u.onend = () => {
        if (this.current === handle) this.current = null;
        resolve();
      };
      u.onerror = (e) => {
        if (this.current === handle) this.current = null;
        e.error === 'canceled' || e.error === 'interrupted' ? resolve() : reject(e);
      };
      this.current = handle;
      speechSynthesis.speak(u);
    });
  }

  mouth() {
    return this.current?.mouth() ?? null;
  }
}

export const detectLang = (text) => (/[؀-ۿ]/.test(text) ? 'fa' : 'en');
