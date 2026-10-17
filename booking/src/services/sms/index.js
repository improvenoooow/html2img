'use strict';

const { SmsapiProvider } = require('./smsapi');
const { TwilioProvider } = require('./twilio');
const { SmsError } = require('./errors');
const { maskPhone } = require('../../lib/phone');

/** Tylko do developmentu: zamiast wysyłać, wypisuje SMS w logach. */
class ConsoleProvider {
  constructor({ logger }) {
    this.name = 'console';
    this.logger = logger;
    this.sent = [];
  }

  async send(toE164, message) {
    this.sent.push({ to: toE164, message, at: new Date() });
    if (this.sent.length > 50) this.sent.shift();
    this.logger.warn('sms_console_provider', { to: maskPhone(toE164), message });
    return { id: `console-${this.sent.length}` };
  }
}

function createSmsProvider(smsConfig, { logger, fetchImpl } = {}) {
  switch (smsConfig.provider) {
    case 'smsapi':
      return new SmsapiProvider({ ...smsConfig.smsapi, fetchImpl });
    case 'twilio':
      return new TwilioProvider({ ...smsConfig.twilio, fetchImpl });
    case 'console':
      return new ConsoleProvider({ logger });
    default:
      throw new Error(`Nieznany SMS_PROVIDER: ${smsConfig.provider}`);
  }
}

/**
 * Treść SMS-a. Domyślny szablon jest bez polskich znaków – kodowanie GSM-7 daje 160 znaków
 * w jednej wiadomości (UCS-2 tylko 70), więc SMS jest tańszy i nie dzieli się na części.
 * Opcjonalna ostatnia linia "@domena #kod" włącza autouzupełnianie kodu (WebOTP) w Chrome na Androidzie.
 */
function buildOtpMessage(smsConfig, { code, minutes, businessName }) {
  let text = smsConfig.template
    .replaceAll('{code}', code)
    .replaceAll('{minutes}', String(minutes))
    .replaceAll('{business}', businessName);
  if (smsConfig.webOtpDomain) text += `\n\n@${smsConfig.webOtpDomain} #${code}`;
  return text;
}

module.exports = { createSmsProvider, buildOtpMessage, ConsoleProvider, SmsError };
