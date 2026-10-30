// Small in-memory fixed-window rate limiter; enough for a single-process deployment.
export function rateLimit({ windowMs, max, key = (req) => req.ip, message = 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.' }) {
  const hits = new Map();

  setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const k = key(req);
    const t = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= t) {
      entry = { count: 0, reset: t + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - t) / 1000)));
      return res.status(429).json({ error: message });
    }
    next();
  };
}
