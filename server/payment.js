// Zarinpal payment gateway (REST API v4).
// Flow: /api/pay/request -> redirect to StartPay -> Zarinpal redirects to /api/pay/callback -> verify.
import express from 'express';
import { config, findPlan } from './config.js';
import { db, now, extendSubscription } from './db.js';
import { requireUser } from './auth.js';
import { rateLimit } from './ratelimit.js';
import { msg } from './i18n.js';

const zp = config.zarinpal;
const host = zp.sandbox ? 'https://sandbox.zarinpal.com' : 'https://payment.zarinpal.com';
const apiBase = zp.apiBase || `${host}/pg/v4/payment`;
const startPayUrl = (authority) => `${zp.apiBase ? zp.apiBase.replace(/\/pg\/v4\/payment$/, '') : host}/pg/StartPay/${authority}`;

async function zarinpalPost(endpoint, body) {
  const res = await fetch(`${apiBase}/${endpoint}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  // Zarinpal returns `data` as [] on error and `errors` as [] on success.
  const data = json && !Array.isArray(json.data) ? json.data : null;
  const errors = json && !Array.isArray(json.errors) ? json.errors : null;
  return { data, errors };
}

export const paymentRouter = express.Router();

paymentRouter.get('/plans', (_req, res) => {
  res.json({ plans: config.plans });
});

paymentRouter.post('/request', requireUser, rateLimit({ windowMs: 10 * 60 * 1000, max: 10 }), async (req, res) => {
  const plan = findPlan(req.body?.planId);
  if (!plan) return res.status(400).json({ error: msg(req, 'unknown_plan') });
  if (!zp.merchantId) return res.status(503).json({ error: msg(req, 'payments_unavailable') });

  const amountRial = plan.priceToman * 10;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO payments (user_id, plan_id, days, amount_rial, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(req.user.id, plan.id, plan.days, amountRial, now());
  const paymentId = Number(lastInsertRowid);

  const metadata = {};
  if (req.user.login.includes('@')) metadata.email = req.user.login;
  else metadata.mobile = req.user.login;

  try {
    const { data, errors } = await zarinpalPost('request', {
      merchant_id: zp.merchantId,
      amount: amountRial,
      currency: 'IRR',
      callback_url: `${config.baseUrl}/api/pay/callback`,
      description: `My Avatar - ${plan.title}`,
      metadata,
    });
    if (!data || data.code !== 100 || !data.authority) {
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
      console.error('Zarinpal request failed', errors || data);
      return res.status(502).json({ error: msg(req, 'gateway_error') });
    }
    db.prepare('UPDATE payments SET authority = ? WHERE id = ?').run(data.authority, paymentId);
    res.json({ url: startPayUrl(data.authority) });
  } catch (err) {
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
    console.error('Zarinpal request error', err);
    res.status(502).json({ error: msg(req, 'gateway_error') });
  }
});

// Zarinpal redirects the browser here with ?Authority=...&Status=OK|NOK
paymentRouter.get('/callback', async (req, res) => {
  const authority = String(req.query.Authority || '');
  const status = String(req.query.Status || '');
  const back = (params) => res.redirect(`/?${new URLSearchParams(params)}`);

  const payment = authority && db.prepare('SELECT * FROM payments WHERE authority = ?').get(authority);
  if (!payment) return back({ payment: 'failed' });
  if (payment.status === 'paid') return back({ payment: 'success', ref: payment.ref_id });
  if (status !== 'OK') {
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payment.id);
    return back({ payment: 'cancelled' });
  }

  try {
    const { data, errors } = await zarinpalPost('verify', {
      merchant_id: zp.merchantId,
      amount: payment.amount_rial,
      authority,
    });
    // 100 = verified now, 101 = already verified earlier.
    if (data && (data.code === 100 || data.code === 101)) {
      // Guard against double crediting when the callback is hit twice concurrently.
      const changed = db
        .prepare("UPDATE payments SET status = 'paid', ref_id = ?, card_pan = ?, verified_at = ? WHERE id = ? AND status != 'paid'")
        .run(String(data.ref_id ?? ''), data.card_pan || null, now(), payment.id).changes;
      if (changed) extendSubscription(payment.user_id, payment.days);
      return back({ payment: 'success', ref: String(data.ref_id ?? '') });
    }
    console.error('Zarinpal verify failed', errors || data);
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'pending'").run(payment.id);
    back({ payment: 'failed' });
  } catch (err) {
    console.error('Zarinpal verify error', err);
    back({ payment: 'failed' });
  }
});
