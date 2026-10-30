import { api } from './api.js';
import { FaceTracker, detectImage, loadFaceAssets } from './tracker.js';
import { createParams, paramsFromResult, smoothParams, IdleAnimator } from './face-params.js';
import { FaceAvatar } from './face-avatar.js';
import { Speaker, unlockAudio, detectLang, createRecordingDestination } from './speech.js';
import { MouthSamples, saveSampleSet, loadSampleSet } from './mouth-samples.js';
import { VISEME_IDS, visemeOfBlendshapes } from './visemes.js';
import { VideoRecorder, VIDEO_FPS, buildCaptions, canRecordVideo } from './recorder.js';
import { t, lang, setLanguage, applyLanguage, formatNumber, formatDate, formatDuration } from './i18n.js';

const $ = (id) => document.getElementById(id);

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
  },
};

const STYLE_ICONS = { animated: '🎬', elf: '🧝', hero: '🦸', anime: '🌸' };
const CHARACTER_ICONS = { fox: '🦊', robot: '🤖', alien: '👽', bear: '🐻' };
const CHARACTERS = Object.keys(CHARACTER_ICONS);

const state = {
  user: null,
  plans: [],
  voices: [],
  mode: store.get('avatar.mode', 'fantasy'),
  // An AI style id (a 3D character generated from the user's face) or "char:<id>" for a ready-made character.
  look: store.get('avatar.look', 'animated'),
  styles: [],
  generationAvailable: true,
  consent: store.get('avatar.consent', false),
  showPreview: store.get('avatar.preview', true),
  faceVisible: false,
  cameraError: null,
  modelProgress: 0,
  modelError: false,
  // Portraits the avatar can animate: the user's photo and the characters generated from it.
  real: null,
  generated: {},
  generating: null,
  // The user's photo has part of the head cut off or is tilted (Gemini can complete it); completing it now.
  realIncomplete: false,
  completing: false,
  generationError: null,
  afterLogin: null,
  authTab: 'login',
  // While a video is being recorded: { recorder, cancelled }.
  recording: null,
};

const video = $('video');
const tracker = new FaceTracker(video);
// The ready-made 3D characters (three.js, ~300 KB) are only loaded when someone picks one.
let characters = null;
let charactersPromise = null;
function showCharacter(id) {
  charactersPromise ??= import('./fantasy.js').then(({ FantasyAvatar }) => (characters = new FantasyAvatar($('char-canvas'))));
  charactersPromise.then((c) => c.setCharacter(id));
}
let faceAvatar = null;
try {
  faceAvatar = new FaceAvatar($('face-canvas'), $('mouth-canvas'));
} catch (err) {
  console.warn('Face avatar unavailable', err);
}
const speaker = new Speaker();
// Real frames of the user's mouth, collected while they talk to the camera (for the realistic avatar).
const mouths = new MouthSamples();

const usesCharacter = () => state.mode === 'fantasy' && state.look.startsWith('char:');
// The portrait that should be on screen right now (null while it still has to be captured/created).
const wantedPortrait = () => (usesCharacter() ? null : state.mode === 'realistic' ? state.real : state.generated[state.look] || null);
const needsCapture = () => !usesCharacter() && !state.real;

// ---------- small UI helpers ----------
let toastTimer = null;
function toast(message, kind = '', ms = 4500) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setStatus(text) {
  const el = $('status');
  el.hidden = !text;
  el.textContent = text || '';
}

function showOverlay({ title, text, actions = [], busy = false }) {
  $('overlay-title').textContent = title;
  $('overlay-text').textContent = text;
  $('overlay-actions').replaceChildren(...actions.map((a) => {
    const b = document.createElement('button');
    b.className = `btn ${a.primary ? 'primary' : 'ghost'}`;
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    return b;
  }));
  $('overlay').classList.toggle('busy', busy);
  $('overlay').hidden = false;
}

function hideOverlay() {
  $('overlay').hidden = true;
}

