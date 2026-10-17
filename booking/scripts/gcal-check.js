'use strict';

/**
 * Diagnostyka połączenia z Google Calendar (Service Account).
 *
 *   npm run gcal:check                 – uwierzytelnienie, dostęp do kalendarza, odczyt Free/Busy, wolne sloty (7 dni)
 *   npm run gcal:check -- --days 14    – dłuższy zakres
 *   npm run gcal:check -- --write      – dodatkowo test zapisu: tworzy i od razu usuwa wydarzenie testowe
 *
 * Wymagane zmienne: GOOGLE_CALENDAR_ID oraz GOOGLE_SERVICE_ACCOUNT_JSON | _BASE64 | _FILE
 * (opcjonalnie WORKING_HOURS, SLOT_DURATION_MIN itd. – jak w serwerze).
 */
const crypto = require('crypto');
const { DateTime } = require('luxon');
const { loadConfig, ConfigError } = require('../src/config');
const { GoogleCalendarClient } = require('../src/services/googleCalendar');
const { generateSlots, overlaps } = require('../src/lib/schedule');

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 7;
const doWrite = args.includes('--write');

const ok = (msg) => console.log(`  ✔ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const fail = (msg, hint) => {
  console.error(`  ✘ ${msg}`);
  if (hint) console.error(`    → ${hint}`);
  process.exit(1);
};

async function main() {
  let config;
  try {
    config = loadConfig({ ...process.env, GCAL_PROVIDER: 'google' }, { only: 'gcal' });
  } catch (err) {
    if (err instanceof ConfigError) fail(err.message);
    throw err;
  }
  const { gcal, booking } = config;
  const sa = gcal.serviceAccount;
  const client = new GoogleCalendarClient({ serviceAccount: sa, calendarId: gcal.calendarId });
  const zone = booking.timezone;

  console.log('\nGoogle Calendar – diagnostyka\n');
  info(`Konto usługi:  ${sa.clientEmail}`);
  info(`Kalendarz:     ${gcal.calendarId}`);
  info(`Strefa studia: ${zone}\n`);

  // 1. Uwierzytelnienie
  try {
    await client.getAccessToken();
    ok('Uwierzytelnienie Service Account (token OAuth2)');
  } catch (err) {
    fail(
      `Uwierzytelnienie nieudane: ${err.message}`,
      'Sprawdź, czy klucz JSON jest aktualny (nie został usunięty w Google Cloud) i czy zegar serwera jest poprawny.',
    );
  }

  // 2. Dostęp do kalendarza
  try {
    const meta = await client.getCalendarMeta();
    ok(`Dostęp do kalendarza: "${meta.summary}" (strefa ${meta.timeZone})`);
    if (meta.timeZone && meta.timeZone !== zone) {
      info(`UWAGA: strefa kalendarza (${meta.timeZone}) różni się od TIMEZONE (${zone}).`);
    }
  } catch (err) {
    const notShared = err.status === 404 || err.status === 403;
    fail(
      `Brak dostępu do kalendarza: ${err.message}`,
      notShared
        ? `W Google Calendar: Ustawienia kalendarza → "Udostępnij określonym osobom" → dodaj ${sa.clientEmail} ` +
            'z uprawnieniem "Wprowadzanie zmian w wydarzeniach". Upewnij się też, że w Google Cloud włączone jest "Google Calendar API".'
        : 'Sprawdź, czy w projekcie Google Cloud włączone jest "Google Calendar API".',
    );
  }

  // 3. Odczyt Free/Busy
  const now = DateTime.now().setZone(zone);
  const from = now.startOf('day');
  const to = from.plus({ days });
  let busy;
  try {
    busy = await client.freeBusy(from.toJSDate(), to.toJSDate());
    ok(`Odczyt Free/Busy (${days} dni) – zajęte bloki: ${busy.length}`);
  } catch (err) {
    fail(`Odczyt Free/Busy nieudany: ${err.message}`);
  }
  for (const b of busy) {
    const s = DateTime.fromJSDate(b.start, { zone });
    const e = DateTime.fromJSDate(b.end, { zone });
    info(`  zajęte: ${s.toFormat('ccc dd.LL HH:mm', { locale: 'pl' })} – ${e.toFormat('HH:mm')}`);
  }

  // 4. Wolne sloty wg godzin pracy
  console.log('');
  const earliest = now.plus({ minutes: booking.minNoticeMin }).toJSDate();
  const bufMs = booking.bufferMin * 60_000;
  const slots = generateSlots({
    fromDate: from.toISODate(),
    toDate: to.minus({ days: 1 }).toISODate(),
    schedule: booking.schedule,
    zone,
    durationMin: booking.slotDurationMin,
    stepMin: booking.slotStepMin,
    closedDates: booking.closedDates,
  }).filter(
    (s) =>
      s.start >= earliest &&
      !busy.some((b) => overlaps(s.start.getTime() - bufMs, s.end.getTime() + bufMs, b.start.getTime(), b.end.getTime())),
  );
  ok(`Wolne terminy wg WORKING_HOURS="${booking.workingHours}" (${booking.slotDurationMin} min):`);
  const byDay = new Map();
  for (const s of slots) byDay.set(s.date, [...(byDay.get(s.date) || []), s.time]);
  for (let d = from; d < to; d = d.plus({ days: 1 })) {
    const times = byDay.get(d.toISODate()) || [];
    info(`  ${d.toFormat('ccc dd.LL', { locale: 'pl' }).padEnd(10)} ${times.length ? times.join(' ') : '—'}`);
  }

  // 5. Test zapisu (opcjonalny)
  if (doWrite) {
    console.log('');
    const start = from.plus({ days: 1 }).set({ hour: 23, minute: 30 });
    const id = `plbtest${crypto.randomBytes(8).toString('hex')}`;
    try {
      await client.insertEvent({
        id,
        summary: 'TEST systemu rezerwacji (zostanie usunięte)',
        start: { dateTime: start.toISO(), timeZone: zone },
        end: { dateTime: start.plus({ minutes: 15 }).toISO(), timeZone: zone },
        transparency: 'transparent',
      });
      ok('Zapis wydarzenia testowego');
      const ev = await client.getEvent(id);
      if (!ev) throw new Error('nie można odczytać utworzonego wydarzenia');
      await client.deleteEvent(id);
      ok('Usunięcie wydarzenia testowego');
    } catch (err) {
      fail(
        `Test zapisu nieudany: ${err.message}`,
        `Konto ${sa.clientEmail} potrzebuje uprawnienia "Wprowadzanie zmian w wydarzeniach" (nie tylko "Wyświetlanie").`,
      );
    }
  }

  console.log('\nWszystko działa poprawnie.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
