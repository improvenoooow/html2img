'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/context');

const SLOT = '2026-10-19T07:00:00.000Z';

test('zajęcia grupowe (SLOT_CAPACITY=3): 3 osoby na termin, wydarzenia nie blokują Free/Busy', async () => {
  const ctx = await createTestContext({ env: { SLOT_CAPACITY: '3' } });
  try {
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await ctx.api('/api/send-otp', {
        body: { slotStart: SLOT, firstName: 'Osoba', lastName: `Nr${'abc'[i]}`, phone: `60030040${i}`, consent: true },
        ip: `10.2.0.${i}`,
      });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const v = await ctx.api('/api/verify-otp', { body: { bookingId: r.data.bookingId, code: ctx.sms.lastCode() } });
      assert.equal(v.status, 200, JSON.stringify(v.data));
      ids.push(r.data.bookingId);
    }
    assert.equal(ctx.calendar.events.size, 3);
    for (const ev of ctx.calendar.events.values()) assert.equal(ev.transparency, 'transparent');

    const full = await ctx.api('/api/send-otp', {
      body: { slotStart: SLOT, firstName: 'Czwarta', lastName: 'Osoba', phone: '600300409', consent: true },
      ip: '10.2.0.9',
    });
    assert.equal(full.status, 409);
    const slots = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19');
    assert.ok(!slots.data.days[0].slots.some((s) => s.start === SLOT));
  } finally {
    await ctx.close();
  }
});

test('bufor między zajęciami (BUFFER_MIN=15) blokuje sloty przylegające do zajętych bloków', async () => {
  const ctx = await createTestContext({ env: { BUFFER_MIN: '15', SLOT_STEP_MIN: '60' } });
  try {
    ctx.calendar.addBusy('2026-10-19T10:00:00Z', '2026-10-19T11:00:00Z'); // 12:00–13:00
    const r = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19');
    const times = r.data.days[0].slots.map((s) => s.time);
    assert.ok(!times.includes('11:00'), '11:00–12:00 kończy się bez 15 min przerwy');
    assert.ok(!times.includes('12:00'));
    assert.ok(!times.includes('13:00'), '13:00 zaczyna się bez 15 min przerwy');
    assert.ok(times.includes('10:00') && times.includes('14:00'));
  } finally {
    await ctx.close();
  }
});
