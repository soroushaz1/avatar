// Animates a single portrait image (the user's photo, or the 3D character generated from it):
// a triangle mesh over the face landmarks is warped to follow the webcam or the speech track.
// While the lips are apart, a canvas above the WebGL layer paints the inside of the mouth.
import {
  LIP_UPPER_INNER, LIP_LOWER_INNER, LIP_UPPER_OUTER, LIP_LOWER_OUTER,
  MOUTH_CORNERS_OUTER, MOUTH_CORNERS_INNER, MOUTH_INNER_POLYGON,
  EYE_A, EYE_B, BROW_A, BROW_B, FACE_OVAL, FOREHEAD, CHIN, CHEEK_A, CHEEK_B, FACE_POINT_COUNT,
} from './landmarks.js';
import { mirrorParams } from './face-params.js';

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const VERTEX_SHADER = `
attribute vec3 aPos;
attribute vec2 aUv;
uniform vec4 uView;   // scale.xy, offset.xy (image px -> clip space)
uniform float uDepth;
varying vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = vec4(aPos.xy * uView.xy + uView.zw, clamp(aPos.z * uDepth, -0.99, 0.99), 1.0);
}`;

const FRAGMENT_SHADER = `
precision mediump float;
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }`;

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
      uView: gl.getUniformLocation(prog, 'uView'),
      uDepth: gl.getUniformLocation(prog, 'uDepth'),
    };
    this.posBuf = gl.createBuffer();
    this.uvBuf = gl.createBuffer();
    this.idxBuf = gl.createBuffer();
    this.tex = gl.createTexture();
    this.face = null;
    this.source = null;
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

    const pts = [];
    for (let i = 0; i < FACE_POINT_COUNT; i++) {
      const l = landmarks[i];
      pts.push([l.x * W, l.y * H, l.z * W]);
    }
    const P = (i) => pts[i];
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const faceW = dist(P(CHEEK_A), P(CHEEK_B));
    const faceH = dist(P(FOREHEAD), P(CHIN));
    const mouthW = dist(P(61), P(291));

    // Face-aligned axes (photo may be tilted): ex points from eye A to eye B, ey points down the face.
    const ex0 = [P(263)[0] - P(33)[0], P(263)[1] - P(33)[1]];
    const exl = Math.hypot(...ex0);
    const ex = [ex0[0] / exl, ex0[1] / exl];
    const ey = [-ex[1], ex[0]];

    // Pivot for head rotation: between the cheeks, pushed behind the face.
    const center = [(P(CHEEK_A)[0] + P(CHEEK_B)[0]) / 2, (P(FOREHEAD)[1] + P(CHIN)[1]) / 2];
    const meanZ = FACE_OVAL.reduce((s, i) => s + P(i)[2], 0) / FACE_OVAL.length;
    const pivot = [center[0], center[1] + 0.1 * faceH, meanZ + 0.45 * faceW];

    // Extra points around the face so the warp fades out smoothly, plus the image border (fixed).
    const headWeight = new Array(pts.length).fill(1);
    const ring = (scale, w) => {
      for (const i of FACE_OVAL) {
        const p = P(i);
        const x = Math.min(W - 1, Math.max(1, center[0] + (p[0] - center[0]) * scale));
        const y = Math.min(H - 1, Math.max(1, center[1] + (p[1] - center[1]) * scale));
        pts.push([x, y, pivot[2]]);
        headWeight.push(w);
      }
    };
    ring(1.3, 0.55);
    ring(1.75, 0.2);
    const steps = 8;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      for (const [x, y] of [[t * W, 0], [W, t * H], [W - t * W, H], [0, H - t * H]]) {
        pts.push([x, y, pivot[2] + faceW]);
        headWeight.push(0);
      }
    }

    // Triangulate in 2D. The mesh stays whole: the inside of the mouth is painted over it while the
    // lips are apart, so a closed mouth looks exactly like the original image.
    const flat = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    const indices = Array.from(new window.Delaunator(flat).triangles);

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
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    // Region of the photo to show: head and shoulders.
    const viewH = Math.min(H, faceH * 3.1);
    const viewC = [center[0], Math.min(H - viewH / 2, Math.max(viewH / 2, center[1] + faceH * 0.35))];

    this.face = {
      W, H, rest: pts, n, indices: indices.length, ex, ey, pivot, faceW, faceH, mouthW,
      headWeight, jaw, cornerA, cornerB, browA, browB, lipRound,
      restPose, mirrored, viewH, viewC,
      // An image with the mouth already open keeps its own teeth, attached to the upper lip.
      restOpen: dist(P(13), P(14)) > 0.06 * mouthW,
      restGap: dist(P(13), P(14)) / dist(P(78), P(308)),
      positions: new Float32Array(n * 3),
    };
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
      const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
  }

  // Deforms the rest mesh according to the params (all in photo pixel space).
  // With relativePose the head angles are offsets from the photo's own pose (idle/speech motion).
  // With mouthFromSpeech the jaw opens from the image's own mouth instead of mirroring tracked openness.
  deform(p, relativePose, mouthFromSpeech) {
    const f = this.face;
    const out = f.positions;
    const { ex, ey, mouthW, faceH } = f;
    const jawRef = mouthFromSpeech ? 0 : f.restPose.jawOpen || 0;
    const jaw = Math.max(0, p.jawOpen - jawRef) * 0.45 * mouthW;
    const smile = p.smile, wide = p.wide, pucker = p.pucker;
    const brow = p.browUp * 0.045 * faceH;

    // Relative head rotation since the photo, limited to what a 2D warp can sell.
    const lim = (v, m) => Math.max(-m, Math.min(m, v));
    const rest = relativePose ? { yaw: 0, pitch: 0, roll: 0 } : f.restPose;
    const yaw = lim(p.yaw - rest.yaw, 0.35);
    const pitch = lim(p.pitch - rest.pitch, 0.3);
    const roll = lim(p.roll - rest.roll, 0.35);
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
        const lo = f.rest[eye.lower[k]], up = f.rest[u];
        const d = [(lo[0] - up[0]) * blink * 0.92, (lo[1] - up[1]) * blink * 0.92];
        lidOffsets.set(u, d);
        lidOffsets.set(eye.crease[k], [d[0] * 0.4, d[1] * 0.4]);
      });
    }

    for (let i = 0; i < f.n; i++) {
      const r = f.rest[i];
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

  update(rawParams, dt, { relativePose = false, mouthFromSpeech = false } = {}) {
    if (!this.face) return;
    this.resize();
    const f = this.face;
    // A mirrored image already behaves like a mirror; an un-mirrored one needs mirrored params.
    const p = f.mirrored ? rawParams : mirrorParams(rawParams);
    const pos = this.deform(p, relativePose, mouthFromSpeech);

    // Map photo pixels to clip space: show the head-and-shoulders region, always covering the canvas.
    const cw = this.glCanvas.width, ch = this.glCanvas.height;
    const s = Math.max(ch / f.viewH, cw / f.W, ch / f.H); // photo px -> canvas px
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
    gl.useProgram(this.prog);
    gl.uniform4f(this.loc.uView, sxClip, syClip, oxClip, oyClip);
    gl.uniform1f(this.loc.uDepth, 1 / (f.faceW * 4));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(this.loc.aPos);
    gl.vertexAttribPointer(this.loc.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvBuf);
    gl.enableVertexAttribArray(this.loc.aUv);
    gl.vertexAttribPointer(this.loc.aUv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.drawElements(gl.TRIANGLES, f.indices, gl.UNSIGNED_SHORT, 0);

    const toCanvas = (x, y) => [(x * sxClip + oxClip + 1) / 2 * cw, (1 - (y * syClip + oyClip)) / 2 * ch];
    this.drawMouth((i) => toCanvas(pos[i * 3], pos[i * 3 + 1]));
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
