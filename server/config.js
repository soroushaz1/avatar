import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader so the app runs without extra dependencies.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes)$/i.test(v));

export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  // Public origin of the site, used for the payment callback URL.
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  dataDir: path.resolve(ROOT, env.DATA_DIR || 'data'),
  cookieSecure: bool(env.COOKIE_SECURE, (env.BASE_URL || '').startsWith('https://')),
  trustProxy: bool(env.TRUST_PROXY, true),

  zarinpal: {
    merchantId: env.ZARINPAL_MERCHANT_ID || '',
    sandbox: bool(env.ZARINPAL_SANDBOX, false),
    // Override only for testing against a mock gateway.
    apiBase: env.ZARINPAL_API_BASE || '',
  },

  gemini: {
    apiKey: env.GEMINI_API_KEY || '',
    model: env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
    // Override only for testing against a mock API.
    apiBase: (env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/$/, ''),
    // Character generations per 24h: whole site / free visitor (account or IP) / subscriber.
    // Each character is nine images (the character and eight mouth shapes), about $0.35 with Gemini Flash.
    dailyLimit: Number(env.AVATAR_DAILY_LIMIT || 100),
    freeLimit: Number(env.AVATAR_FREE_LIMIT || 2),
    subscriberLimit: Number(env.AVATAR_SUBSCRIBER_LIMIT || 20),
  },

  tts: {
    url: (env.TTS_URL || 'http://127.0.0.1:5002').replace(/\/$/, ''),
    maxChars: Number(env.TTS_MAX_CHARS || 1000),
  },

  // Prices are in Toman; the gateway is called in Rial (×10).
  plans: [
    {
      id: 'monthly',
      title: 'Monthly',
      days: 30,
      priceToman: Number(env.PLAN_MONTHLY_TOMAN || 99000),
    },
    {
      id: 'quarterly',
      title: 'Quarterly',
      days: 90,
      priceToman: Number(env.PLAN_QUARTERLY_TOMAN || 249000),
    },
  ],
};

export function findPlan(id) {
  return config.plans.find((p) => p.id === id) || null;
}
