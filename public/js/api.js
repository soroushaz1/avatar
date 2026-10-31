import { lang, t } from './i18n.js';

// timeout (ms): give up instead of waiting forever, e.g. when a slow connection can't upload a photo
// (the browser may otherwise keep retrying the upload without telling anyone).
async function request(method, url, body, { timeout = 0 } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: { 'X-Lang': lang, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    throw Object.assign(new Error(t(timedOut ? 'upload_too_slow' : 'network_error')), { status: 0, timedOut });
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(data.error || t('network_error')), { status: res.status, data });
  }
  return res.json();
}

export const api = {
  me: () => request('GET', '/api/auth/me'),
  login: (login, password) => request('POST', '/api/auth/login', { login, password }),
  register: (login, password) => request('POST', '/api/auth/register', { login, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  plans: () => request('GET', '/api/pay/plans'),
  pay: (planId) => request('POST', '/api/pay/request', { planId }),
  voices: () => request('GET', '/api/tts/voices'),
  avatarStyles: () => request('GET', '/api/avatar/styles'),
  // Making a character can take a couple of minutes on the server (which gives up after 180 s).
  generateAvatar: (image, style, mirrored) => request('POST', '/api/avatar/generate', { image, style, mirrored }, { timeout: 200000 }),
  // The user's saved 3D characters.
  characters: () => request('GET', '/api/characters'),
  saveCharacter: (character) => request('POST', '/api/characters', character, { timeout: 180000 }),
  deleteCharacter: (id) => request('DELETE', `/api/characters/${id}`, {}),
  avatarMouths: (image) => request('POST', '/api/avatar/mouths', { image }, { timeout: 200000 }),
  completePhoto: (image) => request('POST', '/api/avatar/complete', { image }, { timeout: 180000 }),
  // Speech as { audio (base64), mime, phonemes: [[phoneme, start, duration]] }.
  tts: (text, voice, speed) => request('POST', '/api/tts', { text, voice, speed }),
  ttsDemo: (lang, voice) => request('POST', '/api/tts/demo', { lang, voice }),
};
