import { FaceLandmarker, FilesetResolver } from '/vendor/mediapipe/vision_bundle.mjs';

const WASM_PATH = '/vendor/mediapipe/wasm';
const MODEL_PATH = '/models/face_landmarker.task';

let filesetPromise = null;
const fileset = () => (filesetPromise ??= FilesetResolver.forVisionTasks(WASM_PATH));

async function createLandmarker(runningMode) {
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode,
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });
  try {
    return await FaceLandmarker.createFromOptions(await fileset(), options('GPU'));
  } catch {
    return FaceLandmarker.createFromOptions(await fileset(), options('CPU'));
  }
}

// Webcam + live face tracking. All processing stays in the browser.
export class FaceTracker {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.landmarker = null;
    this.lastVideoTime = -1;
    this.lastResult = null;
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
    this.landmarker ??= await createLandmarker('VIDEO');
  }

  stopCamera() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.lastResult = null;
  }

  get running() {
    return !!this.stream && !!this.landmarker;
  }

  // Returns the latest result, running detection only when a new video frame is available.
  detect() {
    if (!this.running || this.video.readyState < 2) return this.lastResult;
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
    canvas.getContext('2d').drawImage(this.video, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
}

let imageLandmarkerPromise = null;

// One-off detection on a still image (captured frame or uploaded photo).
export async function detectImage(source) {
  imageLandmarkerPromise ??= createLandmarker('IMAGE');
  const landmarker = await imageLandmarkerPromise;
  return landmarker.detect(source);
}
