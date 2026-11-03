"use strict";
// Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s) for two-step
// sign-in with apps such as Google Authenticator, Microsoft Authenticator or Authy.
const crypto = require("crypto");

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(buf) {
  let bits = 0, value = 0, out = "";
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += ALPHA[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += ALPHA[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const ch of String(s).toUpperCase().replace(/[^A-Z2-7]/g, "")) { value = (value << 5) | ALPHA.indexOf(ch); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
const newSecret = () => base32(crypto.randomBytes(20));

function codeAt(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", Buffer.isBuffer(secret) ? secret : unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, "0");
}
const counterAt = (ms = Date.now()) => Math.floor(ms / 1000 / 30);

// Returns the matching time step (to stop the same code being used twice), or null.
// Accepts one step either side for clock drift; `last` is the last step already used.
function verify(secret, code, last = -1, now = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c) || !secret) return null;
  const t = counterAt(now);
  for (const step of [t - 1, t, t + 1]) {
    if (step <= last) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, step)), Buffer.from(c))) return step;
  }
  return null;
}

module.exports = { base32, unbase32, newSecret, codeAt, counterAt, verify };