function setLoading(btn, on) {
  btn.disabled = on;
  btn.classList.toggle('loading', on);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function imageToCanvas(img, maxSize = 1024) {
  const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  const s = Math.min(1, maxSize / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * s);
  c.height = Math.round(h * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// ---------- camera ----------
function renderCamera() {
  const on = tracker.cameraOn;
  $('btn-camera').textContent = t(on ? 'turn_off' : 'turn_on');
  $('camera-state').textContent = t(on ? (state.faceVisible ? 'camera_face' : 'camera_searching') : 'camera_off');
  $('btn-preview').hidden = !on || needsCapture();
  $('btn-preview').textContent = t(state.showPreview ? 'hide_camera' : 'show_camera');
}

const CAMERA_ERRORS = {
  NotAllowedError: 'err_blocked',
  NotFoundError: 'err_notfound',
  NotReadableError: 'err_busy',
  NotSupportedError: 'err_unsupported',
};

async function startCamera() {
  state.cameraError = null;
  $('btn-camera').disabled = true;
  setStatus(t('starting_camera'));
  try {
    if (!window.isSecureContext) throw Object.assign(new Error('insecure'), { name: 'NotSupportedError' });
    await tracker.startCamera();
  } catch (err) {
    console.warn('Camera error', err);
    tracker.stopCamera();
    state.cameraError = CAMERA_ERRORS[err.name] || 'err_camera';
  } finally {
    $('btn-camera').disabled = false;
    setStatus('');
    renderStage();
  }
}

// Face tracking (~6 MB, cached after the first visit) starts downloading as soon as the page opens.
function loadTracking() {
  state.modelError = false;
  renderStage();
  tracker.loadModel()
    .catch((err) => {
      console.warn('Face tracking failed to load', err);
      state.modelError = true;
    })
    .finally(() => {
      setStatus('');
      renderStage();
    });
}

loadFaceAssets((p) => {
  state.modelProgress = p;
  // While an avatar is already on screen, show progress in the corner instead of the capture guide.
  if (!needsCapture() && tracker.cameraOn && !tracker.ready) {
    setStatus(t('loading_model', { pct: formatNumber(Math.round(p * 100)) }));
  }
}).catch(() => {});

$('btn-camera').addEventListener('click', () => {
  if (tracker.cameraOn) {
    tracker.stopCamera();
    state.faceVisible = false;
    renderStage();
  } else {
    startCamera();
  }
});

$('btn-preview').addEventListener('click', () => {
  state.showPreview = !state.showPreview;
  store.set('avatar.preview', state.showPreview);
  renderStage();
});

// ---------- stage: which layers and messages are visible ----------
let shownPortrait = null;

// Shows the wanted portrait on the face canvas, or the user's photo while a character is being made.
function syncPortrait() {
  const portrait = wantedPortrait() || (!usesCharacter() ? state.real : null);
  if (!faceAvatar || portrait === shownPortrait) return;
  shownPortrait = portrait;
  if (portrait) faceAvatar.setFace(portrait.canvas, portrait.landmarks, portrait.restPose, portrait.mirrored);
  else faceAvatar.clear();
  // A small copy is enough for the blurred background.
  const bg = $('stage-bg');
  if (portrait) {
    const small = document.createElement('canvas');
    small.width = 48;
    small.height = Math.max(1, Math.round((48 * portrait.canvas.height) / portrait.canvas.width));
    small.getContext('2d').drawImage(portrait.canvas, 0, 0, small.width, small.height);
    bg.style.backgroundImage = `url(${small.toDataURL('image/jpeg', 0.8)})`;
    bg.style.transform = portrait.mirrored ? 'scaleX(-1)' : '';
  } else {
    bg.style.backgroundImage = '';
  }
}

// While the realistic avatar records the user's mouth shapes, the stage shows the live camera so the
// user sees their own mouth; otherwise it shows the avatar.
const showsLiveCamera = () => coachActive();
let liveCameraShown = false;

// Once made, the avatar does not copy the camera, so the camera is only needed to capture the face
// and, for the realistic avatar, to record the mouth shapes. It turns on when it becomes needed and
// off when it no longer is (the camera button still works in between).
function cameraNeeded() {
  if (usesCharacter()) return false;
  if (!state.real) return true;
  return state.mode === 'realistic' && (!mouths.ready || (tracker.cameraOn && !!nextCoachTarget()));
}

let cameraWasNeeded = null;
function syncCamera() {
  const needed = cameraNeeded();
  if (needed === cameraWasNeeded) return;
  cameraWasNeeded = needed;
  if (needed && !tracker.cameraOn && !state.cameraError) {
    startCamera();
  } else if (!needed && tracker.cameraOn) {
    tracker.stopCamera();
    state.faceVisible = false;
  }
}

function renderStage() {
  syncCamera();
  syncPortrait();
  const charMode = usesCharacter();
  const capturing = needsCapture();
  liveCameraShown = showsLiveCamera();
  const live = (capturing && tracker.cameraOn && !!faceAvatar) || liveCameraShown;

  $('stage').dataset.mode = state.mode;
  $('stage').classList.toggle('recording', !!state.recording);
  $('rec-badge').hidden = !state.recording;
  $('char-canvas').hidden = !charMode;
  for (const id of ['face-canvas', 'mouth-canvas', 'stage-bg']) $(id).hidden = charMode || !faceAvatar?.ready || liveCameraShown;
  video.hidden = !tracker.cameraOn || (!live && !state.showPreview);
  video.classList.toggle('live', live);
  $('guide').hidden = !(capturing && live);
  renderCoach();

  document.querySelectorAll('.mode-btn').forEach((b) => {
    const active = b.dataset.mode === state.mode;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $('style-card').hidden = state.mode !== 'fantasy';
  $('btn-reset-face').hidden = !state.real;
  $('btn-capture').textContent = t(state.real ? 'capture_again' : 'capture_from_camera');
  $('btn-regenerate').hidden = charMode || !state.generated[state.look] || !!state.generating;

  renderOverlay(capturing);
  renderCamera();
}

// The realistic avatar talks with real frames of the user's mouth, one per mouth shape (viseme).
// The coach asks for the shapes one at a time; shapes seen while the user talks are kept as well.
const COACH_ORDER = ['AW', 'AA', 'E', 'I', 'O', 'U', 'FF', 'SS'];
const coach = { target: null, since: 0, held: 0, skipped: new Set() };
const nextCoachTarget = () => COACH_ORDER.find((id) => !mouths.set[id] && !coach.skipped.has(id)) || null;
const coachActive = () => state.mode === 'realistic' && !!state.real && tracker.cameraOn && tracker.ready
  && !speaker.speaking && !state.recording && !!nextCoachTarget();

let mouthsWereReady = false;
function renderCoach() {
  const show = coachActive();
  $('coach').hidden = !show;
  if (show) {
    const want = nextCoachTarget();
    $('coach-title').textContent = t('coach_title', { n: formatNumber(mouths.count), total: formatNumber(VISEME_IDS.length) });
    $('coach-text').textContent = t('coach_say', { sound: t(`viseme_${want}`) });
    $('coach-dots').replaceChildren(...COACH_ORDER.map((id) => {
      const dot = document.createElement('span');
      dot.className = mouths.set[id] ? 'done' : id === want ? 'now' : '';
      return dot;
    }));
  }
  if (mouths.ready && !mouthsWereReady && state.mode === 'realistic') toast(t('samples_ready'), 'ok', 6000);
  mouthsWereReady = mouths.ready;
}

let mouthsSaveTimer = null;
let mouthsApplied = null;
function onMouthSamplesChanged() {
  clearTimeout(mouthsSaveTimer);
  mouthsSaveTimer = setTimeout(() => mouths.save(), 3000);
  renderStage();
}

function collectMouthSamples(landmarks, shapes, p, now, dt) {
  const id = visemeOfBlendshapes(shapes);
  let changed = false;
  if (coachActive()) {
    const want = nextCoachTarget();
    if (want !== coach.target) {
      Object.assign(coach, { target: want, since: now, held: 0 });
      renderStage();
    }
    // A frame counts when it is recognized as the requested shape or, after a moment, when the user
    // clearly holds some open shape (people form sounds differently).
    coach.held = id ? coach.held + dt : 0;
    if (id === want || (now - coach.since > 2500 && coach.held > 0.6)) {
      changed = mouths.offer(video, landmarks, shapes, p, now, want);
    } else if (now - coach.since > 12000) {
      coach.skipped.add(want); // a similar shape stands in for it
      renderStage();
    }
  }
  if (!changed && id) changed = mouths.offer(video, landmarks, shapes, p, now);
  if (changed) onMouthSamplesChanged();
}

function renderOverlay(capturing) {
  const upload = { label: t('upload_photo'), onClick: () => $('file-input').click() };
  if (capturing && !faceAvatar) {
    return showOverlay({ title: t('no_webgl_title'), text: t('no_webgl_text') });
  }
  if (capturing && state.cameraError) {
    return showOverlay({
      title: t(`${state.cameraError}_title`),
      text: t(`${state.cameraError}_text`),
      actions: [{ label: t('try_again'), primary: true, onClick: () => startCamera() }, upload],
    });
  }
  if (state.modelError && (capturing || tracker.cameraOn)) {
    return showOverlay({
      title: t('model_error_title'),
      text: t('model_error_text'),
      actions: [{ label: t('try_again'), primary: true, onClick: () => loadTracking() }, upload],
    });
  }
  if (capturing && !tracker.cameraOn) {
    return showOverlay({
      title: t('create_avatar_title'),
      text: t('create_avatar_text'),
      actions: [{ label: t('turn_on_camera'), primary: true, onClick: () => startCamera() }, upload],
    });
  }
  if (!capturing && state.mode === 'realistic' && state.real) {
    if (state.completing) return showOverlay({ title: t('completing_title'), text: t('completing_text'), busy: true });
    if (state.realIncomplete && state.generationAvailable) {
      return showOverlay({
        title: t('incomplete_title'),
        text: t('incomplete_text'),
        actions: [
          { label: t('complete_photo'), primary: true, onClick: () => completePhoto() },
          { label: t('keep_photo'), onClick: () => setIncomplete(false) },
        ],
      });
    }
  }
  if (capturing || state.mode !== 'fantasy' || usesCharacter() || state.generated[state.look]) return hideOverlay();

  // Fantasy mode with a captured face but no character in this style yet.
  const readyMade = { label: t('use_ready_made'), onClick: () => setLook(`char:${CHARACTERS[0]}`) };
  if (state.generating) {
    return showOverlay({ title: t('generating_title'), text: t('generating_text'), busy: true });
  }
  if (!state.generationAvailable) {
    return showOverlay({
      title: t('soon_title'),
      text: t('soon_text'),
      actions: [{ label: t('realistic_avatar'), primary: true, onClick: () => setMode('realistic') }, readyMade],
    });
  }
  if (state.generationError) {
    const { message, upgrade } = state.generationError;
    return showOverlay({
      title: t('failed_title'),
      text: message,
      actions: upgrade
        ? [{ label: t('subscribe'), primary: true, onClick: () => subscribe() }, readyMade]
        : [{ label: t('try_again'), primary: true, onClick: () => generateCharacter(state.look) }, readyMade],
    });
  }
  if (!state.consent) {
    return showOverlay({
      title: t('consent_title'),
      text: t('consent_text'),
      actions: [
        { label: t('create_my_character'), primary: true, onClick: () => { state.consent = true; store.set('avatar.consent', true); generateCharacter(state.look); } },
        { label: t('not_now'), onClick: () => setMode('realistic') },
      ],
    });
  }
  generateCharacter(state.look);
}

function setMode(mode) {
  state.mode = mode;
  store.set('avatar.mode', mode);
  renderStage();
}

document.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

// ---------- looks: AI styles and ready-made characters ----------
function chip(icon, label, active, onClick) {
  const b = document.createElement('button');
  b.className = `chip${active ? ' active' : ''}`;
  const i = document.createElement('span');
  i.className = 'emoji';
  i.setAttribute('aria-hidden', 'true');
  i.textContent = icon;
  b.append(i, label);
  b.addEventListener('click', onClick);
  return b;
}

function setLook(look) {
  state.look = look;
  state.generationError = null;
  store.set('avatar.look', look);
  if (look.startsWith('char:')) showCharacter(look.slice(5));
  renderLooks();
  setMode('fantasy');
}

function renderLooks() {
  $('styles').replaceChildren(...state.styles.map((s) =>
    chip(STYLE_ICONS[s.id] || '✨', t(`style_${s.id}`), state.look === s.id, () => setLook(s.id))));
  $('characters').replaceChildren(...CHARACTERS.map((id) =>
    chip(CHARACTER_ICONS[id], t(`char_${id}`), state.look === `char:${id}`, () => setLook(`char:${id}`))));
  if (state.look.startsWith('char:')) $('characters-box').open = true;
}

async function loadStyles() {
  try {
    const { styles, available } = await api.avatarStyles();
    state.styles = styles;
    state.generationAvailable = available;
  } catch {
    state.styles = [{ id: 'animated', name: '3D Animated' }];
    state.generationAvailable = false;
  }
  if (!state.look.startsWith('char:') && !state.styles.some((s) => s.id === state.look)) state.look = state.styles[0].id;
  renderLooks();
}

// ---------- portraits: capture, upload, generation, persistence ----------
const REAL_KEY = 'avatar.face';
const INCOMPLETE_KEY = 'avatar.face.incomplete';
const charKey = (style) => `avatar.character.${style}`;
const charVisemesKey = (style) => `avatar.character.${style}.visemes`;
const oldCharMouthsKey = (style) => `avatar.character.${style}.mouths`;

// Detects the face in an image and returns everything the avatar needs to animate it.
async function makePortrait(canvas, mirrored) {
  const result = await detectImage(canvas);
  const landmarks = result.faceLandmarks?.[0];
  const params = landmarks && paramsFromResult(result);
  if (!params) return null;
  return {
    canvas,
    landmarks: landmarks.slice(0, 468).map((p) => ({ x: p.x, y: p.y, z: p.z })),
    restPose: { yaw: params.yaw, pitch: params.pitch, roll: params.roll, jawOpen: params.jawOpen },
    mirrored,
  };
}

function savePortrait(key, portrait) {
  const ok = store.set(key, {
    img: portrait.canvas.toDataURL('image/jpeg', 0.9),
    landmarks: portrait.landmarks.map((p) => [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]),
    restPose: portrait.restPose,
    mirrored: portrait.mirrored,
  });
  if (!ok) console.warn('Could not save the avatar in this browser');
}

async function loadPortrait(key) {
  const saved = store.get(key, null);
  if (!saved) return null;
  try {
    return {
      canvas: imageToCanvas(await loadImage(saved.img)),
      landmarks: saved.landmarks.map(([x, y, z]) => ({ x, y, z })),
      restPose: saved.restPose,
      mirrored: saved.mirrored,
    };
  } catch {
    store.remove(key);
    return null;
  }
}

function forgetFace() {
  store.remove(REAL_KEY);
  store.remove(INCOMPLETE_KEY);
  state.realIncomplete = false;
  for (const s of state.styles) {
    store.remove(charKey(s.id));
    store.remove(charVisemesKey(s.id));
    store.remove(oldCharMouthsKey(s.id));
  }
  state.real = null;
  state.generated = {};
  state.generationError = null;
  capture.stable = capture.usable = capture.motion = 0;
  capture.last = null;
  mouths.clear();
  coach.skipped.clear();
}

async function useNewPhoto(canvas, mirrored) {
  const portrait = await makePortrait(canvas, mirrored);
  if (!portrait) {
    toast(t('no_face'), 'err');
    return false;
  }
  forgetFace();
  state.real = portrait;
  savePortrait(REAL_KEY, portrait);
  const incomplete = isIncomplete(portrait);
  // Gemini can complete such a photo (offered in realistic mode; 3D characters are always composed well).
  if (incomplete && !state.generationAvailable) toast(t('look_straight'), 'err', 6000);
  setIncomplete(incomplete);
  return true;
}

// Whether part of the head is outside the photo, or the head is turned or tilted a lot.
function isIncomplete({ landmarks, restPose }) {
  const xs = landmarks.map((q) => q.x), ys = landmarks.map((q) => q.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const faceW = maxX - minX, faceH = maxY - minY;
  const cutOff = minX - 0.1 * faceW < 0 || maxX + 0.1 * faceW > 1 || minY - 0.2 * faceH < 0 || maxY + 0.05 * faceH > 1;
  const turned = Math.abs(restPose.yaw) > 0.3 || Math.abs(restPose.pitch) > 0.3 || Math.abs(restPose.roll) > 0.2;
  return cutOff || turned;
}

function setIncomplete(incomplete) {
  state.realIncomplete = incomplete;
  if (incomplete) store.set(INCOMPLETE_KEY, true);
  else store.remove(INCOMPLETE_KEY);
  renderStage();
}

// Has Gemini complete and straighten the user's photo for the realistic avatar.
async function completePhoto() {
  if (!state.real || state.completing) return;
  state.completing = true;
  renderStage();
  try {
    const { image } = await api.completePhoto(state.real.canvas.toDataURL('image/jpeg', 0.9));
    const portrait = await makePortrait(imageToCanvas(await loadImage(image)), state.real.mirrored);
    if (!portrait) throw new Error(t('no_face_generated'));
    state.real = portrait;
    savePortrait(REAL_KEY, portrait);
    setIncomplete(false);
    toast(t('photo_completed'), 'ok');
  } catch (err) {
    console.warn('Photo completion failed', err);
    if (err.data?.upgrade) subscribe();
    toast(err.message, 'err', 7000);
  } finally {
    state.completing = false;
    renderStage();
  }
}

// Head-and-shoulders crop around the face (3:4), which is what the character generator works best with.
function portraitCrop(portrait, maxHeight = 896) {
  const { canvas, landmarks } = portrait;
  const W = canvas.width, H = canvas.height;
  const xs = landmarks.map((p) => p.x * W), ys = landmarks.map((p) => p.y * H);
  const fx = (Math.min(...xs) + Math.max(...xs)) / 2, fy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const faceH = Math.max(...ys) - Math.min(...ys);
  let h = Math.min(H, faceH * 2.8), w = h * 0.75;
  if (w > W) { w = W; h = Math.min(H, w / 0.75); }
  const x = Math.min(W - w, Math.max(0, fx - w / 2)), y = Math.min(H - h, Math.max(0, fy - h * 0.42));
  const s = Math.min(1, maxHeight / h);
  const out = document.createElement('canvas');
  out.width = Math.round(w * s);
  out.height = Math.round(h * s);
  out.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, out.width, out.height);
  return out.toDataURL('image/jpeg', 0.9);
}

async function generateCharacter(style) {
  if (!state.real || state.generating) return;
  state.generating = style;
  state.generationError = null;
  renderStage();
  try {
    const { image, visemes } = await api.generateAvatar(portraitCrop(state.real), style);
    const portrait = await makePortrait(imageToCanvas(await loadImage(image)), state.real.mirrored);
    if (!portrait) throw new Error(t('no_face_generated'));
    await attachCharacterVisemes(style, portrait, visemes);
    state.generated[style] = portrait;
    savePortrait(charKey(style), portrait);
    if (state.look === style) toast(t('character_ready'), 'ok');
  } catch (err) {
    console.warn('Character generation failed', err);
    if (err.status === 503) state.generationAvailable = false;
    else state.generationError = { message: err.message, upgrade: !!err.data?.upgrade };
  } finally {
    state.generating = null;
    renderStage();
  }
}

// The character's images with the mouth in each shape (viseme) let it talk with a natural mouth.
async function attachCharacterVisemes(style, portrait, images) {
  const set = {};
  await Promise.all((images || []).map(async ({ id, image }) => {
    if (!VISEME_IDS.includes(id)) return;
    try {
      const canvas = imageToCanvas(await loadImage(image));
      const landmarks = (await detectImage(canvas)).faceLandmarks?.[0];
      if (landmarks) set[id] = { canvas, landmarks: landmarks.slice(0, 468).map((q) => ({ x: q.x, y: q.y, z: q.z })) };
    } catch (err) {
      console.warn('Mouth image skipped', err);
    }
  }));
  portrait.visemes = set;
  saveSampleSet(charVisemesKey(style), set);
  store.remove(oldCharMouthsKey(style));
}

// Characters made before every mouth shape existed get them once, in the background.
const mouthsRequested = new Set();
async function ensureCharacterMouths(style) {
  const portrait = state.generated[style];
  if (!portrait || mouthsRequested.has(style) || !state.generationAvailable) return;
  mouthsRequested.add(style);
  try {
    const { visemes } = await api.avatarMouths(portrait.canvas.toDataURL('image/jpeg', 0.9));
    await attachCharacterVisemes(style, portrait, visemes);
  } catch (err) {
    console.warn('Mouth images unavailable', err);
  }
}

$('btn-regenerate').addEventListener('click', () => {
  delete state.generated[state.look];
  store.remove(charKey(state.look));
  store.remove(charVisemesKey(state.look));
  renderStage();
});

// Called every frame while we wait for a good, straight-on view of the face.
const capture = { stable: 0, usable: 0, busy: false, last: null, motion: 0 };

// The part of the camera image the stage shows (the video is scaled to cover the stage, so its edges
// may be cut off), in normalized image coordinates.
function visibleRegion() {
  const vw = video.videoWidth, vh = video.videoHeight, sw = video.clientWidth, sh = video.clientHeight;
  if (!vw || !vh || !sw || !sh) return { x0: 0, x1: 1, y0: 0, y1: 1 };
  const va = vw / vh, sa = sw / sh;
  if (va > sa) {
    const f = sa / va;
    return { x0: 0.5 - f / 2, x1: 0.5 + f / 2, y0: 0, y1: 1 };
  }
  const f = va / sa;
  return { x0: 0, x1: 1, y0: 0.5 - f / 2, y1: 0.5 + f / 2 };
}

function autoCapture(result, p, dt) {
  const lm = result?.faceLandmarks?.[0];
  let hint = t('hint_frame');
  let good = false, usable = false;
  if (p && lm) {
    const xs = lm.map((q) => q.x), ys = lm.map((q) => q.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const faceW = maxX - minX, faceH = maxY - minY;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const v = visibleRegion();
    const visW = v.x1 - v.x0, visH = v.y1 - v.y0;
    // The whole head must be on screen (with room for the hair above the forehead) and near the middle.
    const inside = minX - 0.12 * faceW >= v.x0 && maxX + 0.12 * faceW <= v.x1
      && minY - 0.25 * faceH >= v.y0 && maxY + 0.05 * faceH <= v.y1;
    const centered = Math.abs(cx - (v.x0 + v.x1) / 2) < visW * 0.2 && Math.abs(cy - (v.y0 + v.y1) / 2) < visH * 0.22;
    // How fast the head moves, in face heights per second (smoothed).
    if (capture.last) {
      const speed = Math.hypot(cx - capture.last[0], cy - capture.last[1]) / faceH / Math.max(dt, 1 / 60);
      capture.motion += (speed - capture.motion) * Math.min(1, dt * 8);
    }
    capture.last = [cx, cy];
    if (faceH < 0.25 * visH) hint = t('hint_closer');
    else if (faceH > 0.68 * visH) hint = t('hint_farther');
    else if (!inside || !centered) hint = t('hint_frame');
    else if (Math.abs(p.yaw) > 0.25 || Math.abs(p.pitch) > 0.3 || Math.abs(p.roll) > 0.25) hint = t('hint_straight');
    else if (capture.motion > 0.3) hint = t('hint_still');
    else {
      usable = true;
      // The photo is the avatar's resting face: eyes open, lips closed and relaxed. After a while, slightly
      // parted lips (e.g. a smile) are accepted so nobody gets stuck; closed eyes never are.
      const patient = capture.usable > 5;
      if (p.blinkA > 0.35 || p.blinkB > 0.35) hint = t('hint_eyes');
      else if (p.jawOpen > (patient ? 0.4 : 0.25) || p.pucker > (patient ? 0.5 : 0.35)) hint = t('hint_mouth');
      else good = true;
    }
  } else {
    capture.last = null;
  }
  capture.stable = good ? capture.stable + dt : 0;
  capture.usable = usable ? capture.usable + dt : 0;
  // After a while of good framing, the first acceptable frame is taken without waiting.
  if (good && capture.usable > 5) capture.stable = 2;
  if (good) hint = t('hint_hold');
  $('guide-text').textContent = hint;
  $('guide-oval').classList.toggle('good', good);
  if (capture.stable > 1.5 && !capture.busy) {
    capture.busy = true;
    capture.stable = capture.usable = 0;
    $('guide-text').textContent = t('hint_done');
    useNewPhoto(tracker.grabFrame(), true)
      .catch((err) => {
        console.error(err);
        toast(t('capture_failed'), 'err');
      })
      .finally(() => {
        capture.busy = false;
        renderStage();
      });
  }
}

$('btn-capture').addEventListener('click', () => {
  forgetFace();
  if (!tracker.cameraOn) startCamera();
  renderStage();
});

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file || !faceAvatar) return;
  setStatus(t('reading_photo'));
  const url = URL.createObjectURL(file);
  try {
    if (await useNewPhoto(imageToCanvas(await loadImage(url)), false)) toast(t('photo_added'), 'ok');
  } catch (err) {
    console.error(err);
    toast(t('photo_unreadable'), 'err');
  } finally {
    URL.revokeObjectURL(url);
    setStatus('');
    renderStage();
  }
});

$('btn-reset-face').addEventListener('click', () => {
  forgetFace();
  renderStage();
});

async function restorePortraits() {
  state.real = await loadPortrait(REAL_KEY);
  state.realIncomplete = !!state.real && store.get(INCOMPLETE_KEY, false);
  if (!state.real) return;
  for (const s of state.styles) {
    const p = await loadPortrait(charKey(s.id));
    if (!p) continue;
    p.visemes = await loadSampleSet(charVisemesKey(s.id));
    state.generated[s.id] = p;
  }
}

// ---------- account & subscription ----------
function renderAccount() {
  const u = state.user;
  $('btn-login').hidden = !!u;
  $('user-menu').hidden = !u;
  $('user-login').textContent = u?.login || '';
  const badge = $('sub-badge');
  badge.hidden = !u?.subscribed;
  if (u?.subscribed) badge.textContent = t('subscribed_until', { date: formatDate(new Date(u.subscriptionExpiresAt)) });
  $('speak-lock').hidden = !!u?.subscribed;
}

async function refreshMe() {
  try {
    state.user = (await api.me()).user;
  } catch {
    state.user = null;
  }
  renderAccount();
}

function openAuth(tab = 'login', afterLogin = null) {
  state.afterLogin = afterLogin;
  setAuthTab(tab);
  $('auth-error').hidden = true;
  $('auth-dialog').showModal();
  $('auth-login').focus();
}

function setAuthTab(tab) {
  state.authTab = tab;
  document.querySelectorAll('#auth-dialog .tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('auth-submit').textContent = t(tab === 'login' ? 'login' : 'create_account');
  $('auth-password').autocomplete = tab === 'login' ? 'current-password' : 'new-password';
}

document.querySelectorAll('#auth-dialog .tab').forEach((t) => t.addEventListener('click', () => setAuthTab(t.dataset.tab)));
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  const login = $('auth-login').value;
  const password = $('auth-password').value;
  $('auth-error').hidden = true;
  setLoading(btn, true);
  try {
    const { user } = state.authTab === 'login' ? await api.login(login, password) : await api.register(login, password);
    state.user = user;
    renderAccount();
    $('auth-dialog').close();
    $('auth-password').value = '';
    toast(t(state.authTab === 'login' ? 'welcome_back' : 'account_ready'), 'ok');
    const next = state.afterLogin;
    state.afterLogin = null;
    next?.();
  } catch (err) {
    $('auth-error').textContent = err.message;
    $('auth-error').hidden = false;
  } finally {
    setLoading(btn, false);
  }
});

$('btn-login').addEventListener('click', () => openAuth('login'));
$('btn-logout').addEventListener('click', async () => {
  await api.logout().catch(() => {});
  state.user = null;
  renderAccount();
});

function renderPlans() {
  $('plans').replaceChildren(...state.plans.map((plan, i) => {
    const el = document.createElement('div');
    el.className = `plan${i === state.plans.length - 1 && state.plans.length > 1 ? ' featured' : ''}`;
    const h = document.createElement('h4');
    h.textContent = t(`plan_${plan.id}`) === `plan_${plan.id}` ? plan.title : t(`plan_${plan.id}`);
    const price = document.createElement('div');
    price.className = 'price';
    price.textContent = formatNumber(plan.priceToman);
    const unit = document.createElement('small');
    unit.textContent = ` ${t('toman')}`;
    price.append(unit);
    const per = document.createElement('div');
    per.className = 'per-month';
    const months = Math.round(plan.days / 30);
    per.textContent = months > 1
      ? t('per_month', { price: formatNumber(Math.round(plan.priceToman / months)) })
      : t('days_access', { days: formatNumber(plan.days) });
    const btn = document.createElement('button');
    btn.className = 'btn primary block';
    btn.textContent = t('pay');
    btn.addEventListener('click', () => buy(plan.id, btn));
    el.append(h, price, per, btn);
    return el;
  }));
}

async function openPlans() {
  if (!state.plans.length) {
    try {
      state.plans = (await api.plans()).plans;
    } catch {
      return toast(t('plans_failed'), 'err');
    }
  }
  renderPlans();
  $('plans-dialog').showModal();
}

async function buy(planId, btn) {
  if (!state.user) {
    $('plans-dialog').close();
    return openAuth('register', () => openPlans());
  }
  setLoading(btn, true);
  try {
    const { url } = await api.pay(planId);
    location.href = url;
  } catch (err) {
    toast(err.message, 'err');
    setLoading(btn, false);
  }
}

function subscribe() {
  if (!state.user) openAuth('register', () => { if (!state.user.subscribed) openPlans(); });
  else openPlans();
}

$('btn-subscribe').addEventListener('click', subscribe);

function handlePaymentReturn() {
  const q = new URLSearchParams(location.search);
  const result = q.get('payment');
  if (!result) return;
  if (result === 'success') toast(t('payment_success', { ref: q.get('ref') || '-' }), 'ok', 10000);
  else if (result === 'cancelled') toast(t('payment_cancelled'), 'err', 6000);
  else toast(t('payment_failed'), 'err', 10000);
  history.replaceState(null, '', location.pathname);
}

// ---------- text to speech ----------

async function loadVoices() {
  try {
    state.voices = (await api.voices()).voices;
  } catch {
    state.voices = [];
  }
  renderVoices();
}

function renderVoices() {
  const select = $('voice-select');
  const label = (v) => `${v.name}${v.gender ? ` · ${t(`gender_${v.gender}`)}` : ''}`;
  // Free voices by language; Google's voices speak both languages.
  const group = (title, voices) => {
    const g = document.createElement('optgroup');
    g.label = title;
    g.append(...voices.map((v) => new Option(label(v), v.id)));
    return g;
  };
  const piper = state.voices.filter((v) => v.engine !== 'gemini');
  const groups = [
    group(t('lang_fa'), piper.filter((v) => v.langs[0] === 'fa')),
    group(t('lang_en'), piper.filter((v) => v.langs[0] === 'en')),
    group(t('voices_google'), state.voices.filter((v) => v.engine === 'gemini')),
  ].filter((g) => g.children.length);
  select.replaceChildren(new Option(t('voice_auto'), ''), ...groups);
  select.value = store.get('avatar.voice', '');
  if (select.selectedIndex < 0) select.value = '';
}

// The chosen voice when it speaks the text's language (an English voice can't read Persian); otherwise a
// voice that does, of the same kind when possible.
function pickVoice(text) {
  const lang = detectLang(text);
  const speaks = (v) => v.langs.includes(lang);
  const chosen = state.voices.find((v) => v.id === $('voice-select').value);
  if (chosen && speaks(chosen)) return chosen.id;
  const voice = (chosen && state.voices.find((v) => speaks(v) && v.gender === chosen.gender && v.engine === chosen.engine))
    || (chosen && state.voices.find((v) => speaks(v) && v.gender === chosen.gender))
    || state.voices.find((v) => speaks(v) && v.engine === 'piper')
    || state.voices.find(speaks);
  return voice?.id || '';
}

$('voice-select').addEventListener('change', (e) => store.set('avatar.voice', e.target.value));

const textArea = $('speak-text');
const renderCharCount = () => {
  $('char-count').textContent = `${formatNumber(textArea.value.length)} / ${formatNumber(1000)}`;
};
textArea.addEventListener('input', renderCharCount);

function renderSpeaking(phase) {
  setLoading($('btn-speak'), phase === 'loading');
  $('btn-speak').hidden = phase === 'playing';
  $('btn-stop').hidden = phase !== 'playing';
  $('btn-video').disabled = phase !== 'idle';
}

// Whether the avatar can talk right now; otherwise tells the user what is missing.
function avatarCanTalk() {
  if (!usesCharacter() && !faceAvatar?.ready) {
    toast(t('create_avatar_first'));
    return false;
  }
  if (state.mode === 'realistic' && !mouths.ready && !state.cameraError) {
    // Without a camera at all, the realistic avatar falls back to a drawn mouth.
    renderCoach();
    toast(t(tracker.cameraOn ? 'need_samples' : 'need_samples_camera'), '', 7000);
    return false;
  }
  return true;
}

// Sends visitors without a subscription to log in or subscribe; returns true when it did.
function needsSubscription(retry) {
  if (!state.user) {
    openAuth('login', () => (state.user.subscribed ? retry() : openPlans()));
    return true;
  }
  if (!state.user.subscribed) {
    openPlans();
    return true;
  }
  return false;
}

function handleSpeechError(err, retry) {
  if (err.status === 401) {
    state.user = null;
    renderAccount();
    openAuth('login', retry);
  } else if (err.status === 402) {
    refreshMe().then(openPlans);
  } else {
    toast(err.message, 'err');
  }
}

const fetchSpeech = (text) => api.tts(text, pickVoice(text), Number($('speed').value));

async function speak() {
  const text = textArea.value.trim();
  if (!text) return toast(t('type_first'));
  if (needsSubscription(speak) || !avatarCanTalk()) return;
  unlockAudio();
  renderSpeaking('loading');
  try {
    const speech = await fetchSpeech(text);
    renderSpeaking('playing');
    await speaker.play(speech);
  } catch (err) {
    if (err.status === 503) {
      toast(t('voice_fallback'), '', 6000);
      renderSpeaking('playing');
      await speaker.speakWithBrowser(text, detectLang(text)).catch(() => toast(t('audio_failed'), 'err'));
    } else {
      handleSpeechError(err, speak);
    }
  } finally {
    renderSpeaking('idle');
  }
}

// A fixed sentence anyone can hear, to try the talking avatar before subscribing.
async function playDemo() {
  if (!avatarCanTalk()) return;
  unlockAudio();
  const btn = $('btn-demo');
  setLoading(btn, true);
  try {
    const voice = state.voices.find((v) => v.id === $('voice-select').value && v.langs.includes(lang))?.id || '';
    const speech = await api.ttsDemo(lang, voice);
    setLoading(btn, false);
    renderSpeaking('playing');
    await speaker.play(speech);
  } catch (err) {
    toast(err.status === 503 ? t('voice_down') : err.message, 'err');
  } finally {
    setLoading(btn, false);
    renderSpeaking('idle');
  }
}

$('btn-speak').addEventListener('click', speak);
$('btn-demo').addEventListener('click', playDemo);
$('btn-stop').addEventListener('click', () => {
  if (state.recording) state.recording.cancelled = true;
  speaker.stop();
});

// ---------- video ----------
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The drawn-mouth layer is only used when the avatar has no mouth images.
const recordLayers = () => {
  if (usesCharacter()) return [$('char-canvas')];
  return faceAvatar.hasMouthSamples ? [$('face-canvas')] : [$('face-canvas'), $('mouth-canvas')];
};

let recTimer = null;
function setRecording(recorder) {
  state.recording = recorder && { recorder, cancelled: false, started: performance.now() };
  // Render the avatar at the video's size (the stage shows it letterboxed meanwhile).
  const size = recorder ? recorder.avatarSize : null;
  if (faceAvatar) faceAvatar.renderSize = size;
  if (characters) characters.renderSize = size;
  clearInterval(recTimer);
  const tick = () => {
    const secs = Math.floor((performance.now() - state.recording.started) / 1000);
    $('rec-text').textContent = t('recording', { time: formatDuration(secs) });
  };
  if (recorder) {
    tick();
    recTimer = setInterval(tick, 500);
  }
  renderStage();
}

async function makeVideo() {
  const text = textArea.value.trim();
  if (!text) return toast(t('type_first'));
  if (needsSubscription(makeVideo) || !avatarCanTalk()) return;
  if (!canRecordVideo()) return toast(t('video_unsupported'), 'err', 8000);
  unlockAudio();
  speaker.stop();
  const btn = $('btn-video');
  setLoading(btn, true);
  let speech;
  try {
    speech = await fetchSpeech(text);
  } catch (err) {
    setLoading(btn, false);
    if (err.status === 503) return toast(t('voice_down'), 'err', 7000);
    return handleSpeechError(err, makeVideo);
  }
  await document.fonts?.load('700 40px Vazirmatn').catch(() => {});
  const withCaptions = $('video-captions').checked;
  const recorder = new VideoRecorder($('video-format').value, { rtl: detectLang(text) === 'fa' });
  const audio = createRecordingDestination();
  setRecording(recorder);
  renderSpeaking('playing');
  toast(t('video_keep_open'), '', 5000);
  try {
    // Let the (silent) sound run first, so the video has sound from its very first frame.
    await wait(300);
    recorder.start(audio.stream);
    await wait(400);
    await speaker.play(speech, {
      record: audio.node,
      onStart: (duration) => {
        if (withCaptions) recorder.captions = buildCaptions(text, speech.phonemes, duration);
      },
    });
    await wait(600);
    const blob = await recorder.stop();
    if (!state.recording.cancelled) showVideo(blob, recorder.extension);
  } catch (err) {
    console.error('Recording failed', err);
    toast(t('video_failed'), 'err');
  } finally {
    audio.release();
    setRecording(null);
    setLoading(btn, false);
    renderSpeaking('idle');
  }
}

$('btn-video').addEventListener('click', makeVideo);

let videoUrl = null;
function showVideo(blob, extension) {
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = `avatar-${stamp}.${extension}`;
  $('video-result').src = videoUrl;
  $('btn-download').href = videoUrl;
  $('btn-download').download = name;
  const file = new File([blob], name, { type: blob.type });
  const share = $('btn-share');
  share.hidden = !navigator.canShare?.({ files: [file] });
  share.onclick = () => navigator.share({ files: [file] }).catch(() => {});
  $('video-note').textContent = extension === 'webm' ? t('video_webm_note') : '';
  $('video-dialog').showModal();
}

$('video-dialog').addEventListener('close', () => $('video-result').pause());
$('video-format').value = store.get('avatar.videoFormat', 'portrait');
$('video-format').addEventListener('change', (e) => store.set('avatar.videoFormat', e.target.value));
$('video-captions').checked = store.get('avatar.videoCaptions', true);
$('video-captions').addEventListener('change', (e) => store.set('avatar.videoCaptions', e.target.checked));

// ---------- animation loop ----------
const live = createParams();
const idle = new IdleAnimator();
let last = performance.now();

const blendshapesOf = (result) => Object.fromEntries((result.faceBlendshapes?.[0]?.categories || []).map((c) => [c.categoryName, c.score]));

let frameFailed = false;
function frame(now) {
  requestAnimationFrame(frame);
  // While recording, the video's frame rate is enough and leaves the device time to encode it.
  if (state.recording && now - last < 1000 / VIDEO_FPS - 4) return;
  try {
    step(now);
  } catch (err) {
    // Keep the page alive; report the problem once.
    if (!frameFailed) console.error('Animation error', err);
    frameFailed = true;
  }
}

function step(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  // The camera is only used to capture the face and record mouth shapes.
  let result = null, tracking = null;
  try {
    result = tracker.detect();
    tracking = result && paramsFromResult(result);
  } catch (err) {
    console.warn('Tracking error', err);
  }
  const tracked = !!tracking;
  if (tracked !== state.faceVisible) {
    state.faceVisible = tracked;
    renderCamera();
  }
  if (needsCapture() && tracker.cameraOn && faceAvatar) {
    if (tracker.ready) autoCapture(result, tracking, dt);
    else $('guide-text').textContent = t('loading_model', { pct: formatNumber(Math.round(state.modelProgress * 100)) });
  }
  if (tracked && state.real) collectMouthSamples(result.faceLandmarks[0], blendshapesOf(result), tracking, now, dt);
  if (showsLiveCamera() !== liveCameraShown) renderStage();

  // The avatar does not copy the user's head: it blinks and moves slightly on its own, and its mouth
  // follows the speech.
  const target = idle.apply(createParams(), dt);
  const mouth = speaker.mouth();
  if (mouth) {
    target.jawOpen = mouth.jawOpen;
    target.wide = mouth.wide;
    target.pucker = mouth.pucker;
    // A small nod and brow lift on stressed syllables.
    target.pitch += (mouth.nod ?? mouth.energy) * 0.05;
    target.browUp = Math.max(target.browUp, (mouth.nod || 0) * 0.25);
  }
  smoothParams(live, target, dt, mouth ? 28 : 16);

  if (usesCharacter()) characters?.update(live, dt);
  else if (faceAvatar?.ready && !liveCameraShown) {
    // Mouth images: the user's real frames (realistic) or the character's Gemini-made images.
    const realistic = state.mode === 'realistic';
    const character = state.generated[state.look];
    const samples = (realistic ? mouths.ready && mouths.set : character?.visemes) || {};
    const samplesKey = realistic ? `real:${mouths.ready}:${mouths.version}` : `char:${state.look}:${Object.keys(samples).length}`;
    if (samplesKey !== mouthsApplied) {
      faceAvatar.setMouthSamples(samples);
      mouthsApplied = samplesKey;
    }
    if (!realistic && character && Object.keys(samples).length < 4) ensureCharacterMouths(state.look);
    let visemes = null;
    if (faceAvatar.hasMouthSamples) visemes = mouth ? mouth.visemes || [['AA', Math.min(1, mouth.jawOpen * 1.6)]] : [];
    faceAvatar.update(live, dt, { relativePose: true, mouthFromSpeech: !!mouth, visemes });
  }
  if (state.recording) state.recording.recorder.draw(recordLayers(), speaker.elapsed());
}

// ---------- language ----------
function renderLanguage() {
  applyLanguage();
  renderLooks();
  renderStage();
  renderAccount();
  renderVoices();
  renderCharCount();
  setAuthTab(state.authTab);
  if ($('plans-dialog').open) renderPlans();
  renderSpeaking(speaker.speaking ? 'playing' : 'idle');
}

$('btn-lang').addEventListener('click', () => {
  setLanguage(lang === 'fa' ? 'en' : 'fa');
  renderLanguage();
});

// ---------- start ----------
applyLanguage();
renderCharCount();
renderSpeaking('idle');
renderAccount();
handlePaymentReturn();
setStatus(t('getting_ready'));
await loadStyles();
if (usesCharacter()) showCharacter(state.look.slice(5));
await restorePortraits();
await mouths.restore();
mouthsWereReady = mouths.ready;
setStatus('');
renderStage();
requestAnimationFrame(frame);
refreshMe();
loadVoices();
loadTracking();
