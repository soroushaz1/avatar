// Animates a single portrait image (the user's photo, or the 3D character generated from it):
// a triangle mesh over the face landmarks is warped to follow the webcam or the speech track.
// While the lips are apart, a canvas above the WebGL layer paints the inside of the mouth.
import {
  LIP_UPPER_INNER, LIP_LOWER_INNER, LIP_UPPER_OUTER, LIP_LOWER_OUTER,
  MOUTH_CORNERS_OUTER, MOUTH_CORNERS_INNER, MOUTH_INNER_POLYGON,
  EYE_A, EYE_B, BROW_A, BROW_B, FACE_OVAL, FOREHEAD, CHIN, CHEEK_A, CHEEK_B, FACE_POINT_COUNT,
} from './landmarks.js';
import { mirrorParams } from './face-params.js';
import { VISEME_FALLBACK } from './visemes.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const VERTEX_SHADER = `
attribute vec3 aPos;
attribute vec2 aUv;
attribute float aMask;
uniform vec4 uView;   // scale.xy, offset.xy (image px -> clip space)
uniform float uDepth;
varying vec2 vUv;
varying float vMask;
void main() {
  vUv = aUv;
  vMask = aMask;
  gl_Position = vec4(aPos.xy * uView.xy + uView.zw, clamp(aPos.z * uDepth, -0.99, 0.99), 1.0);
}`;

// Mouth images only show on the lips and inside the mouth (vMask) and fade out towards their crop
// edges (uFeather); everything else comes from the portrait. uGain matches their colours to it.
const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
uniform float uAlpha;
uniform float uFeather;
uniform vec3 uGain;
varying vec2 vUv;
varying float vMask;
void main() {
  float a = uAlpha;
  if (uFeather > 0.0) {
    float edge = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
    a *= smoothstep(0.0, uFeather, edge) * vMask;
  }
  gl_FragColor = vec4(texture2D(uTex, vUv).rgb * uGain, a);
}`;

// Landmarks that barely move when talking, used to line mouth samples up with the portrait.
const STABLE_POINTS = [33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 10, 151, 9, 127, 356, 234, 454];
// The base of the nose: a mouth image is shifted so these meet the portrait's exactly, which removes
// the offset a slightly different head tilt leaves around the mouth.
const NOSE_BASE = [2, 98, 327];
// Skin around the mouth, compared between a mouth image and the portrait to match their colours.
const SKIN_AROUND_MOUTH = [57, 186, 92, 165, 167, 164, 393, 391, 322, 410, 287, 43, 106, 182, 83, 18, 313, 406, 335, 273, 205, 425];
const OUTER_LIP_POLYGON = [61, ...LIP_UPPER_OUTER, 291, ...LIP_LOWER_OUTER.slice().reverse()];

// Distance from a point to a polygon's outline, 0 inside it.
function distanceToPolygon(p, poly) {
  let inside = false, best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return inside ? 0 : best;
}

// Average colour of small patches around the given points (pixel coordinates) of a canvas.
function meanColor(canvas, pts, ids) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const sum = [0, 0, 0];
  let n = 0;
  for (const i of ids) {
    const x = Math.round(pts[i][0]) - 2, y = Math.round(pts[i][1]) - 2;
    if (x < 0 || y < 0 || x + 5 > canvas.width || y + 5 > canvas.height) continue;
    const d = ctx.getImageData(x, y, 5, 5).data;
    for (let k = 0; k < d.length; k += 4) {
      sum[0] += d[k];
      sum[1] += d[k + 1];
      sum[2] += d[k + 2];
      n++;
    }
  }
  return n ? sum.map((v) => v / n) : null;
}

