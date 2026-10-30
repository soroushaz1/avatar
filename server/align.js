// Aligns two recordings of the same text spoken by different voices, so phoneme timings known for one
// (Piper reports them) can be carried over to the other (e.g. a Gemini voice, which reports none).
// Features: MFCCs every 10 ms (they describe the sounds, largely independent of the voice), compared
// with dynamic time warping in a band around the diagonal.

const HOP = 0.01;
const WINDOW = 512;
const MEL_BANDS = 26;
const COEFFS = 13; // energy + 12 cepstral coefficients

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

function melFilters(rate) {
  const mel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(80), hi = mel(Math.min(7600, rate / 2));
  const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => hz(lo + ((hi - lo) * i) / (MEL_BANDS + 1)));
  const bin = (f) => (f / rate) * WINDOW;
  return Array.from({ length: MEL_BANDS }, (_, m) => {
    const [a, b, c] = [bin(edges[m]), bin(edges[m + 1]), bin(edges[m + 2])];
    const weights = new Float32Array(WINDOW / 2);
    for (let k = Math.floor(a); k <= Math.ceil(c) && k < WINDOW / 2; k++) {
      weights[k] = Math.max(0, k < b ? (k - a) / (b - a) : (c - k) / (c - b));
    }
    return weights;
  });
}

// MFCC frames of 16-bit mono PCM, each coefficient normalized over the recording (so overall loudness
// and the voice's own timbre matter less).
export function features(samples, rate) {
  const hop = Math.round(rate * HOP);
  const frames = Math.max(1, Math.floor(samples.length / hop));
  const filters = melFilters(rate);
  const win = Float32Array.from({ length: WINDOW }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (WINDOW - 1)));
  const re = new Float32Array(WINDOW), im = new Float32Array(WINDOW);
  const out = Array.from({ length: frames }, () => new Float32Array(COEFFS));
  const logMel = new Float32Array(MEL_BANDS);
  for (let f = 0; f < frames; f++) {
    const start = f * hop - WINDOW / 2;
    for (let i = 0; i < WINDOW; i++) {
      re[i] = (samples[start + i] || 0) * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let m = 0; m < MEL_BANDS; m++) {
      let e = 0;
      const w = filters[m];
      for (let k = 0; k < WINDOW / 2; k++) if (w[k]) e += w[k] * (re[k] * re[k] + im[k] * im[k]);
      logMel[m] = Math.log(e + 1e-3);
    }
    for (let c = 0; c < COEFFS; c++) {
      let sum = 0;
      for (let m = 0; m < MEL_BANDS; m++) sum += logMel[m] * Math.cos((Math.PI * c * (m + 0.5)) / MEL_BANDS);
      out[f][c] = sum;
    }
  }
  for (let c = 0; c < COEFFS; c++) {
    let mean = 0, sq = 0;
    for (const v of out) mean += v[c];
    mean /= frames;
    for (const v of out) sq += (v[c] - mean) ** 2;
    const sd = Math.sqrt(sq / frames) || 1;
    for (const v of out) v[c] = (v[c] - mean) / sd;
  }
  return out;
}

/**
 * Dynamic time warping between two feature sequences, limited to a band around the diagonal.
 * @returns for every frame of `a`, the matching frame of `b` (fractional)
 */
export function warp(a, b) {
  const n = a.length, m = b.length;
  const slope = m / n;
  const band = Math.max(100, Math.round(0.2 * Math.max(n, m)));
  const width = 2 * band + 1;
  const lo = (i) => Math.max(0, Math.round(i * slope) - band);
  const dist = (x, y) => {
    let d = 0;
    for (let c = 0; c < COEFFS; c++) d += (x[c] - y[c]) ** 2;
    return Math.sqrt(d);
  };
  // Cumulative cost of the previous and current row, and the step taken into every cell.
  let prev = new Float64Array(width).fill(Infinity), cur = new Float64Array(width);
  const steps = new Uint8Array(n * width); // 0 diagonal, 1 from above (i-1), 2 from the left (j-1)
  for (let i = 0; i < n; i++) {
    const j0 = lo(i), pj0 = i ? lo(i - 1) : 0;
    cur.fill(Infinity);
    for (let k = 0; k < width; k++) {
      const j = j0 + k;
      if (j >= m) break;
      const d = dist(a[i], b[j]);
      if (i === 0 && j === 0) { cur[k] = d; continue; }
      const up = i ? prev[j - pj0] ?? Infinity : Infinity; // (i-1, j)
      const diag = i && j ? prev[j - 1 - pj0] ?? Infinity : Infinity; // (i-1, j-1)
      const left = k ? cur[k - 1] : Infinity; // (i, j-1)
      let best = diag, step = 0;
      if (up < best) { best = up; step = 1; }
      if (left < best) { best = left; step = 2; }
      cur[k] = best + d * (step === 0 ? 1 : 1.2); // a small penalty keeps the path from stalling
      steps[i * width + k] = step;
    }
    [prev, cur] = [cur, prev];
  }
  // Walk back from the end; average the matched frames of b for every frame of a.
  const sum = new Float64Array(n), count = new Uint32Array(n);
  let i = n - 1, j = m - 1;
  while (i >= 0 && j >= 0) {
    sum[i] += j;
    count[i]++;
    if (i === 0 && j === 0) break;
    const k = j - lo(i);
    const step = k >= 0 && k < width ? steps[i * width + k] : 0;
    if (step === 0) { i--; j--; } else if (step === 1) i--; else j--;
    if (i < 0) i = 0;
    if (j < 0) j = 0;
  }
  return Array.from(sum, (s, f) => (count[f] ? s / count[f] : f * slope));
}

/**
 * Carries phoneme timings from one recording over to another recording of the same text.
 * @param phonemes [phoneme, start s, duration s] in the reference recording
 * @returns the same phonemes timed for the target recording
 */
export function retime(phonemes, refSamples, refRate, targetSamples, targetRate) {
  const map = warp(features(refSamples, refRate), features(targetSamples, targetRate));
  const at = (t) => {
    const f = Math.min(map.length - 1, Math.max(0, t / HOP));
    const k = Math.floor(f), u = f - k;
    const v = map[k] + ((map[Math.min(map.length - 1, k + 1)] ?? map[k]) - map[k]) * u;
    return v * HOP;
  };
  return phonemes.map(([ph, start, dur]) => {
    const a = at(start), b = at(start + dur);
    return [ph, +a.toFixed(4), +Math.max(0.005, b - a).toFixed(4)];
  });
}
