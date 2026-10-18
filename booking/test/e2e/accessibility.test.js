'use strict';

/**
 * Automatyczny audyt dostępności widgetu (axe-core, reguły WCAG 2.1 A/AA) w trzech stanach:
 * kalendarz, wpisywanie kodu SMS, potwierdzenie. axe analizuje też zawartość Shadow DOM.
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
        return require(path.join(execSync('npm root -g', { encoding: 'utf8' }).trim(), name));
      } catch {
        /* następny */
      }
    }
  }
  return null;
}
const pw = loadPlaywright();
const AXE_SOURCE = require('fs').readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

async function audit(page, label) {
  await page.addScriptTag({ content: AXE_SOURCE });
  const result = await page.evaluate(async () => {
    // eslint-disable-next-line no-undef
    const r = await axe.run(document.querySelector('[data-pilanka-booking]'), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => n.target.join(' ')) }));
  });
  assert.deepEqual(result, [], `${label}: naruszenia WCAG:\n${JSON.stringify(result, null, 2)}`);
}

test('dostępność (WCAG 2.1 AA) w każdym kroku rezerwacji – jasny i ciemny motyw', { skip: !pw && 'brak Playwright' }, async () => {
  const ctx = await createTestContext();
  const browser = await pw.chromium.launch();
  try {
    for (const theme of ['light', 'dark']) {
      // bypassCSP: CSP strony demo (słusznie) blokuje wstrzyknięcie skryptu axe.
      const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, bypassCSP: true });
      await page.goto(`${ctx.baseUrl}/demo`);
      await page.evaluate((t) => document.querySelector('[data-pilanka-booking]').setAttribute('data-theme', t), theme);
      const w = page.locator('[data-pilanka-booking]');
      await w.locator('.plb-slot').first().waitFor();
      await page.waitForTimeout(400); // animacje
      await audit(page, `${theme}: kalendarz`);

      await w.locator('.plb-slot').nth(theme === 'light' ? 0 : 1).click();
      await w.locator('#plb-firstName').fill('Jan');
      await w.locator('#plb-lastName').fill('Nowak');
      await w.locator('#plb-phone').fill(theme === 'light' ? '600123456' : '600123457');
      await w.locator('#plb-consent').check();
      await w.getByRole('button', { name: 'Wyślij kod SMS' }).click();
      await w.locator('#plb-code').waitFor();
      await audit(page, `${theme}: kod SMS`);

      await w.locator('#plb-code').fill(ctx.sms.lastCode());
      await w.getByRole('heading', { name: 'Zarezerwowano!' }).waitFor();
      await page.waitForTimeout(500);
      await audit(page, `${theme}: potwierdzenie`);
      await page.close();
    }
  } finally {
    await browser.close();
    await ctx.close();
  }
});

test('kolory widgetu można nadpisać CSS-em strony (zmienne --plb-*)', { skip: !pw && 'brak Playwright' }, async () => {
  const ctx = await createTestContext();
  const browser = await pw.chromium.launch();
  try {
    // reducedMotion: bez animacji przejścia kolorów, więc odczytujemy wartość końcową.
    const page = await browser.newPage({ reducedMotion: 'reduce' });
    await page.goto(`${ctx.baseUrl}/demo`);
    await page.addStyleTag({ content: '[data-pilanka-booking] { --plb-accent: rgb(138, 111, 90); }' });
    const btn = page.locator('[data-pilanka-booking]').getByRole('button', { name: 'Wyślij kod SMS' });
    await btn.waitFor();
    assert.equal(await btn.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(138, 111, 90)');
  } finally {
    await browser.close();
    await ctx.close();
  }
});
