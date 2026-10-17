'use strict';

/**
 * Polskie numery komórkowe – prefiksy zakresów mobilnych wg planu numeracji UKE.
 * Ograniczenie wysyłki wyłącznie do polskich komórek to pierwsza linia obrony
 * przed "SMS pumping" (wysyłką na drogie numery zagraniczne/premium na koszt studia).
 */
const PL_MOBILE_PREFIXES = ['45', '50', '51', '53', '57', '60', '66', '69', '72', '73', '78', '79', '88'];

/**
 * Normalizuje polski numer komórkowy do formatu E.164 (+48XXXXXXXXX).
 * Akceptuje m.in.: "600 123 456", "600-123-456", "+48 600 123 456", "0048600123456", "48600123456".
 * @returns {{ ok: true, e164: string, national: string } | { ok: false, error: string }}
 */
function normalizePlPhone(input) {
  if (typeof input !== 'string') return { ok: false, error: 'Podaj numer telefonu.' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Podaj numer telefonu.' };
  if (!/^[+\d\s\-().]+$/.test(trimmed)) {
    return { ok: false, error: 'Numer telefonu może zawierać tylko cyfry.' };
  }

  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) {
    if (!digits.startsWith('48')) return { ok: false, error: 'Obsługujemy wyłącznie polskie numery (+48).' };
    digits = digits.slice(2);
  } else if (digits.startsWith('0048')) {
    digits = digits.slice(4);
  } else if (digits.length === 11 && digits.startsWith('48')) {
    digits = digits.slice(2);
  }

  if (digits.length !== 9) return { ok: false, error: 'Numer telefonu musi mieć 9 cyfr.' };
  if (!PL_MOBILE_PREFIXES.includes(digits.slice(0, 2))) {
    return { ok: false, error: 'Podaj numer telefonu komórkowego – na ten numer wyślemy kod SMS.' };
  }
  return { ok: true, e164: `+48${digits}`, national: digits };
}

/** "+48600123456" -> "+48 600 123 456" */
function formatPlPhone(e164) {
  const d = String(e164).replace(/^\+48/, '');
  return `+48 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

/** "+48600123456" -> "+48 600 *** 456" (do logów) */
function maskPhone(e164) {
  if (!e164) return '';
  const d = String(e164).replace(/^\+48/, '');
  return `+48 ${d.slice(0, 3)} *** ${d.slice(6)}`;
}

module.exports = { normalizePlPhone, formatPlPhone, maskPhone, PL_MOBILE_PREFIXES };
