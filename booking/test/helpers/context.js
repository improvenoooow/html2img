'use strict';

const { loadConfig } = require('../../src/config');
const { createLogger } = require('../../src/lib/logger');
const { createPool, migrate } = require('../../src/db');
const { buildServices } = require('../../src/container');
const { createApp } = require('../../src/app');
const { MockCalendar } = require('../../src/services/mockCalendar');
const { SmsError } = require('../../src/services/sms');

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://booking:booking@localhost:5432/booking_test';

/** Poniedziałek 19.10.2026, 07:00 czasu polskiego (CEST, UTC+2). */
const MONDAY_0700 = new Date('2026-10-19T05:00:00.000Z');

class FakeClock {
  constructor(start = MONDAY_0700) {
    this.t = new Date(start).getTime();
  }
  now() {
    return new Date(this.t);
  }
  advance(ms) {
    this.t += ms;
  }
  advanceMinutes(min) {
    this.advance(min * 60_000);
  }
}

class CapturingSms {
  constructor() {
    this.name = 'capture';
    this.sent = [];
    this.failNext = 0;
  }
  async send(to, message) {
    if (this.failNext > 0) {
      this.failNext--;
      throw new SmsError('symulowana awaria bramki', { provider: 'capture', code: 500 });
    }
    this.sent.push({ to, message });
    return { id: `cap-${this.sent.length}` };
  }
  lastCode() {
    const last = this.sent[this.sent.length - 1];
    return last ? /\b(\d{6})\b/.exec(last.message)[1] : null;
  }
}

function testEnv(overrides = {}) {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    GCAL_PROVIDER: 'mock',
    SMS_PROVIDER: 'console',
    OTP_SECRET: 'test-secret-test-secret-test-secret-1234',
    WORKING_HOURS: 'mon-fri=08:00-20:00;sat=09:00-14:00',
    SLOT_DURATION_MIN: '60',
    MIN_NOTICE_MIN: '60',
    BOOKING_HORIZON_DAYS: '30',
    HOLD_MINUTES: '10',
    OTP_TTL_SECONDS: '300',
    SMS_RESEND_COOLDOWN_SECONDS: '60',
    GCAL_CACHE_SECONDS: '0',
    ALLOWED_ORIGINS: 'https://pilankapilatestczew.pl',
    LOG_LEVEL: 'silent',
    ...overrides,
  };
}

async function resetDatabase(pool) {
  await pool.query('DROP TABLE IF EXISTS bookings, sms_log, schema_migrations CASCADE');
  await migrate(pool);
}

/**
 * Uruchamia pełną aplikację (prawdziwy Postgres, HTTP) z podmienionym kalendarzem, bramką SMS i zegarem.
 */
async function createTestContext({ env = {}, clock = new FakeClock(), captcha, alerter } = {}) {
  const config = loadConfig(testEnv(env));
  const logger = createLogger({ level: 'silent' });
  const pool = createPool(config.database);
  await resetDatabase(pool);
  const calendar = new MockCalendar({ calendarId: 'studio@test' });
  const sms = new CapturingSms();
  const services = buildServices({ config, pool, logger, clock, calendar, sms, captcha, alerter });
  const app = createApp({ config, pool, ...services, logger });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function api(path, { body, ip, headers = {} } = {}) {
    const res = await fetch(baseUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(ip ? { 'X-Forwarded-For': ip } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    return { status: res.status, data, headers: res.headers };
  }

  return {
    config,
    pool,
    calendar,
    sms,
    clock,
    services,
    baseUrl,
    api,
    async close() {
      await new Promise((r) => server.close(r));
      await pool.end();
    },
  };
}

module.exports = { createTestContext, FakeClock, CapturingSms, testEnv, MONDAY_0700, TEST_DATABASE_URL };
