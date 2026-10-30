// Procedural 3D cartoon characters driven by face params (three.js).
import * as THREE from '/vendor/three/three.module.js';
import { mirrorParams } from './face-params.js';


const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0, ...extra });

function mesh(geometry, material, { pos = [0, 0, 0], scale = [1, 1, 1], rot = [0, 0, 0] } = {}) {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(...pos);
  m.scale.set(...scale);
  m.rotation.set(...rot);
  return m;
}

const sphere = (r, material, opts) => mesh(new THREE.SphereGeometry(r, 48, 32), material, opts);

function roundedBox(w, h, d, r, material) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y);
  s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r);
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r);
  s.quadraticCurveTo(x, y, x + r, y);
  const bevel = Math.min(r, d) * 0.4;
  const g = new THREE.ExtrudeGeometry(s, { depth: d - bevel * 2, bevelEnabled: true, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 6, curveSegments: 16 });
  g.translate(0, 0, -(d - bevel * 2) / 2);
  return new THREE.Mesh(g, material);
}

// Mouth drawn on a canvas so it can take any shape cheaply every frame.
class MouthTexture {
  constructor(style, colors) {
    this.style = style;
    this.colors = colors;
    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 176;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.time = 0;
  }

  draw(p, dt) {
    this.time += dt;
    if (this.style === 'led') this.drawLed(p);
    else this.drawOrganic(p);
    this.texture.needsUpdate = true;
  }

