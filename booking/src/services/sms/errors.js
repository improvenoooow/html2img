'use strict';

class SmsError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, code?: string|number, configProblem?: boolean, cause?: Error }} [opts]
   *   configProblem – błąd po stronie konfiguracji/konta (zły token, brak środków), a nie numeru klienta.
   *   definitive    – bramka jednoznacznie odrzuciła wiadomość (SMS na pewno nie wyszedł). Timeout, błąd sieci
   *                   czy 5xx są niejednoznaczne: SMS mógł zostać wysłany.
   */
  constructor(message, { provider, code = null, configProblem = false, definitive = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SmsError';
    this.provider = provider;
    this.code = code;
    this.configProblem = configProblem;
    this.definitive = definitive;
  }
}

module.exports = { SmsError };
