'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/context');

// Zegar testowy: pon. 19.10.2026 07:00 (Warszawa). MIN_NOTICE 60 min → pierwszy slot 08:00 (06:00Z).
const SLOT_0900 = '2026-10-19T07:00:00.000Z';
const SLOT_1000 = '2026-10-19T08:00:00.000Z';
const SLOT_1100 = '2026-10-19T09:00:00.000Z';

const person = (over = {}) => ({
  slotStart: SLOT_0900,
  firstName: 'Anna',
  lastName: 'Kowalska-Nowak',
  phone: '600 123 456',
  email: 'Anna@Example.com',
  consent: true,
  ...over,
});

async function slotsOn(ctx, date = '2026-10-19') {
  const r = await ctx.api(`/api/slots?from=${date}&to=${date}`);
  assert.equal(r.status, 200);
  return r.data.days[0].slots.map((s) => s.start);
}

let ctx;
test.beforeEach(async () => {
  ctx = await createTestContext();
});
test.afterEach(async () => {
  await ctx.close();
});

test('GET /api/config i /api/slots: godziny pracy, wyprzedzenie, horyzont, zajętość z kalendarza', async () => {
  const cfg = await ctx.api('/api/config');
  assert.equal(cfg.data.today, '2026-10-19');
  assert.equal(cfg.data.lastDate, '2026-11-18');
  assert.equal(cfg.data.holdMinutes, 10);

  ctx.calendar.addBusy('2026-10-19T09:30:00Z', '2026-10-19T10:15:00Z'); // 11:30–12:15 → blokuje 11:00 i 12:00
  const r = await ctx.api('/api/slots?from=2026-10-18&to=2026-10-20');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.data.from, '2026-10-19', 'przeszłość przycięta do dziś');
  const mon = r.data.days.find((d) => d.date === '2026-10-19');
  assert.deepEqual(
    mon.slots.map((s) => s.time),
    ['08:00', '09:00', '10:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00'],
  );
  assert.equal(r.data.days.find((d) => d.date === '2026-10-20').slots.length, 12);

  const bad = await ctx.api('/api/slots?from=jutro&to=2026-10-20');
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'VALIDATION_ERROR');
  const far = await ctx.api('/api/slots?from=2027-05-01&to=2027-05-02');
  assert.deepEqual(far.data.days, [], 'poza horyzontem rezerwacji');
});

test('pełny przepływ: soft lock → SMS → weryfikacja → wydarzenie w Google Calendar', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  assert.equal(sent.status, 200, JSON.stringify(sent.data));
  assert.match(sent.data.bookingId, /^[0-9a-f-]{36}$/);
  assert.equal(sent.data.phone, '+48 600 123 456');
  assert.equal(sent.data.lockExpiresAt, '2026-10-19T05:10:00.000Z');
  assert.equal(sent.data.otpExpiresAt, '2026-10-19T05:05:00.000Z');

  // SMS
  assert.equal(ctx.sms.sent.length, 1);
  assert.equal(ctx.sms.sent[0].to, '+48600123456');
  const code = ctx.sms.lastCode();
  assert.match(code, /^\d{6}$/);

  // Kod nie jest przechowywany jawnie.
  const row = (await ctx.pool.query('SELECT * FROM bookings')).rows[0];
  assert.equal(row.status, 'pending');
  assert.notEqual(row.otp_hash, code);
  assert.equal(row.email, 'anna@example.com');
  assert.ok(!JSON.stringify((await ctx.pool.query('SELECT * FROM sms_log')).rows).includes('600123456'), 'sms_log bez numeru');

  // Termin zablokowany dla innych.
  assert.ok(!(await slotsOn(ctx)).includes(SLOT_0900));

  // Weryfikacja
  const ok = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.status, 'confirmed');
  assert.equal(ok.data.message, 'Zarezerwowano');
  assert.equal(ok.data.booking.start, SLOT_0900);

  const events = [...ctx.calendar.events.values()];
  assert.equal(events.length, 1);
  const ev = events[0];
  assert.equal(ev.summary, 'Rezerwacja: Anna Kowalska-Nowak - +48 600 123 456');
  assert.equal(ev.start.dateTime, '2026-10-19T09:00:00.000+02:00');
  assert.equal(ev.end.dateTime, '2026-10-19T10:00:00.000+02:00');
  assert.equal(ev.start.timeZone, 'Europe/Warsaw');
  assert.equal(ev.transparency, 'opaque');
  assert.match(ev.id, /^plb[0-9a-v]{32}$/, 'ID zgodne z base32hex Google');
  assert.match(ev.description, /E-mail: anna@example.com/);

  const confirmed = (await ctx.pool.query('SELECT * FROM bookings')).rows[0];
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.gcal_event_id, ev.id);
  assert.equal(confirmed.otp_hash, null);

  // Idempotencja: ponowne potwierdzenie nie tworzy drugiego wydarzenia.
  const again = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(again.status, 200);
  assert.equal(ctx.calendar.events.size, 1);

  // Termin pozostaje zajęty także po wygaśnięciu soft locka.
  ctx.clock.advanceMinutes(30);
  assert.ok(!(await slotsOn(ctx)).includes(SLOT_0900));
});