// Face landmarks plus two rings around the face and the image border, in pixels (with depth).
function meshPoints(landmarks, W, H) {
  const pts = [];
  for (let i = 0; i < FACE_POINT_COUNT; i++) {
    const l = landmarks[i];
    pts.push([l.x * W, l.y * H, l.z * W]);
  }
  const P = (i) => pts[i];
  const faceW = Math.hypot(P(CHEEK_A)[0] - P(CHEEK_B)[0], P(CHEEK_A)[1] - P(CHEEK_B)[1]);
  const center = [(P(CHEEK_A)[0] + P(CHEEK_B)[0]) / 2, (P(FOREHEAD)[1] + P(CHIN)[1]) / 2];
  const meanZ = FACE_OVAL.reduce((s, i) => s + P(i)[2], 0) / FACE_OVAL.length;
  const backZ = meanZ + 0.45 * faceW;
  for (const scale of [1.3, 1.75]) {
    for (const i of FACE_OVAL) {
      const p = P(i);
      pts.push([
        Math.min(W - 1, Math.max(1, center[0] + (p[0] - center[0]) * scale)),
        Math.min(H - 1, Math.max(1, center[1] + (p[1] - center[1]) * scale)),
        backZ,
      ]);
    }
  }
  const steps = 8;
  for (let k = 0; k < steps; k++) {
    const t = k / steps;
    for (const [x, y] of [[t * W, 0], [W, t * H], [W - t * W, H], [0, H - t * H]]) pts.push([x, y, backZ + faceW]);
  }
  return { pts, center, faceW, backZ };
}

// Least-squares similarity transform (scale, rotation, shift) taking src points onto dst points.
function similarity(src, dst, ids) {
  let msx = 0, msy = 0, mdx = 0, mdy = 0;
  for (const i of ids) { msx += src[i][0]; msy += src[i][1]; mdx += dst[i][0]; mdy += dst[i][1]; }
  msx /= ids.length; msy /= ids.length; mdx /= ids.length; mdy /= ids.length;
  let a = 0, b = 0, n = 0;
  for (const i of ids) {
    const sx = src[i][0] - msx, sy = src[i][1] - msy, dx = dst[i][0] - mdx, dy = dst[i][1] - mdy;
    a += sx * dx + sy * dy;
    b += sx * dy - sy * dx;
    n += sx * sx + sy * sy;
  }
  const c = a / n, s = b / n, k = Math.hypot(c, s);
  return (p) => [c * (p[0] - msx) - s * (p[1] - msy) + mdx, s * (p[0] - msx) + c * (p[1] - msy) + mdy, p[2] * k];
}

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

export class FaceAvatar {
  constructor(glCanvas, mouthCanvas) {
    this.glCanvas = glCanvas;
    this.mouthCanvas = mouthCanvas;
    this.mctx = mouthCanvas.getContext('2d');
    const gl = glCanvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL is not available');
    this.gl = gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    this.loc = {
      aPos: gl.getAttribLocation(prog, 'aPos'),
      aUv: gl.getAttribLocation(prog, 'aUv'),
      aMask: gl.getAttribLocation(prog, 'aMask'),
      uView: gl.getUniformLocation(prog, 'uView'),
      uDepth: gl.getUniformLocation(prog, 'uDepth'),
      uAlpha: gl.getUniformLocation(prog, 'uAlpha'),
      uFeather: gl.getUniformLocation(prog, 'uFeather'),
      uGain: gl.getUniformLocation(prog, 'uGain'),
    };
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.maskBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = gl.createTexture();
    this.face = null;
    this.source = null;
    // One image per mouth shape (viseme id -> texture and mesh), see setMouthSamples.
    this.samples = {};
    // [width, height] to render at instead of the on-screen size (used while recording a video).
    this.renderSize = null;
  }

  get ready() {
    return !!this.face;
  }

