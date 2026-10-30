import { VISEME_PARAMS, visemeOfPhoneme } from './visemes.js';

// Plays synthesized speech and turns it into mouth movement (jawOpen / wide / pucker).
// With phoneme timings from the voice engine each sound gets its own mouth shape (visemes): lips close
// on m/b/p, round on o/u and widen on i/e. Without them the mouth follows loudness only.

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

// Loudness (0..1 of the loudest moment) every HOP seconds: all that is needed alongside phoneme timings,
// and much cheaper than analyzeSpeech on long texts.
function loudnessTrack(buffer) {
  const data = buffer.getChannelData(0);
  const hop = Math.round(buffer.sampleRate * HOP);
  const frames = Math.max(1, Math.ceil(data.length / hop));
  const track = new Array(frames);
  let peak = 1e-6;
  for (let f = 0; f < frames; f++) {
    // A 30 ms window, so the level doesn't flicker with the voice's pitch.
    let sum = 0;
    const start = Math.max(0, (f - 1) * hop), end = Math.min(data.length, (f + 2) * hop);
    for (let i = start; i < end; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    peak = Math.max(peak, rms);
    track[f] = rms;
  }
  return track.map((rms) => ({ energy: rms / peak }));
}

// Precomputes a viseme-like track from the whole utterance so playback is perfectly in sync
// (used when the voice engine gives no phoneme timings).
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
    // Map loudness (dB relative to the loudest frame) to jaw opening; the curve keeps most syllables
    // moderately open and saves wide opening for the loudest vowels, as in natural speech.
    const db = 20 * Math.log10(level + 1e-6);
    let target = Math.min(1, Math.max(0, (db + 30) / 30)) ** 1.5;
    const voiced = low[f] + mid[f];
    const fricative = high[f] / (voiced + high[f] + 1e-9); // s, sh, f: teeth together
    target *= 1 - 0.6 * fricative;
    // Fast opening, slower closing looks natural.
    jaw += (target - jaw) * (target > jaw ? 0.6 : 0.3);
    const ratio = mid[f] / (low[f] + 1e-9); // high F2 -> "ee" (wide), low F2 -> "oo" (rounded)
    const wide = Math.min(1, Math.max(0, (Math.log10(ratio + 1e-9) + 0.2) * 0.9)) * Math.min(1, jaw * 2.5);
    const pucker = Math.min(1, Math.max(0, (-Math.log10(ratio + 1e-9) - 0.5) * 0.8)) * Math.min(1, jaw * 2.5);
    track[f] = { jawOpen: Math.min(1, jaw * 0.7), wide, pucker, energy: level };
  }
  return track;
}

const smooth = (u) => u * u * (3 - 2 * u);

// Keyframes (time, viseme, strength) from [phoneme, start, duration] triples, plus stressed-syllable times.
function visemeTrack(phonemes) {
  const sounds = [];
  const stresses = [];
  let prev = null;
  for (const [ph, start, dur] of phonemes) {
    if (ph === 'ˈ' || ph === 'ˌ') {
      if (ph === 'ˈ') stresses.push(start + dur);
      continue;
    }
    let v = ph === 'ː' ? prev : visemeOfPhoneme(ph);
    if (ph === ' ' && dur > 0.15) v = ['rest', 1, 'c']; // a real pause between words
    if (!v) continue;
    sounds.push({ id: v[0], s: v[1], kind: v[2], start, dur });
    prev = v;
  }

  const keys = [{ t: 0, id: 'PP', s: 1 }];
  sounds.forEach((snd, i) => {
    let { id, s } = snd;
    const { kind, start, dur } = snd;
    if (kind === 'w') {
      // Coarticulation: during t, k, h... the lips already take the shape of the next vowel.
      const next = sounds.slice(i + 1, i + 3).find((n) => n.kind === 'v' && n.start - (start + dur) < 0.12);
      if (next) [id, s] = [next.id, next.s * 0.6];
    } else if (kind === 'v') {
      // Short vowels don't reach the full shape (undershoot), as in natural fast speech.
      s *= Math.min(1, 0.4 + dur / 0.12);
    }
    if (id === 'rest' || id === 'PP') {
      // Hold closed lips for most of the sound so the closure is actually visible.
      keys.push({ t: start + dur * 0.25, id: 'PP', s: 1 }, { t: start + dur * 0.75, id: 'PP', s: 1 });
    } else if (dur > 0.18) {
      // Long sounds hold their shape instead of passing through it.
      keys.push({ t: start + dur * 0.3, id, s }, { t: start + dur * 0.75, id, s });
    } else {
      keys.push({ t: start + dur / 2, id, s });
    }
  });
  const last = phonemes[phonemes.length - 1];
  keys.push({ t: (last ? last[1] + last[2] : 0) + 0.05, id: 'PP', s: 1 });
  keys.sort((x, y) => x.t - y.t);
  return { keys, stresses };
}

