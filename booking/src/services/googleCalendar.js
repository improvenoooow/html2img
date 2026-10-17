'use strict';

const crypto = require('crypto');

const SCOPE = 'https://www.googleapis.com/auth/calendar';
const DEFAULT_API_BASE = 'https://www.googleapis.com/calendar/v3';

class CalendarError extends Error {
  constructor(message, { status = null, reason = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CalendarError';
    this.status = status;
    this.reason = reason;
  }
}

const b64url = (input) => Buffer.from(input).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Klient Google Calendar API v3 uwierzytelniany kontem usługi (Service Account, OAuth2 JWT bearer).
 * Kalendarz studia musi być udostępniony adresowi client_email konta usługi
 * z uprawnieniem "Wprowadzanie zmian w wydarzeniach".
 */
class GoogleCalendarClient {
  constructor({ serviceAccount, calendarId, fetchImpl = globalThis.fetch, apiBase = DEFAULT_API_BASE, timeoutMs = 10_000 }) {
    this.sa = serviceAccount;
    this.calendarId = calendarId;
    this.fetch = fetchImpl;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this._token = null;
    this._tokenPromise = null;
  }

  _signJwt(nowSec) {
    const header = { alg: 'RS256', typ: 'JWT', ...(this.sa.privateKeyId ? { kid: this.sa.privateKeyId } : {}) };
    const claims = { iss: this.sa.clientEmail, scope: SCOPE, aud: this.sa.tokenUri, iat: nowSec, exp: nowSec + 3600 };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = crypto.sign('RSA-SHA256', Buffer.from(input), this.sa.privateKey).toString('base64url');
    return `${input}.${signature}`;
  }

  async _fetchToken() {
    const nowSec = Math.floor(Date.now() / 1000);
    let assertion;
    try {
      assertion = this._signJwt(nowSec);
    } catch (err) {
      throw new CalendarError('Nie można podpisać JWT – sprawdź private_key w kluczu Service Account', { cause: err });
    }
    let res;
    try {
      res = await this.fetch(this.sa.tokenUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new CalendarError(`Brak połączenia z serwerem tokenów Google: ${err.message}`, { cause: err });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new CalendarError(
        `Google odrzucił uwierzytelnienie Service Account: ${data.error || res.status} ${data.error_description || ''}`.trim(),
        { status: res.status, reason: data.error || 'auth_failed' },
      );
    }
    return { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000 };
  }

  async getAccessToken() {
    if (this._token && this._token.expiresAt - 60_000 > Date.now()) return this._token.value;
    // Współbieżne żądania czekają na jeden wspólny token.
    if (!this._tokenPromise) {
      this._tokenPromise = this._fetchToken()
        .then((t) => {
          this._token = t;
          return t;
        })
        .finally(() => {
          this._tokenPromise = null;
        });
    }
    return (await this._tokenPromise).value;
  }

  async _request(method, path, { body, query, notFoundAsNull = false, retries = 2 } = {}) {
    const url = new URL(this.apiBase + path);
    if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

    for (let attempt = 0; ; attempt++) {
      const token = await this.getAccessToken();
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new CalendarError(`Błąd połączenia z Google Calendar: ${err.message}`, { cause: err });
      }

      if (res.status === 204) return null;
      const data = await res.json().catch(() => null);
      if (res.ok) return data;
      if (notFoundAsNull && (res.status === 404 || res.status === 410)) return null;
      if (res.status === 401 && attempt < retries) {
        this._token = null; // wygasły/odwołany token – pobierz nowy
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(300 * 2 ** attempt);
        continue;
      }
      const reason = data?.error?.errors?.[0]?.reason || data?.error?.status || null;
      throw new CalendarError(`Google Calendar API ${res.status}: ${data?.error?.message || res.statusText}`, {
        status: res.status,
        reason,
      });
    }
  }

  /**
   * Zajęte przedziały w kalendarzu (Free/Busy). Zdarzenia oznaczone jako "Dostępny" (transparent) nie blokują.
   * @returns {Promise<{ start: Date, end: Date }[]>}
   */
  async freeBusy(timeMin, timeMax) {
    const data = await this._request('POST', '/freeBusy', {
      body: { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), items: [{ id: this.calendarId }] },
    });
    const calendars = data?.calendars || {};
    const cal = calendars[this.calendarId] || Object.values(calendars)[0];
    if (!cal) throw new CalendarError('Brak danych kalendarza w odpowiedzi Free/Busy', { reason: 'empty_response' });
    // Brak dostępu do kalendarza NIE oznacza wolnych terminów – zwracamy błąd (fail-closed).
    if (cal.errors?.length) {
      const reason = cal.errors[0].reason;
      throw new CalendarError(
        reason === 'notFound'
          ? `Kalendarz "${this.calendarId}" nie istnieje lub nie jest udostępniony kontu ${this.sa.clientEmail}`
          : `Błąd Free/Busy: ${reason}`,
        { reason },
      );
    }
    return (cal.busy || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
  }

  /**
   * Tworzy wydarzenie o zadanym `id` (idempotentnie: ponowna próba z tym samym id zwraca istniejące).
   */
  async insertEvent(event) {
    try {
      return await this._request('POST', `/calendars/${encodeURIComponent(this.calendarId)}/events`, { body: event });
    } catch (err) {
      if (err instanceof CalendarError && err.status === 409 && event.id) {
        const existing = await this.getEvent(event.id);
        if (existing && existing.status !== 'cancelled') return existing;
      }
      throw err;
    }
  }

  async getEvent(eventId) {
    return this._request(
      'GET',
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { notFoundAsNull: true },
    );
  }

  async deleteEvent(eventId) {
    await this._request(
      'DELETE',
      `/calendars/${encodeURIComponent(this.calendarId)}/events/${encodeURIComponent(eventId)}`,
      { notFoundAsNull: true, query: { sendUpdates: 'none' } },
    );
  }

  async getCalendarMeta() {
    return this._request('GET', `/calendars/${encodeURIComponent(this.calendarId)}`);
  }
}

module.exports = { GoogleCalendarClient, CalendarError, SCOPE };
