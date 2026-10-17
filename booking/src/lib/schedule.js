'use strict';

const { DateTime } = require('luxon');

const DAY_ALIASES = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
  pn: 1, wt: 2, sr: 3, śr: 3, cz: 4, pt: 5, so: 6, sb: 6, nd: 7, nie: 7,
};

function parseTime(str, ctx) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(str.trim());
  if (!m) throw new Error(`Nieprawidłowa godzina "${str}" w ${ctx} (oczekiwano HH:MM)`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) throw new Error(`Nieprawidłowa godzina "${str}" w ${ctx}`);
  return h * 60 + min;
}

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(',')) {
    const p = part.trim().toLowerCase();
    if (!p) continue;
    const range = p.split('-');
    if (range.length === 2) {
      const a = DAY_ALIASES[range[0]];
      const b = DAY_ALIASES[range[1]];
      if (!a || !b) throw new Error(`Nieznany dzień tygodnia w "${part}"`);
      for (let d = a; ; d = (d % 7) + 1) {
        days.add(d);
        if (d === b) break;
      }
    } else {
      const d = DAY_ALIASES[p];
      if (!d) throw new Error(`Nieznany dzień tygodnia "${part}"`);
      days.add(d);
    }
  }
  return days;
}

/**
 * Parsuje godziny pracy, np.:
 *   "mon-fri=08:00-12:00,16:00-20:00;sat=09:00-13:00"
 *   "pn-pt=07:00-21:00;so=08:00-14:00"
 * Zwraca { 1: [[480, 720], [960, 1200]], ..., 7: [] } (minuty od północy, ISO weekday 1=pon).
 * Kolejne wpisy dla tego samego dnia nadpisują wcześniejsze.
 */
function parseWorkingHours(str) {
  const schedule = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [] };
  if (!str || !str.trim()) throw new Error('WORKING_HOURS jest puste');

  for (const rawEntry of str.split(';')) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const eq = entry.indexOf('=');
    if (eq === -1) throw new Error(`Brak "=" we wpisie "${entry}"`);
    const days = parseDays(entry.slice(0, eq));
    const rangesSpec = entry.slice(eq + 1).trim();
    const ranges = [];
    if (rangesSpec && !['closed', 'off', 'zamkniete', 'zamknięte', '-'].includes(rangesSpec.toLowerCase())) {
      for (const r of rangesSpec.split(',')) {
        const [a, b] = r.split('-');
        if (b === undefined) throw new Error(`Nieprawidłowy przedział "${r}" (oczekiwano HH:MM-HH:MM)`);
        const start = parseTime(a, entry);
        const end = parseTime(b, entry);
        if (end <= start) throw new Error(`Koniec przedziału musi być po początku: "${r}"`);
        ranges.push([start, end]);
      }
      ranges.sort((x, y) => x[0] - y[0]);
      for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] < ranges[i - 1][1]) throw new Error(`Nakładające się przedziały we wpisie "${entry}"`);
      }
    }
    for (const d of days) schedule[d] = ranges;
  }
  return schedule;
}

function parseClosedDates(str) {
  const set = new Set();
  if (!str) return set;
  for (const raw of str.split(',')) {
    const d = raw.trim();
    if (!d) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !DateTime.fromISO(d).isValid) {
      throw new Error(`Nieprawidłowa data w CLOSED_DATES: "${d}" (oczekiwano RRRR-MM-DD)`);
    }
    set.add(d);
  }
  return set;
}

/**
 * Generuje sloty (bez sprawdzania zajętości) dla dni [fromDate, toDate] włącznie,
 * w strefie `zone`. Daty jako "RRRR-MM-DD" (w strefie studia).
 * Sloty zaczynające się w nieistniejącej godzinie (zmiana czasu na letni) są pomijane.
 * @returns {{ start: Date, end: Date, date: string, time: string }[]}
 */
function generateSlots({ fromDate, toDate, schedule, zone, durationMin, stepMin, closedDates = new Set() }) {
  const slots = [];
  let day = DateTime.fromISO(fromDate, { zone }).startOf('day');
  const last = DateTime.fromISO(toDate, { zone }).startOf('day');
  if (!day.isValid || !last.isValid) throw new Error('Nieprawidłowy zakres dat');

  while (day <= last) {
    const date = day.toISODate();
    if (!closedDates.has(date)) {
      for (const [rangeStart, rangeEnd] of schedule[day.weekday] || []) {
        for (let t = rangeStart; t + durationMin <= rangeEnd; t += stepMin) {
          const hour = Math.floor(t / 60);
          const minute = t % 60;
          const start = DateTime.fromObject(
            { year: day.year, month: day.month, day: day.day, hour, minute },
            { zone },
          );
          if (!start.isValid || start.hour !== hour || start.minute !== minute) continue;
          const end = start.plus({ minutes: durationMin });
          slots.push({ start: start.toJSDate(), end: end.toJSDate(), date, time: start.toFormat('HH:mm') });
        }
      }
    }
    day = day.plus({ days: 1 });
  }
  return slots;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

module.exports = { parseWorkingHours, parseClosedDates, generateSlots, overlaps };