test('wyścig: dwie osoby jednocześnie o ten sam termin → dokładnie jedna dostaje blokadę', async () => {
  const phones = ['600100100', '600100101', '600100102', '600100103', '600100104'];
  const results = await Promise.all(
    phones.map((phone, i) => ctx.api('/api/send-otp', { body: person({ phone }), ip: `10.0.0.${i + 1}` })),
  );
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409, 409]);
  for (const r of results.filter((x) => x.status === 409)) assert.equal(r.data.error.code, 'SLOT_UNAVAILABLE');
  assert.equal(ctx.sms.sent.length, 1, 'SMS tylko dla zwycięzcy');
});

test('soft lock wygasa po 10 min: termin wraca do puli, a stary kod nie działa', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  const code = ctx.sms.lastCode();
  ctx.clock.advanceMinutes(9);
  assert.ok(!(await slotsOn(ctx)).includes(SLOT_0900), 'po 9 min nadal zablokowany');
  ctx.clock.advanceMinutes(1);
  assert.ok((await slotsOn(ctx)).includes(SLOT_0900), 'po 10 min wraca do puli');

  const late = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(late.status, 410);
  assert.equal(late.data.error.code, 'HOLD_EXPIRED');

  // Inna osoba może zarezerwować zwolniony termin.
  const other = await ctx.api('/api/send-otp', { body: person({ phone: '512 000 111' }), ip: '10.0.0.9' });
  assert.equal(other.status, 200);

  const m = await ctx.services.bookings.runMaintenance();
  assert.equal(m.expired, 1);
  assert.equal(ctx.calendar.events.size, 0);
});

test('kod wygasa po 5 min (blokada trwa) – ponowna wysyłka przedłuża blokadę i unieważnia stary kod', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  const oldCode = ctx.sms.lastCode();
  ctx.clock.advanceMinutes(6);
  const expired = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: oldCode } });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error.code, 'OTP_EXPIRED');

  const resent = await ctx.api('/api/send-otp', { body: person() });
  assert.equal(resent.status, 200);
  assert.equal(resent.data.bookingId, sent.data.bookingId, 'ta sama rezerwacja');
  assert.equal(resent.data.lockExpiresAt, '2026-10-19T05:16:00.000Z');
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 1);

  const newCode = ctx.sms.lastCode();
  if (newCode !== oldCode) {
    const stale = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: oldCode } });
    assert.equal(stale.data.error.code, 'OTP_INVALID');
  }
  const ok = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: newCode } });
  assert.equal(ok.status, 200);
});

