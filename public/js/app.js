import { api } from './api.js';
import { FaceTracker, detectImage } from './tracker.js';
import { createParams, paramsFromResult, smoothParams, IdleAnimator } from './face-params.js';
import { FantasyAvatar, CHARACTERS } from './fantasy.js';
import { FaceAvatar } from './face-avatar.js';
import { Speaker, unlockAudio, detectLang } from './speech.js';
import { t, lang, setLanguage, applyLanguage, formatNumber, formatDate } from './i18n.js';

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
  // Portraits the avatar can animate: the user's photo and the characters generated from it.
  real: null,
  generated: {},
  generating: null,
  generationError: null,
  afterLogin: null,
  authTab: 'login',
};

const video = $('video');
const tracker = new FaceTracker(video);
const characters = new FantasyAvatar($('char-canvas'));
let faceAvatar = null;
try {
  faceAvatar = new FaceAvatar($('face-canvas'), $('mouth-canvas'));
} catch (err) {
  console.warn('Face avatar unavailable', err);
}
const speaker = new Speaker();

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
  const on = tracker.running;
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

$('btn-camera').addEventListener('click', () => {
  if (tracker.running) {
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
}

function renderStage() {
  syncPortrait();
  const charMode = usesCharacter();
  const capturing = needsCapture();
  const live = capturing && tracker.running && !!faceAvatar;

  $('stage').dataset.mode = state.mode;
  $('char-canvas').hidden = !charMode;
  for (const id of ['face-canvas', 'mouth-canvas']) $(id).hidden = charMode || !faceAvatar?.ready;
  video.hidden = !tracker.running || (!live && !state.showPreview);
  video.classList.toggle('live', live);
  $('guide').hidden = !live;

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
  if (capturing && !tracker.running) {
    return showOverlay({
      title: t('create_avatar_title'),
      text: t('create_avatar_text'),
      actions: [{ label: t('turn_on_camera'), primary: true, onClick: () => startCamera() }, upload],
    });
  }
  if (capturing || state.mode !== 'fantasy' || usesCharacter() || state.generated[state.look]) return hideOverlay();

  // Fantasy mode with a captured face but no character in this style yet.
  const readyMade = { label: t('use_ready_made'), onClick: () => setLook(`char:${CHARACTERS[0].id}`) };
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
  if (look.startsWith('char:')) characters.setCharacter(look.slice(5));
  renderLooks();
  setMode('fantasy');
}

function renderLooks() {
  $('styles').replaceChildren(...state.styles.map((s) =>
    chip(STYLE_ICONS[s.id] || '✨', t(`style_${s.id}`), state.look === s.id, () => setLook(s.id))));
  $('characters').replaceChildren(...CHARACTERS.map((c) =>
    chip(CHARACTER_ICONS[c.id] || '✨', t(`char_${c.id}`), state.look === `char:${c.id}`, () => setLook(`char:${c.id}`))));
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
const charKey = (style) => `avatar.character.${style}`;

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
  for (const s of state.styles) store.remove(charKey(s.id));
  state.real = null;
  state.generated = {};
  state.generationError = null;
  capture.stable = capture.usable = 0;
}

async function useNewPhoto(canvas, mirrored) {
  const portrait = await makePortrait(canvas, mirrored);
  if (!portrait) {
    toast(t('no_face'), 'err');
    return false;
  }
  if (Math.abs(portrait.restPose.yaw) > 0.35 || Math.abs(portrait.restPose.pitch) > 0.35) {
    toast(t('look_straight'), 'err', 6000);
  }
  forgetFace();
  state.real = portrait;
  savePortrait(REAL_KEY, portrait);
  return true;
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
    const { image } = await api.generateAvatar(portraitCrop(state.real), style);
    const portrait = await makePortrait(imageToCanvas(await loadImage(image)), state.real.mirrored);
    if (!portrait) throw new Error(t('no_face_generated'));
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

$('btn-regenerate').addEventListener('click', () => {
  delete state.generated[state.look];
  store.remove(charKey(state.look));
  renderStage();
});

// Called every frame while we wait for a good, straight-on view of the face.
const capture = { stable: 0, usable: 0, busy: false };

function autoCapture(result, p, dt) {
  const lm = result?.faceLandmarks?.[0];
  let hint = t('hint_frame');
  let good = false, usable = false;
  if (p && lm) {
    const xs = lm.map((q) => q.x);
    const width = Math.max(...xs) - Math.min(...xs);
    if (width < 0.16) hint = t('hint_closer');
    else if (Math.abs(p.yaw) > 0.25 || Math.abs(p.pitch) > 0.3 || Math.abs(p.roll) > 0.25) hint = t('hint_straight');
    else {
      usable = true;
      if (p.jawOpen > 0.3) hint = t('hint_mouth');
      else if (p.blinkA > 0.5 || p.blinkB > 0.5) hint = t('hint_eyes');
      else good = true;
    }
  }
  capture.stable = good ? capture.stable + dt : 0;
  // A straight-on face is good enough after a while, so nobody gets stuck (e.g. while smiling).
  capture.usable = usable ? capture.usable + dt : 0;
  if (capture.usable > 5) capture.stable = 2;
  if (good) hint = t('hint_hold');
  $('guide-text').textContent = hint;
  $('guide-oval').classList.toggle('good', good);
  if (capture.stable > 1 && !capture.busy) {
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
  if (!tracker.running) startCamera();
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
  if (!state.real) return;
  for (const s of state.styles) {
    const p = await loadPortrait(charKey(s.id));
    if (p) state.generated[s.id] = p;
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
  const label = (v) => `${['fa', 'en'].includes(v.lang) ? t(`lang_${v.lang}`) : v.lang} – ${v.name}`;
  select.replaceChildren(new Option(t('voice_auto'), ''), ...state.voices.map((v) => new Option(label(v), v.id)));
  select.value = store.get('avatar.voice', '');
  if (select.selectedIndex < 0) select.value = '';
}

function pickVoice(text) {
  const chosen = $('voice-select').value;
  if (chosen) return chosen;
  const lang = detectLang(text);
  return (state.voices.find((v) => v.lang === lang) || state.voices[0])?.id || '';
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
}

async function speak() {
  const text = textArea.value.trim();
  if (!text) return toast(t('type_first'));
  if (!state.user) return openAuth('login', () => (state.user.subscribed ? speak() : openPlans()));
  if (!state.user.subscribed) return openPlans();
  if (!usesCharacter() && !faceAvatar?.ready) return toast(t('create_avatar_first'));
  unlockAudio();
  renderSpeaking('loading');
  try {
    const audio = await api.tts(text, pickVoice(text), Number($('speed').value));
    renderSpeaking('playing');
    await speaker.playAudio(audio);
  } catch (err) {
    if (err.status === 503) {
      toast(t('voice_fallback'), '', 6000);
      renderSpeaking('playing');
      await speaker.speakWithBrowser(text, detectLang(text)).catch(() => toast(t('audio_failed'), 'err'));
    } else if (err.status === 401) {
      state.user = null;
      renderAccount();
      openAuth('login');
    } else if (err.status === 402) {
      await refreshMe();
      openPlans();
    } else {
      toast(err.message, 'err');
    }
  } finally {
    renderSpeaking('idle');
  }
}

$('btn-speak').addEventListener('click', speak);
$('btn-stop').addEventListener('click', () => speaker.stop());

// ---------- animation loop ----------
const live = createParams();
const idle = new IdleAnimator();
let last = performance.now();

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;

  let result = null, target = null;
  try {
    result = tracker.detect();
    target = result && paramsFromResult(result);
  } catch (err) {
    console.warn('Tracking error', err);
  }
  const tracked = !!target;
  if (tracked !== state.faceVisible) {
    state.faceVisible = tracked;
    renderCamera();
  }
  if (needsCapture() && tracker.running && faceAvatar) autoCapture(result, target, dt);
  if (!target) target = idle.apply(createParams(), dt);

  const mouth = speaker.mouth();
  if (mouth) {
    target.jawOpen = mouth.jawOpen;
    target.wide = mouth.wide;
    target.pucker = mouth.pucker;
    target.smile = Math.min(target.smile, 0.25);
    if (!tracked) target.pitch += mouth.energy * 0.06;
  }
  smoothParams(live, target, dt, mouth ? 28 : 16);

  if (usesCharacter()) characters.update(live, dt);
  else if (faceAvatar?.ready) faceAvatar.update(live, dt, { relativePose: !tracked });

  requestAnimationFrame(frame);
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
if (usesCharacter()) characters.setCharacter(state.look.slice(5));
await restorePortraits();
setStatus('');
renderStage();
requestAnimationFrame(frame);
refreshMe();
loadVoices();
startCamera();
