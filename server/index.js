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
const longCache = { maxAge: '30d', immutable: true };
for (const [name, dir] of Object.entries(vendor)) {
  app.use(`/vendor/${name}`, express.static(path.join(ROOT, dir), longCache));
}
app.use('/models', express.static(path.join(ROOT, 'public/models'), longCache));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: msg(req, 'internal_error') });
});

app.listen(config.port, config.host, () => {
  console.log(`Avatar server listening on http://${config.host}:${config.port} (public URL: ${config.baseUrl})`);
  if (!config.zarinpal.merchantId) console.warn('ZARINPAL_MERCHANT_ID is not set: payments are disabled.');
  if (!config.gemini.apiKey) console.warn('GEMINI_API_KEY is not set: 3D character generation is disabled.');
});
