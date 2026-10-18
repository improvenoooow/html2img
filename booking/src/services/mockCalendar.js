'use strict';

const { CalendarError } = require('./googleCalendar');
const { overlaps } = require('../lib/schedule');

/**
 * Kalendarz w pamięci o tym samym interfejsie co GoogleCalendarClient.
 * Do lokalnego developmentu (GCAL_PROVIDER=mock) i testów – nie wymaga kluczy Google.
 */
class MockCalendar {
  constructor({ calendarId = 'mock@calendar' } = {}) {
    this.calendarId = calendarId;
    this.events = new Map();
    this.calls = { freeBusy: 0, insertEvent: 0 };
    this.failures = { freeBusy: 0, insertEvent: 0 }; // liczba kolejnych wywołań, które mają się nie udać
  }

  addBusy(start, end, summary = 'Zajęte') {
    const id = `busy${this.events.size + 1}x${Date.now().toString(32)}`;
    this.events.set(id, {
      id,
      summary,
      status: 'confirmed',
      transparency: 'opaque',
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(end).toISOString() },
    });
    return id;
  }

  _maybeFail(op) {
    if (this.failures[op] > 0) {
      this.failures[op]--;
      throw new CalendarError(`Symulowana awaria ${op}`, { status: 503, reason: 'backendError' });
    }
  }

  async freeBusy(timeMin, timeMax) {
    this.calls.freeBusy++;
    this._maybeFail('freeBusy');
    const busy = [];
    for (const e of this.events.values()) {
      if (e.status === 'cancelled' || e.transparency === 'transparent') continue;
      const start = new Date(e.start.dateTime);
      const end = new Date(e.end.dateTime);
      if (overlaps(start, end, timeMin, timeMax)) busy.push({ start, end });
    }
    return busy.sort((a, b) => a.start - b.start);
  }

  async insertEvent(event) {
    this.calls.insertEvent++;
    this._maybeFail('insertEvent');
    if (event.id && this.events.has(event.id)) return this.events.get(event.id);
    const stored = {
      status: 'confirmed',
      transparency: 'opaque',
      ...structuredClone(event),
      htmlLink: `https://calendar.google.com/calendar/event?eid=${event.id}`,
    };
    this.events.set(stored.id, stored);
    return stored;
  }

  async getEvent(id) {
    return this.events.get(id) || null;
  }

  async deleteEvent(id) {
    this.events.delete(id);
  }

  async listBookingEvents(timeMin, timeMax) {
    return [...this.events.values()].filter(
      (e) =>
        e.extendedProperties?.private?.source === 'pilanka-booking' &&
        new Date(e.end.dateTime) > timeMin &&
        new Date(e.start.dateTime) < timeMax,
    );
  }

  async getCalendarMeta() {
    return { id: this.calendarId, summary: 'Kalendarz testowy (mock)', timeZone: 'Europe/Warsaw' };
  }
}

module.exports = { MockCalendar };
