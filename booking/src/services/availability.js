'use strict';

const { DateTime } = require('luxon');
const { generateSlots, overlaps } = require('../lib/schedule');
const { Errors } = require('../lib/errors');
const repo = require('../db/repository');

const MAX_RANGE_DAYS = 62;

/**
 * Wyznacza wolne terminy: godziny pracy − zajętość w Google Calendar (Free/Busy, z buforem)
 * − aktywne rezerwacje i soft locki w bazie (z uwzględnieniem pojemności slotu).
 */
class AvailabilityService {
  constructor({ config, calendar, pool, clock, logger, alerts = { notify() {} } }) {
    this.cfg = config.booking;
    this.cacheMs = config.gcal.cacheSeconds * 1000;
    this.calendar = calendar;
    this.pool = pool;
    this.clock = clock;
    this.logger = logger;
    this.alerts = alerts;
    this._cache = new Map();
  }

  invalidateCache() {
    this._cache.clear();
  }

  async getBusy(from, to, { fresh = false } = {}) {
    const key = `${from.toISOString()}|${to.toISOString()}`;
    const nowMs = Date.now();
    const hit = this._cache.get(key);
    if (!fresh && this.cacheMs > 0 && hit && hit.expiresAt > nowMs) return hit.busy;
    let busy;
    try {
      busy = await this.calendar.freeBusy(from, to);
    } catch (err) {
      this.logger.error('gcal_freebusy_failed', { err });
      this.alerts.notify(
        'gcal',
        `Google Calendar nie odpowiada – klienci nie widzą wolnych terminów i nie mogą rezerwować.\nBłąd: ${err.message}`,
      );
      throw Errors.calendarUnavailable();
    }
    if (this.cacheMs > 0) {
      if (this._cache.size > 200) this._cache.clear();
      this._cache.set(key, { busy, expiresAt: nowMs + this.cacheMs });
    }
    return busy;
  }

  /** Granice rezerwacji liczone od "teraz": najwcześniejszy i najpóźniejszy możliwy start. */
  bounds() {
    const now = DateTime.fromJSDate(this.clock.now(), { zone: this.cfg.timezone });
    return {
      now,
      today: now.toISODate(),
      lastDate: now.plus({ days: this.cfg.horizonDays }).toISODate(),
      earliestStart: now.plus({ minutes: this.cfg.minNoticeMin }).toJSDate(),
    };
  }

  _candidateSlots(fromDate, toDate) {
    const { earliestStart } = this.bounds();
    return generateSlots({
      fromDate,
      toDate,
      schedule: this.cfg.schedule,
      zone: this.cfg.timezone,
      durationMin: this.cfg.slotDurationMin,
      stepMin: this.cfg.slotStepMin,
      closedDates: this.cfg.closedDates,
    }).filter((s) => s.start >= earliestStart);
  }

  _isFree(slot, busy, active) {
    const bufMs = this.cfg.bufferMin * 60_000;
    const s = slot.start.getTime() - bufMs;
    const e = slot.end.getTime() + bufMs;
    if (busy.some((b) => overlaps(s, e, b.start.getTime(), b.end.getTime()))) return false;
    const taken = active.filter((a) => overlaps(slot.start, slot.end, a.slot_start, a.slot_end)).length;
    return taken < this.cfg.slotCapacity;
  }

  /**
   * Wolne terminy w dniach [fromDate, toDate] (RRRR-MM-DD w strefie studia), przycięte do horyzontu rezerwacji.
   */
  async getAvailability(fromDate, toDate) {
    const { today, lastDate } = this.bounds();
    const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && DateTime.fromISO(d).isValid;
    if (!isDate(fromDate) || !isDate(toDate)) {
      throw Errors.validation('Parametry from i to muszą być datami w formacie RRRR-MM-DD.');
    }
    const from = fromDate < today ? today : fromDate;
    const to = toDate > lastDate ? lastDate : toDate;
    const result = { timezone: this.cfg.timezone, from, to, days: [] };
    if (from > to) return result;

    const zone = this.cfg.timezone;
    const fromDt = DateTime.fromISO(from, { zone });
    const toDt = DateTime.fromISO(to, { zone });
    if (toDt.diff(fromDt, 'days').days > MAX_RANGE_DAYS) {
      throw Errors.validation(`Zakres dat nie może przekraczać ${MAX_RANGE_DAYS} dni.`);
    }

    const slots = this._candidateSlots(from, to);
    const byDay = new Map();
    for (let d = fromDt; d <= toDt; d = d.plus({ days: 1 })) byDay.set(d.toISODate(), []);

    if (slots.length) {
      const bufMs = this.cfg.bufferMin * 60_000;
      const rangeStart = new Date(slots[0].start.getTime() - bufMs);
      const rangeEnd = new Date(Math.max(...slots.map((s) => s.end.getTime())) + bufMs);
      const [busy, active] = await Promise.all([
        this.getBusy(rangeStart, rangeEnd),
        repo.listActiveInRange(this.pool, rangeStart, rangeEnd, this.clock.now()),
      ]);
      for (const slot of slots) {
        if (this._isFree(slot, busy, active)) {
          byDay.get(slot.date).push({ start: slot.start.toISOString(), end: slot.end.toISOString(), time: slot.time });
        }
      }
    }
    result.days = [...byDay].map(([date, daySlots]) => ({ date, slots: daySlots }));
    return result;
  }

  /**
   * Sprawdza, czy podany start odpowiada realnemu slotowi z grafiku (w horyzoncie, z wyprzedzeniem)
   * i czy jest wolny w Google Calendar (świeże zapytanie, bez cache).
   * Nie sprawdza blokad w bazie – to robi transakcja rezerwacji.
   * @returns {Promise<{ start: Date, end: Date }>}
   */
  async resolveBookableSlot(slotStartIso) {
    const start = new Date(slotStartIso);
    if (typeof slotStartIso !== 'string' || Number.isNaN(start.getTime())) {
      throw Errors.validation('Wybierz termin.', { slotStart: 'Nieprawidłowy termin.' });
    }
    const { today, lastDate } = this.bounds();
    const date = DateTime.fromJSDate(start, { zone: this.cfg.timezone }).toISODate();
    if (date < today || date > lastDate) throw Errors.slotUnavailable();
    const slot = this._candidateSlots(date, date).find((s) => s.start.getTime() === start.getTime());
    if (!slot) throw Errors.slotUnavailable();
    await this.assertFreeInCalendar(slot);
    return slot;
  }

  async assertFreeInCalendar(slot) {
    const bufMs = this.cfg.bufferMin * 60_000;
    const busy = await this.getBusy(new Date(slot.start.getTime() - bufMs), new Date(slot.end.getTime() + bufMs), {
      fresh: true,
    });
    if (!this._isFree(slot, busy, [])) throw Errors.slotUnavailable();
  }
}

module.exports = { AvailabilityService };
