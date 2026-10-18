'use strict';

const crypto = require('crypto');

/** Kryptograficznie bezpieczny 6-cyfrowy kod (z zerami wiodącymi). */
function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', secret).update(String(value)).digest('hex');
}

/**
 * Kod OTP nigdy nie trafia do bazy jawnym tekstem. Hash jest związany z konkretną
 * rezerwacją, więc ten sam kod w innej rezerwacji ma inny hash.
 */
function hashOtp(secret, bookingId, code) {
  return hmac(secret, `otp:${bookingId}:${code}`);
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** Pseudonimizacja identyfikatorów do rate limitingu (telefon, IP) – RODO: minimalizacja danych. */
function pseudonymize(secret, kind, value) {
  return hmac(secret, `${kind}:${value}`);
}

/** Losowy token blokady (192 bity) – zwracany klientowi, w bazie trzymamy tylko jego SHA-256. */
function generateHoldToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashHoldToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

module.exports = { generateOtp, hashOtp, safeEqualHex, pseudonymize, hmac, generateHoldToken, hashHoldToken };
