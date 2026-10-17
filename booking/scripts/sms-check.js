'use strict';

/**
 * Wysyła testowy SMS przez skonfigurowaną bramkę (SMS_PROVIDER=smsapi|twilio).
 *
 *   npm run sms:check -- +48600123456
 *
 * Uwaga: wysyła prawdziwy SMS (kosztuje punkty), chyba że ustawisz SMSAPI_TEST_MODE=true
 * – wtedy SMSAPI tylko waliduje żądanie, nic nie wysyłając.
 */
const { loadConfig, ConfigError } = require('../src/config');
const { normalizePlPhone } = require('../src/lib/phone');
const { createSmsProvider, buildOtpMessage } = require('../src/services/sms');
const { createLogger } = require('../src/lib/logger');

async function main() {
  const phone = normalizePlPhone(process.argv[2] || '');
  if (!phone.ok) {
    console.error(`Użycie: npm run sms:check -- +48600123456\n${phone.error}`);
    process.exit(1);
  }
  let config;
  try {
    config = loadConfig(process.env, { only: 'sms' });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  const provider = createSmsProvider(config.sms, { logger: createLogger() });
  const message = buildOtpMessage(config.sms, { code: '123456', minutes: 5, businessName: config.businessName });
  console.log(`Bramka: ${provider.name}${config.sms.smsapi.testMode ? ' (tryb testowy – bez wysyłki)' : ''}`);
  console.log(`Do: ${phone.e164}\nTreść (${message.length} znaków):\n---\n${message}\n---`);
  try {
    const res = await provider.send(phone.e164, message);
    console.log(`✔ Wysłano. ID wiadomości: ${res.id}${res.points != null ? `, koszt: ${res.points} pkt` : ''}`);
  } catch (err) {
    console.error(`✘ ${err.message}`);
    if (err.configProblem) console.error('  → Sprawdź token/klucze, saldo konta i zatwierdzenie nazwy nadawcy w panelu bramki.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
