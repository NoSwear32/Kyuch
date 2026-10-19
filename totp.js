// Time-based one-time passwords (RFC 6238), stored as an otpauth:// link in the entry's "otp" field (KeePassXC's convention).
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALGS = ['SHA1', 'SHA256', 'SHA512'];

function base32Decode(s) {
  const clean = String(s).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!clean) throw new Error('Enter the secret key or an otpauth:// link');
  const out = [];
  let bits = 0, val = 0;
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('The secret key may only contain the letters A–Z and the digits 2–7');
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; val &= (1 << bits) - 1; }
  }
  return Buffer.from(out);
}

function base32Encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const b of buf) {
    val = (val << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; val &= (1 << bits) - 1; }
  }
  return bits ? out + B32[(val << (5 - bits)) & 31] : out;
}

// Accepts an otpauth://totp/... link or a bare base32 secret (opts supply digits/period/algorithm for a bare secret).
function parse(input, opts = {}) {
  const s = String(input ?? '').trim();
  let secret = s, digits = opts.digits || 6, period = opts.period || 30, algorithm = String(opts.algorithm || 'SHA1').toUpperCase();
  let issuer = '', label = '';
  if (/^otpauth:/i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new Error('That is not a valid otpauth:// link'); }
    if (u.hostname.toLowerCase() !== 'totp') throw new Error('Only time-based (totp) codes are supported');
    const q = u.searchParams;
    secret = q.get('secret') || '';
    try { label = decodeURIComponent(u.pathname.replace(/^\//, '')); } catch { label = u.pathname.replace(/^\//, ''); } // a stray % must not break the whole link
    if ((q.get('encoder') || '').toLowerCase() === 'steam') throw new Error('Steam Guard codes are not supported');
    issuer = q.get('issuer') || (label.includes(':') ? label.split(':')[0] : '');
    digits = Number(q.get('digits')) || 6; period = Number(q.get('period')) || 30; algorithm = (q.get('algorithm') || 'SHA1').toUpperCase();
  }
  digits = Number(digits); period = Number(period);
  if (![6, 7, 8].includes(digits)) throw new Error('Digits must be 6, 7 or 8');
  if (!Number.isInteger(period) || period < 5 || period > 300) throw new Error('The period must be between 5 and 300 seconds');
  if (!ALGS.includes(algorithm)) throw new Error('Algorithm must be SHA1, SHA256 or SHA512');
  const key = base32Decode(secret);
  if (key.length < 10) throw new Error('That secret key is too short to be valid (at least 16 characters)');
  return { key, secret: base32Encode(key), digits, period, algorithm, issuer, label };
}

const build = (c) => {
  const label = encodeURIComponent(c.label || c.issuer || 'Kyuch');
  const q = new URLSearchParams({ secret: c.secret, period: String(c.period), digits: String(c.digits), algorithm: c.algorithm });
  if (c.issuer) q.set('issuer', c.issuer);
  return `otpauth://totp/${label}?${q}`;
};

// The code for the time window containing `now` (ms).
function code(c, now = Date.now()) {
  const counter = Math.floor(now / 1000 / c.period);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(c.algorithm.toLowerCase(), c.key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  const validUntil = (counter + 1) * c.period * 1000;
  return { code: String(bin % 10 ** c.digits).padStart(c.digits, '0'), period: c.period, validUntil, remaining: Math.ceil((validUntil - now) / 1000) };
}

module.exports = { parse, build, code, base32Decode, base32Encode };