test('błędne kody: licznik prób i blokada po 5 próbach', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  const code = ctx.sms.lastCode();
  const wrong = code === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left--) {
    const r = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: wrong } });
    assert.equal(r.status, 400);
    assert.equal(r.data.error.code, 'OTP_INVALID');
    assert.equal(r.data.error.attemptsLeft, left);
  }
  const fifth = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: wrong } });
  assert.equal(fifth.status, 429);
  assert.equal(fifth.data.error.code, 'OTP_LOCKED');
  // Nawet poprawny kod nie działa po zablokowaniu.
  const locked = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(locked.data.error.code, 'OTP_LOCKED');
  assert.equal(ctx.calendar.events.size, 0);

  // Nowy kod resetuje licznik.
  ctx.clock.advanceMinutes(1);
  await ctx.api('/api/send-otp', { body: person() });
  const ok = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: ctx.sms.lastCode() } });
  assert.equal(ok.status, 200);
});

test('rate limiting: max 3 SMS na numer na godzinę + odstęp 60 s między SMS-ami', async () => {
  const send = (over, ip = '10.1.1.1') => ctx.api('/api/send-otp', { body: person(over), ip });

  assert.equal((await send()).status, 200);
  const tooFast = await send();
  assert.equal(tooFast.status, 429);
  assert.equal(tooFast.data.error.code, 'RESEND_COOLDOWN');
  assert.equal(tooFast.headers.get('retry-after'), '60');

  ctx.clock.advanceMinutes(1);
  assert.equal((await send({}, '10.1.1.2')).status, 200);
  ctx.clock.advanceMinutes(1);
  assert.equal((await send({}, '10.1.1.3')).status, 200);
  ctx.clock.advanceMinutes(1);
  const fourth = await send({}, '10.1.1.4');
  assert.equal(fourth.status, 429);
  assert.equal(fourth.data.error.code, 'RATE_LIMITED');
  assert.match(fourth.data.error.message, /57 minut/);
  assert.equal(ctx.sms.sent.length, 3);

  // Okno przesuwne: po godzinie od pierwszego SMS-a można znowu.
  ctx.clock.advanceMinutes(57);
  assert.equal((await send({ slotStart: SLOT_1000 }, '10.1.1.5')).status, 200);
});

test('rate limiting: max SMS z jednego IP na godzinę (różne numery)', async () => {
  const ip = '203.0.113.7';
  const slots = ['2026-10-19T06:00:00.000Z', SLOT_0900, SLOT_1000, SLOT_1100, '2026-10-19T10:00:00.000Z', '2026-10-19T11:00:00.000Z'];
  for (let i = 0; i < 5; i++) {
    const r = await ctx.api('/api/send-otp', { body: person({ phone: `60020030${i}`, slotStart: slots[i] }), ip });
    assert.equal(r.status, 200, `SMS ${i + 1}`);
  }
  const sixth = await ctx.api('/api/send-otp', { body: person({ phone: '600200309', slotStart: slots[5] }), ip });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.data.error.code, 'RATE_LIMITED');
  // Inny IP nie jest blokowany.
  const other = await ctx.api('/api/send-otp', { body: person({ phone: '600200309', slotStart: slots[5] }), ip: '198.51.100.1' });
  assert.equal(other.status, 200);
});

test('globalny dzienny limit SMS chroni budżet', async () => {
  await ctx.close();
  ctx = await createTestContext({ env: { SMS_LIMIT_GLOBAL_DAY: '2' } });
  assert.equal((await ctx.api('/api/send-otp', { body: person({ phone: '600000001' }), ip: '1.1.1.1' })).status, 200);
  assert.equal(
    (await ctx.api('/api/send-otp', { body: person({ phone: '600000002', slotStart: SLOT_1000 }), ip: '1.1.1.2' })).status,
    200,
  );
  const r = await ctx.api('/api/send-otp', { body: person({ phone: '600000003', slotStart: SLOT_1100 }), ip: '1.1.1.3' });
  assert.equal(r.status, 503);
  assert.equal(r.data.error.code, 'SMS_DAILY_LIMIT');
});

test('ten sam numer wybiera inny termin → poprzednia blokada jest zwalniana', async () => {
  await ctx.api('/api/send-otp', { body: person() });
  ctx.clock.advanceMinutes(1);
  const second = await ctx.api('/api/send-otp', { body: person({ slotStart: SLOT_1000 }) });
  assert.equal(second.status, 200);
  const free = await slotsOn(ctx);
  assert.ok(free.includes(SLOT_0900), 'pierwszy termin zwolniony');
  assert.ok(!free.includes(SLOT_1000), 'nowy termin zablokowany');
});

