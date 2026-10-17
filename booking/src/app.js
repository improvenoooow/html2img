'use strict';

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { AppError } = require('./lib/errors');
const { createApiRouter } = require('./routes/api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function createApp({ config, pool, availability, bookings, logger }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(
    helmet({
      // Widget (JS/CSS) jest ładowany z domeny studia – musi być dostępny cross-origin.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://challenges.cloudflare.com'],
          frameSrc: ['https://challenges.cloudflare.com'],
          connectSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
        },
      },
    }),
  );

  const allowAll = config.allowedOrigins.includes('*');
  const apiCors = cors({
    origin: (origin, cb) => cb(null, !origin || allowAll || config.allowedOrigins.includes(origin)),
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    maxAge: 600,
  });

  app.get('/', (req, res) => res.json({ status: 'ok', service: 'pilanka-booking' }));

  app.get('/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch (err) {
      logger.error('health_db_failed', { err });
      res.status(503).json({ status: 'error', db: 'unavailable' });
    }
  });

  const asset = (file, type) => (req, res) => {
    res.type(type);
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(PUBLIC_DIR, file));
  };
  app.get('/widget.js', asset('widget.js', 'application/javascript'));
  app.get('/widget.css', asset('widget.css', 'text/css'));
  if (config.enableDemo) app.get('/demo', asset('demo.html', 'html'));

  app.use('/api', apiCors, createApiRouter({ config, availability, bookings }));

  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Nie znaleziono.' } }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof AppError) {
      if (err.details.retryAfter) res.set('Retry-After', String(err.details.retryAfter));
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } });
    }
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Nieprawidłowe żądanie.' } });
    }
    logger.error('unhandled_error', { err, path: req.path });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Wystąpił nieoczekiwany błąd. Spróbuj ponownie.' } });
  });

  return app;
}

module.exports = { createApp };