  /**
   * @param image canvas holding the portrait
   * @param landmarks normalized MediaPipe landmarks for that image
   * @param restPose {yaw,pitch,roll,jawOpen} measured on the image
   * @param mirrored whether to show the image mirrored (true for webcam captures)
   */
  setFace(image, landmarks, restPose, mirrored) {
    this.source = image;
    const gl = this.gl;
    const W = image.width, H = image.height;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const { pts, center, faceW } = meshPoints(landmarks, W, H);
    const P = (i) => pts[i];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const faceH = dist(P(FOREHEAD), P(CHIN));
    const mouthW = dist(P(61), P(291));

    // Face-aligned axes (the face may be tilted): ex points from eye A to eye B, ey points down the face.
    const ex0 = [P(263)[0] - P(33)[0], P(263)[1] - P(33)[1]];
    const exl = Math.hypot(...ex0);
    const ex = [ex0[0] / exl, ex0[1] / exl];
    const ey = [-ex[1], ex[0]];

    // Pivot for head rotation: between the cheeks, pushed behind the face. The two rings around the
    // face follow the head partly so the warp fades out smoothly; the image border stays fixed.
    const meanZ = FACE_OVAL.reduce((sum, i) => sum + P(i)[2], 0) / FACE_OVAL.length;
    const pivot = [center[0], center[1] + 0.1 * faceH, meanZ + 0.45 * faceW];
    const ringN = FACE_OVAL.length;
    const headWeight = pts.map((_, i) => (i < FACE_POINT_COUNT ? 1 : i < FACE_POINT_COUNT + ringN ? 0.55 : i < FACE_POINT_COUNT + 2 * ringN ? 0.2 : 0));

    // Triangulate in 2D, with the lips pulled slightly apart so the mouth opening gets its own
    // well-shaped triangles (they have no area while the mouth is closed). The mesh stays whole, so a
    // closed mouth looks exactly like the original image.
    const flat = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    const lipMid = [(P(78)[0] + P(308)[0]) / 2, (P(78)[1] + P(308)[1]) / 2];
    for (const i of LIP_LOWER_INNER) {
      const u = ((pts[i][0] - lipMid[0]) * ex[0] + (pts[i][1] - lipMid[1]) * ex[1]) / (mouthW / 2);
      const open = 0.15 * mouthW * Math.max(0.25, 1 - u * u);
      flat[i * 2] += ey[0] * open;
      flat[i * 2 + 1] += ey[1] * open;
    }
    const triangles = new window.Delaunator(flat).triangles;
    // Triangles inside the mouth opening go last, so they can be drawn on their own.
    const inner = new Set([...LIP_UPPER_INNER, ...LIP_LOWER_INNER, ...MOUTH_CORNERS_INNER]);
    const outside = [], opening = [];
    for (let k = 0; k < triangles.length; k += 3) {
      const tri = [triangles[k], triangles[k + 1], triangles[k + 2]];
      (tri.every((i) => inner.has(i)) ? opening : outside).push(...tri);
    }
    const indices = [...outside, ...opening];

    // Per-vertex weights for each expression, computed once.
    const n = pts.length;
    const mouthC = [(P(13)[0] + P(14)[0]) / 2, (P(13)[1] + P(14)[1]) / 2];
    const local = (p) => {
      const dx = p[0] - mouthC[0], dy = p[1] - mouthC[1];
      return [dx * ex[0] + dy * ex[1], dx * ey[0] + dy * ey[1]];
    };
    const chinV = local(P(CHIN))[1];
    const jaw = new Float32Array(n);
    const lowerLip = new Set([...LIP_LOWER_INNER, ...LIP_LOWER_OUTER]);
    const upperLip = new Set([...LIP_UPPER_INNER, ...LIP_UPPER_OUTER]);
    const corners = new Set([...MOUTH_CORNERS_OUTER, ...MOUTH_CORNERS_INNER]);
    for (let i = 0; i < n; i++) {
      const [u, v] = local(pts[i]);
      if (lowerLip.has(i)) jaw[i] = 1 - 0.45 * Math.min(1, (u / (mouthW / 2)) ** 2);
      else if (corners.has(i)) jaw[i] = 0.45;
      else if (upperLip.has(i)) jaw[i] = LIP_UPPER_INNER.includes(i) ? -0.12 : -0.05;
      else {
        let fv = smoothstep(0.02 * faceH, 0.12 * faceH, v);
        fv *= 1 - 0.85 * smoothstep(chinV, chinV + 0.35 * faceH, v);
        const fh = 1 - smoothstep(0.32 * faceW, 0.6 * faceW, Math.abs(u));
        jaw[i] = fv * fh * (i < FACE_POINT_COUNT ? 1 : 0.7);
      }
    }
    const gauss = (i, c, r) => Math.exp(-((dist(pts[i], P(c)) / r) ** 2));
    const cornerA = new Float32Array(n), cornerB = new Float32Array(n), browA = new Float32Array(n), browB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      cornerA[i] = Math.max(gauss(i, 61, 0.32 * mouthW), gauss(i, 78, 0.25 * mouthW));
      cornerB[i] = Math.max(gauss(i, 291, 0.32 * mouthW), gauss(i, 308, 0.25 * mouthW));
      browA[i] = Math.max(...BROW_A.map((b) => gauss(i, b, 0.07 * faceH)));
      browB[i] = Math.max(...BROW_B.map((b) => gauss(i, b, 0.07 * faceH)));
    }
    for (const eye of [EYE_A, EYE_B]) {
      for (const i of [...eye.upper, ...eye.lower, ...eye.corners]) {
        browA[i] *= 0.25;
        browB[i] *= 0.25;
      }
    }
    const lipRound = new Float32Array(n);
    for (const i of LIP_UPPER_OUTER) lipRound[i] = -1;
    for (const i of LIP_LOWER_OUTER) lipRound[i] = 1;

