// Animates a single portrait image (the user's photo, or the 3D character generated from it):
// a triangle mesh over the face landmarks is warped to follow the webcam or the speech track.
// The mouth is a hole in the mesh; a canvas behind the WebGL layer draws the inside of the mouth.
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

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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

    // Triangulate in 2D, then cut out the mouth so it can open.
    const flat = new Float64Array(pts.length * 2);
    pts.forEach((p, i) => { flat[i * 2] = p[0]; flat[i * 2 + 1] = p[1]; });
    const tri = new window.Delaunator(flat).triangles;
    const upper = new Set(LIP_UPPER_INNER), lower = new Set(LIP_LOWER_INNER);
    const mouthPoly = MOUTH_INNER_POLYGON.map((i) => P(i));
    const indices = [];
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t], b = tri[t + 1], c = tri[t + 2];
      const vs = [a, b, c];
      const spansGap = vs.some((v) => upper.has(v)) && vs.some((v) => lower.has(v));
      const cx = (pts[a][0] + pts[b][0] + pts[c][0]) / 3, cy = (pts[a][1] + pts[b][1] + pts[c][1]) / 3;
      if (spansGap || pointInPolygon(cx, cy, mouthPoly)) continue;
      indices.push(a, b, c);
    }

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
      else if (upperLip.has(i)) jaw[i] = -0.06;
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
  deform(p, relativePose) {
    const f = this.face;
    const out = f.positions;
    const { ex, ey, mouthW, faceH } = f;
    const jaw = Math.max(0, p.jawOpen - (f.restPose.jawOpen || 0)) * 0.55 * mouthW;
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

  update(rawParams, dt, { relativePose = false } = {}) {
    if (!this.face) return;
    this.resize();
    const f = this.face;
    // A mirrored image already behaves like a mirror; an un-mirrored one needs mirrored params.
    const p = f.mirrored ? rawParams : mirrorParams(rawParams);
    const pos = this.deform(p, relativePose);

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

  // Mouth interior seen through the hole in the mesh.
  drawMouth(pt) {
    const ctx = this.mctx;
    ctx.clearRect(0, 0, this.mouthCanvas.width, this.mouthCanvas.height);
    const poly = MOUTH_INNER_POLYGON.map(pt);
    const top = pt(13), bottom = pt(14), left = pt(78), right = pt(308);
    const open = Math.hypot(bottom[0] - top[0], bottom[1] - top[1]);
    if (open < 0.5) return;
    const width = Math.hypot(right[0] - left[0], right[1] - left[1]);
    const angle = Math.atan2(right[1] - left[1], right[0] - left[0]);
    const mid = [(left[0] + right[0]) / 2, (left[1] + right[1]) / 2];

    ctx.save();
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    // Stroke as well so no background shows at the lip edges.
    ctx.lineWidth = 2;
    ctx.fillStyle = '#2a0c10';
    ctx.strokeStyle = '#2a0c10';
    ctx.fill();
    ctx.stroke();
    ctx.clip();

    ctx.translate(mid[0], mid[1]);
    ctx.rotate(angle);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 0.6);
    g.addColorStop(0, '#4a1219');
    g.addColorStop(1, '#16050a');
    ctx.fillStyle = g;
    ctx.fillRect(-width, -width, width * 2, width * 2);

    const rel = ([x, y]) => (x - mid[0]) * Math.sin(-angle) + (y - mid[1]) * Math.cos(-angle);
    const topY = rel(top), botY = rel(bottom);
    // Tongue, lower teeth, upper teeth.
    ctx.fillStyle = '#a8454f';
    ctx.beginPath();
    ctx.ellipse(0, botY + open * 0.1, width * 0.3, open * 0.38, 0, 0, Math.PI * 2);
    ctx.fill();
    const toothH = Math.min(width * 0.12, open * 0.45);
    if (!this.face.restOpen) {
      const teeth = ctx.createLinearGradient(0, topY, 0, topY + toothH);
      teeth.addColorStop(0, '#d9d2c8');
      teeth.addColorStop(1, '#f4f0ea');
      ctx.fillStyle = teeth;
      ctx.fillRect(-width * 0.42, topY - 2, width * 0.84, toothH + 2);
      ctx.strokeStyle = 'rgba(120,100,90,0.35)';
      ctx.lineWidth = Math.max(1, width * 0.008);
      for (let k = -3; k <= 3; k++) {
        const x = k * width * 0.095;
        ctx.beginPath();
        ctx.moveTo(x, topY);
        ctx.lineTo(x, topY + toothH);
        ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(225,218,208,0.55)';
    ctx.fillRect(-width * 0.32, botY - Math.min(width * 0.05, open * 0.18), width * 0.64, width * 0.05);
    ctx.restore();
    if (this.face.restOpen) this.drawPhotoTeeth(ctx, pt, poly);
  }

  // Paints the image's own open mouth, following the upper lip (upper teeth sit on the upper jaw).
  drawPhotoTeeth(ctx, pt, poly) {
    const f = this.face;
    const src = [78, 308, 13].map((i) => f.rest[i]);
    const dst = [78, 308, 13].map(pt);
    const [[x0, y0], [x1, y1], [x2, y2]] = src;
    const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(det) < 1e-6) return;
    // Affine map (photo px -> canvas px) through the two mouth corners and the upper lip centre.
    const solve = (u0, u1, u2) => [
      ((u1 - u0) * (y2 - y0) - (u2 - u0) * (y1 - y0)) / det,
      ((u2 - u0) * (x1 - x0) - (u1 - u0) * (x2 - x0)) / det,
    ];
    const [a, c] = solve(dst[0][0], dst[1][0], dst[2][0]);
    const [b, d] = solve(dst[0][1], dst[1][1], dst[2][1]);
    const e = dst[0][0] - a * x0 - c * y0;
    const g = dst[0][1] - b * x0 - d * y0;
    ctx.save();
    ctx.beginPath();
    poly.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(a, b, c, d, e, g);
    ctx.beginPath();
    MOUTH_INNER_POLYGON.forEach((i, k) => (k ? ctx.lineTo(f.rest[i][0], f.rest[i][1]) : ctx.moveTo(f.rest[i][0], f.rest[i][1])));
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(this.source, 0, 0);
    ctx.restore();
  }
}