test('release-hold zwalnia termin od razu (także jako text/plain z sendBeacon)', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  const res = await fetch(`${ctx.baseUrl}/api/release-hold`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ bookingId: sent.data.bookingId }),
  });
  assert.deepEqual(await res.json(), { released: true });
  assert.ok((await slotsOn(ctx)).includes(SLOT_0900));
  const code = ctx.sms.lastCode();
  const v = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(v.data.error.code, 'HOLD_EXPIRED');
  assert.deepEqual((await ctx.api('/api/release-hold', { body: { bookingId: 'nie-uuid' } })).data, { released: false });
});

test('walidacja danych wejściowych', async () => {
  const r = await ctx.api('/api/send-otp', {
    body: { slotStart: SLOT_0900, firstName: ' ', lastName: 'K<script>', phone: '58 123 45 67', email: 'zly@', consent: 'true' },
  });
  assert.equal(r.status, 400);
  assert.deepEqual(Object.keys(r.data.error.fields).sort(), ['consent', 'email', 'firstName', 'lastName', 'phone']);
  assert.equal(ctx.sms.sent.length, 0);

  // Termin spoza grafiku (np. 09:30) i z przeszłości.
  for (const slotStart of ['2026-10-19T07:30:00.000Z', '2026-10-19T04:00:00.000Z', '2026-10-18T07:00:00.000Z', 'xyz']) {
    const s = await ctx.api('/api/send-otp', { body: person({ slotStart }) });
    assert.ok([400, 409].includes(s.status), slotStart);
  }
  // Polskie znaki w imieniu są poprawne.
  assert.equal((await ctx.api('/api/send-otp', { body: person({ firstName: 'Łucja', lastName: "Żółć-O'Neill" }) })).status, 200);

  const malformed = await fetch(`${ctx.baseUrl}/api/send-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{zly json',
  });
  assert.equal(malformed.status, 400);

  const v = await ctx.api('/api/verify-otp', { body: { bookingId: '00000000-0000-4000-8000-000000000000', code: '123456' } });
  assert.equal(v.status, 404);
  const v2 = await ctx.api('/api/verify-otp', { body: { bookingId: '00000000-0000-4000-8000-000000000000', code: '12ab' } });
  assert.equal(v2.status, 400);
});

test('honeypot: bot dostaje udaną odpowiedź, ale nic nie jest blokowane ani wysyłane', async () => {
  const r = await ctx.api('/api/send-otp', { body: person({ website: 'http://spam.example' }) });
  assert.equal(r.status, 200);
  assert.equal(ctx.sms.sent.length, 0);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
});

test('captcha (Turnstile) – odrzucenie blokuje wysyłkę SMS', async () => {
  await ctx.close();
  ctx = await createTestContext({ captcha: { enabled: true, verify: async (token) => token === 'ok-token' } });
  const bad = await ctx.api('/api/send-otp', { body: person({ captchaToken: 'zly' }) });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'CAPTCHA_FAILED');
  assert.equal(ctx.sms.sent.length, 0);
  const good = await ctx.api('/api/send-otp', { body: person({ captchaToken: 'ok-token' }) });
  assert.equal(good.status, 200);
});

test('awaria bramki SMS: termin zwolniony, limit nie zużyty', async () => {
  ctx.sms.failNext = 1;
  const r = await ctx.api('/api/send-otp', { body: person() });
  assert.equal(r.status, 502);
  assert.equal(r.data.error.code, 'SMS_SEND_FAILED');
  assert.ok((await slotsOn(ctx)).includes(SLOT_0900));
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM sms_log')).rows[0].n, 0);
  // Można od razu spróbować ponownie (bez cooldownu).
  assert.equal((await ctx.api('/api/send-otp', { body: person() })).status, 200);
});

test('awaria Google Calendar przy odczycie → 503, żadnych "fałszywie wolnych" terminów', async () => {
  ctx.calendar.failures.freeBusy = 10;
  const r = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19');
  assert.equal(r.status, 503);
  assert.equal(r.data.error.code, 'CALENDAR_UNAVAILABLE');
  const s = await ctx.api('/api/send-otp', { body: person() });
  assert.equal(s.status, 503);
  assert.equal(ctx.sms.sent.length, 0);
});

test('awaria Google przy zapisie → rezerwacja wraca do pending, ponowienie tym samym kodem działa', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  const code = ctx.sms.lastCode();
  ctx.calendar.failures.insertEvent = 1;
  const fail = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(fail.status, 503);
  assert.equal((await ctx.pool.query('SELECT status FROM bookings')).rows[0].status, 'pending');
  assert.ok(!(await slotsOn(ctx)).includes(SLOT_0900), 'termin nadal zablokowany');

  const ok = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code } });
  assert.equal(ok.status, 200);
  assert.equal(ctx.calendar.events.size, 1);
});

test('termin zajęty w kalendarzu w trakcie weryfikacji → 409 i anulowanie rezerwacji', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  ctx.calendar.addBusy('2026-10-19T07:00:00Z', '2026-10-19T08:00:00Z', 'Właścicielka wpisała coś ręcznie');
  const r = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: ctx.sms.lastCode() } });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'SLOT_UNAVAILABLE');
  assert.equal((await ctx.pool.query('SELECT status FROM bookings')).rows[0].status, 'cancelled');
});

test('konserwacja: naprawia rezerwację zawieszoną w "confirming" i usuwa stare dane (RODO)', async () => {
  const sent = await ctx.api('/api/send-otp', { body: person() });
  const id = sent.data.bookingId;
  // Symulacja: wydarzenie powstało w GCal, ale serwer padł przed zapisem statusu.
  const row = (await ctx.pool.query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0];
  await ctx.calendar.insertEvent(ctx.services.bookings.buildEvent(row));
  await ctx.pool.query(`UPDATE bookings SET status = 'confirming' WHERE id = $1`, [id]);
  ctx.clock.advanceMinutes(3);
  const m = await ctx.services.bookings.runMaintenance();
  assert.equal(m.reconciled, 1);
  assert.equal((await ctx.pool.query('SELECT status FROM bookings')).rows[0].status, 'confirmed');

  // Niepotwierdzone dane znikają po 24 h, potwierdzone po okresie retencji, dziennik SMS po 48 h.
  ctx.clock.advanceMinutes(1);
  const other = await ctx.api('/api/send-otp', { body: person({ phone: '511222333', slotStart: SLOT_1100 }), ip: '9.9.9.9' });
  assert.equal(other.status, 200);
  ctx.clock.advanceMinutes(60 * 49);
  const m2 = await ctx.services.bookings.runMaintenance();
  assert.equal(m2.expired, 1);
  assert.equal(m2.smsLog, 2, 'dziennik SMS starszy niż 48 h usunięty');
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM sms_log')).rows[0].n, 0);
  ctx.clock.advanceMinutes(60 * 23);
  assert.equal((await ctx.services.bookings.runMaintenance()).inactive, 0, 'dane wygasłej rezerwacji trzymane 24 h');
  ctx.clock.advanceMinutes(61);
  const m3 = await ctx.services.bookings.runMaintenance();
  assert.equal(m3.inactive, 1);
  ctx.clock.advanceMinutes(60 * 24 * 91);
  const m4 = await ctx.services.bookings.runMaintenance();
  assert.equal(m4.confirmed, 1);
  assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
});

test('CORS: dozwolona domena studia, obca domena bez nagłówków; widget dostępny cross-origin', async () => {
  const ok = await ctx.api('/api/config', { headers: { Origin: 'https://pilankapilatestczew.pl' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://pilankapilatestczew.pl');
  const evil = await ctx.api('/api/config', { headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);

  const js = await fetch(`${ctx.baseUrl}/widget.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(js.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.equal((await fetch(`${ctx.baseUrl}/health`)).status, 200);
});
