'use strict';

/**
 * Błąd domenowy zwracany klientowi jako JSON:
 * { error: { code, message, ...details } }
 * `message` jest po polsku i nadaje się do pokazania użytkownikowi.
 */
class AppError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const Errors = {
  validation: (message, fields = {}) => new AppError(400, 'VALIDATION_ERROR', message, { fields }),
  slotUnavailable: () =>
    new AppError(409, 'SLOT_UNAVAILABLE', 'Ten termin został właśnie zajęty. Wybierz proszę inny.'),
  rateLimited: (message, retryAfterSec) =>
    new AppError(429, 'RATE_LIMITED', message, { retryAfter: Math.max(1, Math.ceil(retryAfterSec)) }),
  resendCooldown: (retryAfterSec) =>
    new AppError(429, 'RESEND_COOLDOWN', 'Kod został przed chwilą wysłany. Odczekaj chwilę przed ponowną wysyłką.', {
      retryAfter: Math.max(1, Math.ceil(retryAfterSec)),
    }),
  smsDailyLimit: () =>
    new AppError(
      503,
      'SMS_DAILY_LIMIT',
      'Chwilowo nie możemy wysłać SMS-a. Spróbuj później lub skontaktuj się ze studiem telefonicznie.',
    ),
  smsFailed: () =>
    new AppError(502, 'SMS_SEND_FAILED', 'Nie udało się wysłać SMS-a. Sprawdź numer telefonu i spróbuj ponownie.'),
  calendarUnavailable: () =>
    new AppError(503, 'CALENDAR_UNAVAILABLE', 'Kalendarz jest chwilowo niedostępny. Spróbuj ponownie za moment.'),
  captchaFailed: () =>
    new AppError(400, 'CAPTCHA_FAILED', 'Weryfikacja antyspamowa nie powiodła się. Odśwież stronę i spróbuj ponownie.'),
  bookingNotFound: () => new AppError(404, 'BOOKING_NOT_FOUND', 'Nie znaleziono rezerwacji. Zacznij proszę od nowa.'),
  holdExpired: () =>
    new AppError(410, 'HOLD_EXPIRED', 'Czas na potwierdzenie minął i termin został zwolniony. Wybierz termin ponownie.'),
  otpExpired: () => new AppError(410, 'OTP_EXPIRED', 'Kod SMS wygasł. Wyślij nowy kod.'),
  otpInvalid: (attemptsLeft) =>
    new AppError(400, 'OTP_INVALID', 'Nieprawidłowy kod SMS.', { attemptsLeft }),
  otpLocked: () =>
    new AppError(429, 'OTP_LOCKED', 'Wpisano zbyt wiele błędnych kodów. Wyślij nowy kod SMS.'),
  confirmInProgress: () =>
    new AppError(409, 'CONFIRM_IN_PROGRESS', 'Rezerwacja jest właśnie potwierdzana. Odczekaj chwilę.'),
};

module.exports = { AppError, Errors };
