'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateOtp, hashOtp, safeEqualHex, pseudonymize } = require('../../src/lib/crypto');
const { loadConfig, ConfigError } = require('../../src/config');
const { buildOtpMessage } = require('../../src/services/sms');
const { testEnv } = require('../helpers/context');

test('OTP ma zawsze 6 cyfr i jest losowy', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const c = generateOtp();
    assert.match(c, /^\d{6}$/);
    seen.add(c);
  }
  assert.ok(seen.size > 1990, 'brak powtórzeń w praktyce');
});

test('hash OTP jest związany z rezerwacją i porównywany w stałym czasie', () => {
  const a = hashOtp('s'.repeat(32), 'booking-1', '123456');
  assert.equal(a, hashOtp('s'.repeat(32), 'booking-1', '123456'));
  assert.notEqual(a, hashOtp('s'.repeat(32), 'booking-2', '123456'));
  assert.notEqual(a, hashOtp('x'.repeat(32), 'booking-1', '123456'));
  assert.equal(safeEqualHex(a, a), true);
  assert.equal(safeEqualHex(a, hashOtp('s'.repeat(32), 'booking-1', '123457')), false);
  assert.equal(safeEqualHex(a, 'abc'), false);
  assert.notEqual(pseudonymize('k', 'phone', '+48600123456'), pseudonymize('k', 'ip', '+48600123456'));
});

test('domyślna konfiguracja testowa jest poprawna', () => {
  const c = loadConfig(testEnv());
  assert.equal(c.booking.slotDurationMin, 60);
  assert.equal(c.booking.slotStepMin, 60);
  assert.equal(c.limits.smsPerPhonePerHour, 3);
  assert.equal(c.booking.holdMinutes, 10);
  assert.equal(c.otp.ttlSeconds, 300);
});

test('produkcja wymaga sekretów, prawdziwych dostawców i domen CORS', () => {
  try {
    loadConfig({ NODE_ENV: 'production' });
    assert.fail('powinien rzucić');
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    const all = err.problems.join('\n');
    for (const needle of ['OTP_SECRET', 'GOOGLE_CALENDAR_ID', 'Service Account', 'SMS_PROVIDER', 'ALLOWED_ORIGINS', 'DATABASE_URL']) {
      assert.ok(all.includes(needle), `brak komunikatu o ${needle}:\n${all}`);
    }
  }
  assert.throws(
    () => loadConfig(testEnv({ NODE_ENV: 'production', GCAL_PROVIDER: 'mock', SMS_PROVIDER: 'console' })),
    /niedozwolony w produkcji/,
  );
});

test('wykrywa błędy wartości', () => {
  assert.throws(() => loadConfig(testEnv({ SLOT_DURATION_MIN: 'abc' })), /SLOT_DURATION_MIN/);
  assert.throws(() => loadConfig(testEnv({ OTP_TTL_SECONDS: '900', HOLD_MINUTES: '10' })), /OTP_TTL_SECONDS/);
  assert.throws(() => loadConfig(testEnv({ TIMEZONE: 'Mars/Olympus' })), /TIMEZONE/);
  assert.throws(() => loadConfig(testEnv({ SMS_TEMPLATE: 'bez kodu' })), /SMS_TEMPLATE/);
  assert.throws(() => loadConfig(testEnv({ TURNSTILE_SITE_KEY: 'x' })), /TURNSTILE/);
  assert.throws(() => loadConfig(testEnv({ SMS_PROVIDER: 'smsapi' })), /SMSAPI_TOKEN/);
});

test('wczytuje klucz Service Account z JSON i base64', () => {
  const sa = JSON.stringify({
    type: 'service_account',
    client_email: 'booking@proj.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
  });
  const base = testEnv({ GCAL_PROVIDER: 'google', GOOGLE_CALENDAR_ID: 'studio@gmail.com' });
  const c1 = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON: sa });
  assert.equal(c1.gcal.serviceAccount.clientEmail, 'booking@proj.iam.gserviceaccount.com');
  assert.ok(c1.gcal.serviceAccount.privateKey.includes('\nabc\n'), 'zamienia \\n na nowe linie');
  const c2 = loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_BASE64: Buffer.from(sa).toString('base64') });
  assert.equal(c2.gcal.serviceAccount.tokenUri, 'https://oauth2.googleapis.com/token');
  assert.throws(() => loadConfig({ ...base, GOOGLE_SERVICE_ACCOUNT_JSON: '{"type":"user"}' }), /service_account/);
});

test('treść SMS: szablon, GSM-7 i opcjonalna linia WebOTP', () => {
  const c = loadConfig(testEnv());
  const msg = buildOtpMessage(c.sms, { code: '042137', minutes: 5, businessName: c.businessName });
  assert.equal(msg, '042137 - Twoj kod do rezerwacji w Pilanka Pilates Tczew. Wazny 5 min.');
  assert.ok(msg.length <= 160);
  assert.match(msg, /^[\x20-\x7E]+$/, 'tylko znaki ASCII (1 SMS = 160 znaków)');
  const c2 = loadConfig(testEnv({ OTP_WEBOTP_DOMAIN: 'pilankapilatestczew.pl' }));
  assert.ok(buildOtpMessage(c2.sms, { code: '042137', minutes: 5, businessName: 'X' }).endsWith('\n\n@pilankapilatestczew.pl #042137'));
});
