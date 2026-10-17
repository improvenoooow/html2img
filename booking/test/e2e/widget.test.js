'use strict';

/**
 * Test E2E widgetu w prawdziwej przeglądarce (Chromium przez Playwright).
 * Uruchomienie: npm run test:e2e  (wymaga Postgresa jak testy integracyjne i pakietu playwright / playwright-core)
 * Zrzuty ekranu: E2E_SCREENSHOTS=/ścieżka/do/katalogu npm run test:e2e
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execSync } = require('child_process');
const { createTestContext } = require('../helpers/context');

function loadPlaywright() {
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return require(name);
    } catch {
      try {
        const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
        return require(path.join(globalRoot, name));
      } catch {
        /* następny */
      }
    }
  }
  return null;
}

const pw = loadPlaywright();
const SHOTS = process.env.E2E_SCREENSHOTS || null;

async function shot(page, name) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test('widget: wybór terminu → dane → SMS → kod → "Zarezerwowano"', { skip: !pw && 'brak Playwright' }, async () => {
  const ctx = await createTestContext();
  ctx.calendar.addBusy('2026-10-19T08:00:00Z', '2026-10-19T10:00:00Z'); // 10:00–12:00 zajęte
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, locale: 'pl-PL' });
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    // Oczekiwane odpowiedzi 4xx (np. błędny kod) przeglądarka loguje jako "Failed to load resource" – pomijamy je.
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && consoleErrors.push(m.text()));

    await page.goto(`${ctx.baseUrl}/demo`);
    const w = page.locator('[data-pilanka-booking]');
    await w.locator('.plb-month').filter({ hasText: 'październik 2026' }).waitFor();
    await w.locator('.plb-day[aria-pressed="true"]').filter({ hasText: /^19$/ }).waitFor();

    // Zajęte godziny nie są oferowane.
    const times = await w.locator('.plb-slot').allTextContents();
    assert.deepEqual(times, ['08:00', '09:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']);
    await shot(page, '01-kalendarz');

    // Walidacja front-end: zły numer nie wysyła żądania.
    await w.locator('.plb-slot', { hasText: '09:00' }).click();
    await w.locator('#plb-firstName').fill('Anna');
    await w.locator('#plb-lastName').fill('Kowalska');
    await w.locator('#plb-phone').fill('58 123 45 67');
    await w.getByRole('button', { name: 'Wyślij kod SMS' }).click();
    await w.locator('#plb-phone-err').filter({ hasText: 'komórkowego' }).waitFor();
    await w.locator('#plb-consent-err').filter({ hasText: 'Zgoda' }).waitFor();
    assert.equal(ctx.sms.sent.length, 0);
    await shot(page, '02-walidacja');

    await w.locator('#plb-phone').fill('');
    await w.locator('#plb-phone').pressSequentially('600123456');
    assert.equal(await w.locator('#plb-phone').inputValue(), '600 123 456', 'formatowanie numeru w trakcie pisania');
    await w.locator('#plb-email').fill('anna@example.com');
    await w.locator('#plb-consent').check();
    await w.getByRole('button', { name: 'Wyślij kod SMS' }).click();

    // Po wysłaniu: numer read-only, pole na kod i przycisk potwierdzenia.
    const codeInput = w.locator('#plb-code');
    await codeInput.waitFor();
    assert.equal(await w.locator('#plb-phone').getAttribute('readonly'), '');
    await w.getByText('+48 600 123 456').waitFor();
    await w.getByRole('button', { name: 'Potwierdź rezerwację' }).waitFor();
    assert.match(await w.locator('[data-ref="lockTimer"]').textContent(), /^(10:00|9:5\d)$/);
    assert.equal(ctx.sms.sent.length, 1);
    await shot(page, '03-kod-sms');

    // Błędny kod.
    const code = ctx.sms.lastCode();
    const wrong = code === '000000' ? '111111' : '000000';
    await codeInput.fill(wrong);
    await w.locator('#plb-code-err').filter({ hasText: 'Pozostało prób: 4' }).waitFor();
    await shot(page, '04-zly-kod');

    // Poprawny kod (auto-wysyłka po 6 cyfrach).
    await codeInput.fill(code);
    await w.getByRole('heading', { name: 'Zarezerwowano!' }).waitFor();
    await w.getByText('09:00–10:00').waitFor();
    await shot(page, '05-sukces');

    const bookingEvents = [...ctx.calendar.events.values()].filter((e) => e.id.startsWith('plb'));
    assert.equal(bookingEvents.length, 1);
    const ev = bookingEvents[0];
    assert.equal(ev.summary, 'Rezerwacja: Anna Kowalska - +48 600 123 456');

    // "Zarezerwuj kolejny" – świeży widget bez zarezerwowanej godziny.
    await w.getByRole('button', { name: 'Zarezerwuj kolejny termin' }).click();
    await w.locator('.plb-slot', { hasText: '08:00' }).waitFor();
    assert.ok(!(await w.locator('.plb-slot').allTextContents()).includes('09:00'));
    assert.deepEqual(consoleErrors, []);
  } finally {
    await browser.close();
    await ctx.close();
  }
});

test('widget (mobile): termin zajęty przez kogoś innego w trakcie wypełniania', { skip: !pw && 'brak Playwright' }, async () => {
  const ctx = await createTestContext();
  const browser = await pw.chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'pl-PL' });
    await page.goto(`${ctx.baseUrl}/demo`);
    const w = page.locator('[data-pilanka-booking]');
    await w.locator('.plb-slot', { hasText: '08:00' }).click();
    await shot(page, '06-mobile-kalendarz');

    // Ktoś inny blokuje 08:00 przez API.
    const other = await ctx.api('/api/send-otp', {
      body: { slotStart: '2026-10-19T06:00:00.000Z', firstName: 'Ewa', lastName: 'Nowak', phone: '511000222', consent: true },
      ip: '10.9.9.9',
    });
    assert.equal(other.status, 200);

    await w.locator('#plb-firstName').fill('Jan');
    await w.locator('#plb-lastName').fill('Wiśniewski');
    await w.locator('#plb-phone').fill('+48 512 345 678');
    await w.locator('#plb-consent').check();
    await w.getByRole('button', { name: 'Wyślij kod SMS' }).click();
    await w.locator('[data-ref="whenAlert"]').filter({ hasText: 'został właśnie zajęty' }).waitFor();
    // Lista odświeżona: 08:00 zniknęło, formularz nadal edytowalny z danymi.
    await w.locator('.plb-slot', { hasText: '09:00' }).waitFor();
    assert.ok(!(await w.locator('.plb-slot').allTextContents()).includes('08:00'));
    assert.equal(await w.locator('#plb-firstName').inputValue(), 'Jan');
    assert.equal(await w.locator('#plb-phone').getAttribute('readonly'), null);
    await shot(page, '07-mobile-termin-zajety');

    // Zmiana danych w trakcie weryfikacji zwalnia blokadę.
    await w.locator('.plb-slot', { hasText: '09:00' }).click();
    await w.getByRole('button', { name: 'Wyślij kod SMS' }).click();
    await w.locator('#plb-code').waitFor();
    await shot(page, '08-mobile-kod');
    await w.getByRole('button', { name: 'Zmień dane lub termin' }).click();
    await w.getByRole('button', { name: 'Wyślij kod SMS' }).waitFor();
    const slots = await ctx.api('/api/slots?from=2026-10-19&to=2026-10-19');
    assert.ok(slots.data.days[0].slots.some((s) => s.start === '2026-10-19T07:00:00.000Z'), '09:00 znów wolne');
  } finally {
    await browser.close();
    await ctx.close();
  }
});
