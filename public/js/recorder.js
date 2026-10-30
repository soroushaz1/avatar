// Turns the talking avatar into a video file: the avatar canvases are drawn into a frame of the
// chosen format (with optional subtitles) and recorded together with the voice.

// Output size, the size the avatar itself is rendered at (always head and shoulders, 3:4) and where it
// sits vertically (0 top .. 1 bottom). Around it is a blurred copy of itself; subtitles go at the bottom,
// below the chin, so they never cover the mouth.
export const VIDEO_FORMATS = {
  portrait: { size: [720, 1280], avatar: [720, 960], top: 0.3 },
  square: { size: [960, 960], avatar: [720, 960], top: 0.5 },
  landscape: { size: [1280, 720], avatar: [540, 720], top: 0.5 },
};

const MIME_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export const canRecordVideo = () => !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream);

const pickMimeType = () => MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type)) || '';

const SEPARATOR = /^[\s,.!?;:^$—–_-]/;

/**
 * Subtitle lines (a few words each) timed with the speech.
 * @param phonemes [phoneme, start, duration] triples from the voice engine (may be empty)
 */
export function buildCaptions(text, phonemes, duration) {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  // Word start times: from the gaps between words in the phoneme timings when they line up with the
  // text, otherwise spread over the speech by word length.
  let starts = [];
  let speechStart = 0, speechEnd = duration;
  if (phonemes?.length) {
    let inWord = false;
    const voiced = phonemes.filter(([ph]) => !SEPARATOR.test(ph));
    if (voiced.length) {
      speechStart = voiced[0][1];
      speechEnd = voiced[voiced.length - 1][1] + voiced[voiced.length - 1][2];
    }
    for (const [ph, start] of phonemes) {
      if (SEPARATOR.test(ph)) inWord = false;
      else if (!inWord) {
        starts.push(start);
        inWord = true;
      }
    }
  }
  if (starts.length !== words.length) {
    const weights = words.map((w) => w.length + 2);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    starts = weights.map((w) => {
      const t = speechStart + ((speechEnd - speechStart) * acc) / total;
      acc += w;
      return t;
    });
  }

  const lines = [];
  let line = [];
  const flush = (end) => {
    if (!line.length) return;
    lines.push({ start: starts[line[0]], end, text: line.map((i) => words[i]).join(' ') });
    line = [];
  };
  words.forEach((word, i) => {
    line.push(i);
    const length = line.reduce((n, k) => n + words[k].length + 1, 0);
    if (/[.!?؟،,;:]$/.test(word) || line.length >= 6 || length > 34) flush(starts[i + 1] ?? speechEnd + 0.3);
  });
  flush(speechEnd + 0.3);
  return lines;
}

export class VideoRecorder {
  /**
   * @param format a key of VIDEO_FORMATS
   * @param options.captions subtitle lines from buildCaptions (or null)
   * @param options.rtl whether the subtitles are right-to-left text
   */
  constructor(format, { captions = null, rtl = false } = {}) {
    const { size, avatar, top } = VIDEO_FORMATS[format] || VIDEO_FORMATS.portrait;
    this.avatarSize = avatar;
    this.top = top;
    this.canvas = document.createElement('canvas');
    [this.canvas.width, this.canvas.height] = size;
    this.ctx = this.canvas.getContext('2d');
    // A tiny copy of the avatar, scaled up, is a cheap blurred background.
    this.tiny = document.createElement('canvas');
    this.tiny.width = 24;
    this.tiny.height = 32;
    this.captions = captions;
    this.rtl = rtl;
    this.mimeType = pickMimeType();
    this.time = 0;
  }

  get extension() {
    return this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  }

  start(audioStream) {
    this.stream = this.canvas.captureStream(30);
    for (const track of audioStream?.getAudioTracks() || []) this.stream.addTrack(track);
    const options = { videoBitsPerSecond: 5_000_000, audioBitsPerSecond: 128_000 };
    if (this.mimeType) options.mimeType = this.mimeType;
    this.recorder = new MediaRecorder(this.stream, options);
    this.mimeType = this.recorder.mimeType || this.mimeType || 'video/webm';
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.recorder.start(1000);
  }

  stop() {
    return new Promise((resolve, reject) => {
      this.recorder.onstop = () => {
        for (const track of this.stream.getTracks()) track.stop();
        resolve(new Blob(this.chunks, { type: this.mimeType.split(';')[0] }));
      };
      this.recorder.onerror = (e) => reject(e.error || new Error('recording failed'));
      this.recorder.stop();
    });
  }

  /**
   * Draws one video frame.
   * @param layers canvases holding the avatar, all the same size, drawn in order
   * @param t seconds since the speech started (for subtitles), or null before it starts
   */
  draw(layers, t) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const src = layers[0];
    if (!src?.width || !src.height) return;
    const tctx = this.tiny.getContext('2d');
    tctx.clearRect(0, 0, this.tiny.width, this.tiny.height);
    for (const layer of layers) tctx.drawImage(layer, 0, 0, this.tiny.width, this.tiny.height);
    ctx.fillStyle = '#120f24';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const cover = Math.max(W / this.tiny.width, H / this.tiny.height);
    const bw = this.tiny.width * cover, bh = this.tiny.height * cover;
    ctx.drawImage(this.tiny, (W - bw) / 2, (H - bh) / 2, bw, bh);
    ctx.fillStyle = 'rgba(10, 8, 20, 0.35)';
    ctx.fillRect(0, 0, W, H);

    // The avatar as large as fits.
    const s = Math.min(W / src.width, H / src.height);
    const w = src.width * s, h = src.height * s;
    for (const layer of layers) ctx.drawImage(layer, (W - w) / 2, (H - h) * this.top, w, h);

    const line = t !== null && this.captions?.find((c) => t >= c.start && t < c.end);
    if (line) this.drawCaption(line.text);
  }

  drawCaption(text) {
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const size = Math.round(Math.min(W, H) * 0.05);
    ctx.save();
    ctx.font = `700 ${size}px Vazirmatn, system-ui, sans-serif`;
    ctx.direction = this.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Wrap into at most two lines that fit the frame.
    const maxWidth = W * 0.84;
    const rows = [];
    let row = '';
    for (const word of text.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (row && ctx.measureText(next).width > maxWidth) {
        rows.push(row);
        row = word;
      } else {
        row = next;
      }
    }
    if (row) rows.push(row);
    const lineH = size * 1.45;
    const boxW = Math.min(W * 0.92, Math.max(...rows.map((r) => ctx.measureText(r).width)) + size * 1.2);
    const boxH = rows.length * lineH + size * 0.5;
    const bottom = H * 0.95;
    ctx.fillStyle = 'rgba(10, 8, 20, 0.62)';
    ctx.beginPath();
    ctx.roundRect((W - boxW) / 2, bottom - boxH, boxW, boxH, size * 0.45);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    rows.forEach((r, i) => ctx.fillText(r, W / 2, bottom - boxH + size * 0.25 + lineH * (i + 0.5)));
    ctx.restore();
  }
}