// Mouth parameters of a viseme at a given strength (0 = closed and relaxed).
function paramsOf(id, s) {
  const pp = VISEME_PARAMS.PP, v = VISEME_PARAMS[id] || pp;
  return { jawOpen: pp.jawOpen + (v.jawOpen - pp.jawOpen) * s, wide: pp.wide + (v.wide - pp.wide) * s, pucker: pp.pucker + (v.pucker - pp.pucker) * s };
}

// The mouth at time t: the two visemes being blended (with weights) and equivalent mouth parameters.
function sampleTrack({ keys, stresses }, t, intensity) {
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++;
  const a = keys[i], b = keys[Math.min(i + 1, keys.length - 1)];
  const u = b.t > a.t ? smooth(Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))) : 0;
  const pa = paramsOf(a.id, a.s * intensity), pb = paramsOf(b.id, b.s * intensity);
  const m = {
    jawOpen: pa.jawOpen + (pb.jawOpen - pa.jawOpen) * u,
    wide: pa.wide + (pb.wide - pa.wide) * u,
    pucker: pa.pucker + (pb.pucker - pa.pucker) * u,
    visemes: [[a.id, a.s * intensity * (1 - u)], [b.id, b.s * intensity * u]],
  };
  // A small nod and brow lift on stressed syllables keeps the head alive while talking.
  let nod = 0;
  for (const st of stresses) nod += Math.exp(-(((t - st - 0.06) / 0.12) ** 2));
  m.nod = Math.min(1, nod);
  return m;
}

const base64ToBuffer = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer;

let audioCtx = null;
const ctx = () => (audioCtx ??= new (window.AudioContext || window.webkitAudioContext)());

// Must be called from a user gesture (e.g. the "speak" button) so audio is allowed to play.
export function unlockAudio() {
  const c = ctx();
  if (c.state === 'suspended') c.resume();
}

// An audio output that can be recorded (for making videos): { node, stream, release() }.
// A silent source plays into it for the whole recording: while nothing plays into it, browsers send
// no audio at all, so the recorded sound would start late and drift against the picture.
export function createRecordingDestination() {
  const c = ctx();
  const node = c.createMediaStreamDestination();
  const silence = c.createOscillator();
  const mute = c.createGain();
  mute.gain.value = 0;
  silence.connect(mute).connect(node);
  silence.start();
  return {
    node,
    stream: node.stream,
    release: () => {
      silence.stop();
      silence.disconnect();
      mute.disconnect();
    },
  };
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

  /**
   * Plays speech from the server ({ audio: base64, phonemes }) and resolves when it ends.
   * @param record optional MediaStreamAudioDestinationNode that also receives the sound (for a video)
   * @param onStart called with the duration when playback actually starts
   */
  async play({ audio, phonemes }, { record = null, onStart = null } = {}) {
    this.stop();
    const c = ctx();
    const buffer = await c.decodeAudioData(base64ToBuffer(audio));
    const track = phonemes?.length ? visemeTrack(phonemes) : null;
    const loudness = track ? loudnessTrack(buffer) : analyzeSpeech(buffer);
    const src = c.createBufferSource();
    src.buffer = buffer;
    src.connect(c.destination);
    if (record) src.connect(record);
    const startAt = c.currentTime + 0.05;
    // The speakers play the sound a little late (a lot on some phones), so the mouth waits for it.
    // A recording gets the sound without that delay, so then the mouth must not wait.
    const latency = record ? 0 : c.outputLatency || c.baseLatency || 0;
    return new Promise((resolve) => {
      const handle = {
        stop: () => src.stop(),
        elapsed: () => c.currentTime - startAt,
        mouth: () => {
          // Lead the audio slightly: lips move just before the sound is heard.
          const t = c.currentTime - startAt - latency + 0.05;
          if (t < 0) return null;
          const loud = loudness[Math.min(loudness.length - 1, Math.floor(t / HOP))];
          if (!track) return loud;
          // Louder syllables are articulated fully, quieter ones a little less.
          const m = sampleTrack(track, t, Math.min(1, 0.72 + 0.4 * Math.min(1, loud.energy * 1.4)));
          m.energy = loud.energy;
          return m;
        },
      };
      src.onended = () => {
        if (this.current === handle) this.current = null;
        resolve();
      };
      this.current = handle;
      src.start(startAt);
      onStart?.(buffer.duration);
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

  // Seconds since the current speech started (null when nothing is playing).
  elapsed() {
    return this.current?.elapsed?.() ?? null;
  }
}

export const detectLang = (text) => (/[؀-ۿ]/.test(text) ? 'fa' : 'en');
