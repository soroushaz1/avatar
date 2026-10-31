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

// Sends a large JSON body in small pieces and returns the upload's id, which the real request names
// instead of carrying the body: on some connections a long upload stalls and never arrives, while short
// requests get through. A piece that fails is sent again, smaller.
async function upload(payload) {
  const text = JSON.stringify(payload);
  const { id } = await request('POST', '/api/uploads', {}, { timeout: 20000 });
  let size = 32 * 1024;
  for (let index = 0, offset = 0; offset < text.length; index++) {
    for (let attempt = 0; ; attempt++) {
      const part = text.slice(offset, offset + size);
      try {
        await request('POST', `/api/uploads/${id}/${index}`, { data: part }, { timeout: 20000 });
        offset += part.length;
        break;
      } catch (err) {
        if (attempt >= 5 || (err.status >= 400 && err.status !== 408 && err.status !== 429 && err.status < 500)) throw err;
        size = Math.max(4 * 1024, size >> 1);
        await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }
  return id;
}

// A request whose (large) body is uploaded in pieces first.
const uploading = async (url, payload, timeout) => request('POST', url, { uploadId: await upload(payload) }, { timeout });

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
  generateAvatar: (image, style, mirrored) => uploading('/api/avatar/generate', { image, style, mirrored }, 200000),
  // The user's saved 3D characters.
  characters: () => request('GET', '/api/characters'),
  saveCharacter: (character) => uploading('/api/characters', character, 120000),
  deleteCharacter: (id) => request('DELETE', `/api/characters/${id}`, {}),
  avatarMouths: (image) => uploading('/api/avatar/mouths', { image }, 200000),
  completePhoto: (image) => uploading('/api/avatar/complete', { image }, 180000),
  // Speech as { audio (base64), mime, phonemes: [[phoneme, start, duration]] }.
  tts: (text, voice, speed) => request('POST', '/api/tts', { text, voice, speed }),
  ttsDemo: (lang, voice) => request('POST', '/api/tts/demo', { lang, voice }),
};
