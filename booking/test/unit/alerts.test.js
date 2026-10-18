'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAlerter } = require('../../src/services/alerts');
const { createLogger } = require('../../src/lib/logger');

const logger = createLogger({ level: 'silent' });
const flush = () => new Promise((r) => setTimeout(r, 10));

function recorder(status = 200) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response('ok', { status });
  };
  return { calls, fetchImpl };
}

test('bez ALERT_WEBHOOK_URL alerty są wyłączone', () => {
  const a = createAlerter({ webhookUrl: null, logger });
  assert.equal(a.enabled, false);
  a.notify('x', 'y'); // nie rzuca
});

test('ntfy.sh: treść jako zwykły tekst, tytuł zakodowany (polskie znaki w nagłówku)', async () => {
  const { calls, fetchImpl } = recorder();
  const a = createAlerter({ webhookUrl: 'https://ntfy.sh/pilanka-tajny-temat', businessName: 'Pilanka Pilates Tczew', logger, fetchImpl });
  a.notify('sms_config', 'Bramka SMS odrzuca wysyłkę – brak środków');
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, 'Bramka SMS odrzuca wysyłkę – brak środków');
  assert.match(calls[0].init.headers.Title, /^=\?UTF-8\?B\?/);
  assert.equal(
    Buffer.from(calls[0].init.headers.Title.slice(10, -2), 'base64').toString(),
    'Rezerwacje Pilanka Pilates Tczew',
  );
});

test('Discord/Slack: JSON z polami content i text', async () => {
  const { calls, fetchImpl } = recorder();
  const a = createAlerter({ webhookUrl: 'https://discord.com/api/webhooks/1/abc', logger, fetchImpl });
  a.notify('gcal', 'Google nie odpowiada');
  await flush();
  const body = JSON.parse(calls[0].init.body);
  assert.match(body.content, /Google nie odpowiada/);
  assert.match(body.text, /Google nie odpowiada/);
});

test('cooldown: ten sam alert najwyżej raz na okres, różne alerty niezależnie', async () => {
  const { calls, fetchImpl } = recorder();
  const a = createAlerter({ webhookUrl: 'https://hooks.slack.com/x', cooldownMinutes: 60, logger, fetchImpl });
  a.notify('gcal', '1');
  a.notify('gcal', '2');
  a.notify('sms_config', '3');
  await flush();
  assert.deepEqual(calls.map((c) => JSON.parse(c.init.body).content.split('\n')[1]), ['1', '3']);
});

test('nieudana wysyłka nie blokuje kolejnej próby', async () => {
  const fail = recorder(500);
  const a = createAlerter({ webhookUrl: 'https://hooks.slack.com/x', logger, fetchImpl: fail.fetchImpl });
  a.notify('gcal', '1');
  await flush();
  a.notify('gcal', '2');
  await flush();
  assert.equal(fail.calls.length, 2);
});