  drawOrganic(p) {
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const c = this.colors;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H * 0.32;
    const halfW = W * 0.27 * (1 + 0.25 * p.smile + 0.2 * p.wide - 0.45 * p.pucker);
    const open = H * 0.55 * p.jawOpen * (1 + 0.25 * p.pucker);
    const lift = H * 0.14 * p.smile - H * 0.04 * p.pucker;
    const lx = cx - halfW, rx = cx + halfW, ly = cy - lift;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (open < 3) {
      ctx.strokeStyle = c.lip;
      ctx.lineWidth = 11;
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.quadraticCurveTo(cx, cy + H * 0.06 + H * 0.12 * p.smile, rx, ly);
      ctx.stroke();
      return;
    }

    const path = new Path2D();
    path.moveTo(lx, ly);
    path.bezierCurveTo(cx - halfW * 0.5, cy - open * 0.18, cx + halfW * 0.5, cy - open * 0.18, rx, ly);
    path.bezierCurveTo(cx + halfW * 0.8, cy + open * 1.25 + lift, cx - halfW * 0.8, cy + open * 1.25 + lift, lx, ly);
    path.closePath();

    const g = ctx.createLinearGradient(0, cy, 0, cy + open);
    g.addColorStop(0, '#3b0c18');
    g.addColorStop(1, '#18040a');
    ctx.fillStyle = g;
    ctx.fill(path);

    ctx.save();
    ctx.clip(path);
    ctx.fillStyle = '#fbf7f0';
    ctx.fillRect(cx - halfW * 0.75, cy - open * 0.3, halfW * 1.5, Math.max(4, Math.min(open * 0.42, H * 0.13)) + open * 0.3);
    ctx.fillStyle = '#e0687a';
    ctx.beginPath();
    ctx.ellipse(cx, cy + open * 1.12 + lift, halfW * 0.62, open * 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = c.lip;
    ctx.lineWidth = 9;
    ctx.stroke(path);
  }

  drawLed(p) {
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.clearRect(0, 0, W, H);
    const bars = 11;
    const gap = 6;
    const span = W * (0.62 + 0.22 * p.wide + 0.12 * p.smile - 0.3 * p.pucker);
    const bw = (span - gap * (bars - 1)) / bars;
    const x0 = (W - span) / 2;
    const cy = H * 0.45;
    ctx.shadowColor = this.colors.glow;
    ctx.shadowBlur = 14;
    ctx.fillStyle = this.colors.glow;
    for (let i = 0; i < bars; i++) {
      const u = (i - (bars - 1) / 2) / ((bars - 1) / 2); // -1..1
      const envelope = Math.exp(-u * u * (1.6 + 2.5 * p.pucker));
      const wobble = 0.75 + 0.25 * Math.sin(this.time * 18 + i * 1.7);
      const h = 7 + p.jawOpen * H * 0.75 * envelope * wobble;
      const curve = -p.smile * 22 * u * u;
      ctx.beginPath();
      ctx.roundRect(x0 + i * (bw + gap), cy - h / 2 + curve, bw, h, Math.min(bw / 2, 5));
      ctx.fill();
    }
    ctx.shadowBlur = 0;
  }
}

function makeEye({ r = 0.17, iris = '#3b2a1a', style = 'cartoon' }) {
  const eye = new THREE.Group();
  const look = new THREE.Group();
  eye.add(look);
  if (style === 'cartoon') {
    eye.add(sphere(r, std('#ffffff', { roughness: 0.25 })));
    look.add(sphere(r * 0.58, std(iris, { roughness: 0.3 }), { pos: [0, 0, r * 0.62], scale: [1, 1, 0.55] }));
    look.add(sphere(r * 0.3, std('#0b0b10', { roughness: 0.2 }), { pos: [0, 0, r * 0.86], scale: [1, 1, 0.5] }));
    look.add(sphere(r * 0.13, new THREE.MeshBasicMaterial({ color: '#ffffff' }), { pos: [r * 0.22, r * 0.25, r * 0.95] }));
  } else if (style === 'black') {
    look.add(sphere(r, std('#0a0a12', { roughness: 0.08, metalness: 0.2 }), { scale: [1, 0.62, 0.45] }));
    look.add(sphere(r * 0.16, new THREE.MeshBasicMaterial({ color: '#ffffff' }), { pos: [r * 0.3, r * 0.18, r * 0.42] }));
  } else if (style === 'led') {
    look.add(mesh(new THREE.CapsuleGeometry(r * 0.55, r * 0.7, 8, 24), new THREE.MeshBasicMaterial({ color: iris })));
  }
  eye.userData.r = r;
  eye.userData.style = style;
  eye.userData.look = look;
  return eye;
}

function buildFox() {
  const skin = std('#f08a3c'), cream = std('#fff1e2'), dark = std('#2a1a14', { roughness: 0.35 });
  const head = new THREE.Group();
  head.add(sphere(1, skin, { scale: [1.08, 0.95, 0.95] }));
  head.add(sphere(0.42, cream, { pos: [-0.66, -0.34, 0.32], scale: [0.9, 0.7, 0.7] }));
  head.add(sphere(0.42, cream, { pos: [0.66, -0.34, 0.32], scale: [0.9, 0.7, 0.7] }));
  head.add(sphere(0.5, cream, { pos: [0, -0.36, 0.6], scale: [1.05, 0.74, 0.9] }));
  head.add(sphere(0.11, dark, { pos: [0, -0.13, 1.05], scale: [1.35, 0.9, 1] }));
  for (const s of [-1, 1]) {
    head.add(mesh(new THREE.ConeGeometry(0.36, 0.95, 32), skin, { pos: [s * 0.6, 0.98, -0.05], rot: [0, 0, -s * 0.38] }));
    head.add(mesh(new THREE.ConeGeometry(0.22, 0.6, 32), cream, { pos: [s * 0.57, 0.9, 0.1], rot: [0, 0, -s * 0.38] }));
  }
  const body = new THREE.Group();
  body.add(mesh(new THREE.CapsuleGeometry(0.78, 0.7, 12, 32), skin, { pos: [0, -2.05, -0.15] }));
  body.add(sphere(0.55, cream, { pos: [0, -1.85, 0.35], scale: [1, 1.1, 0.6] }));
  return {
    head, body,
    eyes: { pos: [[-0.36, 0.13, 0.8], [0.36, 0.13, 0.8]], opts: { r: 0.17, iris: '#c9780f' } },
    brows: { color: '#fff1e2', pos: [[-0.36, 0.42, 0.86], [0.36, 0.42, 0.86]] },
    mouth: { style: 'organic', colors: { lip: '#2a1a14' }, pos: [0, -0.5, 1.04], size: [0.7, 0.48], tilt: 0.35 },
  };
}

function buildBear() {
  const fur = std('#8a5a3b'), light = std('#e7c9a3'), dark = std('#1d1410', { roughness: 0.35 });
  const head = new THREE.Group();
  head.add(sphere(1, fur, { scale: [1.08, 0.98, 0.95] }));
  head.add(sphere(0.46, light, { pos: [0, -0.34, 0.66], scale: [1.1, 0.78, 0.85] }));
  head.add(sphere(0.14, dark, { pos: [0, -0.12, 1.05], scale: [1.4, 0.95, 0.9] }));
  for (const s of [-1, 1]) {
    head.add(sphere(0.32, fur, { pos: [s * 0.72, 0.78, -0.05], scale: [1, 1, 0.6] }));
    head.add(sphere(0.19, light, { pos: [s * 0.72, 0.78, 0.1], scale: [1, 1, 0.5] }));
  }
  const body = new THREE.Group();
  body.add(mesh(new THREE.CapsuleGeometry(0.85, 0.65, 12, 32), fur, { pos: [0, -2.08, -0.15] }));
  body.add(sphere(0.55, light, { pos: [0, -1.95, 0.4], scale: [1, 1.05, 0.55] }));
  return {
    head, body,
    eyes: { pos: [[-0.34, 0.16, 0.82], [0.34, 0.16, 0.82]], opts: { r: 0.14, iris: '#2b1a10' } },
    brows: { color: '#4a2e1e', pos: [[-0.34, 0.42, 0.88], [0.34, 0.42, 0.88]] },
    mouth: { style: 'organic', colors: { lip: '#1d1410' }, pos: [0, -0.5, 1.04], size: [0.6, 0.42], tilt: 0.35 },
  };
}

function buildRobot() {
  const metal = std('#c7d2e6', { roughness: 0.35, metalness: 0.25 });
  const accent = std('#ff9f43', { roughness: 0.4 });
  const glass = std('#0c1222', { roughness: 0.12, metalness: 0.1 });
  const head = new THREE.Group();
  head.add(roundedBox(2.0, 1.75, 1.5, 0.42, metal));
  const plate = roundedBox(1.62, 1.2, 0.12, 0.3, glass);
  plate.position.set(0, -0.02, 0.72);
  head.add(plate);
  for (const s of [-1, 1]) {
    head.add(mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.22, 32), accent, { pos: [s * 1.08, 0, 0], rot: [0, 0, Math.PI / 2] }));
  }
  head.add(mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.55, 12), metal, { pos: [0, 1.12, 0] }));
  const bulb = sphere(0.12, new THREE.MeshBasicMaterial({ color: '#ff5d8f' }), { pos: [0, 1.42, 0] });
  head.add(bulb);
  const body = new THREE.Group();
  const torso = roundedBox(1.7, 1.3, 1.1, 0.35, metal);
  torso.position.set(0, -1.95, -0.1);
  body.add(torso);
  body.add(mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.06, 32), accent, { pos: [0, -1.8, 0.47], rot: [Math.PI / 2, 0, 0] }));
  return {
    head, body, bulb,
    eyes: { pos: [[-0.38, 0.17, 0.8], [0.38, 0.17, 0.8]], opts: { r: 0.18, iris: '#5ef2ff', style: 'led' } },
    brows: null,
    mouth: { style: 'led', colors: { glow: '#5ef2ff' }, pos: [0, -0.3, 0.8], size: [0.95, 0.5], tilt: 0 },
  };
}

