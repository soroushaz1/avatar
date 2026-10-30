import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, ROOT } from './config.js';
import { sessionMiddleware, authRouter } from './auth.js';
import { paymentRouter } from './payment.js';
import { ttsRouter } from './tts.js';
import { avatarRouter } from './avatar.js';
import { langMiddleware, msg } from './i18n.js';

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', 'loopback');

app.use((_req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "connect-src 'self' data: blob:",
      "worker-src 'self' blob:",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  });
  next();
});

app.use(langMiddleware);
app.use(sessionMiddleware);

// Reject cross-site state-changing requests (cookies are SameSite=Lax, this is defence in depth).
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (!req.is('application/json')) return res.status(415).json({ error: msg(req, 'unsupported_type') });
  next();
});

// Photo uploads need a bigger body limit than the rest of the API.
app.use('/api/avatar', avatarRouter);
app.use(express.json({ limit: '32kb' }));

app.use('/api/auth', authRouter);
app.use('/api/pay', paymentRouter);
app.use('/api/tts', ttsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: msg(req, 'not_found') }));

// Third-party browser libraries are served from node_modules so the site works without any CDN.
const vendor = {
  three: 'node_modules/three/build',
  mediapipe: 'node_modules/@mediapipe/tasks-vision',
  delaunator: 'node_modules/delaunator',
  vazirmatn: 'node_modules/vazirmatn',
};
// Vendor files and models change only with dependency upgrades; the site's own files are revalidated on
// every load (cheap 304s), so a deploy is visible immediately. X-File-Size lets the browser show
// download progress even when the response is compressed.
const longCache = {
  maxAge: '7d',
  setHeaders: (res, _file, stat) => res.set('X-File-Size', String(stat.size)),
};

// Brotli copies of the large assets, built at deploy time by scripts/precompress.mjs.
const PRECOMPRESSED = path.join(ROOT, 'precompressed');
const precompressed = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(PRECOMPRESSED, 'manifest.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const TYPES = { '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.task': 'application/octet-stream' };
app.use((req, res, next) => {
  const size = precompressed[req.path];
  if (!size || (req.method !== 'GET' && req.method !== 'HEAD') || !req.acceptsEncodings('br')) return next();
  res.set({
    'Content-Encoding': 'br',
    'Content-Type': TYPES[path.extname(req.path)] || 'application/octet-stream',
    'Vary': 'Accept-Encoding',
    'X-File-Size': String(size),
  });
  res.sendFile(path.join(PRECOMPRESSED, `${req.path}.br`), { maxAge: '7d' }, (err) => err && next(err));
});

for (const [name, dir] of Object.entries(vendor)) {
  app.use(`/vendor/${name}`, express.static(path.join(ROOT, dir), longCache));
}
app.use('/models', express.static(path.join(ROOT, 'public/models'), longCache));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: msg(req, 'internal_error') });
});

app.listen(config.port, config.host, () => {
  console.log(`Avatar server listening on http://${config.host}:${config.port} (public URL: ${config.baseUrl})`);
  if (!config.zarinpal.merchantId) console.warn('ZARINPAL_MERCHANT_ID is not set: payments are disabled.');
  if (!config.gemini.apiKey) console.warn('GEMINI_API_KEY is not set: 3D character generation is disabled.');
});
