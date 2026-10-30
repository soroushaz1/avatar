import { FaceLandmarker, FilesetResolver } from '/vendor/mediapipe/vision_bundle.mjs';

const WASM_DIR = '/vendor/mediapipe/wasm';
const MODEL_PATH = '/models/face_landmarker.task';

// Downloads a file, reporting bytes received and the uncompressed size (sent by the server as X-File-Size).
async function download(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const size = Number(res.headers.get('x-file-size')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onBytes(received, size);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const progressListeners = new Set();
let assetsPromise = null;

// The face-detection engine and model (~8 MB to download) are fetched once, with progress (0..1).
export function loadFaceAssets(onProgress) {
  if (onProgress) progressListeners.add(onProgress);
  assetsPromise ??= (async () => {
    const simd = await FilesetResolver.isSimdSupported();
    const name = simd ? 'vision_wasm_internal' : 'vision_wasm_nosimd_internal';
    const parts = { wasm: [0, 14.5e6], model: [0, 3.8e6] };
    const report = () => {
      const p = (parts.wasm[0] + parts.model[0]) / (parts.wasm[1] + parts.model[1]);
      for (const l of progressListeners) l(Math.min(0.99, p));
    };
    const [wasm, model] = await Promise.all([
      download(`${WASM_DIR}/${name}.wasm`, (got, size) => { parts.wasm = [got, size || parts.wasm[1]]; report(); }),
      download(MODEL_PATH, (got, size) => { parts.model = [got, size || parts.model[1]]; report(); }),
    ]);
    for (const l of progressListeners) l(1);
    const fileset = {
      wasmLoaderPath: `${WASM_DIR}/${name}.js`,
      wasmBinaryPath: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
    };
    return { fileset, model };
  })();
  // A failed download can be retried.
  assetsPromise.catch(() => { assetsPromise = null; });
  return assetsPromise;
}

async function createLandmarker(runningMode) {
  const { fileset, model } = await loadFaceAssets();
  const options = (delegate) => ({
    baseOptions: { modelAssetBuffer: model.slice(), delegate },
    runningMode,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, options('GPU'));
  } catch {
    return FaceLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

// Webcam + live face tracking. All processing stays in the browser.
export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.modelPromise = null;
    this.lastVideoTime = -1;
    this.lastResult = null;
  }

  // Loads face tracking; safe to call repeatedly, and to retry after a failure.
  loadModel() {
    this.modelPromise ??= createLandmarker('VIDEO').then(
      (lm) => (this.landmarker = lm),
      (err) => {
        this.modelPromise = null;
        throw err;
      },
    );
    return this.modelPromise;
  }

  async startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('getUserMedia unsupported'), { name: 'NotSupportedError' });
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastResult = null;
  }

  get cameraOn() {
    return !!this.stream;
  }

  get ready() {
    return !!this.landmarker;
  }

  // Returns the latest result, running detection only when a new video frame is available.
  detect() {
    if (!this.stream || !this.landmarker || this.video.readyState < 2) return this.lastResult;
    if (this.video.currentTime !== this.lastVideoTime) {
      this.lastVideoTime = this.video.currentTime;
      this.lastResult = this.landmarker.detectForVideo(this.video, performance.now());
    }
    return this.lastResult;
  }

  // Copies the current (un-mirrored) camera frame into a canvas.
  grabFrame(maxSize = 1024) {
    const { videoWidth: w, videoHeight: h } = this.video;
    const s = Math.min(1, maxSize / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * s);
    canvas.height = Math.round(h * s);
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
}

let imageLandmarkerPromise = null;

// One-off detection on a still image (captured frame or uploaded photo).
export async function detectImage(source) {
  imageLandmarkerPromise ??= createLandmarker('IMAGE');
  imageLandmarkerPromise.catch(() => { imageLandmarkerPromise = null; });
  const landmarker = await imageLandmarkerPromise;
  return landmarker.detect(source);
}