function buildAlien() {
  const skin = std('#79d65a', { roughness: 0.45 });
  const collar = std('#7b5cff', { roughness: 0.4 });
  const head = new THREE.Group();
  head.add(sphere(1, skin, { scale: [1.0, 1.12, 0.92] }));
  for (const s of [-1, 1]) {
    head.add(mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.6, 10), skin, { pos: [s * 0.35, 1.25, 0], rot: [0, 0, -s * 0.35] }));
    head.add(sphere(0.09, std('#ffe05e', { emissive: '#665500' }), { pos: [s * 0.46, 1.53, 0] }));
  }
  const body = new THREE.Group();
  body.add(mesh(new THREE.CapsuleGeometry(0.62, 0.8, 12, 32), skin, { pos: [0, -2.1, -0.1] }));
  body.add(mesh(new THREE.TorusGeometry(0.55, 0.12, 16, 48), collar, { pos: [0, -1.38, -0.1], rot: [Math.PI / 2, 0, 0] }));
  return {
    head, body,
    eyes: { pos: [[-0.4, 0.05, 0.74], [0.4, 0.05, 0.74]], opts: { r: 0.32, style: 'black' }, tilt: 0.42 },
    brows: null,
    mouth: { style: 'organic', colors: { lip: '#2f6b22' }, pos: [0, -0.58, 0.8], size: [0.5, 0.35], tilt: 0.45 },
  };
}

