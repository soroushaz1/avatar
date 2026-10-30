import { lang, t } from './i18n.js';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Lang': lang, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  generateAvatar: (image, style) => request('POST', '/api/avatar/generate', { image, style }),
  avatarMouths: (image) => request('POST', '/api/avatar/mouths', { image }),
  completePhoto: (image) => request('POST', '/api/avatar/complete', { image }),
  // Speech as { audio (base64), mime, phonemes: [[phoneme, start, duration]] }.
  tts: (text, voice, speed) => request('POST', '/api/tts', { text, voice, speed }),
  ttsDemo: (lang, voice) => request('POST', '/api/tts/demo', { lang, voice }),
};
