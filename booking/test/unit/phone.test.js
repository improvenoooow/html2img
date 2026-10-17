'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePlPhone, formatPlPhone, maskPhone } = require('../../src/lib/phone');

test('akceptuje typowe zapisy polskiego numeru komórkowego', () => {
  for (const input of ['600123456', '600 123 456', '600-123-456', '+48 600 123 456', '+48600123456', '0048600123456', '48600123456', '(+48) 600 123 456']) {
    const r = normalizePlPhone(input);
    assert.equal(r.ok, true, input);
    assert.equal(r.e164, '+48600123456', input);
  }
});

test('akceptuje wszystkie prefiksy mobilne', () => {
  for (const p of ['45', '50', '51', '53', '57', '60', '66', '69', '72', '73', '78', '79', '88']) {
    assert.equal(normalizePlPhone(`${p}1234567`).ok, true, p);
  }
});

test('odrzuca numery stacjonarne, zagraniczne i błędne', () => {
  const cases = {
    '58 123 45 67': /komórkowego/, // stacjonarny Gdańsk
    '+49 1512 3456789': /polskie/,
    '+1 202 555 0100': /polskie/,
    '60012345': /9 cyfr/,
    '6001234567': /9 cyfr/,
    '600abc456': /cyfry/,
    '': /Podaj/,
  };
  for (const [input, re] of Object.entries(cases)) {
    const r = normalizePlPhone(input);
    assert.equal(r.ok, false, input);
    assert.match(r.error, re, input);
  }
  assert.equal(normalizePlPhone(undefined).ok, false);
  assert.equal(normalizePlPhone(600123456).ok, false);
});

test('formatuje i maskuje numer', () => {
  assert.equal(formatPlPhone('+48600123456'), '+48 600 123 456');
  assert.equal(maskPhone('+48600123456'), '+48 600 *** 456');
});
