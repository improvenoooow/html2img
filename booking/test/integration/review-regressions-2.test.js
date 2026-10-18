'use strict';

/**
 * Testy regresyjne dla problemów z ponownej weryfikacji poprawek (N1–N7).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/context');
const { SmsError } = require('../../src/services/sms');

const SLOT_A = '2026-10-19T07:00:00.000Z'; // 09:00
const SLOT_B = '2026-10-19T08:00:00.000Z'; // 10:00
const SLOT_C = '2026-10-19T09:00:00.000Z'; // 11:00
const person = (over = {}) => ({ slotStart: SLOT_A, firstName: 'Anna', lastName: 'Kowalska', phone: '600123456', consent: true, ...over });

async function slotsOn(ctx) {
  const r = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19');
  return r.data.days[0].slots.map((s) => s.start);
}

test('N1: brak podwójnej rezerwacji nawet gdy Free/Busy w Google nie widzi jeszcze nowego wydarzenia', async () => {
  const ctx = await createTestContext();
  try {
    const a = await ctx.api('/api/send-otp', { body: person() });
    await ctx.api('/api/verify-otp', { body: { bookingId: a.data.bookingId, code: ctx.sms.lastCode() } });
    // Symulacja opóźnienia Google: Free/Busy jeszcze nie zawiera wydarzenia A.
    ctx.calendar.freeBusy = async () => [];
    const b = await ctx.api('/api/send-otp', { body: person({ phone: '511222333' }), ip: '10.0.0.2' });
    assert.equal(b.status, 409);
    assert.equal(b.data.error.code, 'SLOT_UNAVAILABLE');
    const confirmed = await ctx.pool.query(`SELECT count(*)::int AS n FROM bookings WHERE status = 'confirmed'`);
    assert.equal(confirmed.rows[0].n, 1);
  } finally {
    await ctx.close();
  }
});

test('N2: przywrócenie po nieudanej wysyłce nie cofa przeniesionej w międzyczasie blokady na zajęty termin', async () => {
  const ctx = await createTestContext();
  try {
    const a = await ctx.api('/api/send-otp', { body: person() });
    const token = a.data.holdToken;
    ctx.clock.advanceMinutes(2);

    // Ponowna wysyłka, która długo trwa i ostatecznie się nie udaje.
    let release;
    const gate = new Promise((r) => (release = r));
    ctx.sms.send = async () => {
      await gate;
      throw new SmsError('odrzucone', { provider: 'capture', code: 13, definitive: true });
    };
    const resendP = ctx.api('/api/send-otp', { body: person({ holdToken: token, resend: true }) });
    await new Promise((r) => setTimeout(r, 150));

    // W tym czasie klient przenosi blokadę na 10:00 (kod z nieudanej wysyłki "obowiązuje" w bazie, więc
    // przeniesienie idzie bez SMS-a), a ktoś inny zajmuje zwolnione 09:00.
    ctx.sms.send = async () => ({ id: 'x' });
    const move = await ctx.api('/api/send-otp', { body: person({ slotStart: SLOT_B, holdToken: token }) });
    assert.equal(move.status, 200, JSON.stringify(move.data));
    ctx.sms.sent.length = 0;
    ctx.sms.send = async (to, message) => {
      ctx.sms.sent.push({ to, message });
      return { id: 'v' };
    };
    const v = await ctx.api('/api/send-otp', { body: person({ phone: '511222333', firstName: 'Vera' }), ip: '10.0.0.9' });
    assert.equal(v.status, 200);

    release();
    assert.equal((await resendP).status, 502);
    const rows = (await ctx.pool.query(`SELECT slot_start FROM bookings WHERE status = 'pending' ORDER BY slot_start`)).rows;
    assert.deepEqual(rows.map((r) => r.slot_start.toISOString()), [SLOT_A, SLOT_B], 'A zostaje na 10:00, V na 09:00');
  } finally {
    await ctx.close();
  }
});

test('N3: jeden numer ma najwyżej 2 niepotwierdzone blokady; potwierdzenie zwalnia pozostałe', async () => {
  const ctx = await createTestContext();
  try {
    assert.equal((await ctx.api('/api/send-otp', { body: person({ slotStart: SLOT_A }) })).status, 200);
    ctx.clock.advanceMinutes(1.1);
    const second = await ctx.api('/api/send-otp', { body: person({ slotStart: SLOT_B }), ip: '10.0.0.2' });
    assert.equal(second.status, 200);
    ctx.clock.advanceMinutes(1.1);
    const third = await ctx.api('/api/send-otp', { body: person({ slotStart: SLOT_C }), ip: '10.0.0.3' });
    assert.equal(third.status, 429);
    assert.equal(third.data.error.code, 'TOO_MANY_HOLDS');

    await ctx.api('/api/verify-otp', { body: { bookingId: second.data.bookingId, code: ctx.sms.lastCode() } });
    assert.ok((await slotsOn(ctx)).includes(SLOT_A), 'pierwsza blokada zwolniona po potwierdzeniu drugiej');
  } finally {
    await ctx.close();
  }
});

test('N4: ID rezerwacji nie daje kontroli nad blokadą – potrzebny token, którego nie wydajemy bez dowodu', async () => {
  const ctx = await createTestContext();
  try {
    const a = await ctx.api('/api/send-otp', { body: person() });
    assert.match(a.data.holdToken, /^[A-Za-z0-9_-]{32}$/);

    // Samo ID: brak zwolnienia i brak zmiany danych.
    assert.deepEqual((await ctx.api('/api/release-hold', { body: { bookingId: a.data.bookingId } })).data, { released: false });
    await ctx.api('/api/send-otp', {
      body: person({ firstName: 'Mallory', previousBookingId: a.data.bookingId, holdToken: a.data.bookingId }),
      ip: '10.6.6.6',
    });
    const row = (await ctx.pool.query('SELECT first_name FROM bookings WHERE id = $1', [a.data.bookingId])).rows[0];
    assert.equal(row.first_name, 'Anna');

    // Ponowna wysyłka bez tokenu z tymi samymi danymi nie wydaje tokenu do istniejącej blokady.
    ctx.clock.advanceMinutes(2);
    const again = await ctx.api('/api/send-otp', { body: person(), ip: '10.6.6.7' });
    assert.equal(again.status, 200);
    assert.equal(again.data.bookingId, a.data.bookingId);
    assert.equal(again.data.holdToken, undefined);

    // Właściciel z tokenem zwalnia blokadę.
    assert.deepEqual((await ctx.api('/api/release-hold', { body: { holdToken: a.data.holdToken } })).data, { released: true });

    // Token w nagłówku (nie w URL) ukrywa własną blokadę na liście terminów.
    const b = await ctx.api('/api/send-otp', { body: person({ slotStart: SLOT_B, phone: '512000000' }), ip: '10.0.0.5' });
    assert.equal(b.status, 200);
    const own = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19', { headers: { 'X-Hold-Token': b.data.holdToken } });
    assert.ok(own.data.days[0].slots.some((s) => s.start === SLOT_B));
    assert.ok(!(await slotsOn(ctx)).includes(SLOT_B));
  } finally {
    await ctx.close();
  }
});

test('N6: wydarzenie nieobecne na liście, ale istniejące, nie anuluje rezerwacji; przesunięte – aktualizuje termin', async () => {
  const ctx = await createTestContext();
  try {
    const a = await ctx.api('/api/send-otp', { body: person() });
    await ctx.api('/api/verify-otp', { body: { bookingId: a.data.bookingId, code: ctx.sms.lastCode() } });
    const ev = [...ctx.calendar.events.values()][0];

    ctx.calendar.listBookingEvents = async () => []; // np. niepełna odpowiedź
    ctx.clock.advanceMinutes(1);
    assert.equal((await ctx.services.bookings.runMaintenance()).cancelledInCalendar, 0);
    assert.equal((await ctx.pool.query('SELECT status FROM bookings')).rows[0].status, 'confirmed');

    // Studio przesuwa wydarzenie na 13:00.
    ev.start.dateTime = '2026-10-19T13:00:00.000+02:00';
    ev.end.dateTime = '2026-10-19T14:00:00.000+02:00';
    ctx.clock.advanceMinutes(1);
    await ctx.services.bookings.runMaintenance();
    const row = (await ctx.pool.query('SELECT slot_start FROM bookings')).rows[0];
    assert.equal(row.slot_start.toISOString(), '2026-10-19T11:00:00.000Z');
  } finally {
    await ctx.close();
  }
});

test('N7: błąd 5xx bramki jest niejednoznaczny – SMS liczy się do limitów', async () => {
  const { SmsapiProvider } = require('../../src/services/sms/smsapi');
  const p = new SmsapiProvider({
    token: 't',
    fetchImpl: async () => new Response('<html>Gateway Timeout</html>', { status: 504 }),
  });
  await assert.rejects(p.send('+48600123456', 'x'), (err) => err.definitive === false);
  const p2 = new SmsapiProvider({
    token: 't',
    fetchImpl: async () => new Response(JSON.stringify({ error: 13, message: 'No valid numbers' }), { status: 200 }),
  });
  await assert.rejects(p2.send('+48600123456', 'x'), (err) => err.definitive === true);
});
