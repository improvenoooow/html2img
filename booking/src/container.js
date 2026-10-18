'use strict';

const { GoogleCalendarClient } = require('./services/googleCalendar');
const { MockCalendar } = require('./services/mockCalendar');
const { AvailabilityService } = require('./services/availability');
const { BookingService } = require('./services/booking');
const { createSmsProvider } = require('./services/sms');
const { createCaptchaVerifier } = require('./services/captcha');
const { createAlerter } = require('./services/alerts');

const systemClock = { now: () => new Date() };

function createCalendar(gcalConfig) {
  if (gcalConfig.provider === 'mock') return new MockCalendar({ calendarId: gcalConfig.calendarId || 'mock@calendar' });
  return new GoogleCalendarClient({ serviceAccount: gcalConfig.serviceAccount, calendarId: gcalConfig.calendarId });
}

/** Składa serwisy aplikacji. Zależności zewnętrzne (kalendarz, SMS, zegar) można podmienić w testach. */
function buildServices({ config, pool, logger, clock = systemClock, calendar, sms, captcha, alerter }) {
  const cal = calendar || createCalendar(config.gcal);
  const smsProvider = sms || createSmsProvider(config.sms, { logger });
  const captchaVerifier = captcha || createCaptchaVerifier({ secretKey: config.turnstile.secretKey, logger });
  const alerts =
    alerter ||
    createAlerter({
      webhookUrl: config.alerts.webhookUrl,
      cooldownMinutes: config.alerts.cooldownMinutes,
      businessName: config.businessName,
      logger,
    });
  const availability = new AvailabilityService({ config, calendar: cal, pool, clock, logger, alerts });
  const bookings = new BookingService({
    config,
    pool,
    calendar: cal,
    availability,
    sms: smsProvider,
    captcha: captchaVerifier,
    clock,
    logger,
    alerts,
  });
  return { calendar: cal, sms: smsProvider, captcha: captchaVerifier, alerts, availability, bookings };
}

module.exports = { buildServices, createCalendar, systemClock };
