'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTestContext } = require('../helpers/context');
const { SmsError } = require('../../src/services/sms');

function fakeAlerter() {
  const sent = [];
  return { enabled: true, sent, notify: (key, text) => sent.push({ key, text }) };
}

const body = {
  slotStart: '2026-10-19T07:00:00.000Z',
  firstName: 'Jan',
  lastName: 'Nowak',
  phone: '600123456',
  consent: true,
};

test('alert, gdy bramka SMS odrzuca wysyłkę z powodu konfiguracji (np. brak punktów)', async () => {
  const alerter = fakeAlerter();
  const ctx = await createTestContext({ alerter });
  try {
    ctx.sms.send = async () => {
      throw new SmsError('SMSAPI: Not enough points (kod 103)', { provider: 'smsapi', code: 103, configProblem: true });
    };
    const r = await ctx.api('/api/send-otp', { body });
    assert.equal(r.status, 502);
    assert.equal(alerter.sent.length, 1);
    assert.equal(alerter.sent[0].key, 'sms_config');
    assert.match(alerter.sent[0].text, /Not enough points/);
  } finally {
    await ctx.close();
  }
});

test('bez alertu, gdy SMS nie doszedł z powodu numeru klienta', async () => {
  const alerter = fakeAlerter();
  const ctx = await createTestContext({ alerter });
  try {
    ctx.sms.failNext = 1; // błąd bez configProblem
    await ctx.api('/api/send-otp', { body });
    assert.equal(alerter.sent.length, 0);
  } finally {
    await ctx.close();
  }
});

test('alert przy awarii Google Calendar i przy dziennym limicie SMS', async () => {
  const alerter = fakeAlerter();
  const ctx = await createTestContext({ alerter, env: { SMS_LIMIT_GLOBAL_DAY: '1' } });
  try {
    ctx.calendar.failures.freeBusy = 1;
    assert.equal((await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19')).status, 503);
    assert.equal(alerter.sent.at(-1).key, 'gcal');

    assert.equal((await ctx.api('/api/send-otp', { body })).status, 200);
    const r = await ctx.api('/api/send-otp', { body: { ...body, phone: '600123457' }, ip: '10.0.0.2' });
    assert.equal(r.status, 503);
    assert.equal(alerter.sent.at(-1).key, 'sms_daily_limit');
  } finally {
    await ctx.close();
  }
});

test('alert o niskim saldzie bramki SMS (sprawdzane w zadaniu okresowym)', async () => {
  const alerter = fakeAlerter();
  const ctx = await createTestContext({ alerter, env: { SMS_LOW_BALANCE_ALERT: '50' } });
  try {
    ctx.sms.getBalance = async () => ({ amount: 12.5, unit: 'pkt' });
    await ctx.services.bookings.runMaintenance();
    assert.equal(alerter.sent.length, 1);
    assert.equal(alerter.sent[0].key, 'sms_low_balance');
    assert.match(alerter.sent[0].text, /12\.5 pkt \(próg 50\)/);
  } finally {
    await ctx.close();
  }
});
