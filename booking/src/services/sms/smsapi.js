'use strict';

const { SmsError } = require('./errors');

/**
 * SMSAPI.pl – POST {baseUrl}/sms.do, autoryzacja tokenem OAuth (Bearer).
 * Token generujesz w panelu SMSAPI: Ustawienia API → Tokeny API (OAuth), uprawnienie "SMS".
 * Pole nadawcy (`from`) musi być zarejestrowane i zatwierdzone w panelu; bez niego SMSAPI użyje domyślnego.
 */
class SmsapiProvider {
  constructor({ token, sender, baseUrl = 'https://api.smsapi.pl', testMode = false, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
    this.name = 'smsapi';
    this.token = token;
    this.sender = sender;
    this.baseUrl = baseUrl;
    this.testMode = testMode;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async send(toE164, message) {
    const body = {
      to: toE164.replace(/^\+/, ''),
      message,
      format: 'json',
      encoding: 'utf-8',
      ...(this.sender ? { from: this.sender } : {}),
      ...(this.testMode ? { test: 1 } : {}),
    };
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/sms.do`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new SmsError(`SMSAPI: błąd połączenia: ${err.message}`, { provider: this.name, cause: err });
    }
    const data = await res.json().catch(() => null);
    // SMSAPI zwraca błędy jako { error: <kod>, message: "..." } – czasem z HTTP 200.
    if (!res.ok || !data || data.error !== undefined) {
      const code = data?.error ?? res.status;
      throw new SmsError(`SMSAPI: ${data?.message || res.statusText} (kod ${code})`, {
        provider: this.name,
        code,
        // 101/102/103: autoryzacja / brak środków – problem konfiguracji studia, nie klienta.
        configProblem: [101, 102, 103, 105, 14].includes(Number(code)) || res.status === 401,
        // Błąd API (pole "error") lub 4xx = odrzucone. 5xx bez treści błędu – nie wiadomo, czy SMS wyszedł.
        definitive: (data && data.error !== undefined) || (res.status >= 400 && res.status < 500),
      });
    }
    const item = data.list?.[0];
    return { id: item?.id ?? null, points: item?.points ?? null };
  }

  /** Saldo konta w punktach (GET /profile). */
  async getBalance() {
    const res = await this.fetch(`${this.baseUrl}/profile`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.points === undefined) {
      throw new SmsError(`SMSAPI: nie można odczytać salda (${data?.message || res.status})`, { provider: this.name });
    }
    return { amount: Number(data.points), unit: 'pkt' };
  }
}

module.exports = { SmsapiProvider };
