'use strict';

/**
 * Powiadomienia operacyjne dla studia (np. na telefon), gdy rezerwacje przestają działać:
 * brak środków / zły token bramki SMS, dzienny limit SMS, awaria Google Calendar, niskie saldo SMS.
 *
 * ALERT_WEBHOOK_URL:
 *   - ntfy.sh (najprostsze, darmowe powiadomienia push): https://ntfy.sh/<twoj-tajny-temat>
 *   - Discord / Slack: adres "incoming webhook"
 * Każdy rodzaj alertu wysyłany jest najwyżej raz na ALERT_COOLDOWN_MINUTES.
 */
function createAlerter({ webhookUrl, cooldownMinutes = 60, businessName = '', logger, fetchImpl = globalThis.fetch }) {
  if (!webhookUrl) return { enabled: false, notify() {} };

  const isNtfy = /(^|\.)ntfy\.sh$/i.test(new URL(webhookUrl).hostname) || /\/ntfy\//i.test(webhookUrl);
  const lastSent = new Map();
  const cooldownMs = cooldownMinutes * 60_000;

  async function send(text) {
    const title = `Rezerwacje ${businessName}`.trim();
    const init = isNtfy
      ? {
          method: 'POST',
          // Nagłówki HTTP muszą być ASCII – tytuł z polskimi znakami kodujemy wg RFC 2047.
          headers: { Title: `=?UTF-8?B?${Buffer.from(title).toString('base64')}?=`, Priority: 'high', Tags: 'warning' },
          body: text,
        }
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // "text" – Slack, "content" – Discord.
          body: JSON.stringify({ text: `*${title}*\n${text}`, content: `**${title}**\n${text}` }),
        };
    const res = await fetchImpl(webhookUrl, { ...init, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
  }

  return {
    enabled: true,
    /** Nie blokuje wywołującego i nigdy nie rzuca. */
    notify(key, text) {
      const now = Date.now();
      if ((lastSent.get(key) || 0) > now - cooldownMs) return;
      lastSent.set(key, now);
      send(text)
        .then(() => logger.info('alert_sent', { key }))
        .catch((err) => {
          lastSent.delete(key); // spróbuj ponownie przy następnym zdarzeniu
          logger.warn('alert_failed', { key, err });
        });
    },
  };
}

module.exports = { createAlerter };
