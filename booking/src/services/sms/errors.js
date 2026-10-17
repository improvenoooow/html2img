'use strict';

class SmsError extends Error {
  /**
   * @param {string} message
   * @param {{ provider?: string, code?: string|number, configProblem?: boolean, cause?: Error }} [opts]
   *   configProblem – błąd po stronie konfiguracji/konta (zły token, brak środków), a nie numeru klienta.
   */
  constructor(message, { provider, code = null, configProblem = false, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'SmsError';
    this.provider = provider;
    this.code = code;
    this.configProblem = configProblem;
  }
}

module.exports = { SmsError };
