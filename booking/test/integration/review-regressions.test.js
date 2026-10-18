'use strict';

/**
 * Testy regresyjne dla problemów znalezionych w niezależnym przeglądzie kodu.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/context');
const { SmsError } = require('../../src/services/sms');

const SLOT_A = '2026-10-19T07:00:00.000Z'; // 09:00
const SLOT_B = '2026-10-19T08:00:00.000Z'; // 10:00
const victim = { slotStart: SLOT_A, firstName: 'Anna', lastName: 'Kowalska', phone: '600123456', consent: true };

async function slotsOn(ctx) {
  const r = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19');
  return r.data.days[0].slots.map((s) => s.start);
}
const wrongCode = (code) => (code === '000000' ? '111111' : '000000');

test('usunięcie wydarzenia w Google Calendar od razu zwalnia termin (zajęcia indywidualne)', async () => {
  const ctx = await createTestContext();
  try {
    const sent = await ctx.api('/api/send-otp', { body: victim });
    await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: ctx.sms.lastCode() } });
    assert.ok(!(await slotsOn(ctx)).includes(SLOT_A));

    const ev = [...ctx.calendar.events.values()][0];
    await ctx.calendar.deleteEvent(ev.id);
    assert.ok((await slotsOn(ctx)).includes(SLOT_A), 'termin wolny od razu po usunięciu wydarzenia');
    const other = await ctx.api('/api/send-otp', { body: { ...victim, phone: '511222333' }, ip: '10.0.0.2' });
    assert.equal(other.status, 200);

    ctx.clock.advanceMinutes(6);
    const m = await ctx.services.bookings.runMaintenance();
    assert.equal(m.cancelledInCalendar, 1, 'status w bazie uzgodniony z kalendarzem');
  } finally {
    await ctx.close();
  }
});

test('zajęcia grupowe: usunięcie wydarzenia zwalnia miejsce po synchronizacji', async () => {
  const g = await createTestContext({ env: { SLOT_CAPACITY: '2' } });
  try {
    for (const [i, phone] of ['600000001', '600000002'].entries()) {
      const s = await g.api('/api/send-otp', { body: { ...victim, phone }, ip: `10.1.0.${i}` });
      await g.api('/api/verify-otp', { body: { bookingId: s.data.bookingId, code: g.sms.lastCode() } });
    }
    assert.ok(!(await slotsOn(g)).includes(SLOT_A), 'grupa pełna');
    await g.calendar.deleteEvent([...g.calendar.events.keys()][0]);
    g.clock.advanceMinutes(6);
    await g.services.bookings.runMaintenance();
    assert.ok((await slotsOn(g)).includes(SLOT_A), 'zwolnione miejsce w grupie');
  } finally {
    await g.close();
  }
});

test('nieudana ponowna wysyłka nie zeruje prób, nie przedłuża blokady i nie unieważnia ważnego kodu', async () => {
  const ctx = await createTestContext();
  try {
    const sent = await ctx.api('/api/send-otp', { body: victim });
    const id = sent.data.bookingId;
    const code = ctx.sms.lastCode();
    for (let i = 0; i < 4; i++) await ctx.api('/api/verify-otp', { body: { bookingId: id, code: wrongCode(code) } });
    ctx.clock.advanceMinutes(2);
    ctx.sms.send = async () => {
      throw new SmsError('numer na czarnej liście', { provider: 'capture', code: 13 });
    };
    const resend = await ctx.api('/api/send-otp', { body: { ...victim, previousBookingId: id, resend: true } });
    assert.equal(resend.status, 502);
    const row = (await ctx.pool.query('SELECT * FROM bookings WHERE id = $1', [id])).rows[0];
    assert.equal(row.otp_attempts, 4, 'licznik prób zachowany');
    assert.equal(row.lock_expires_at.toISOString(), sent.data.lockExpiresAt, 'blokada nieprzedłużona');
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM sms_log')).rows[0].n, 1, 'nieudany SMS nie liczony');
    const ok = await ctx.api('/api/verify-otp', { body: { bookingId: id, code } });
    assert.equal(ok.status, 200, 'pierwotny kod nadal działa');
  } finally {
    await ctx.close();
  }
});

test('niejednoznaczna awaria wysyłki (timeout) liczy się do limitów – SMS mógł dotrzeć', async () => {
  const ctx = await createTestContext();
  try {
    ctx.sms.send = async () => {
      throw new SmsError('timeout', { provider: 'capture' });
    };
    assert.equal((await ctx.api('/api/send-otp', { body: victim })).status, 502);
    assert.equal((await ctx.pool.query('SELECT count(*)::int AS n FROM sms_log')).rows[0].n, 1);
    assert.equal((await ctx.api('/api/send-otp', { body: victim })).data.error.code, 'RESEND_COOLDOWN');
  } finally {
    await ctx.close();
  }
});

test('osoba znająca cudzy numer nie może zwolnić ani przejąć cudzej blokady', async () => {
  const ctx = await createTestContext();
  try {
    const v = await ctx.api('/api/send-otp', { body: victim, ip: '10.0.0.1' });
    const victimCode = ctx.sms.lastCode();

    // Inny termin z tym samym numerem – blokada ofiary zostaje.
    const other = await ctx.api('/api/send-otp', { body: { ...victim, slotStart: SLOT_B, firstName: 'Mallory' }, ip: '10.6.6.6' });
    assert.ok([200, 429].includes(other.status));
    assert.ok(!(await slotsOn(ctx)).includes(SLOT_A), 'termin ofiary nadal zablokowany');

    // Ten sam termin po cooldownie – dane ofiary nie są nadpisywane.
    ctx.clock.advanceMinutes(2);
    const hijack = await ctx.api('/api/send-otp', {
      body: { ...victim, firstName: 'Mallory', lastName: 'Evil', email: 'evil@example.com' },
      ip: '10.6.6.7',
    });
    assert.equal(hijack.status, 200);
    const row = (await ctx.pool.query('SELECT * FROM bookings WHERE id = $1', [v.data.bookingId])).rows[0];
    assert.equal(row.first_name, 'Anna');
    assert.equal(row.email, null);

    const ok = await ctx.api('/api/verify-otp', { body: { bookingId: v.data.bookingId, code: ctx.sms.lastCode() } });
    assert.equal(ok.status, 200);
    const ev = [...ctx.calendar.events.values()].find((e) => e.id.startsWith('plb'));
    assert.equal(ev.summary, 'Rezerwacja: Anna Kowalska - +48 600 123 456');
    assert.ok(victimCode);
  } finally {
    await ctx.close();
  }
});

test('bez zaufanego proxy podrobiony X-Forwarded-For nie omija limitu SMS na IP', async () => {
  const ctx = await createTestContext({ env: { TRUST_PROXY: 'false' } });
  try {
    const slots = ['06', '07', '08', '09', '10', '11'].map((h) => `2026-10-19T${h}:00:00.000Z`);
    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await ctx.api('/api/send-otp', {
        body: { ...victim, slotStart: slots[i], phone: `60070070${i}` },
        ip: `198.51.100.${i}`, // podrabiany nagłówek
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  } finally {
    await ctx.close();
  }
});

test('"Zmień dane": poprawka imienia i terminu bez nowego SMS-a i bez blokady cooldown', async () => {
  const ctx = await createTestContext();
  try {
    const first = await ctx.api('/api/send-otp', { body: { ...victim, firstName: 'Ana' } });
    const code = ctx.sms.lastCode();
    const fixed = await ctx.api('/api/send-otp', {
      body: { ...victim, firstName: 'Anna', slotStart: SLOT_B, previousBookingId: first.data.bookingId },
    });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.data));
    assert.equal(fixed.data.smsSent, false);
    assert.equal(fixed.data.lockExpiresAt, first.data.lockExpiresAt, 'blokada nieprzedłużona');
    assert.equal(ctx.sms.sent.length, 1);
    const ok = await ctx.api('/api/verify-otp', { body: { bookingId: first.data.bookingId, code } });
    assert.equal(ok.data.booking.firstName, 'Anna');
    assert.equal(ok.data.booking.start, SLOT_B);
  } finally {
    await ctx.close();
  }
});

test('"Zmień dane" z innym numerem: poprzednia blokada zwolniona, nowy SMS na nowy numer', async () => {
  const ctx = await createTestContext();
  try {
    const first = await ctx.api('/api/send-otp', { body: victim });
    const second = await ctx.api('/api/send-otp', {
      body: { ...victim, phone: '512345678', previousBookingId: first.data.bookingId },
    });
    assert.equal(second.status, 200);
    assert.equal(second.data.smsSent, true);
    assert.notEqual(second.data.bookingId, first.data.bookingId);
    assert.equal(ctx.sms.sent.at(-1).to, '+48512345678');
    const old = (await ctx.pool.query('SELECT status FROM bookings WHERE id = $1', [first.data.bookingId])).rows[0];
    assert.equal(old.status, 'cancelled');
  } finally {
    await ctx.close();
  }
});

test('"Wyślij ponownie" (resend) wymusza nowy kod dla tej samej rezerwacji', async () => {
  const ctx = await createTestContext();
  try {
    const first = await ctx.api('/api/send-otp', { body: victim });
    ctx.clock.advanceMinutes(1);
    const again = await ctx.api('/api/send-otp', {
      body: { ...victim, previousBookingId: first.data.bookingId, resend: true },
    });
    assert.equal(again.data.smsSent, true);
    assert.equal(again.data.bookingId, first.data.bookingId);
    assert.equal(ctx.sms.sent.length, 2);
  } finally {
    await ctx.close();
  }
});

test('ponowna weryfikacja potwierdzonej rezerwacji nie zwraca danych osobowych bez poprawnego kodu', async () => {
  const ctx = await createTestContext();
  try {
    const sent = await ctx.api('/api/send-otp', { body: victim });
    await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: ctx.sms.lastCode() } });
    const leak = await ctx.api('/api/verify-otp', { body: { bookingId: sent.data.bookingId, code: '000000' } });
    assert.equal(leak.status, 200);
    assert.equal(leak.data.status, 'confirmed');
    assert.equal(leak.data.booking.phone, undefined);
    assert.equal(leak.data.booking.firstName, undefined);
  } finally {
    await ctx.close();
  }
});

test('cache Free/Busy: zmienianie zakresu dat nie mnoży zapytań do Google', async () => {
  const ctx = await createTestContext({ env: { GCAL_CACHE_SECONDS: '30' } });
  try {
    const before = ctx.calendar.calls.freeBusy;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const d = String(19 + (i % 12)).padStart(2, '0');
        return ctx.api(`/api/slots?from=2026-10-19&to=2026-10-${d}`);
      }),
    );
    const calls = ctx.calendar.calls.freeBusy - before;
    assert.ok(calls <= 2, `zapytań do Google: ${calls}`);
  } finally {
    await ctx.close();
  }
});
