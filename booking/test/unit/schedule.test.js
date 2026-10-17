'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseWorkingHours, parseClosedDates, generateSlots } = require('../../src/lib/schedule');

const ZONE = 'Europe/Warsaw';

test('parsuje zakresy dni, wiele przedziałów i polskie skróty', () => {
  const s = parseWorkingHours('mon-fri=08:00-12:00,16:00-20:00; sat=09:00-13:00');
  assert.deepEqual(s[1], [[480, 720], [960, 1200]]);
  assert.deepEqual(s[5], [[480, 720], [960, 1200]]);
  assert.deepEqual(s[6], [[540, 780]]);
  assert.deepEqual(s[7], []);

  const pl = parseWorkingHours('pn-pt=07:00-21:00;so=08:00-14:00;śr=closed');
  assert.deepEqual(pl[1], [[420, 1260]]);
  assert.deepEqual(pl[3], [], 'późniejszy wpis nadpisuje dzień');
  assert.deepEqual(pl[6], [[480, 840]]);
});

test('zakres dni przez weekend (fri-mon)', () => {
  const s = parseWorkingHours('fri-mon=10:00-12:00');
  for (const d of [5, 6, 7, 1]) assert.deepEqual(s[d], [[600, 720]]);
  for (const d of [2, 3, 4]) assert.deepEqual(s[d], []);
});

test('odrzuca błędne godziny pracy', () => {
  for (const bad of ['', 'mon=8-12', 'xyz=08:00-12:00', 'mon=12:00-08:00', 'mon=08:00-12:00,11:00-13:00', 'mon=25:00-26:00', 'mon 08:00-12:00']) {
    assert.throws(() => parseWorkingHours(bad), undefined, bad);
  }
});

test('parsuje dni zamknięte', () => {
  assert.deepEqual([...parseClosedDates('2026-12-24, 2026-12-25')], ['2026-12-24', '2026-12-25']);
  assert.throws(() => parseClosedDates('24.12.2026'));
});

test('generuje sloty w czasie lokalnym studia', () => {
  const slots = generateSlots({
    fromDate: '2026-10-19',
    toDate: '2026-10-19',
    schedule: parseWorkingHours('mon=08:00-20:00'),
    zone: ZONE,
    durationMin: 60,
    stepMin: 60,
  });
  assert.equal(slots.length, 12);
  assert.equal(slots[0].time, '08:00');
  assert.equal(slots[0].start.toISOString(), '2026-10-19T06:00:00.000Z'); // CEST = UTC+2
  assert.equal(slots[11].time, '19:00');
  assert.equal(slots[11].end.toISOString(), '2026-10-19T18:00:00.000Z');
});

test('krok inny niż długość (zajęcia 60 min co 90 min) i slot nie wychodzi poza godziny pracy', () => {
  const slots = generateSlots({
    fromDate: '2026-10-19',
    toDate: '2026-10-19',
    schedule: parseWorkingHours('mon=08:00-20:00'),
    zone: ZONE,
    durationMin: 60,
    stepMin: 90,
  });
  assert.deepEqual(slots.map((s) => s.time), ['08:00', '09:30', '11:00', '12:30', '14:00', '15:30', '17:00', '18:30']);
});

test('zmiana czasu na zimowy (25.10.2026): sloty trwają rzeczywiście 60 min', () => {
  const slots = generateSlots({
    fromDate: '2026-10-25',
    toDate: '2026-10-25',
    schedule: parseWorkingHours('sun=01:00-05:00'),
    zone: ZONE,
    durationMin: 60,
    stepMin: 60,
  });
  assert.deepEqual(slots.map((s) => s.time), ['01:00', '02:00', '03:00', '04:00']);
  for (const s of slots) assert.equal(s.end - s.start, 3_600_000);
  assert.equal(slots[0].start.toISOString(), '2026-10-24T23:00:00.000Z'); // CEST
  assert.equal(slots[3].start.toISOString(), '2026-10-25T03:00:00.000Z'); // CET
});

test('zmiana czasu na letni (28.03.2027): nieistniejąca 02:00 jest pomijana', () => {
  const slots = generateSlots({
    fromDate: '2027-03-28',
    toDate: '2027-03-28',
    schedule: parseWorkingHours('sun=01:00-05:00'),
    zone: ZONE,
    durationMin: 60,
    stepMin: 60,
  });
  assert.deepEqual(slots.map((s) => s.time), ['01:00', '03:00', '04:00']);
  assert.equal(slots[1].start.toISOString(), '2027-03-28T01:00:00.000Z');
});

test('pomija dni zamknięte i dni bez godzin pracy', () => {
  const slots = generateSlots({
    fromDate: '2026-10-17', // sobota
    toDate: '2026-10-20', // wtorek
    schedule: parseWorkingHours('mon-fri=08:00-10:00'),
    zone: ZONE,
    durationMin: 60,
    stepMin: 60,
    closedDates: new Set(['2026-10-20']),
  });
  assert.deepEqual([...new Set(slots.map((s) => s.date))], ['2026-10-19']);
});
