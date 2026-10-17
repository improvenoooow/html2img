'use strict';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Cloudflare Turnstile (darmowa, niewidoczna dla większości użytkowników alternatywa reCAPTCHA).
 * Opcjonalna, ale zalecana: zatrzymuje boty przed wysyłką SMS-ów na koszt studia.
 * Gdy klucze nie są skonfigurowane, weryfikacja jest pomijana.
 */
function createCaptchaVerifier({ secretKey, fetchImpl = globalThis.fetch, logger }) {
  if (!secretKey) return { enabled: false, verify: async () => true };
  return {
    enabled: true,
    async verify(token, remoteIp) {
      if (!token || typeof token !== 'string' || token.length > 2048) return false;
      try {
        const res = await fetchImpl(VERIFY_URL, {
          method: 'POST',
          body: new URLSearchParams({ secret: secretKey, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        if (!data.success) logger?.warn('captcha_rejected', { codes: data['error-codes'] });
        return data.success === true;
      } catch (err) {
        logger?.error('captcha_verify_failed', { err });
        return false;
      }
    },
  };
}

module.exports = { createCaptchaVerifier };
