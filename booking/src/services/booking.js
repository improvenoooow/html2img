'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { withTransaction } = require('../db');
const repo = require('../db/repository');
const { Errors, AppError } = require('../lib/errors');
const { normalizePlPhone, formatPlPhone, maskPhone } = require('../lib/phone');
const { generateOtp, hashOtp, safeEqualHex, pseudonymize } = require('../lib/crypto');
const { buildOtpMessage } = require('./sms');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NAME_RE = /^\p{L}[\p{L}\p{M}' .-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUCK_CONFIRMING_MS = 2 * 60_000;

function cleanName(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/g, ' ') : '';
}

function minutesText(ms) {
  const min = Math.max(1, Math.ceil(ms / 60_000));
  return min === 1 ? '1 minutę' : min % 10 >= 2 && min % 10 <= 4 && (min % 100 < 10 || min % 100 >= 20) ? `${min} minuty` : `${min} minut`;
}

/** Identyfikator wydarzenia w GCal wyprowadzony z ID rezerwacji (base32hex: 0-9, a-v) – gwarantuje idempotencję. */
function eventIdFor(bookingId) {
  return `plb${bookingId.replace(/-/g, '').toLowerCase()}`;
}

class BookingService {
  constructor({ config, pool, calendar, availability, sms, captcha, clock, logger }) {
    this.config = config;
    this.pool = pool;
    this.calendar = calendar;
    this.availability = availability;
    this.sms = sms;
    this.captcha = captcha;
    this.clock = clock;
    this.logger = logger;
  }

  validateRequest(body) {
    const fields = {};
    const firstName = cleanName(body.firstName);
    const lastName = cleanName(body.lastName);
    if (!firstName) fields.firstName = 'Podaj imię.';
    else if (firstName.length > 60 || !NAME_RE.test(firstName)) fields.firstName = 'Imię zawiera niedozwolone znaki.';
    if (!lastName) fields.lastName = 'Podaj nazwisko.';
    else if (lastName.length > 60 || !NAME_RE.test(lastName)) fields.lastName = 'Nazwisko zawiera niedozwolone znaki.';

    const phone = normalizePlPhone(body.phone);
    if (!phone.ok) fields.phone = phone.error;

    let email = null;
    if (body.email !== undefined && body.email !== null && String(body.email).trim() !== '') {
      email = String(body.email).trim().toLowerCase();
      if (email.length > 254 || !EMAIL_RE.test(email)) fields.email = 'Podaj poprawny adres e-mail.';
    }
    if (body.consent !== true) fields.consent = 'Zgoda na przetwarzanie danych jest wymagana do rezerwacji.';
    if (typeof body.slotStart !== 'string' || !body.slotStart) fields.slotStart = 'Wybierz termin.';

    if (Object.keys(fields).length) throw Errors.validation('Popraw zaznaczone pola formularza.', fields);
    return { firstName, lastName, phone: phone.ok ? phone.e164 : null, email, slotStart: body.slotStart };
  }

  _hashes(phone, ip) {
    const secret = this.config.otp.secret;
    return { phoneHash: pseudonymize(secret, 'phone', phone), ipHash: pseudonymize(secret, 'ip', ip || 'unknown') };
  }

  /** Limity wysyłki SMS: odstęp między SMS-ami, limit na numer, na IP i dzienny limit globalny (budżet). */
  async _checkSmsLimits(db, { phoneHash, ipHash }, now) {
    const { limits, otp } = this.config;
    const stats = await repo.smsStats(db, {
      phoneHash,
      ipHash,
      hourAgo: new Date(now - HOUR),
      dayAgo: new Date(now - DAY),
    });
    if (stats.phone_last && now - stats.phone_last < otp.resendCooldownSeconds * 1000) {
      throw Errors.resendCooldown((otp.resendCooldownSeconds * 1000 - (now - stats.phone_last)) / 1000);
    }
    if (stats.phone_count >= limits.smsPerPhonePerHour) {
      const wait = stats.phone_oldest.getTime() + HOUR - now;
      throw Errors.rateLimited(
        `Osiągnięto limit kodów SMS dla tego numeru (${limits.smsPerPhonePerHour} na godzinę). Spróbuj ponownie za ${minutesText(wait)}.`,
        wait / 1000,
      );
    }
    if (stats.ip_count >= limits.smsPerIpPerHour) {
      const wait = stats.ip_oldest.getTime() + HOUR - now;
      throw Errors.rateLimited(`Zbyt wiele prób wysłania kodu SMS. Spróbuj ponownie za ${minutesText(wait)}.`, wait / 1000);
    }
    if (stats.global_count >= limits.smsGlobalPerDay) {
      this.logger.error('sms_global_daily_limit_reached', { limit: limits.smsGlobalPerDay });
      throw Errors.smsDailyLimit();
    }
  }

