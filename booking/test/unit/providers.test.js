'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { GoogleCalendarClient, CalendarError } = require('../../src/services/googleCalendar');
const { SmsapiProvider } = require('../../src/services/sms/smsapi');
const { TwilioProvider } = require('../../src/services/sms/twilio');

/** Atrapa fetch: kolejka odpowiedzi + zapis żądań. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (!next) throw new Error(`Nieoczekiwane żądanie: ${url}`);
    if (next instanceof Error) throw next;
    const { status = 200, body = {} } = typeof next === 'function' ? next(String(url), init) : next;
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  fn.calls = calls;
  return fn;
}

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = {
  clientEmail: 'booking@pilanka.iam.gserviceaccount.com',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  privateKeyId: 'kid123',
  tokenUri: 'https://oauth2.googleapis.com/token',
};

function tokenResponse(url, init) {
  // Weryfikujemy prawdziwość podpisu JWT kluczem publicznym – tak jak robi to Google.
  const assertion = new URLSearchParams(init.body.toString()).get('assertion');
  const [h, p, sig] = assertion.split('.');
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'));
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (!ok || claims.iss !== SA.clientEmail || claims.aud !== SA.tokenUri || header.kid !== 'kid123') {
    return { status: 400, body: { error: 'invalid_grant' } };
  }
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar');
  assert.equal(claims.exp - claims.iat, 3600);
  return { body: { access_token: 'ya29.test', expires_in: 3599, token_type: 'Bearer' } };
}

test('Google: podpisuje JWT, pobiera token (cache) i odpytuje Free/Busy', async () => {
  const fetch = fakeFetch([
    tokenResponse,
    (url, init) => {
      assert.equal(url, 'https://www.googleapis.com/calendar/v3/freeBusy');
      assert.equal(init.headers.Authorization, 'Bearer ya29.test');
      const body = JSON.parse(init.body);
      assert.deepEqual(body.items, [{ id: 'studio@gmail.com' }]);
      return {
        body: {
          calendars: {
            'studio@gmail.com': { busy: [{ start: '2026-10-19T08:00:00Z', end: '2026-10-19T09:30:00Z' }] },
          },
        },
      };
    },
    { body: { calendars: { 'studio@gmail.com': { busy: [] } } } },
  ]);
  const gc = new GoogleCalendarClient({ serviceAccount: SA, calendarId: 'studio@gmail.com', fetchImpl: fetch });
  const busy = await gc.freeBusy(new Date('2026-10-19T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
  assert.deepEqual(busy, [{ start: new Date('2026-10-19T08:00:00Z'), end: new Date('2026-10-19T09:30:00Z') }]);
  await gc.freeBusy(new Date('2026-10-19T00:00:00Z'), new Date('2026-10-20T00:00:00Z'));
  assert.equal(fetch.calls.filter((c) => c.url.includes('/token')).length, 1, 'token z cache');
});

test('Google: brak dostępu do kalendarza = błąd, a nie "wszystko wolne" (fail-closed)', async () => {
  const fetch = fakeFetch([
    tokenResponse,
    { body: { calendars: { 'studio@gmail.com': { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } } },
  ]);
  const gc = new GoogleCalendarClient({ serviceAccount: SA, calendarId: 'studio@gmail.com', fetchImpl: fetch });
  await assert.rejects(gc.freeBusy(new Date(), new Date(Date.now() + 3600e3)), (err) => {
    assert.ok(err instanceof CalendarError);
    assert.equal(err.reason, 'notFound');
    assert.match(err.message, /nie jest udostępniony kontu booking@pilanka/);
    return true;
  });
});

test('Google: ponawia po 503 i odświeża token po 401', async () => {
  const fetch = fakeFetch([
    tokenResponse,
    { status: 503, body: { error: { message: 'Backend Error' } } },
    { status: 401, body: { error: { message: 'Invalid Credentials' } } },
    tokenResponse,
    { body: { calendars: { c: { busy: [] } } } },
  ]);
  const gc = new GoogleCalendarClient({ serviceAccount: SA, calendarId: 'c', fetchImpl: fetch });
  assert.deepEqual(await gc.freeBusy(new Date(), new Date()), []);
  assert.equal(fetch.calls.length, 5);
});

test('Google: insertEvent jest idempotentny (409 → istniejące wydarzenie)', async () => {
  const fetch = fakeFetch([
    tokenResponse,
    { status: 409, body: { error: { message: 'The requested identifier already exists.', errors: [{ reason: 'duplicate' }] } } },
    (url) => {
      assert.match(url, /\/calendars\/studio%40gmail\.com\/events\/plbabc$/);
      return { body: { id: 'plbabc', status: 'confirmed' } };
    },
  ]);
  const gc = new GoogleCalendarClient({ serviceAccount: SA, calendarId: 'studio@gmail.com', fetchImpl: fetch });
  const ev = await gc.insertEvent({ id: 'plbabc', summary: 'x' });
  assert.equal(ev.id, 'plbabc');
});

test('Google: getEvent zwraca null dla 404, błędy uwierzytelnienia są czytelne', async () => {
  const gc = new GoogleCalendarClient({
    serviceAccount: SA,
    calendarId: 'c',
    fetchImpl: fakeFetch([tokenResponse, { status: 404, body: { error: { message: 'Not Found' } } }]),
  });
  assert.equal(await gc.getEvent('nope1'), null);

  const bad = new GoogleCalendarClient({
    serviceAccount: SA,
    calendarId: 'c',
    fetchImpl: fakeFetch([{ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }]),
  });
  await assert.rejects(bad.freeBusy(new Date(), new Date()), /invalid_grant Invalid JWT Signature/);
});

test('SMSAPI: wysyła poprawne żądanie i parsuje odpowiedź', async () => {
  const fetch = fakeFetch([
    (url, init) => {
      assert.equal(url, 'https://api.smsapi.pl/sms.do');
      assert.equal(init.headers.Authorization, 'Bearer tok123');
      assert.deepEqual(JSON.parse(init.body), {
        to: '48600123456',
        message: '123456 - kod',
        format: 'json',
        encoding: 'utf-8',
        from: 'Pilanka',
      });
      return { body: { count: 1, list: [{ id: '1460969715572091219', points: 0.16, number: '48600123456', status: 'QUEUE' }] } };
    },
  ]);
  const p = new SmsapiProvider({ token: 'tok123', sender: 'Pilanka', fetchImpl: fetch });
  assert.deepEqual(await p.send('+48600123456', '123456 - kod'), { id: '1460969715572091219', points: 0.16 });
});

test('SMSAPI: błąd w treści odpowiedzi (HTTP 200) i brak środków', async () => {
  const p = new SmsapiProvider({
    token: 't',
    fetchImpl: fakeFetch([{ body: { error: 103, message: 'Not enough points' } }]),
  });
  await assert.rejects(p.send('+48600123456', 'x'), (err) => err.code === 103 && err.configProblem === true);
  const p2 = new SmsapiProvider({ token: 't', testMode: true, fetchImpl: fakeFetch([new TypeError('fetch failed')]) });
  await assert.rejects(p2.send('+48600123456', 'x'), /błąd połączenia/);
});

test('Twilio: Basic Auth, formularz i obsługa błędów', async () => {
  const fetch = fakeFetch([
    (url, init) => {
      assert.equal(url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from('AC123:secret').toString('base64')}`);
      const form = new URLSearchParams(init.body.toString());
      assert.equal(form.get('To'), '+48600123456');
      assert.equal(form.get('From'), '+15005550006');
      assert.equal(form.get('Body'), 'kod');
      return { status: 201, body: { sid: 'SM1', status: 'queued' } };
    },
    { status: 400, body: { code: 21211, message: "The 'To' number is not a valid phone number." } },
  ]);
  const p = new TwilioProvider({ accountSid: 'AC123', authToken: 'secret', from: '+15005550006', fetchImpl: fetch });
  assert.deepEqual(await p.send('+48600123456', 'kod'), { id: 'SM1' });
  await assert.rejects(p.send('+48600123456', 'kod'), (err) => err.code === 21211 && err.configProblem === false);
});
