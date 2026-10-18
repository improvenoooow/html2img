'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { IANAZone } = require('luxon');
const { parseWorkingHours, parseClosedDates } = require('./lib/schedule');

class ConfigError extends Error {
  constructor(problems) {
    super(`Nieprawidłowa konfiguracja:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

function readServiceAccount(env, problems) {
  let raw = null;
  try {
    if (env.GOOGLE_SERVICE_ACCOUNT_JSON) raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
    else if (env.GOOGLE_SERVICE_ACCOUNT_BASE64) raw = Buffer.from(env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8');
    else if (env.GOOGLE_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(env.GOOGLE_SERVICE_ACCOUNT_FILE, 'utf8');
  } catch (err) {
    problems.push(`Nie można odczytać klucza Service Account: ${err.message}`);
    return null;
  }
  if (!raw) {
    problems.push(
      'Brak klucza Service Account – ustaw GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_SERVICE_ACCOUNT_BASE64 lub GOOGLE_SERVICE_ACCOUNT_FILE',
    );
    return null;
  }
  try {
    const sa = JSON.parse(raw);
    if (sa.type !== 'service_account' || !sa.client_email || !sa.private_key) {
      problems.push('Klucz Service Account musi zawierać type="service_account", client_email i private_key');
      return null;
    }
    return {
      clientEmail: sa.client_email,
      privateKey: sa.private_key.replace(/\\n/g, '\n'),
      privateKeyId: sa.private_key_id,
      tokenUri: sa.token_uri || 'https://oauth2.googleapis.com/token',
    };
  } catch {
    problems.push('Klucz Service Account nie jest poprawnym JSON-em');
    return null;
  }
}

/**
 * Wczytuje i waliduje konfigurację. Rzuca ConfigError z pełną listą problemów,
 * żeby błędna konfiguracja na Railway była widoczna od razu przy starcie, a nie przy pierwszej rezerwacji.
 * @param {object} env
 * @param {{ only?: 'gcal' | 'sms' }} [opts] – częściowa walidacja dla skryptów diagnostycznych
 */
function loadConfig(env = process.env, opts = {}) {
  const problems = [];
  const warnings = [];
  const isProd = env.NODE_ENV === 'production';

  const int = (name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      problems.push(`${name} musi być liczbą całkowitą z zakresu ${min}–${max} (jest "${raw}")`);
      return def;
    }
    return n;
  };
  const bool = (name, def) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return def;
    return ['1', 'true', 'yes', 'tak', 'on'].includes(String(raw).toLowerCase());
  };
  const str = (name, def = '') => (env[name] === undefined || env[name] === '' ? def : String(env[name]).trim());

  // --- Harmonogram ---
  const timezone = str('TIMEZONE', 'Europe/Warsaw');
  if (!IANAZone.isValidZone(timezone)) problems.push(`TIMEZONE "${timezone}" nie jest poprawną strefą IANA`);

  let schedule = null;
  const workingHours = str('WORKING_HOURS', 'mon-fri=08:00-20:00;sat=09:00-14:00');
  try {
    schedule = parseWorkingHours(workingHours);
  } catch (err) {
    problems.push(`WORKING_HOURS: ${err.message}`);
  }
  let closedDates = new Set();
  try {
    closedDates = parseClosedDates(str('CLOSED_DATES'));
  } catch (err) {
    problems.push(err.message);
  }

  const slotDurationMin = int('SLOT_DURATION_MIN', 60, { min: 5, max: 600 });
  const bufferMin = int('BUFFER_MIN', 0, { min: 0, max: 240 });
  const slotStepMin = int('SLOT_STEP_MIN', slotDurationMin + bufferMin, { min: 5, max: 600 });

  const booking = {
    timezone,
    workingHours,
    schedule,
    closedDates,
    slotDurationMin,
    slotStepMin,
    bufferMin,
    slotCapacity: int('SLOT_CAPACITY', 1, { min: 1, max: 100 }),
    minNoticeMin: int('MIN_NOTICE_MIN', 120, { min: 0, max: 60 * 24 * 30 }),
    horizonDays: int('BOOKING_HORIZON_DAYS', 60, { min: 1, max: 365 }),
    holdMinutes: int('HOLD_MINUTES', 10, { min: 2, max: 60 }),
    retentionDays: int('BOOKING_RETENTION_DAYS', 90, { min: 1, max: 3650 }),
  };

  // --- OTP i limity ---
  let otpSecret = str('OTP_SECRET');
  if (!otpSecret) {
    if (isProd && !opts.only) problems.push('OTP_SECRET jest wymagany w produkcji (min. 32 znaki, np. `openssl rand -hex 32`)');
    otpSecret = crypto.randomBytes(32).toString('hex');
    if (!opts.only) warnings.push('OTP_SECRET nie ustawiony – wygenerowano losowy (kody stracą ważność po restarcie)');
  } else if (otpSecret.length < 32) {
    problems.push('OTP_SECRET musi mieć co najmniej 32 znaki');
  }

  const otp = {
    secret: otpSecret,
    ttlSeconds: int('OTP_TTL_SECONDS', 300, { min: 60, max: 1800 }),
    maxAttempts: int('OTP_MAX_ATTEMPTS', 5, { min: 1, max: 10 }),
    resendCooldownSeconds: int('SMS_RESEND_COOLDOWN_SECONDS', 60, { min: 0, max: 600 }),
  };
  if (otp.ttlSeconds > booking.holdMinutes * 60) {
    problems.push('OTP_TTL_SECONDS nie może być dłuższy niż HOLD_MINUTES – kod musi wygasać przed blokadą terminu');
  }

  const limits = {
    smsPerPhonePerHour: int('SMS_LIMIT_PER_PHONE_HOUR', 3, { min: 1, max: 100 }),
    smsPerIpPerHour: int('SMS_LIMIT_PER_IP_HOUR', 5, { min: 1, max: 1000 }),
    smsGlobalPerDay: int('SMS_LIMIT_GLOBAL_DAY', 150, { min: 1, max: 100000 }),
    apiRequestsPerMinute: int('API_RATE_LIMIT_PER_MINUTE', 120, { min: 10, max: 10000 }),
    verifyRequestsPer10Min: int('VERIFY_RATE_LIMIT_PER_10MIN', 30, { min: 5, max: 1000 }),
  };

  // --- Google Calendar ---
  const gcalProvider = str('GCAL_PROVIDER', isProd ? 'google' : 'mock').toLowerCase();
  const gcal = {
    provider: gcalProvider,
    calendarId: str('GOOGLE_CALENDAR_ID'),
    serviceAccount: null,
    cacheSeconds: int('GCAL_CACHE_SECONDS', 30, { min: 0, max: 600 }),
    eventColorId: str('GCAL_EVENT_COLOR_ID') || null,
  };
  if (opts.only !== 'sms') {
    if (!['google', 'mock'].includes(gcalProvider)) problems.push('GCAL_PROVIDER musi być "google" lub "mock"');
    if (gcalProvider === 'google') {
      if (!gcal.calendarId) problems.push('GOOGLE_CALENDAR_ID jest wymagany (np. adres e-mail kalendarza)');
      gcal.serviceAccount = readServiceAccount(env, problems);
    } else if (isProd && !opts.only) {
      problems.push('GCAL_PROVIDER=mock jest niedozwolony w produkcji');
    }
  }

  // --- Bramka SMS ---
  const smsProvider = str('SMS_PROVIDER', isProd ? '' : 'console').toLowerCase();
  const sms = {
    provider: smsProvider,
    template: str('SMS_TEMPLATE', '{code} - Twoj kod do rezerwacji w {business}. Wazny {minutes} min.'),
    webOtpDomain: str('OTP_WEBOTP_DOMAIN') || null,
    smsapi: {
      token: str('SMSAPI_TOKEN'),
      sender: str('SMSAPI_SENDER') || null,
      baseUrl: str('SMSAPI_BASE_URL', 'https://api.smsapi.pl').replace(/\/$/, ''),
      testMode: bool('SMSAPI_TEST_MODE', false),
    },
    twilio: {
      accountSid: str('TWILIO_ACCOUNT_SID'),
      authToken: str('TWILIO_AUTH_TOKEN'),
      from: str('TWILIO_FROM') || null,
      messagingServiceSid: str('TWILIO_MESSAGING_SERVICE_SID') || null,
      baseUrl: str('TWILIO_BASE_URL', 'https://api.twilio.com').replace(/\/$/, ''),
    },
  };
  if (opts.only !== 'gcal') {
    if (!['smsapi', 'twilio', 'console'].includes(smsProvider)) {
      problems.push('SMS_PROVIDER musi być "smsapi", "twilio" lub "console" (tylko dev)');
    }
    if (smsProvider === 'smsapi' && !sms.smsapi.token) problems.push('SMSAPI_TOKEN jest wymagany dla SMS_PROVIDER=smsapi');
    if (smsProvider === 'twilio') {
      if (!sms.twilio.accountSid || !sms.twilio.authToken) problems.push('TWILIO_ACCOUNT_SID i TWILIO_AUTH_TOKEN są wymagane');
      if (!sms.twilio.from && !sms.twilio.messagingServiceSid) {
        problems.push('Ustaw TWILIO_FROM lub TWILIO_MESSAGING_SERVICE_SID');
      }
    }
    if (smsProvider === 'console' && isProd && !opts.only) problems.push('SMS_PROVIDER=console jest niedozwolony w produkcji');
    if (!sms.template.includes('{code}')) problems.push('SMS_TEMPLATE musi zawierać {code}');
  }

  // --- HTTP / bezpieczeństwo ---
  const allowedOrigins = str('ALLOWED_ORIGINS', isProd ? '' : '*')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  if (isProd && !opts.only && allowedOrigins.length === 0) {
    problems.push('ALLOWED_ORIGINS jest wymagany w produkcji, np. "https://pilankapilatestczew.pl,https://www.pilankapilatestczew.pl"');
  }
  if (isProd && allowedOrigins.includes('*')) warnings.push('ALLOWED_ORIGINS="*" w produkcji – zalecane jest podanie konkretnych domen');

  // Domyślnie NIE ufamy X-Forwarded-For – bez proxy przed aplikacją klient mógłby podać dowolne IP
  // i obejść limity SMS na IP. Za nginx/Caddy/Railway ustaw TRUST_PROXY=1 (liczba proxy).
  const trustProxyRaw = str('TRUST_PROXY', 'false').toLowerCase();
  const trustProxy = /^\d+$/.test(trustProxyRaw)
    ? Number(trustProxyRaw)
    : trustProxyRaw === 'true'
      ? true
      : trustProxyRaw === 'false'
        ? false
        : trustProxyRaw;
  if (isProd && !opts.only && !trustProxy) {
    warnings.push(
      'TRUST_PROXY nie jest ustawiony – jeśli aplikacja stoi za nginx/Caddy/Railway, ustaw TRUST_PROXY=1, ' +
        'inaczej wszyscy klienci będą mieli wspólny limit SMS na IP',
    );
  }

  const turnstile = {
    siteKey: str('TURNSTILE_SITE_KEY') || null,
    secretKey: str('TURNSTILE_SECRET_KEY') || null,
  };
  if (Boolean(turnstile.siteKey) !== Boolean(turnstile.secretKey)) {
    problems.push('TURNSTILE_SITE_KEY i TURNSTILE_SECRET_KEY muszą być ustawione razem');
  }
  if (isProd && !opts.only && !turnstile.secretKey) {
    warnings.push(
      'Cloudflare Turnstile nie jest skonfigurowany – zalecany w produkcji, utrudnia botom wysyłkę SMS-ów na koszt studia',
    );
  }

  const alerts = {
    webhookUrl: str('ALERT_WEBHOOK_URL') || null,
    cooldownMinutes: int('ALERT_COOLDOWN_MINUTES', 60, { min: 1, max: 24 * 60 }),
    smsLowBalance: env.SMS_LOW_BALANCE_ALERT ? Number(env.SMS_LOW_BALANCE_ALERT) : null,
  };
  if (alerts.webhookUrl && !/^https:\/\/[^\s]+$/i.test(alerts.webhookUrl)) {
    problems.push('ALERT_WEBHOOK_URL musi być adresem https://');
  }
  if (alerts.smsLowBalance !== null && !(alerts.smsLowBalance >= 0)) {
    problems.push('SMS_LOW_BALANCE_ALERT musi być liczbą ≥ 0 (próg salda bramki SMS)');
  }

  const database = {
    url: str('DATABASE_URL'),
    ssl: bool('DATABASE_SSL', false),
  };
  if (!opts.only && !database.url) problems.push('DATABASE_URL jest wymagany (PostgreSQL)');

  if (problems.length) throw new ConfigError(problems);

  return {
    env: env.NODE_ENV || 'development',
    isProd,
    port: int('PORT', 8080, { min: 1, max: 65535 }),
    logLevel: str('LOG_LEVEL', 'info'),
    businessName: str('BUSINESS_NAME', 'Pilanka Pilates Tczew'),
    eventTitlePrefix: str('EVENT_TITLE_PREFIX', 'Rezerwacja'),
    privacyPolicyUrl: str('PRIVACY_POLICY_URL') || null,
    enableDemo: bool('ENABLE_DEMO', !isProd),
    allowedOrigins,
    trustProxy,
    database,
    booking,
    otp,
    limits,
    gcal,
    sms,
    turnstile,
    alerts,
    warnings,
  };
}

module.exports = { loadConfig, ConfigError };
