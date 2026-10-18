'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { clientKey } = require('../lib/ip');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function limiter({ windowMs, limit, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => clientKey(req.ip),
    handler: (req, res, _next, opts) => {
      res.status(429).json({
        error: { code: 'RATE_LIMITED', message, retryAfter: Math.ceil(opts.windowMs / 1000) },
      });
    },
  });
}

/**
 * Publiczne API widgetu rezerwacji.
 *   GET  /api/config        – parametry dla widgetu
 *   GET  /api/slots         – wolne terminy (?from=RRRR-MM-DD&to=RRRR-MM-DD)
 *   POST /api/send-otp      – soft lock terminu + wysyłka kodu SMS
 *   POST /api/verify-otp    – weryfikacja kodu, utworzenie wydarzenia w GCal, potwierdzenie
 *   POST /api/release-hold  – zwolnienie blokady (klient zmienia dane / rezygnuje)
 */
function createApiRouter({ config, availability, bookings }) {
  const router = express.Router();
  const json = express.json({ limit: '10kb' });

  router.use(
    limiter({
      windowMs: 60_000,
      limit: config.limits.apiRequestsPerMinute,
      message: 'Zbyt wiele zapytań. Odczekaj chwilę i spróbuj ponownie.',
    }),
  );
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/config', (req, res) => {
    const { booking, otp, turnstile, businessName, privacyPolicyUrl } = config;
    const b = availability.bounds();
    res.json({
      businessName,
      timezone: booking.timezone,
      slotDurationMin: booking.slotDurationMin,
      horizonDays: booking.horizonDays,
      holdMinutes: booking.holdMinutes,
      otpTtlSeconds: otp.ttlSeconds,
      resendCooldownSeconds: otp.resendCooldownSeconds,
      today: b.today,
      lastDate: b.lastDate,
      turnstileSiteKey: turnstile.siteKey,
      privacyPolicyUrl,
    });
  });

  router.get('/slots', async (req, res) => {
    const { from, to, exclude } = req.query;
    // exclude = ID własnej blokady klienta (np. po "Zmień dane"), żeby jego termin nie wyglądał na zajęty.
    const excludeBookingId = typeof exclude === 'string' && UUID_RE.test(exclude) ? exclude : null;
    res.json(await availability.getAvailability(String(from || ''), String(to || from || ''), { excludeBookingId }));
  });

  router.post(
    '/send-otp',
    limiter({
      windowMs: 10 * 60_000,
      limit: 20,
      message: 'Zbyt wiele prób wysłania kodu. Spróbuj ponownie za kilka minut.',
    }),
    json,
    async (req, res) => {
      res.json(await bookings.requestOtp(req.body || {}, { ip: req.ip }));
    },
  );

  router.post(
    '/verify-otp',
    limiter({
      windowMs: 10 * 60_000,
      limit: config.limits.verifyRequestsPer10Min,
      message: 'Zbyt wiele prób weryfikacji. Spróbuj ponownie za kilka minut.',
    }),
    json,
    async (req, res) => {
      res.json(await bookings.verifyOtp(req.body || {}));
    },
  );

  // Akceptuje też text/plain – pozwala zwolnić blokadę przez navigator.sendBeacon() przy zamknięciu strony.
  router.post('/release-hold', express.text({ limit: '2kb', type: 'text/plain' }), json, async (req, res) => {
    let body = req.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    res.json(await bookings.releaseHold(body || {}));
  });

  return router;
}

module.exports = { createApiRouter };
