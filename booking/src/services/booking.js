'use strict';

const crypto = require('crypto');
const { DateTime } = require('luxon');
const { withTransaction } = require('../db');
const repo = require('../db/repository');
const { Errors, AppError } = require('../lib/errors');
const { normalizePlPhone, formatPlPhone, maskPhone } = require('../lib/phone');
const { generateOtp, hashOtp, safeEqualHex, pseudonymize, generateHoldToken, hashHoldToken } = require('../lib/crypto');
const { buildOtpMessage } = require('./sms');
const { clientKey } = require('../lib/ip');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NAME_RE = /^\p{L}[\p{L}\p{M}' .-]*$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Dłużej niż najgorszy przypadek zapisu do Google (getEvent + freeBusy + insert, każdy z ponowieniami i timeoutem 10 s),
// żeby zadanie okresowe nie "naprawiało" rezerwacji, którą weryfikacja wciąż potwierdza.
const STUCK_CONFIRMING_MS = 5 * 60_000;
// Zadanie okresowe startuje co 60 s – próg nieco niższy, żeby drgania timera nie pomijały co drugiego przebiegu.
const EVENT_SYNC_INTERVAL_MS = 55_000;
// Ile jednocześnie niepotwierdzonych blokad może mieć jeden numer (np. 2 = także po odświeżeniu strony).
const MAX_PENDING_HOLDS_PER_PHONE = 2;
const HOLD_TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

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
  constructor({ config, pool, calendar, availability, sms, captcha, clock, logger, alerts = { notify() {} } }) {
    this.config = config;
    this.pool = pool;
    this.calendar = calendar;
    this.availability = availability;
    this.sms = sms;
    this.captcha = captcha;
    this.clock = clock;
    this.logger = logger;
    this.alerts = alerts;
    this._lastBalanceCheck = 0;
    this._lastEventSync = 0;
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
    return { phoneHash: pseudonymize(secret, 'phone', phone), ipHash: pseudonymize(secret, 'ip', clientKey(ip)) };
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
      this.alerts.notify(
        'sms_daily_limit',
        `Osiągnięto dzienny limit ${limits.smsGlobalPerDay} SMS-ów (SMS_LIMIT_GLOBAL_DAY). Rezerwacje online są wstrzymane do jutra. ` +
          'Jeśli to normalny ruch – podnieś limit; jeśli nie – ktoś może nadużywać formularza.',
      );
      throw Errors.smsDailyLimit();
    }
  }

  /**
   * Krok 1 weryfikacji: blokuje termin (soft lock) i wysyła kod SMS.
   *
   * `holdToken` – losowy token zwrócony przy utworzeniu blokady (dowód, że to ten sam klient):
   *   - kod z poprzedniego SMS-a nadal ważny → zmiana terminu/danych bez nowego SMS-a (`smsSent: false`),
   *   - `resend: true` lub kod nieważny → nowy kod dla tej samej rezerwacji,
   *   - inny numer telefonu → poprzednia blokada jest zwalniana.
   * Bez tokenu nie zmieniamy danych istniejącej rezerwacji ani nie zwalniamy blokad – najwyżej ponownie wysyłamy
   * kod dla rezerwacji tego numeru i terminu (np. po odświeżeniu strony). Jeden numer: maks. 2 niepotwierdzone blokady.
   */
  async requestOtp(body, { ip } = {}) {
    // Honeypot: ukryte pole, które wypełniają tylko boty. Udajemy sukces, nic nie wysyłając.
    if (body && typeof body.website === 'string' && body.website.trim() !== '') {
      this.logger.warn('honeypot_triggered', { ip });
      const now = this.clock.now();
      return {
        bookingId: crypto.randomUUID(),
        holdToken: generateHoldToken(),
        smsSent: true,
        lockExpiresAt: new Date(now.getTime() + this.config.booking.holdMinutes * 60_000).toISOString(),
        otpExpiresAt: new Date(now.getTime() + this.config.otp.ttlSeconds * 1000).toISOString(),
        resendAvailableAt: new Date(now.getTime() + this.config.otp.resendCooldownSeconds * 1000).toISOString(),
        serverNow: now.toISOString(),
      };
    }

    const input = this.validateRequest(body || {});
    const holdToken = typeof body.holdToken === 'string' && HOLD_TOKEN_RE.test(body.holdToken) ? body.holdToken : null;
    const forceNewCode = body.resend === true;
    if (this.captcha.enabled && !(await this.captcha.verify(body.captchaToken, ip))) throw Errors.captchaFailed();

    const hashes = this._hashes(input.phone, ip);
    const slot = await this.availability.resolveBookableSlot(input.slotStart);

    const { slotCapacity, holdMinutes } = this.config.booking;
    const code = generateOtp();
    const now = this.clock.now();
    const nowMs = now.getTime();
    const lockExpiresAt = new Date(nowMs + holdMinutes * 60_000);
    const otpExpiresAt = new Date(nowMs + this.config.otp.ttlSeconds * 1000);
    const details = { slotStart: slot.start, slotEnd: slot.end, firstName: input.firstName, lastName: input.lastName, email: input.email };

    const hold = await withTransaction(this.pool, async (db) => {
      await repo.lockHoldSection(db);
      const isSameSlot = (b) => b.slot_start.getTime() === slot.start.getTime();
      const assertCapacity = async (excludeId) => {
        const taken = await repo.countActiveOverlapping(db, slot.start, slot.end, now, { excludeId });
        if (taken >= slotCapacity) throw Errors.slotUnavailable();
      };

      // Własna blokada klienta (zna jej token).
      let own = holdToken ? await repo.findPendingByToken(db, hashHoldToken(holdToken), now, { forUpdate: true }) : null;
      let replacedOwnId = null;
      if (own && own.phone_hash !== hashes.phoneHash) {
        // Klient zmienił numer – poprzednią blokadę zwolnimy dopiero po udanej wysyłce SMS-a na nowy numer,
        // ale w liczeniu zajętości już jej nie uwzględniamy.
        replacedOwnId = own.id;
        own = null;
      }
      if (own && !isSameSlot(own)) await assertCapacity(own.id);

      const otpStillValid =
        own && own.otp_hash && own.otp_expires_at > now && own.otp_attempts < this.config.otp.maxAttempts;
      if (otpStillValid && !forceNewCode) {
        if (!(await repo.updatePendingDetails(db, own.id, { ...details, now }))) throw Errors.holdExpired();
        return { bookingId: own.id, smsSent: false, lockExpiresAt: own.lock_expires_at, otpExpiresAt: own.otp_expires_at };
      }

      await this._checkSmsLimits(db, hashes, nowMs);

      let target = own;
      if (!target) {
        let pendings = await repo.findPendingByPhone(db, hashes.phoneHash, now);
        target = pendings.find(isSameSlot) || null;
        // Bez tokenu dane istniejącej rezerwacji są nienaruszalne. Te same dane → zwykła ponowna wysyłka kodu;
        // inne dane (np. poprawka literówki po zamknięciu karty) → stara blokada zastąpiona nową, z nowymi danymi.
        // Kod jest związany z ID rezerwacji, więc potwierdzone dane to zawsze te, z którymi wysłano ten kod.
        if (target && !this._sameIdentity(target, input)) {
          await repo.cancelBooking(db, target.id, now);
          pendings = pendings.filter((p) => p !== target);
          target = null;
        }
        if (!target && pendings.length >= MAX_PENDING_HOLDS_PER_PHONE) {
          const firstFree = Math.min(...pendings.map((p) => p.lock_expires_at.getTime()));
          throw Errors.tooManyHolds((firstFree - nowMs) / 1000);
        }
      }

      let bookingId;
      let newToken = null;
      let version = null;
      let otpHash;
      if (target) {
        bookingId = target.id;
        otpHash = hashOtp(this.config.otp.secret, bookingId, code);
        version = await repo.refreshPendingBooking(db, bookingId, {
          otpHash,
          otpExpiresAt,
          lockExpiresAt,
          now,
          ...(own ? details : {}), // dane i termin zmienia tylko właściciel tokenu
        });
        if (version === null) throw Errors.holdExpired();
      } else {
        await assertCapacity(replacedOwnId);
        bookingId = crypto.randomUUID();
        newToken = generateHoldToken();
        otpHash = hashOtp(this.config.otp.secret, bookingId, code);
        await repo.insertBooking(db, {
          id: bookingId,
          ...details,
          phone: input.phone,
          phoneHash: hashes.phoneHash,
          lockExpiresAt,
          otpHash,
          otpExpiresAt,
          holdTokenHash: hashHoldToken(newToken),
          now,
        });
      }
      const smsLogId = await repo.insertSmsLog(db, { ...hashes, bookingId, now });
      return {
        bookingId, smsSent: true, snapshot: target, version, otpHash, smsLogId, lockExpiresAt, otpExpiresAt, newToken, replacedOwnId,
      };
    });

    if (hold.smsSent) {
      await this._sendOtpSms(input.phone, code, hold);
      if (hold.replacedOwnId) await repo.cancelBooking(this.pool, hold.replacedOwnId, this.clock.now());
    }

    return {
      bookingId: hold.bookingId,
      // Token tylko przy nowej blokadzie – klient zachowuje go na kolejne zmiany. Bez dowodu własności
      // (ponowna wysyłka po odświeżeniu strony) token nie jest wydawany, żeby nie dało się przejąć cudzej blokady.
      ...(hold.newToken ? { holdToken: hold.newToken } : {}),
      smsSent: hold.smsSent,
      slot: { start: slot.start.toISOString(), end: slot.end.toISOString() },
      phone: formatPlPhone(input.phone),
      lockExpiresAt: hold.lockExpiresAt.toISOString(),
      otpExpiresAt: hold.otpExpiresAt.toISOString(),
      resendAvailableAt: new Date(
        (hold.smsSent ? nowMs : Math.max(nowMs, hold.otpExpiresAt.getTime() - this.config.otp.ttlSeconds * 1000)) +
          this.config.otp.resendCooldownSeconds * 1000,
      ).toISOString(),
      serverNow: this.clock.now().toISOString(),
    };
  }

  async _sendOtpSms(phone, code, hold) {
    const message = buildOtpMessage(this.config.sms, {
      code,
      minutes: Math.round(this.config.otp.ttlSeconds / 60),
      businessName: this.config.businessName,
    });
    try {
      const sent = await this.sms.send(phone, message);
      this.logger.info('otp_sent', { bookingId: hold.bookingId, to: maskPhone(phone), provider: this.sms.name, smsId: sent?.id });
    } catch (err) {
      // Bramka jednoznacznie odrzuciła SMS → nie liczymy go do limitów. Timeout, sieć, 5xx → SMS mógł wyjść,
      // więc wpis zostaje w dzienniku (cooldown, limity, budżet).
      const definitive = err.definitive === true;
      this.logger.error(err.configProblem ? 'sms_provider_config_error' : 'sms_send_failed', {
        err,
        bookingId: hold.bookingId,
        to: maskPhone(phone),
        provider: this.sms.name,
        code: err.code,
        definitive,
      });
      if (err.configProblem) {
        this.alerts.notify(
          'sms_config',
          `Bramka SMS (${this.sms.name}) odrzuca wysyłkę: ${err.message}. Klienci nie mogą potwierdzić rezerwacji – ` +
            'sprawdź saldo, token i nazwę nadawcy.',
        );
      }
      // Stan sprzed żądania: nowa rezerwacja zwalnia termin, istniejąca wraca do poprzedniego kodu, prób i blokady
      // (inaczej nieudane wysyłki pozwalałyby bez końca zerować licznik prób i przedłużać blokadę).
      await withTransaction(this.pool, async (db) => {
        if (definitive) await repo.deleteSmsLog(db, hold.smsLogId);
        if (!hold.snapshot) await repo.cancelBooking(db, hold.bookingId, this.clock.now());
        else {
          const restored = await repo.restorePendingBooking(db, hold.snapshot, {
            version: hold.version,
            failedOtpHash: hold.otpHash,
            now: this.clock.now(),
          });
          if (restored !== 'full') this.logger.warn('sms_failure_partial_restore', { bookingId: hold.bookingId, restored });
        }
      }).catch((e) => this.logger.error('sms_failure_cleanup_failed', { err: e }));
      throw Errors.smsFailed();
    }
  }

  _sameIdentity(b, input) {
    const norm = (v) => (v || '').toLocaleLowerCase('pl');
    return (
      norm(b.first_name) === norm(input.firstName) &&
      norm(b.last_name) === norm(input.lastName) &&
      norm(b.email) === norm(input.email)
    );
  }

  /** ID własnej blokady klienta (z tokenu) – do pominięcia jej przy wyświetlaniu zajętości. */
  async holdIdForToken(token) {
    if (typeof token !== 'string' || !HOLD_TOKEN_RE.test(token)) return null;
    const b = await repo.findPendingByToken(this.pool, hashHoldToken(token), this.clock.now());
    return b ? b.id : null;
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
    // Ponowne wywołanie dla potwierdzonej rezerwacji (np. podwójne kliknięcie) – bez danych osobowych,
    // bo tej ścieżki nie chroni kod (ID rezerwacji nie jest tajne).
    if (outcome.already) return this._confirmationResult(b, { personal: false });

    let event;
    try {
      event = await this._ensureCalendarEvent(b);
    } catch (err) {
      if (err instanceof AppError && err.code === 'SLOT_UNAVAILABLE') {
        // Termin zajęto bezpośrednio w kalendarzu w trakcie weryfikacji.
        await repo.markStatus(this.pool, b.id, 'cancelled', this.clock.now(), { from: 'confirming' });
        this.logger.warn('slot_taken_in_calendar_during_verification', { bookingId: b.id });
        throw err;
      }
      await repo.revertToPending(this.pool, b.id, this.clock.now());
      this.logger.error('gcal_insert_failed', { err, bookingId: b.id });
      this.alerts.notify('gcal_insert', `Nie można zapisać rezerwacji w Google Calendar: ${err.message}`);
      throw Errors.calendarUnavailable();
    }

    await repo.markConfirmed(this.pool, b.id, event.id, this.clock.now());
    // Inne niepotwierdzone blokady tego numeru (np. po odświeżeniu strony) nie są już potrzebne.
    await repo.cancelOtherPendingForPhone(this.pool, b.phone_hash, b.id, this.clock.now());
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

  _confirmationResult(b, { personal = true } = {}) {
    const booking = { id: b.id, start: b.slot_start.toISOString(), end: b.slot_end.toISOString() };
    if (personal) {
      booking.firstName = b.first_name;
      booking.lastName = b.last_name;
      booking.phone = b.phone ? formatPlPhone(b.phone) : null;
    }
    return { status: 'confirmed', message: 'Zarezerwowano', booking };
  }

  /** Klient zrezygnował (np. zamknął stronę) – zwalnia soft lock od razu. Wymaga tokenu blokady. */
  async releaseHold(body) {
    const token = typeof body?.holdToken === 'string' && HOLD_TOKEN_RE.test(body.holdToken) ? body.holdToken : null;
    if (!token) return { released: false };
    const b = await repo.findPendingByToken(this.pool, hashHoldToken(token), this.clock.now());
    const released = b ? await repo.cancelBooking(this.pool, b.id, this.clock.now()) : false;
    if (released) this.logger.info('hold_released', { bookingId: b.id });
    return { released };
  }

  /** Raz na godzinę: ostrzeżenie, gdy saldo bramki SMS spada poniżej SMS_LOW_BALANCE_ALERT. */
  async _checkSmsBalance() {
    const threshold = this.config.alerts.smsLowBalance;
    if (threshold === null || typeof this.sms.getBalance !== 'function') return;
    if (Date.now() - this._lastBalanceCheck < 3_600_000) return;
    this._lastBalanceCheck = Date.now();
    try {
      const balance = await this.sms.getBalance();
      if (balance.amount < threshold) {
        this.logger.warn('sms_low_balance', balance);
        this.alerts.notify(
          'sms_low_balance',
          `Niskie saldo bramki SMS: ${balance.amount} ${balance.unit} (próg ${threshold}). Doładuj konto, zanim zabraknie na kody.`,
        );
      }
    } catch (err) {
      this.logger.warn('sms_balance_check_failed', { err });
    }
  }

  /**
   * Co minutę: uzgadnia przyszłe potwierdzone rezerwacje z Google Calendar.
   *   - wydarzenie usunięte przez studio → rezerwacja anulowana (termin wraca do puli),
   *   - wydarzenie przesunięte → nowy termin zapisany w bazie.
   * Brak wydarzenia na liście nie wystarcza do anulowania – potwierdzamy to pojedynczym odczytem (404/410/cancelled).
   */
  async _syncCalendarEvents(db, now) {
    if (now.getTime() - this._lastEventSync < EVENT_SYNC_INTERVAL_MS) return 0;
    this._lastEventSync = now.getTime();
    const upcoming = await repo.listUpcomingConfirmed(db, now);
    if (!upcoming.length || typeof this.calendar.listBookingEvents !== 'function') return 0;
    let events;
    try {
      const until = new Date(Math.max(...upcoming.map((b) => b.slot_end.getTime())) + DAY);
      events = await this.calendar.listBookingEvents(now, until);
    } catch (err) {
      this.logger.warn('gcal_event_sync_failed', { err });
      return 0;
    }
    const byId = new Map(events.map((e) => [e.id, e]));
    let cancelled = 0;
    for (const b of upcoming) {
      try {
        let ev = byId.get(b.gcal_event_id);
        if (!ev) ev = (await this.calendar.getEvent(b.gcal_event_id)) || { status: 'cancelled' };
        if (ev.status === 'cancelled') {
          if (await repo.markStatus(db, b.id, 'cancelled', now, { from: 'confirmed' })) {
            cancelled++;
            this.logger.info('booking_cancelled_in_calendar', { bookingId: b.id });
          }
          continue;
        }
        const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
        const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : null;
        if (start && end && (start.getTime() !== b.slot_start.getTime() || end.getTime() !== b.slot_end.getTime())) {
          await repo.updateConfirmedSlot(db, b.id, start, end, now);
          this.logger.info('booking_moved_in_calendar', { bookingId: b.id, start: start.toISOString() });
        }
      } catch (err) {
        this.logger.warn('gcal_event_sync_item_failed', { err, bookingId: b.id });
      }
    }
    if (cancelled) this.availability.invalidateCache();
    return cancelled;
  }

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
            else if (b.lock_expires_at <= now) await repo.markStatus(client, b.id, 'expired', now, { from: 'confirming' });
            else await repo.revertToPending(client, b.id, now);
            reconciled++;
          } catch (err) {
            this.logger.warn('reconcile_confirming_failed', { err, bookingId: b.id });
          }
        }
        const cancelledInCalendar = await this._syncCalendarEvents(client, now);
        const purged = await repo.purgeOldData(client, {
          inactiveBefore: new Date(now - DAY),
          confirmedSlotEndBefore: new Date(now - this.config.booking.retentionDays * DAY),
          smsLogBefore: new Date(now - 2 * DAY),
        });
        await this._checkSmsBalance();
        const summary = { expired, reconciled, cancelledInCalendar, ...purged };
        if (expired || reconciled || cancelledInCalendar || purged.inactive || purged.confirmed) {
          this.logger.info('maintenance', summary);
        }
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
