'use strict';

const { SmsError } = require('./errors');

/**
 * Twilio Programmable Messaging – POST /2010-04-01/Accounts/{SID}/Messages.json (Basic Auth SID:token).
 * Nadawca: numer Twilio (TWILIO_FROM) lub Messaging Service (TWILIO_MESSAGING_SERVICE_SID).
 */
class TwilioProvider {
  constructor({ accountSid, authToken, from, messagingServiceSid, baseUrl = 'https://api.twilio.com', fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    this.name = 'twilio';
    this.accountSid = accountSid;
    this.authToken = authToken;
    this.from = from;
    this.messagingServiceSid = messagingServiceSid;
    this.baseUrl = baseUrl;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(toE164, message) {
    const form = new URLSearchParams({ To: toE164, Body: message });
    if (this.messagingServiceSid) form.set('MessagingServiceSid', this.messagingServiceSid);
    else form.set('From', this.from);

    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: form,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SmsError(`Twilio: błąd połączenia: ${err.message}`, { provider: this.name, cause: err });
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const code = data?.code ?? res.status;
      throw new SmsError(`Twilio: ${data?.message || res.statusText} (kod ${code})`, {
        provider: this.name,
        code,
        // 20003: autoryzacja, 21606/21659: nieprawidłowy nadawca, 20429: limit konta
        configProblem: res.status === 401 || [20003, 21606, 21659, 20429].includes(Number(code)),
      });
    }
    return { id: data?.sid ?? null };
  }
}

module.exports = { TwilioProvider };