  /**
   * Krok 1 weryfikacji: blokuje termin (soft lock) i wysyła kod SMS.
   * Ponowne wywołanie dla tego samego numeru i terminu = ponowna wysyłka kodu (ta sama rezerwacja).
   * Wybranie innego terminu przez ten sam numer zwalnia poprzednią blokadę.
   */
  async requestOtp(body, { ip } = {}) {
    // Honeypot: ukryte pole, które wypełniają tylko boty. Udajemy sukces, nic nie wysyłając.
    if (body && typeof body.website === 'string' && body.website.trim() !== '') {
      this.logger.warn('honeypot_triggered', { ip });
      const now = this.clock.now();
      return {
        bookingId: crypto.randomUUID(),
        lockExpiresAt: new Date(now.getTime() + this.config.booking.holdMinutes * 60_000).toISOString(),
        otpExpiresAt: new Date(now.getTime() + this.config.otp.ttlSeconds * 1000).toISOString(),
        resendAvailableAt: new Date(now.getTime() + this.config.otp.resendCooldownSeconds * 1000).toISOString(),
        serverNow: now.toISOString(),
      };
    }

    const input = this.validateRequest(body || {});
    if (this.captcha.enabled && !(await this.captcha.verify(body.captchaToken, ip))) throw Errors.captchaFailed();

    const hashes = this._hashes(input.phone, ip);
    // Szybkie sprawdzenie limitów przed zapytaniem do Google (bez blokady – autorytatywne jest w transakcji).
    await this._checkSmsLimits(this.pool, hashes, this.clock.now().getTime());

    const slot = await this.availability.resolveBookableSlot(input.slotStart);

    const code = generateOtp();
    const now = this.clock.now();
    const nowMs = now.getTime();
    const lockExpiresAt = new Date(nowMs + this.config.booking.holdMinutes * 60_000);
    const otpExpiresAt = new Date(nowMs + this.config.otp.ttlSeconds * 1000);

    const hold = await withTransaction(this.pool, async (db) => {
      await repo.lockHoldSection(db);
      await this._checkSmsLimits(db, hashes, nowMs);

      const pendings = await repo.findPendingByPhone(db, hashes.phoneHash, now);
      const same = pendings.find((p) => p.slot_start.getTime() === slot.start.getTime());
      for (const p of pendings) if (p !== same) await repo.cancelBooking(db, p.id, now);

      let bookingId;
      if (same) {
        bookingId = same.id;
        await repo.refreshPendingBooking(db, bookingId, {
          ...input,
          otpHash: hashOtp(this.config.otp.secret, bookingId, code),
          otpExpiresAt,
          lockExpiresAt,
          now,
        });
      } else {
        const taken = await repo.countActiveOverlapping(db, slot.start, slot.end, now);
        if (taken >= this.config.booking.slotCapacity) throw Errors.slotUnavailable();
        bookingId = crypto.randomUUID();
        await repo.insertBooking(db, {
          id: bookingId,
          slotStart: slot.start,
          slotEnd: slot.end,
          firstName: input.firstName,
          lastName: input.lastName,
          phone: input.phone,
          phoneHash: hashes.phoneHash,
          email: input.email,
          lockExpiresAt,
          otpHash: hashOtp(this.config.otp.secret, bookingId, code),
          otpExpiresAt,
          now,
        });
      }
      const smsLogId = await repo.insertSmsLog(db, { ...hashes, bookingId, now });
      return { bookingId, created: !same, smsLogId };
    });

    const message = buildOtpMessage(this.config.sms, {
      code,
      minutes: Math.round(this.config.otp.ttlSeconds / 60),
      businessName: this.config.businessName,
    });
    try {
      const sent = await this.sms.send(input.phone, message);
      this.logger.info('otp_sent', { bookingId: hold.bookingId, to: maskPhone(input.phone), provider: this.sms.name, smsId: sent?.id });
    } catch (err) {
      this.logger.error(err.configProblem ? 'sms_provider_config_error' : 'sms_send_failed', {
        err,
        bookingId: hold.bookingId,
        to: maskPhone(input.phone),
        provider: this.sms.name,
        code: err.code,
      });
      // Nieudana wysyłka nie zużywa limitu klienta; nowa rezerwacja zwalnia termin.
      await withTransaction(this.pool, async (db) => {
        await repo.deleteSmsLog(db, hold.smsLogId);
        if (hold.created) await repo.cancelBooking(db, hold.bookingId, this.clock.now());
      }).catch((e) => this.logger.error('sms_failure_cleanup_failed', { err: e }));
      throw Errors.smsFailed();
    }

    return {
      bookingId: hold.bookingId,
      slot: { start: slot.start.toISOString(), end: slot.end.toISOString() },
      phone: formatPlPhone(input.phone),
      lockExpiresAt: lockExpiresAt.toISOString(),
      otpExpiresAt: otpExpiresAt.toISOString(),
      resendAvailableAt: new Date(nowMs + this.config.otp.resendCooldownSeconds * 1000).toISOString(),
      serverNow: this.clock.now().toISOString(),
    };
  }