    const uvs = new Float32Array(n * 2);
    pts.forEach((p, i) => { uvs[i * 2] = p[0] / W; uvs[i * 2 + 1] = p[1] / H; });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
    // Where mouth images show: the lips and the inside of the mouth, fading out just outside the lips.
    // The skin, beard and nose around them always come from the portrait (moved by the morph below).
    const lipOutline = OUTER_LIP_POLYGON.map(P);
    const mask = Float32Array.from(pts, (p, i) => (i < FACE_POINT_COUNT
      ? 1 - smoothstep(0.04 * mouthW, 0.24 * mouthW, distanceToPolygon(p, lipOutline)) : 0));
    // How much each point follows the mouth images' shape: the lips, chin and jaw fully; nothing from
    // the base of the nose up, so the nose never moves.
    const noseV = local(P(2))[1], lipTopV = local(P(0))[1];
    const morphWeight = Float32Array.from(pts, (p, i) => {
      if (i >= FACE_POINT_COUNT + 2 * FACE_OVAL.length) return 0; // image border
      const [u, v] = local(p);
      const up = smoothstep(noseV, lipTopV, v);
      const down = 1 - smoothstep(chinV, chinV + 0.3 * faceH, v);
      const side = 1 - smoothstep(0.75 * mouthW, 1.4 * mouthW, Math.abs(u));
      return up * down * side * (i < FACE_POINT_COUNT ? 1 : 0.7);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.maskBuf);
    gl.bufferData(gl.ARRAY_BUFFER, mask, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    // Region of the photo to show: head and shoulders.
    const viewH = Math.min(H, faceH * 3.1);
    const viewC = [center[0], Math.min(H - viewH / 2, Math.max(viewH / 2, center[1] + faceH * 0.35))];

    this.face = {
      W, H, rest: pts, n, indices: indices.length, openingStart: outside.length, ex, ey, pivot, faceW, faceH, mouthW,
      headWeight, jaw, cornerA, cornerB, browA, browB, lipRound,
      restPose, mirrored, viewH, viewC,
      // An image with the mouth already open keeps its own teeth, attached to the upper lip.
      restOpen: dist(P(13), P(14)) > 0.06 * mouthW,
      restGap: dist(P(13), P(14)) / dist(P(78), P(308)),
      morphWeight,
      morph: pts.map((p) => [...p]),
      positions: new Float32Array(n * 3),
      positionsB: new Float32Array(n * 3),
    };
    for (const sm of Object.values(this.samples)) sm.aligned = null;
  }

  /**
   * Images of the same face with the mouth in different shapes (visemes): real webcam frames for the
   * realistic avatar, Gemini-made images for the 3D character. Used instead of a warped, painted mouth.
   * @param samples { [visemeId]: { canvas, landmarks (normalized to the canvas) } }
   */
  setMouthSamples(samples) {
    const gl = this.gl;
    for (const sm of Object.values(this.samples)) {
      gl.deleteTexture(sm.tex);
      gl.deleteBuffer(sm.uvBuf);
    }
    this.samples = {};
    for (const [id, { canvas, landmarks }] of Object.entries(samples)) {
      const W = canvas.width, H = canvas.height;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const { pts } = meshPoints(landmarks, W, H);
      const uvs = new Float32Array(pts.length * 2);
      pts.forEach((p, i) => { uvs[i * 2] = p[0] / W; uvs[i * 2 + 1] = p[1] / H; });
      const uvBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
      this.samples[id] = { tex, uvBuf, pts, canvas, aligned: null, gain: [1, 1, 1] };
    }
  }

  get hasMouthSamples() {
    return Object.keys(this.samples).length > 0;
  }

  // The image for a viseme, or the closest shape that exists; null means the closed-mouth portrait.
  sampleFor(id) {
    for (const candidate of [id, ...(VISEME_FALLBACK[id] || [])]) {
      if (candidate === 'PP') return null;
      if (this.samples[candidate]) return this.samples[candidate];
    }
    return null;
  }

  // A sample's mesh moved onto the portrait (stable landmarks matched), so only the mouth area differs.
  alignedSample(sm) {
    if (!sm.aligned) {
      const f = this.face;
      const map = similarity(sm.pts, f.rest, STABLE_POINTS);
      const aligned = sm.pts.map(map);
      const shift = [0, 1].map((k) => NOSE_BASE.reduce((sum, i) => sum + f.rest[i][k] - aligned[i][k], 0) / NOSE_BASE.length);
      for (const q of aligned) {
        q[0] += shift[0];
        q[1] += shift[1];
      }
      sm.aligned = aligned;
      // Frames taken at different moments differ in exposure: scale the colours to the portrait's.
      try {
        const mine = meanColor(sm.canvas, sm.pts, SKIN_AROUND_MOUTH);
        const theirs = meanColor(this.source, f.rest, SKIN_AROUND_MOUTH);
        if (mine && theirs) sm.gain = theirs.map((c, k) => Math.min(1.35, Math.max(0.75, (c + 1) / (mine[k] + 1))));
      } catch {
        sm.gain = [1, 1, 1];
      }
    }
    return sm.aligned;
  }

  clear() {
    this.face = null;
    this.source = null;
    this.mctx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of [this.glCanvas, this.mouthCanvas]) {
      const [w, h] = this.renderSize || [Math.round(c.clientWidth * dpr), Math.round(c.clientHeight * dpr)];
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
  }

  // Deforms the rest mesh according to the params (all in photo pixel space).
  // With relativePose the head angles are offsets from the photo's own pose (idle/speech motion).
  // With mouthFromSpeech the jaw opens from the image's own mouth instead of mirroring tracked openness.
  deform(p, relativePose, mouthFromSpeech, rest = this.face.rest, out = this.face.positions) {
    const f = this.face;
    const { ex, ey, mouthW, faceH } = f;
    const jawRef = mouthFromSpeech ? 0 : f.restPose.jawOpen || 0;
    const jaw = Math.max(0, p.jawOpen - jawRef) * 0.45 * mouthW;
    const smile = p.smile, wide = p.wide, pucker = p.pucker;
    const brow = p.browUp * 0.045 * faceH;

    // Relative head rotation since the photo, limited to what a 2D warp can sell.
    const lim = (v, m) => Math.max(-m, Math.min(m, v));
    const pose = relativePose ? { yaw: 0, pitch: 0, roll: 0 } : f.restPose;
    const yaw = lim(p.yaw - pose.yaw, 0.35);
    const pitch = lim(p.pitch - pose.pitch, 0.3);
    const roll = lim(p.roll - pose.roll, 0.35);
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
    // R = Ry * Rx * Rz in a y-up, z-towards-viewer frame.
    const R = [
      cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
      cx * sz, cx * cz, -sx,
      -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx,
    ];

    // Eyelid targets.
    const lidOffsets = new Map();
    for (const [eye, blink] of [[EYE_A, p.blinkA], [EYE_B, p.blinkB]]) {
      eye.upper.forEach((u, k) => {
        const lo = rest[eye.lower[k]], up = rest[u];
        const d = [(lo[0] - up[0]) * blink * 0.92, (lo[1] - up[1]) * blink * 0.92];
        lidOffsets.set(u, d);
        lidOffsets.set(eye.crease[k], [d[0] * 0.4, d[1] * 0.4]);
      });
    }

    for (let i = 0; i < f.n; i++) {
      const r = rest[i];
      let x = r[0], y = r[1];
      // Expression offsets in face-local (u along ex, v along ey) units.
      let du = 0, dv = f.jaw[i] * jaw;
      du += (-f.cornerA[i] + f.cornerB[i]) * mouthW * (0.13 * smile + 0.1 * wide - 0.17 * pucker);
      dv -= (f.cornerA[i] + f.cornerB[i]) * mouthW * 0.08 * smile;
      dv += f.lipRound[i] * mouthW * 0.05 * pucker;
      dv -= (f.browA[i] + f.browB[i]) * brow;
      x += du * ex[0] + dv * ey[0];
      y += du * ex[1] + dv * ey[1];
      const lid = lidOffsets.get(i);
      if (lid) { x += lid[0]; y += lid[1]; }

      // Head rotation about the pivot (image y is down and image z grows away from the camera).
      const w = f.headWeight[i];
      if (w > 0) {
        const qx = x - f.pivot[0], qy = -(y - f.pivot[1]), qz = -(r[2] - f.pivot[2]);
        const rx = R[0] * qx + R[1] * qy + R[2] * qz;
        const ry = R[3] * qx + R[4] * qy + R[5] * qz;
        const rz = R[6] * qx + R[7] * qy + R[8] * qz;
        x += (f.pivot[0] + rx - x) * w;
        y += (f.pivot[1] - ry - y) * w;
        out[i * 3 + 2] = -rz;
      } else {
        out[i * 3 + 2] = r[2] - f.pivot[2];
      }
      out[i * 3] = x;
      out[i * 3 + 1] = y;
    }
    return out;
  }

  /**
   * @param visemes when set and mouth images exist, [[visemeId, weight], ...] (at most two): the mouth
   *   is shown from those images, cross-faded over the closed-mouth portrait, instead of being warped.
   */
  update(rawParams, dt, { relativePose = false, mouthFromSpeech = false, visemes = null } = {}) {
    if (!this.face) return;
    this.resize();
    const f = this.face;
    // A mirrored image already behaves like a mirror; an un-mirrored one needs mirrored params.
    const p = f.mirrored ? rawParams : mirrorParams(rawParams);
    const fromSamples = !!visemes && this.hasMouthSamples;

    // Map image pixels to clip space: show the head-and-shoulders region, always covering the canvas.
    const cw = this.glCanvas.width, ch = this.glCanvas.height;
    const s = Math.max(ch / f.viewH, cw / f.W, ch / f.H); // image px -> canvas px
    const hw = cw / s / 2, hh = ch / s / 2;
    const vx = Math.min(f.W - hw, Math.max(hw, f.viewC[0]));
    const vy = Math.min(f.H - hh, Math.max(hh, f.viewC[1]));
    const sxClip = (2 * s) / cw * (f.mirrored ? -1 : 1);
    const syClip = (-2 * s) / ch;
    const oxClip = -vx * sxClip;
    const oyClip = -vy * syClip;

    const gl = this.gl;
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.useProgram(this.prog);
    gl.uniform4f(this.loc.uView, sxClip, syClip, oxClip, oyClip);
    gl.uniform1f(this.loc.uDepth, 1 / (f.faceW * 4));
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    const draw = (positions, tex, uvBuf, alpha, feather, first = 0, count = f.indices, gain = [1, 1, 1]) => {
      gl.uniform1f(this.loc.uAlpha, alpha);
      gl.uniform1f(this.loc.uFeather, feather);
      gl.uniform3f(this.loc.uGain, gain[0], gain[1], gain[2]);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(this.loc.aPos);
      gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
      gl.enableVertexAttribArray(this.loc.aUv);
      gl.vertexAttribPointer(this.loc.aUv, 2, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.maskBuf);
      gl.enableVertexAttribArray(this.loc.aMask);
      gl.vertexAttribPointer(this.loc.aMask, 1, gl.FLOAT, false, 0, 0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_SHORT, first * 2);
    };

    if (!fromSamples) {
      const pos = this.deform(p, relativePose, mouthFromSpeech);
      draw(pos, this.tex, this.uvBuf, 1, 0);
      const toCanvas = (x, y) => [(x * sxClip + oxClip + 1) / 2 * cw, (1 - (y * syClip + oyClip)) / 2 * ch];
      this.drawMouth((i) => toCanvas(pos[i * 3], pos[i * 3 + 1]));
      return;
    }

    // The mouth comes from the images. Morph: the mesh moves towards each image's own mouth by that
    // image's weight and the images are cross-faded over the portrait on that same mesh, so the lips
    // travel smoothly from shape to shape instead of one picture fading into another.
    this.mctx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
    // Merge weights of visemes that resolve to the same image (or to the closed-mouth portrait).
    const layers = [];
    for (const [id, w] of visemes) {
      const sm = this.sampleFor(id);
      if (!sm || w <= 0) continue;
      const same = layers.find((l) => l.sm === sm);
      if (same) same.w += w;
      else layers.push({ sm, w, mesh: this.alignedSample(sm) });
    }
    const { rest, morph, morphWeight } = f;
    for (let i = 0; i < f.n; i++) {
      const r = rest[i], m = morph[i], k = morphWeight[i];
      m[0] = r[0];
      m[1] = r[1];
      // Only the mouth and jaw move; small differences elsewhere (nose, eyes, hair) are ignored.
      if (k <= 0) continue;
      for (const { mesh, w } of layers) {
        m[0] += (mesh[i][0] - r[0]) * w * k;
        m[1] += (mesh[i][1] - r[1]) * w * k;
      }
    }
    const still = { ...p, jawOpen: 0, smile: 0, wide: 0, pucker: 0 };
    const pos = this.deform(still, relativePose, true, morph, f.positionsB);
    draw(pos, this.tex, this.uvBuf, 1, 0);
    gl.enable(gl.BLEND);
    // Blend colour only; the canvas itself must stay opaque or the page background shows through.
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Drawn one after another, alphas are chosen so each layer ends up with its own weight.
    let above = layers.reduce((sum, l) => sum + l.w, 0);
    for (const { sm, w } of layers) {
      const alpha = Math.min(1, w / Math.max(1e-6, 1 - (above - w)));
      above -= w;
      if (alpha < 0.02) continue;
      gl.clear(gl.DEPTH_BUFFER_BIT);
      draw(pos, sm.tex, sm.uvBuf, alpha, 0.12, 0, f.indices, sm.gain);
    }
    // Inside the mouth opening the closed-mouth portrait has nothing to show (its lips would only be
    // stretched there), so the opening shows the images alone, in proportion to their weights.
    let sum = 0;
    for (const { sm, w } of layers) {
      sum += w;
      gl.clear(gl.DEPTH_BUFFER_BIT);
      draw(pos, sm.tex, sm.uvBuf, w / sum, 0.12, f.openingStart, f.indices - f.openingStart, sm.gain);
    }
    gl.disable(gl.BLEND);
  }

  // Paints the inside of the mouth over the face while the lips are apart (fading in as they part).
  drawMouth(pt) {
    const ctx = this.mctx;
    const f = this.face;
    ctx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
    const top = pt(13), bottom = pt(14), left = pt(78), right = pt(308);
    const width = Math.hypot(right[0] - left[0], right[1] - left[1]);
    const open = Math.hypot(bottom[0] - top[0], bottom[1] - top[1]);
    if (width < 1) return;
    const alpha = smoothstep(0.03, 0.1, open / width - f.restGap);
    if (alpha <= 0) return;

    const poly = MOUTH_INNER_POLYGON.map(pt);
    const angle = Math.atan2(right[1] - left[1], right[0] - left[0]);
    const mid = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];
    // Vertical position of a point in the mouth's own (rotated) frame.
    const along = ([x, y]) => (x - mid[0]) * Math.sin(-angle) + (y - mid[1]) * Math.cos(-angle);
    const topY = along(top), botY = along(bottom);

    ctx.save();
    ctx.globalAlpha = alpha;
    const outline = new Path2D();
    poly.forEach(([x, y], k) => (k ? outline.lineTo(x, y) : outline.moveTo(x, y)));
    outline.closePath();
    ctx.clip(outline);

    ctx.save();
    ctx.translate(mid[0], mid[1]);
    ctx.rotate(angle);
    const depth = ctx.createRadialGradient(0, (topY + botY) / 2, 0, 0, (topY + botY) / 2, width * 0.6);
    depth.addColorStop(0, '#3d1016');
    depth.addColorStop(1, '#0f0204');
    ctx.fillStyle = depth;
    ctx.fillRect(-width, topY - width, width * 2, width * 2);

    // Tongue, low and towards the back.
    const tongue = ctx.createLinearGradient(0, botY - open * 0.45, 0, botY);
    tongue.addColorStop(0, '#5c1c26');
    tongue.addColorStop(1, '#8e3a46');
    ctx.fillStyle = tongue;
    ctx.beginPath();
    ctx.ellipse(0, botY + open * 0.05, width * 0.26, open * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();

    if (!f.restOpen) {
      // Lower teeth peek out only when the mouth is wide open.
      drawTeeth(ctx, width, botY, -1, 0.08 * width, 0.62);
      drawTeeth(ctx, width, topY, 1, 0.21 * width, 1);
    }
    // Corners and edges recede into shadow.
    const sides = ctx.createLinearGradient(-width / 2, 0, width / 2, 0);
    sides.addColorStop(0, 'rgba(12,2,4,0.85)');
    sides.addColorStop(0.25, 'rgba(12,2,4,0)');
    sides.addColorStop(0.75, 'rgba(12,2,4,0)');
    sides.addColorStop(1, 'rgba(12,2,4,0.85)');
    ctx.fillStyle = sides;
    ctx.fillRect(-width, topY - width, width * 2, width * 2);
    ctx.restore();

    if (f.restOpen) this.drawPhotoTeeth(ctx, pt);
    // Soft shadow just inside the lips.
    ctx.strokeStyle = 'rgba(15,2,5,0.7)';
    ctx.lineWidth = Math.max(2, width * 0.07);
    ctx.filter = `blur(${Math.max(1, width * 0.02)}px)`;
    ctx.stroke(outline);
    ctx.restore();
  }

  // Paints the image's own open mouth, carried by the upper lip (upper teeth sit on the upper jaw).
  // A similarity transform (no shear) keeps the teeth in shape while the lips move.
  drawPhotoTeeth(ctx, pt) {
    const f = this.face;
    const [r78, r308, r13] = [78, 308, 13].map((i) => f.rest[i]);
    const [c78, c308, c13] = [78, 308, 13].map(pt);
    const m = f.mirrored ? -1 : 1;
    const rx = (r308[0] - r78[0]) * m, ry = r308[1] - r78[1];
    const cx = c308[0] - c78[0], cy = c308[1] - c78[1];
    const s = Math.hypot(cx, cy) / (Math.hypot(rx, ry) || 1);
    const theta = Math.atan2(cy, cx) - Math.atan2(ry, rx);
    const a = s * m * Math.cos(theta), b = s * m * Math.sin(theta);
    const c = -s * Math.sin(theta), d = s * Math.cos(theta);
    ctx.save();
    ctx.setTransform(a, b, c, d, c13[0] - (a * r13[0] + c * r13[1]), c13[1] - (b * r13[0] + d * r13[1]));
    ctx.beginPath();
    MOUTH_INNER_POLYGON.forEach((i, k) => (k ? ctx.lineTo(f.rest[i][0], f.rest[i][1]) : ctx.moveTo(f.rest[i][0], f.rest[i][1])));
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(this.source, 0, 0);
    ctx.restore();
  }
}

// A row of teeth hanging from (dir = 1) or standing on (dir = -1) the lip at y, in the mouth's frame.
function drawTeeth(ctx, width, y, dir, height, brightness) {
  const count = 8;
  const span = width * 0.86;
  // Front teeth are wider than the ones towards the corners.
  const weights = Array.from({ length: count }, (_, i) => 1.25 - Math.abs(i - (count - 1) / 2) * 0.12);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = -span / 2;
  for (const w of weights) {
    const tw = (w / total) * span;
    const th = height * (0.75 + 0.25 * (w / 1.25));
    const g = ctx.createLinearGradient(0, y, 0, y + dir * th);
    g.addColorStop(0, `rgba(${Math.round(225 * brightness)},${Math.round(218 * brightness)},${Math.round(206 * brightness)},1)`);
    g.addColorStop(1, `rgba(${Math.round(250 * brightness)},${Math.round(247 * brightness)},${Math.round(240 * brightness)},1)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.roundRect(x + tw * 0.04, dir > 0 ? y - th * 0.3 : y - th, tw * 0.92, th * 1.3, Math.min(tw, th) * 0.35);
    ctx.fill();
    x += tw;
  }
}
