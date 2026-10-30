// Manually grant subscription days, e.g. for support or testing:
//   npm run grant -- user@example.com 30
import { normalizeLogin } from '../auth.js';
import { getUserByLogin, extendSubscription } from '../db.js';

const [rawLogin, rawDays = '30'] = process.argv.slice(2);
const login = normalizeLogin(rawLogin);
const days = Number(rawDays);
const user = login && getUserByLogin(login);

if (!user || !Number.isFinite(days) || days <= 0) {
  console.error('Usage: npm run grant -- <email-or-mobile> [days]   (user must already be registered)');
  process.exit(1);
}

const expires = extendSubscription(user.id, days);
console.log(`Subscription for ${user.login} now expires at ${new Date(expires).toISOString()}`);
process.exit(0);