  /**
   * Krok 2 weryfikacji: sprawdza kod, tworzy wydarzenie w Google Calendar i potwierdza rezerwację.
   * Idempotentne: ponowne wywołanie dla potwierdzonej rezerwacji zwraca ten sam wynik.
   */
  async verifyOtp(body) {
    const bookingId = typeof body?.bookingId === 'string' ? body.bookingId.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.replace(/\s/g, '') : '';
    if (!UUID_RE.test(bookingId)) throw Errors.bookingNotFound();
    if (!/^\d{6}$/.test(code)) throw Errors.validation('Kod SMS składa się z 6 cyfr.', { code: 'Wpisz 6-cyfrowy kod.' });

    const now = this.clock.now();
    const outcome = await withTransaction(this.pool, async (db) => {
      const b = await repo.getBooking(db, bookingId, { forUpdate: true });
      if (!b) throw Errors.bookingNotFound();
      if (b.status === 'confirmed') return { booking: b, already: true };
      if (b.status === 'confirming') throw Errors.confirmInProgress();
      if (b.status !== 'pending' || b.lock_expires_at <= now) throw Errors.holdExpired();
      if (b.otp_attempts >= this.config.otp.maxAttempts) throw Errors.otpLocked();
      if (!b.otp_hash || !b.otp_expires_at || b.otp_expires_at <= now) throw Errors.otpExpired();

      if (!safeEqualHex(hashOtp(this.config.otp.secret, b.id, code), b.otp_hash)) {
        const attempts = await repo.incrementOtpAttempts(db, b.id, now);
        return { invalid: true, attemptsLeft: Math.max(0, this.config.otp.maxAttempts - attempts) };
      }
      await repo.markConfirming(db, b.id, now);
      return { booking: b };
    });

    if (outcome.invalid) {
      this.logger.info('otp_invalid', { bookingId, attemptsLeft: outcome.attemptsLeft });
      if (outcome.attemptsLeft === 0) throw Errors.otpLocked();
      throw Errors.otpInvalid(outcome.attemptsLeft);
    }
    const b = outcome.booking;
    if (outcome.already) return this._confirmationResult(b);

    let event;
    try {
      event = await this._ensureCalendarEvent(b);
    } catch (err) {
      if (err instanceof AppError && err.code === 'SLOT_UNAVAILABLE') {
        // Termin zajęto bezpośrednio w kalendarzu w trakcie weryfikacji.
        await repo.markStatus(this.pool, b.id, 'cancelled', this.clock.now());
        this.logger.warn('slot_taken_in_calendar_during_verification', { bookingId: b.id });
        throw err;
      }
      await repo.revertToPending(this.pool, b.id, this.clock.now());
      this.logger.error('gcal_insert_failed', { err, bookingId: b.id });
      throw Errors.calendarUnavailable();
    }

    await repo.markConfirmed(this.pool, b.id, event.id, this.clock.now());
    this.availability.invalidateCache();
    this.logger.info('booking_confirmed', { bookingId: b.id, slotStart: b.slot_start.toISOString(), eventId: event.id });
    return this._confirmationResult(b);
  }