const BUILDERS = { fox: buildFox, robot: buildRobot, alien: buildAlien, bear: buildBear };

export class FantasyAvatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);

    this.scene.add(new THREE.HemisphereLight('#ffffff', '#4a3b66', 1.6));
    const key = new THREE.DirectionalLight('#fff4e8', 2.4);
    key.position.set(3, 4, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#8fb4ff', 1.6);
    rim.position.set(-4, 2, -5);
    this.scene.add(rim);

    this.root = new THREE.Group();
    this.scene.add(this.root);
    this.time = 0;
    this.setCharacter('fox');
  }

  setCharacter(id) {
    if (this.rig) {
      this.root.remove(this.rig.group);
      this.rig.group.traverse((o) => {
        o.geometry?.dispose();
        if (o.material) {
          o.material.map?.dispose();
          o.material.dispose();
        }
      });
    }
    const spec = (BUILDERS[id] || buildFox)();
    const group = new THREE.Group();
    const headPivot = new THREE.Group(); // rotates around the neck
    headPivot.position.y = -0.8;
    spec.head.position.y = 0.8;
    headPivot.add(spec.head);
    group.add(spec.body, headPivot);

    const eyes = spec.eyes.pos.map((pos, i) => {
      const e = makeEye(spec.eyes.opts);
      e.position.set(...pos);
      if (spec.eyes.tilt) e.rotation.z = (i === 0 ? 1 : -1) * spec.eyes.tilt;
      e.userData.baseRotZ = e.rotation.z;
      spec.head.add(e);
      return e;
    });

    const brows = spec.brows?.pos.map((pos, i) => {
      const b = mesh(new THREE.CapsuleGeometry(0.045, 0.2, 6, 12), std(spec.brows.color), { pos, rot: [0, 0, Math.PI / 2] });
      b.userData.baseY = pos[1];
      b.userData.side = i === 0 ? -1 : 1;
      spec.head.add(b);
      return b;
    }) || [];

    const mouthTex = new MouthTexture(spec.mouth.style, spec.mouth.colors);
    const mouth = new THREE.Mesh(
      new THREE.PlaneGeometry(...spec.mouth.size),
      new THREE.MeshBasicMaterial({ map: mouthTex.texture, transparent: true, depthWrite: false }),
    );
    mouth.position.set(...spec.mouth.pos);
    mouth.rotation.x = -spec.mouth.tilt;
    mouth.renderOrder = 1;
    spec.head.add(mouth);

    this.rig = { id, group, headPivot, head: spec.head, body: spec.body, eyes, brows, mouthTex, bulb: spec.bulb };
    this.root.add(group);
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Pull back on narrow (portrait) screens so the head always fits.
    const dist = 9.4 / Math.min(1, Math.max(0.55, this.camera.aspect));
    this.camera.position.set(0, -0.1, dist);
    this.camera.lookAt(0, -0.55, 0);
    this.camera.updateProjectionMatrix();
  }

  update(rawParams, dt) {
    this.time += dt;
    const p = mirrorParams(rawParams);
    const rig = this.rig;
    this.resize();

    const lim = (v, m) => Math.max(-m, Math.min(m, v));
    rig.headPivot.rotation.set(lim(p.pitch, 0.6), lim(p.yaw, 0.8), lim(p.roll, 0.6), 'YXZ');
    rig.body.rotation.y = lim(p.yaw, 0.8) * 0.25;
    this.root.position.x = lim(p.tx, 1) * 0.35;
    this.root.position.y = Math.sin(this.time * 1.7) * 0.025;

    rig.eyes.forEach((eye, i) => {
      const blink = i === 0 ? p.blinkA : p.blinkB;
      eye.scale.y = Math.max(0.08, 1 - blink * 0.95);
      const look = eye.userData.look;
      if (eye.userData.style === 'led') look.position.set(p.lookX * 0.06, p.lookY * 0.04, 0);
      else look.rotation.set(-p.lookY * 0.35, p.lookX * 0.45, 0);
    });

    rig.brows.forEach((b) => {
      b.position.y = b.userData.baseY + p.browUp * 0.13;
      b.rotation.z = Math.PI / 2 + b.userData.side * -p.browUp * 0.18;
    });

    if (rig.bulb) rig.bulb.scale.setScalar(1 + p.jawOpen * 0.6);
    rig.mouthTex.draw(p, dt);
    this.renderer.render(this.scene, this.camera);
  }
}
