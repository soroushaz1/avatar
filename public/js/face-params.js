// A small, renderer-independent set of facial animation parameters.
// Both avatars are driven by these, whether they come from the webcam or from speech.
// Values are expressed in the un-mirrored camera image space; renderers mirror as needed.

export function createParams() {
  return {
    jawOpen: 0, smile: 0, pucker: 0, wide: 0,
    blinkA: 0, blinkB: 0, browUp: 0,
    lookX: 0, lookY: 0,
    yaw: 0, pitch: 0, roll: 0, // radians
    tx: 0, ty: 0,             // head translation, roughly in face widths
  };
}

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));

// Euler angles (YXZ) from a column-major 4x4 matrix.
export function poseFromMatrix(m) {
  const m13 = m[8], m33 = m[10], m21 = m[1], m22 = m[5], m23 = m[9];
  const pitch = Math.asin(-clamp(m23, -1, 1));
  const yaw = Math.atan2(m13, m33);
  const roll = Math.atan2(m21, m22);
  return { yaw, pitch, roll, tx: m[12], ty: m[13], tz: m[14] };
}

// Converts a FaceLandmarker result into params. Returns null when no face is found.
export function paramsFromResult(result) {
  const shapes = result.faceBlendshapes?.[0]?.categories;
  const matrix = result.facialTransformationMatrixes?.[0]?.data;
  if (!shapes || !result.faceLandmarks?.length) return null;

  const b = {};
  for (const c of shapes) b[c.categoryName] = c.score;
  const p = createParams();

  // Lips can part (e.g. a toothy smile) without the jaw dropping much.
  const lipsApart = ((b.mouthUpperUpLeft + b.mouthUpperUpRight) / 2 + (b.mouthLowerDownLeft + b.mouthLowerDownRight) / 2) / 2;
  p.jawOpen = clamp(Math.max((b.jawOpen - 0.04) * 1.25, lipsApart * 0.6));
  p.smile = clamp(((b.mouthSmileLeft + b.mouthSmileRight) / 2) * 1.2);
  p.pucker = clamp(Math.max(b.mouthPucker, b.mouthFunnel * 0.8) * 1.3);
  p.wide = clamp(((b.mouthStretchLeft + b.mouthStretchRight) / 2) * 2);
  // MediaPipe reports blinks from the subject's point of view; A is the image-left eye (subject's right).
  p.blinkA = clamp((b.eyeBlinkRight - 0.1) * 1.6);
  p.blinkB = clamp((b.eyeBlinkLeft - 0.1) * 1.6);
  p.browUp = clamp(Math.max(b.browInnerUp, (b.browOuterUpLeft + b.browOuterUpRight) / 2) * 1.3)
    - clamp((b.browDownLeft + b.browDownRight) / 2) * 0.6;
  // Looking towards the subject's right moves the eyes to the image left (negative x).
  p.lookX = clamp((b.eyeLookInRight + b.eyeLookOutLeft) / 2 - (b.eyeLookOutRight + b.eyeLookInLeft) / 2, -1, 1);
  p.lookY = clamp((b.eyeLookUpLeft + b.eyeLookUpRight) / 2 - (b.eyeLookDownLeft + b.eyeLookDownRight) / 2, -1, 1);

  if (matrix) {
    const pose = poseFromMatrix(matrix);
    p.yaw = pose.yaw;
    p.pitch = pose.pitch;
    p.roll = pose.roll;
    // Translation is in centimetres; a face is ~15cm wide.
    p.tx = clamp(pose.tx / 15, -1.5, 1.5);
    p.ty = clamp(pose.ty / 15, -1.5, 1.5);
  }
  return p;
}

// Swap left/right so the avatar behaves like a mirror.
export function mirrorParams(p) {
  return { ...p, blinkA: p.blinkB, blinkB: p.blinkA, lookX: -p.lookX, yaw: -p.yaw, roll: -p.roll, tx: -p.tx };
}

// Frame-rate independent exponential smoothing towards a target.
export function smoothParams(current, target, dt, speed = 18) {
  const k = 1 - Math.exp(-speed * dt);
  for (const key of Object.keys(current)) {
    // Blinks must stay snappy, everything else is smoothed more.
    const kk = key.startsWith('blink') ? Math.min(1, k * 2) : k;
    current[key] += (target[key] - current[key]) * kk;
  }
  return current;
}

// Gentle life-like motion: blinks and a slight sway of the head.
export class IdleAnimator {
  constructor() {
    this.t = 0;
    this.nextBlink = 1.5;
    this.blinkT = -1;
  }

  apply(p, dt, { head = true } = {}) {
    this.t += dt;
    this.nextBlink -= dt;
    if (this.nextBlink <= 0) {
      this.blinkT = 0;
      this.nextBlink = 2 + Math.random() * 4;
    }
    let blink = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      blink = Math.sin(Math.min(1, this.blinkT / 0.18) * Math.PI);
      if (this.blinkT > 0.18) this.blinkT = -1;
    }
    p.blinkA = p.blinkB = blink;
    if (head) {
      p.yaw = Math.sin(this.t * 0.5) * 0.05;
      p.pitch = Math.sin(this.t * 0.37 + 1) * 0.03;
      p.roll = Math.sin(this.t * 0.29 + 2) * 0.02;
      p.lookX = Math.sin(this.t * 0.23) * 0.1;
    }
    return p;
  }
}