  async _ensureCalendarEvent(b) {
    const eventId = eventIdFor(b.id);
    // Poprzednia próba mogła utworzyć wydarzenie mimo błędu sieci – wtedy nie sprawdzamy zajętości ponownie,
    // bo nasze własne wydarzenie blokuje już ten termin.
    const existing = await this.calendar.getEvent(eventId);
    if (existing && existing.status !== 'cancelled') return existing;
    await this.availability.assertFreeInCalendar({ start: b.slot_start, end: b.slot_end });
    return this.calendar.insertEvent(this.buildEvent(b, eventId));
  }

  buildEvent(b, eventId = eventIdFor(b.id)) {
    const { booking, gcal, eventTitlePrefix, businessName } = this.config;
    const phone = formatPlPhone(b.phone);
    return {
      id: eventId,
      summary: `${eventTitlePrefix}: ${b.first_name} ${b.last_name} - ${phone}`,
      description: [
        `Klient: ${b.first_name} ${b.last_name}`,
        `Telefon: ${phone}`,
        b.email ? `E-mail: ${b.email}` : null,
        '',
        `Rezerwacja online ${businessName} – numer telefonu zweryfikowany kodem SMS.`,
        `ID rezerwacji: ${b.id}`,
      ]
        .filter((l) => l !== null)
        .join('\n'),
      start: { dateTime: DateTime.fromJSDate(b.slot_start, { zone: booking.timezone }).toISO(), timeZone: booking.timezone },
      end: { dateTime: DateTime.fromJSDate(b.slot_end, { zone: booking.timezone }).toISO(), timeZone: booking.timezone },
      // Przy zajęciach grupowych zajętość liczymy w bazie, więc wydarzenia rezerwacji nie mogą blokować Free/Busy.
      transparency: booking.slotCapacity > 1 ? 'transparent' : 'opaque',
      ...(gcal.eventColorId ? { colorId: gcal.eventColorId } : {}),
      extendedProperties: { private: { bookingId: b.id, source: 'pilanka-booking' } },
      reminders: { useDefault: true },
    };
  }

  _confirmationResult(b) {
    return {
      status: 'confirmed',
      message: 'Zarezerwowano',
      booking: {
        id: b.id,
        start: b.slot_start.toISOString(),
        end: b.slot_end.toISOString(),
        firstName: b.first_name,
        lastName: b.last_name,
        phone: b.phone ? formatPlPhone(b.phone) : null,
      },
    };
  }

  /** Klient zrezygnował / zmienia dane – zwalnia soft lock od razu, bez czekania na wygaśnięcie. */
  async releaseHold(body) {
    const bookingId = typeof body?.bookingId === 'string' ? body.bookingId.trim() : '';
    if (!UUID_RE.test(bookingId)) return { released: false };
    const released = await repo.cancelBooking(this.pool, bookingId, this.clock.now());
    if (released) this.logger.info('hold_released', { bookingId });
    return { released };
  }

  /**
   * Zadanie okresowe: oznacza wygasłe blokady, naprawia rezerwacje zawieszone w stanie "confirming"
   * (np. restart serwera w trakcie zapisu do GCal) i usuwa stare dane osobowe (RODO).
   * Wykonywane tylko przez jedną instancję naraz (advisory lock).
   */
  async runMaintenance() {
    const client = await this.pool.connect();
    try {
      if (!(await repo.tryMaintenanceLock(client))) return null;
      try {
        const now = this.clock.now();
        const expired = await repo.expireStalePending(client, now);
        let reconciled = 0;
        for (const b of await repo.listStuckConfirming(client, new Date(now - STUCK_CONFIRMING_MS))) {
          try {
            const event = await this.calendar.getEvent(eventIdFor(b.id));
            if (event && event.status !== 'cancelled') await repo.markConfirmed(client, b.id, event.id, now);
            else if (b.lock_expires_at <= now) await repo.markStatus(client, b.id, 'expired', now);
            else await repo.revertToPending(client, b.id, now);
            reconciled++;
          } catch (err) {
            this.logger.warn('reconcile_confirming_failed', { err, bookingId: b.id });
          }
        }
        const purged = await repo.purgeOldData(client, {
          inactiveBefore: new Date(now - DAY),
          confirmedSlotEndBefore: new Date(now - this.config.booking.retentionDays * DAY),
          smsLogBefore: new Date(now - 2 * DAY),
        });
        const summary = { expired, reconciled, ...purged };
        if (expired || reconciled || purged.inactive || purged.confirmed) this.logger.info('maintenance', summary);
        return summary;
      } finally {
        await repo.releaseMaintenanceLock(client);
      }
    } finally {
      client.release();
    }
  }
}

module.exports = { BookingService, eventIdFor };
