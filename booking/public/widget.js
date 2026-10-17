/*!
 * Pilanka Booking – widget rezerwacji (Google Calendar + weryfikacja SMS).
 *
 * Osadzenie na stronie:
 *   <div data-pilanka-booking></div>
 *   <script src="https://TWOJ-SERWER-REZERWACJI/widget.js" defer></script>
 *
 * Opcje (atrybuty data-* na elemencie):
 *   data-title, data-subtitle      – nagłówek widgetu
 *   data-theme="light|dark|auto"   – motyw kolorystyczny (domyślnie light)
 *   data-contact-phone             – telefon studia pokazywany przy błędach
 *   data-api                       – adres API (domyślnie serwer, z którego wczytano skrypt)
 *
 * Zdarzenia (do analityki, np. GA4 / Meta Pixel) emitowane na elemencie:
 *   pilanka:otp-sent, pilanka:booked (detail: { bookingId, start, end })
 */
(function () {
  'use strict';
  if (window.PilankaBooking) return;

  var SCRIPT = document.currentScript;
  var SCRIPT_ORIGIN = SCRIPT && SCRIPT.src ? new URL(SCRIPT.src, location.href).origin : location.origin;
  var PL_MOBILE = ['45', '50', '51', '53', '57', '60', '66', '69', '72', '73', '78', '79', '88'];
  var NAME_RE = /^\p{L}[\p{L}\p{M}' .-]*$/u;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  var DOW = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];
  var DOW_LONG = ['poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota', 'niedziela'];

  var ICON = {
    prev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    next: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  };

  // ---------- narzędzia ----------

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** Zwraca { ok, digits } albo { ok:false, error } – te same reguły co na serwerze. */
  function normalizePhone(input) {
    var raw = String(input || '').trim();
    if (!raw) return { ok: false, error: 'Podaj numer telefonu.' };
    if (!/^[+\d\s\-().]+$/.test(raw)) return { ok: false, error: 'Numer telefonu może zawierać tylko cyfry.' };
    var d = raw.replace(/\D/g, '');
    if (raw.charAt(0) === '+') {
      if (d.indexOf('48') !== 0) return { ok: false, error: 'Obsługujemy wyłącznie polskie numery (+48).' };
      d = d.slice(2);
    } else if (d.indexOf('0048') === 0) d = d.slice(4);
    else if (d.length === 11 && d.indexOf('48') === 0) d = d.slice(2);
    if (d.length !== 9) return { ok: false, error: 'Numer telefonu musi mieć 9 cyfr.' };
    if (PL_MOBILE.indexOf(d.slice(0, 2)) === -1) {
      return { ok: false, error: 'Podaj numer telefonu komórkowego – na ten numer wyślemy kod SMS.' };
    }
    return { ok: true, digits: d };
  }

  function groupDigits(d) {
    return [d.slice(0, 3), d.slice(3, 6), d.slice(6, 9)].filter(Boolean).join(' ');
  }

  // Daty kalendarzowe (bez godziny) liczone w UTC, żeby uniknąć przesunięć stref czasowych przeglądarki.
  function parseDate(s) {
    var p = s.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  }
  function isoDate(d) {
    return d.toISOString().slice(0, 10);
  }
  var MONTH_FMT = new Intl.DateTimeFormat('pl-PL', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  var DAY_FMT = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  function longDate(dateStr) {
    var d = parseDate(dateStr);
    return DOW_LONG[(d.getUTCDay() + 6) % 7] + ', ' + DAY_FMT.format(d);
  }
  function plural(n, one, few, many) {
    if (n === 1) return one;
    var t = n % 10;
    var h = n % 100;
    return t >= 2 && t <= 4 && (h < 10 || h >= 20) ? few : many;
  }
  function mmss(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  var scriptPromises = {};
  function loadScript(src) {
    if (!scriptPromises[src]) {
      scriptPromises[src] = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = src;
        s.async = true;
        s.onload = resolve;
        s.onerror = function () {
          delete scriptPromises[src];
          reject(new Error('Nie udało się wczytać ' + src));
        };
        document.head.appendChild(s);
      });
    }
    return scriptPromises[src];
  }

  // ---------- widget ----------

  function Widget(host, options) {
    this.host = host;
    this.opts = options || {};
    this.api = (this.opts.api || SCRIPT_ORIGIN).replace(/\/$/, '');
    this.cfg = null;
    this.view = null; // { y, m } – widoczny miesiąc
    this.days = {}; // 'RRRR-MM-DD' -> [{ start, end, time }]
    this.loadedMonths = {};
    this.loadingMonth = null;
    this.date = null;
    this.slot = null;
    this.phase = 'select'; // select | otp | done
    this.hold = null;
    this.busy = false;
    this.captchaToken = null;
    this.captchaWaiters = [];
    this.seq = 0;
    this.timer = null;
    this.webOtpAbort = null;

    if (!this.host.hasAttribute('data-theme')) this.host.setAttribute('data-theme', 'light');
    this.root = host.attachShadow({ mode: 'open' });
    this._renderShell();
    this._bindRoot();
    this._bindForm();
    this._start();
  }

  Widget.prototype.$ = function (ref) {
    return this.root.querySelector('[data-ref="' + ref + '"]');
  };

  Widget.prototype._renderShell = function () {
    var title = this.opts.title || 'Zarezerwuj zajęcia';
    var subtitle = this.opts.subtitle || 'Wybierz dogodny termin, podaj dane i potwierdź rezerwację kodem SMS.';
    this.root.innerHTML =
      '<link rel="stylesheet" href="' + esc(this.api) + '/widget.css">' +
      '<div class="plb" data-loading-css>' +
      '<div data-ref="main">' +
      '<header class="plb-head"><h2 class="plb-title">' + esc(title) + '</h2>' +
      '<p class="plb-subtitle">' + esc(subtitle) + '</p></header>' +
      '<section class="plb-card" data-ref="whenCard" aria-labelledby="plb-s1">' +
      '<h3 class="plb-step" id="plb-s1" data-ref="step1"><span class="plb-step-no">1</span>Wybierz termin</h3>' +
      '<div class="plb-alert" role="alert" data-ref="whenAlert"></div>' +
      '<div class="plb-when-body" data-ref="whenBody">' +
      '<div class="plb-cal" data-ref="cal" aria-busy="true">' +
      '<div class="plb-cal-head">' +
      '<button type="button" class="plb-icon-btn" data-action="prev" aria-label="Poprzedni miesiąc">' + ICON.prev + '</button>' +
      '<div class="plb-month" data-ref="month" aria-live="polite"></div>' +
      '<button type="button" class="plb-icon-btn" data-action="next" aria-label="Następny miesiąc">' + ICON.next + '</button>' +
      '</div>' +
      '<div class="plb-grid" data-ref="grid" role="group" aria-label="Dni miesiąca"></div>' +
      '<p class="plb-legend"><span class="plb-legend-dot" aria-hidden="true"></span>Dni z wolnymi terminami</p>' +
      '</div>' +
      '<div class="plb-times" data-ref="times" aria-live="polite"></div>' +
      '</div></section>' +
      '<form data-ref="form" novalidate>' +
      '<section class="plb-card" aria-labelledby="plb-s2">' +
      '<h3 class="plb-step" id="plb-s2"><span class="plb-step-no">2</span>Twoje dane</h3>' +
      '<div class="plb-summary" data-ref="summary"></div>' +
      '<div class="plb-fields">' +
      this._field('firstName', 'Imię', '<input class="plb-input" id="plb-firstName" name="firstName" autocomplete="given-name" maxlength="60" required>') +
      this._field('lastName', 'Nazwisko', '<input class="plb-input" id="plb-lastName" name="lastName" autocomplete="family-name" maxlength="60" required>') +
      this._field(
        'phone',
        'Numer telefonu komórkowego',
        '<div class="plb-input-wrap"><span class="plb-prefix" aria-hidden="true">+48</span>' +
          '<input class="plb-input" id="plb-phone" name="phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="600 000 000" maxlength="16" required aria-describedby="plb-phone-hint plb-phone-err"></div>' +
          '<span class="plb-sr" id="plb-phone-hint">Polski numer komórkowy, 9 cyfr. Wyślemy na niego kod SMS.</span>',
      ) +
      this._field('email', 'E-mail <small>(opcjonalnie)</small>', '<input class="plb-input" id="plb-email" name="email" type="email" inputmode="email" autocomplete="email" maxlength="254" placeholder="np. anna@example.com">') +
      '<div class="plb-field plb-field-wide">' +
      '<label class="plb-check"><input type="checkbox" name="consent" id="plb-consent" aria-describedby="plb-consent-err">' +
      '<span data-ref="consentText"></span></label>' +
      '<p class="plb-error" id="plb-consent-err" data-err="consent"></p></div>' +
      '<div class="plb-hp" aria-hidden="true"><label>Strona www<input name="website" tabindex="-1" autocomplete="off"></label></div>' +
      '<div class="plb-field-wide plb-captcha"><slot name="captcha"></slot></div>' +
      '</div></section>' +
      '<section class="plb-card" aria-labelledby="plb-s3">' +
      '<h3 class="plb-step" id="plb-s3"><span class="plb-step-no">3</span>Potwierdzenie SMS</h3>' +
      '<div class="plb-alert" role="alert" data-ref="verifyAlert"></div>' +
      '<div data-ref="verify"></div>' +
      '</section></form>' +
      '</div></div>';

    var plb = this.root.querySelector('.plb');
    var link = this.root.querySelector('link');
    var reveal = function () {
      plb.removeAttribute('data-loading-css');
    };
    link.addEventListener('load', reveal);
    link.addEventListener('error', reveal);
    setTimeout(reveal, 3000);
  };

  Widget.prototype._field = function (name, label, control) {
    return (
      '<div class="plb-field">' +
      '<label class="plb-label" for="plb-' + name + '">' + label + '</label>' + control +
      '<p class="plb-error" id="plb-' + name + '-err" data-err="' + name + '"></p></div>'
    );
  };

  /** Zdarzenia na shadow root i dokumencie – podpinane raz na cały cykl życia widgetu. */
  Widget.prototype._bindRoot = function () {
    var self = this;
    // pointerdown następuje przed blur – gdy użytkownik naciska przycisk, nie walidujemy pola przy blur,
    // bo komunikat błędu przesunąłby przycisk i kliknięcie by "przepadło" (zrobi to walidacja przy wysyłce).
    this.root.addEventListener(
      'pointerdown',
      function (e) {
        if (e.target.closest && e.target.closest('button')) self._pressing = true;
      },
      true,
    );
    var release = function () {
      setTimeout(function () {
        self._pressing = false;
      }, 0);
    };
    this.root.addEventListener('pointerup', release, true);
    this.root.addEventListener('pointercancel', release, true);
    this.root.addEventListener('click', function (e) {
      var t = e.target.closest('[data-action],[data-date],[data-slot]');
      if (!t || t.disabled) return;
      if (t.hasAttribute('data-date')) return self.selectDate(t.getAttribute('data-date'));
      if (t.hasAttribute('data-slot')) return self.selectSlot(t.getAttribute('data-slot'));
      var a = t.getAttribute('data-action');
      if (a === 'prev') self.shiftMonth(-1);
      else if (a === 'next') self.shiftMonth(1);
      else if (a === 'resend') self.sendOtp(true);
      else if (a === 'change') self.changeData();
      else if (a === 'confirm') self.verify();
      else if (a === 'retry') self._start();
      else if (a === 'ics') self.downloadIcs();
      else if (a === 'again') self.reset();
    });

    this.root.addEventListener('keydown', function (e) {
      var t = e.target;
      if (!t.hasAttribute || !t.hasAttribute('data-date')) return;
      var step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!step) return;
      e.preventDefault();
      var d = parseDate(t.getAttribute('data-date'));
      for (var i = 0; i < 62; i++) {
        d.setUTCDate(d.getUTCDate() + (step > 0 ? 1 : -1) * (Math.abs(step) === 7 && i === 0 ? 7 : 1));
        var btn = self.root.querySelector('[data-date="' + isoDate(d) + '"]');
        if (!btn) break;
        if (!btn.disabled) {
          btn.focus();
          break;
        }
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && self.phase === 'select' && self.view) self._loadMonth(true);
    });
    // Zamknięcie strony w trakcie weryfikacji – zwalniamy termin od razu.
    window.addEventListener('pagehide', function () {
      if (self.phase === 'otp' && self.hold && navigator.sendBeacon) {
        navigator.sendBeacon(self.api + '/api/release-hold', JSON.stringify({ bookingId: self.hold.bookingId }));
      }
    });
  };

  /** Zdarzenia formularza – podpinane po każdym wyrenderowaniu szkieletu. */
  Widget.prototype._bindForm = function () {
    var self = this;
    var form = this.$('form');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (self.phase === 'select') self.sendOtp(false);
      else if (self.phase === 'otp') self.verify();
    });

    var phone = form.elements.phone;
    phone.addEventListener('input', function () {
      var v = phone.value;
      if (/^\s*(\+|00)/.test(v)) return; // pełny numer z prefiksem – nie formatujemy w trakcie wpisywania
      var digits = v.replace(/\D/g, '').slice(0, 9);
      var formatted = groupDigits(digits);
      if (formatted !== v) phone.value = formatted;
    });
    ['firstName', 'lastName', 'phone', 'email'].forEach(function (name) {
      form.elements[name].addEventListener('blur', function () {
        if (form.elements[name].value && !self._pressing) self._validateField(name);
      });
      form.elements[name].addEventListener('input', function () {
        self._setError(name, '');
      });
    });
    form.elements.phone.addEventListener('blur', function () {
      var r = normalizePhone(phone.value);
      if (r.ok) phone.value = groupDigits(r.digits);
    });
    form.elements.consent.addEventListener('change', function () {
      self._setError('consent', '');
    });
  };

  Widget.prototype._request = function (path, body) {
    var init = { method: body ? 'POST' : 'GET', credentials: 'omit' };
    if (body) {
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    return fetch(this.api + path, init).then(
      function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (data) {
            if (res.ok) return data;
            var err = (data && data.error) || {};
            throw {
              code: err.code || 'HTTP_' + res.status,
              message: err.message || 'Wystąpił nieoczekiwany błąd. Spróbuj ponownie.',
              fields: err.fields,
              attemptsLeft: err.attemptsLeft,
              retryAfter: err.retryAfter,
            };
          });
      },
      function () {
        throw { code: 'NETWORK', message: 'Brak połączenia z serwerem rezerwacji. Sprawdź internet i spróbuj ponownie.' };
      },
    );
  };

  Widget.prototype._contactSuffix = function () {
    return this.opts.contactPhone ? ' Możesz też zadzwonić: ' + this.opts.contactPhone + '.' : '';
  };

  Widget.prototype._start = function () {
    var self = this;
    this._alert('when', '');
    this.$('cal').setAttribute('aria-busy', 'true');
    return this._request('/api/config')
      .then(function (cfg) {
        self.cfg = cfg;
        var privacy = self.opts.privacyUrl || cfg.privacyPolicyUrl;
        self.$('consentText').innerHTML =
          'Wyrażam zgodę na przetwarzanie moich danych osobowych w celu realizacji rezerwacji' +
          (privacy ? ' zgodnie z <a href="' + esc(privacy) + '" target="_blank" rel="noopener">polityką prywatności</a>' : '') +
          '.';
        if (!self.view) {
          var t = parseDate(cfg.today);
          self.view = { y: t.getUTCFullYear(), m: t.getUTCMonth() };
        }
        if (cfg.turnstileSiteKey) self._setupCaptcha(cfg.turnstileSiteKey);
        self._renderSummary();
        self._renderVerify();
        return self._loadMonth(false);
      })
      .catch(function (err) {
        self.$('cal').setAttribute('aria-busy', 'false');
        self._alert(
          'when',
          'Nie udało się wczytać kalendarza rezerwacji. ' + (err.message || '') + self._contactSuffix() +
            ' <button type="button" class="plb-link" data-action="retry">Spróbuj ponownie</button>',
          'error',
          true,
        );
      });
  };

  // ---------- kalendarz ----------

  Widget.prototype._monthRange = function () {
    var first = new Date(Date.UTC(this.view.y, this.view.m, 1));
    var last = new Date(Date.UTC(this.view.y, this.view.m + 1, 0));
    var from = isoDate(first) < this.cfg.today ? this.cfg.today : isoDate(first);
    var to = isoDate(last) > this.cfg.lastDate ? this.cfg.lastDate : isoDate(last);
    return { first: first, last: last, from: from, to: to, key: isoDate(first).slice(0, 7) };
  };

  Widget.prototype.shiftMonth = function (delta) {
    var d = new Date(Date.UTC(this.view.y, this.view.m + delta, 1));
    this.view = { y: d.getUTCFullYear(), m: d.getUTCMonth() };
    this._loadMonth(false);
  };

  Widget.prototype._loadMonth = function (force) {
    var self = this;
    var r = this._monthRange();
    this._renderCalendar();
    if (r.from > r.to) return Promise.resolve();
    if (this.loadedMonths[r.key] && !force) {
      this._autoSelect(r);
      return Promise.resolve();
    }
    var seq = ++this.seq;
    this.loadingMonth = r.key;
    this.$('cal').setAttribute('aria-busy', 'true');
    this._renderTimes();
    return this._request('/api/slots?from=' + r.from + '&to=' + r.to)
      .then(function (data) {
        data.days.forEach(function (d) {
          self.days[d.date] = d.slots;
        });
        self.loadedMonths[r.key] = true;
        if (seq !== self.seq) return;
        self.loadingMonth = null;
        self.$('cal').setAttribute('aria-busy', 'false');
        // Wybrany wcześniej termin mógł zostać zajęty.
        if (self.slot && self.phase === 'select') {
          var still = (self.days[self.date] || []).some(function (s) {
            return s.start === self.slot.start;
          });
          if (!still && self.date >= r.from && self.date <= r.to) {
            self.slot = null;
            self._alert('when', 'Wybrany termin został w międzyczasie zajęty. Wybierz proszę inny.', 'info');
            self._renderSummary();
          }
        }
        self._renderCalendar();
        self._autoSelect(r);
      })
      .catch(function (err) {
        if (seq !== self.seq) return;
        self.loadingMonth = null;
        self.$('cal').setAttribute('aria-busy', 'false');
        self._renderCalendar();
        self._renderTimes();
        self._alert('when', err.message + self._contactSuffix());
      });
  };

  Widget.prototype._autoSelect = function (r) {
    if (this.date && this.date >= r.from && this.date <= r.to) {
      this._renderTimes();
      return;
    }
    for (var d = parseDate(r.from); isoDate(d) <= r.to; d.setUTCDate(d.getUTCDate() + 1)) {
      var key = isoDate(d);
      if ((this.days[key] || []).length) {
        this.date = key;
        break;
      }
    }
    this._renderCalendar();
    this._renderTimes();
  };

  Widget.prototype._renderCalendar = function () {
    if (!this.cfg || !this.view) return;
    var r = this._monthRange();
    var minMonth = this.cfg.today.slice(0, 7);
    var maxMonth = this.cfg.lastDate.slice(0, 7);
    this.$('month').textContent = MONTH_FMT.format(r.first);
    this.root.querySelector('[data-action="prev"]').disabled = r.key <= minMonth;
    this.root.querySelector('[data-action="next"]').disabled = r.key >= maxMonth;

    var html = DOW.map(function (d) {
      return '<div class="plb-dow" aria-hidden="true">' + d + '</div>';
    }).join('');
    var lead = (r.first.getUTCDay() + 6) % 7;
    for (var i = 0; i < lead; i++) html += '<span class="plb-day plb-day-empty" aria-hidden="true"></span>';
    for (var d = new Date(r.first); d <= r.last; d.setUTCDate(d.getUTCDate() + 1)) {
      var key = isoDate(d);
      var slots = this.days[key] || [];
      var available = slots.length > 0 && key >= this.cfg.today && key <= this.cfg.lastDate;
      var label = longDate(key) + (available ? ', ' + slots.length + ' ' + plural(slots.length, 'wolny termin', 'wolne terminy', 'wolnych terminów') : ', brak wolnych terminów');
      html +=
        '<button type="button" class="plb-day" data-date="' + key + '"' +
        (available ? ' data-available' : ' disabled') +
        (key === this.cfg.today ? ' data-today aria-current="date"' : '') +
        ' aria-pressed="' + (key === this.date) + '" aria-label="' + esc(label) + '">' + d.getUTCDate() + '</button>';
    }
    this.$('grid').innerHTML = html;
  };

  Widget.prototype._renderTimes = function () {
    var el = this.$('times');
    if (!this.cfg) return;
    var r = this.view ? this._monthRange() : null;
    if (r && r.from > r.to) {
      el.innerHTML = '<p class="plb-empty">W tym miesiącu nie ma już terminów do rezerwacji.</p>';
      return;
    }
    if (this.loadingMonth && !(this.date && this.days[this.date])) {
      el.innerHTML = '<p class="plb-empty">Wczytywanie wolnych terminów…</p>';
      return;
    }
    if (!this.date || !r || this.date < r.from || this.date > r.to) {
      var anyFree = false;
      if (r) {
        for (var d = parseDate(r.from); isoDate(d) <= r.to; d.setUTCDate(d.getUTCDate() + 1)) {
          if ((this.days[isoDate(d)] || []).length) anyFree = true;
        }
      }
      el.innerHTML =
        '<p class="plb-empty">' +
        (anyFree || this.loadingMonth ? 'Wybierz dzień w kalendarzu, aby zobaczyć wolne godziny.' : 'Brak wolnych terminów w tym miesiącu – sprawdź kolejny.') +
        '</p>';
      return;
    }
    var slots = this.days[this.date] || [];
    var self = this;
    el.innerHTML =
      '<p class="plb-times-title">' + esc(longDate(this.date)) +
      '<span>' + (slots.length ? 'Wybierz godzinę rozpoczęcia (' + this.cfg.slotDurationMin + ' min)' : '') + '</span></p>' +
      (slots.length
        ? '<div class="plb-slots" role="group" aria-label="Dostępne godziny">' +
          slots
            .map(function (s) {
              var on = self.slot && self.slot.start === s.start;
              return '<button type="button" class="plb-slot" data-slot="' + esc(s.start) + '" aria-pressed="' + !!on + '">' + esc(s.time) + '</button>';
            })
            .join('') +
          '</div>'
        : '<p class="plb-empty">Brak wolnych terminów tego dnia.</p>');
  };

  Widget.prototype.selectDate = function (date) {
    if (this.phase !== 'select') return;
    this.date = date;
    this._alert('when', '');
    this._renderCalendar();
    this._renderTimes();
    var btn = this.root.querySelector('[data-date="' + date + '"]');
    if (btn) btn.focus();
  };

  Widget.prototype.selectSlot = function (start) {
    if (this.phase !== 'select') return;
    var slot = (this.days[this.date] || []).filter(function (s) {
      return s.start === start;
    })[0];
    if (!slot) return;
    this.slot = { start: slot.start, end: slot.end, time: slot.time, date: this.date };
    this._alert('when', '');
    this._alert('verify', '');
    this._renderTimes();
    this._renderSummary();
    this.$('step1').classList.add('plb-step-done');
    var focusBtn = this.root.querySelector('[data-slot="' + start + '"]');
    if (focusBtn) focusBtn.focus();
    // Na wąskich ekranach przewiń do formularza.
    if (this.host.getBoundingClientRect().width < 640) {
      var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.$('summary').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
    }
  };

  Widget.prototype._renderSummary = function () {
    var el = this.$('summary');
    if (!this.slot) {
      el.innerHTML = ICON.clock + '<span class="plb-summary-empty">Najpierw wybierz termin w kalendarzu powyżej.</span>';
      this.$('step1').classList.remove('plb-step-done');
      return;
    }
    el.innerHTML =
      ICON.clock + '<span>Wybrany termin: <strong>' + esc(longDate(this.slot.date)) + '</strong>, godz. <strong>' +
      esc(this.slot.time) + '</strong> (' + this.cfg.slotDurationMin + ' min)</span>';
  };

  // ---------- formularz ----------

  Widget.prototype._setError = function (name, msg) {
    var p = this.root.querySelector('[data-err="' + name + '"]');
    if (p) p.textContent = msg || '';
    var input = this.$('form').elements[name];
    if (input) {
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      if (name !== 'phone' && name !== 'consent') input.setAttribute('aria-describedby', 'plb-' + name + '-err');
    }
  };

  Widget.prototype._validateField = function (name) {
    var f = this.$('form').elements;
    var v = f[name].value.trim().replace(/\s+/g, ' ');
    var msg = '';
    if (name === 'firstName') msg = !v ? 'Podaj imię.' : !NAME_RE.test(v) ? 'Imię zawiera niedozwolone znaki.' : '';
    if (name === 'lastName') msg = !v ? 'Podaj nazwisko.' : !NAME_RE.test(v) ? 'Nazwisko zawiera niedozwolone znaki.' : '';
    if (name === 'phone') {
      var r = normalizePhone(f.phone.value);
      msg = r.ok ? '' : r.error;
    }
    if (name === 'email') msg = v && !EMAIL_RE.test(v) ? 'Podaj poprawny adres e-mail.' : '';
    if (name === 'consent') msg = f.consent.checked ? '' : 'Zgoda jest wymagana do rezerwacji.';
    this._setError(name, msg);
    return !msg;
  };

  Widget.prototype._collect = function () {
    var f = this.$('form').elements;
    var self = this;
    var invalid = ['firstName', 'lastName', 'phone', 'email', 'consent'].filter(function (n) {
      return !self._validateField(n);
    });
    if (!this.slot) {
      this._alert('verify', 'Wybierz termin w kalendarzu, zanim wyślesz kod SMS.');
      this.$('whenCard').scrollIntoView({ block: 'start' });
      return null;
    }
    if (invalid.length) {
      f[invalid[0]].focus();
      return null;
    }
    return {
      slotStart: this.slot.start,
      firstName: f.firstName.value.trim().replace(/\s+/g, ' '),
      lastName: f.lastName.value.trim().replace(/\s+/g, ' '),
      phone: '+48' + normalizePhone(f.phone.value).digits,
      email: f.email.value.trim() || null,
      consent: true,
      website: f.website.value,
    };
  };

  Widget.prototype._lock = function (locked) {
    var f = this.$('form').elements;
    ['firstName', 'lastName', 'phone', 'email'].forEach(function (n) {
      f[n].readOnly = locked;
    });
    f.consent.disabled = locked;
    this.$('whenBody').inert = locked;
    this.$('whenCard').setAttribute('aria-disabled', String(locked));
  };

  Widget.prototype._alert = function (where, html, kind, isHtml) {
    var el = this.$(where === 'when' ? 'whenAlert' : 'verifyAlert');
    if (!el) return;
    el.setAttribute('data-kind', kind || 'error');
    if (isHtml) el.innerHTML = html;
    else el.textContent = html || '';
  };

  Widget.prototype._setBusy = function (btnRef, busy, label) {
    this.busy = busy;
    var btn = this.$(btnRef);
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy ? '<span class="plb-spinner" aria-hidden="true"></span>' + esc(label) : esc(label);
  };

  // ---------- Turnstile (opcjonalny) ----------

  Widget.prototype._setupCaptcha = function (siteKey) {
    var self = this;
    if (this.captchaEl) return;
    // Turnstile renderujemy w light DOM (przez <slot>) – iframe działa wtedy niezależnie od Shadow DOM.
    this.captchaEl = document.createElement('div');
    this.captchaEl.slot = 'captcha';
    this.host.appendChild(this.captchaEl);
    loadScript('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit')
      .then(function () {
        self.captchaId = window.turnstile.render(self.captchaEl, {
          sitekey: siteKey,
          language: 'pl',
          appearance: 'interaction-only',
          callback: function (token) {
            self.captchaToken = token;
            self.captchaWaiters.splice(0).forEach(function (w) {
              w(token);
            });
          },
          'expired-callback': function () {
            self.captchaToken = null;
          },
          'error-callback': function () {
            self.captchaToken = null;
          },
        });
      })
      .catch(function () {
        self._alert('verify', 'Nie udało się wczytać zabezpieczenia antyspamowego. Wyłącz blokowanie skryptów lub odśwież stronę.');
      });
  };

  Widget.prototype._captchaToken = function () {
    var self = this;
    if (!this.cfg.turnstileSiteKey) return Promise.resolve(null);
    if (this.captchaToken) return Promise.resolve(this.captchaToken);
    return new Promise(function (resolve, reject) {
      self.captchaWaiters.push(resolve);
      setTimeout(function () {
        reject({ code: 'CAPTCHA_PENDING', message: 'Trwa weryfikacja antyspamowa – spróbuj ponownie za chwilę.' });
      }, 20000);
    });
  };

  Widget.prototype._resetCaptcha = function () {
    this.captchaToken = null;
    if (window.turnstile && this.captchaId !== undefined) window.turnstile.reset(this.captchaId);
  };

  // ---------- SMS / weryfikacja ----------

  Widget.prototype._renderVerify = function () {
    var el = this.$('verify');
    if (this.phase === 'select') {
      el.innerHTML =
        '<p class="plb-note">Na podany numer wyślemy jednorazowy kod. Do czasu jego wpisania termin będzie zarezerwowany dla Ciebie przez ' +
        (this.cfg ? this.cfg.holdMinutes : 10) + ' minut.</p>' +
        '<button type="submit" class="plb-btn" data-ref="sendBtn">Wyślij kod SMS</button>';
      return;
    }
    var h = this.hold;
    el.innerHTML =
      '<div class="plb-otp-box">' +
      '<p class="plb-otp-info">Wysłaliśmy 6-cyfrowy kod na numer <strong>' + esc(h.phone) + '</strong>. ' +
      'Termin czeka na Ciebie jeszcze <span class="plb-timer" data-ref="lockTimer">' +
      mmss(this._remaining(h.lockExpiresAt)) + '</span>.</p>' +
      '<div class="plb-field"><label class="plb-label" for="plb-code">Kod z SMS-a</label>' +
      '<input class="plb-input plb-otp-input" id="plb-code" name="code" inputmode="numeric" autocomplete="one-time-code" ' +
      'pattern="[0-9]*" maxlength="6" placeholder="••••••" aria-describedby="plb-code-err" required>' +
      '<p class="plb-error" id="plb-code-err" data-err="code"></p></div>' +
      '<button type="button" class="plb-btn" data-ref="confirmBtn" data-action="confirm">Potwierdź rezerwację</button>' +
      '<div class="plb-otp-actions">' +
      '<button type="button" class="plb-link" data-ref="resendBtn" data-action="resend" disabled>Wyślij kod ponownie</button>' +
      '<button type="button" class="plb-link" data-action="change">Zmień dane lub termin</button>' +
      '</div></div>';

    var self = this;
    var code = this.$('form').elements.code;
    code.addEventListener('input', function () {
      var digits = code.value.replace(/\D/g, '').slice(0, 6);
      if (digits !== code.value) code.value = digits;
      self._setError('code', '');
      if (digits.length === 6 && !self.busy) self.verify();
    });
    this._tick();
  };

  Widget.prototype._remaining = function (iso) {
    return Date.parse(iso) - (Date.now() + (this.hold ? this.hold.offset : 0));
  };

  Widget.prototype._tick = function () {
    if (this.phase !== 'otp' || !this.hold) return;
    var left = this._remaining(this.hold.lockExpiresAt);
    var t = this.$('lockTimer');
    if (t) {
      t.textContent = mmss(left);
      if (left < 60000) t.setAttribute('data-warn', '');
    }
    var resend = this.$('resendBtn');
    if (resend && !this.busy) {
      var wait = this._remaining(this.hold.resendAvailableAt);
      resend.disabled = wait > 0;
      resend.textContent = wait > 0 ? 'Wyślij kod ponownie (' + mmss(wait) + ')' : 'Wyślij kod ponownie';
    }
    if (left <= 0) this._holdExpired();
  };

  Widget.prototype._startTimer = function () {
    var self = this;
    this._stopTimer();
    this.timer = setInterval(function () {
      self._tick();
    }, 500);
  };

  Widget.prototype._stopTimer = function () {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  };

  Widget.prototype._startWebOtp = function () {
    var self = this;
    if (!('OTPCredential' in window) || !window.AbortController) return;
    if (this.webOtpAbort) this.webOtpAbort.abort();
    this.webOtpAbort = new AbortController();
    navigator.credentials
      .get({ otp: { transport: ['sms'] }, signal: this.webOtpAbort.signal })
      .then(function (otp) {
        var input = self.$('form').elements.code;
        if (otp && otp.code && input && self.phase === 'otp') {
          input.value = otp.code;
          self.verify();
        }
      })
      .catch(function () {});
  };

  Widget.prototype._stopWebOtp = function () {
    if (this.webOtpAbort) this.webOtpAbort.abort();
    this.webOtpAbort = null;
  };

  Widget.prototype.sendOtp = function (isResend) {
    var self = this;
    if (this.busy) return;
    this._alert('verify', '');
    var payload = isResend ? this.lastPayload : this._collect();
    if (!payload) return;
    var btnRef = isResend ? 'resendBtn' : 'sendBtn';
    this._setBusy(btnRef, true, isResend ? 'Wysyłanie…' : 'Wysyłanie kodu…');

    this._captchaToken()
      .then(function (token) {
        payload.captchaToken = token || undefined;
        return self._request('/api/send-otp', payload);
      })
      .then(function (res) {
        self.lastPayload = payload;
        self.hold = {
          bookingId: res.bookingId,
          phone: res.phone || payload.phone,
          lockExpiresAt: res.lockExpiresAt,
          resendAvailableAt: res.resendAvailableAt,
          offset: res.serverNow ? Date.parse(res.serverNow) - Date.now() : 0,
        };
        self.busy = false;
        if (!isResend) {
          self.phase = 'otp';
          self._lock(true);
          self._renderVerify();
          self._startTimer();
          self.$('form').elements.code.focus();
        } else {
          self._tick();
          self._alert('verify', 'Wysłaliśmy nowy kod. Poprzedni kod jest już nieważny.', 'info');
          var code = self.$('form').elements.code;
          code.value = '';
          code.focus();
        }
        self._startWebOtp();
        self._emit('pilanka:otp-sent', { bookingId: res.bookingId });
      })
      .catch(function (err) {
        self._setBusy(btnRef, false, isResend ? 'Wyślij kod ponownie' : 'Wyślij kod SMS');
        if (isResend) self._tick();
        self._handleSendError(err);
      })
      .then(function () {
        self._resetCaptcha();
      });
  };

  Widget.prototype._handleSendError = function (err) {
    var self = this;
    if (err.code === 'VALIDATION_ERROR' && err.fields) {
      var first = null;
      Object.keys(err.fields).forEach(function (name) {
        if (name === 'slotStart') return self._alert('verify', err.fields[name]);
        self._setError(name, err.fields[name]);
        first = first || name;
      });
      if (first && this.phase === 'select') this.$('form').elements[first].focus();
      return;
    }
    if (err.code === 'SLOT_UNAVAILABLE') {
      this._resetToSelect(err.message);
      return;
    }
    if (err.code === 'HOLD_EXPIRED' || err.code === 'BOOKING_NOT_FOUND') {
      this._resetToSelect(err.message);
      return;
    }
    var msg = err.message;
    if (['SMS_DAILY_LIMIT', 'SMS_SEND_FAILED', 'CALENDAR_UNAVAILABLE', 'NETWORK'].indexOf(err.code) !== -1) {
      msg += this._contactSuffix();
    }
    this._alert('verify', msg);
  };

  Widget.prototype.verify = function () {
    var self = this;
    if (this.busy || this.phase !== 'otp') return;
    var input = this.$('form').elements.code;
    var code = input.value.replace(/\D/g, '');
    if (code.length !== 6) {
      this._setError('code', 'Wpisz 6-cyfrowy kod z SMS-a.');
      input.focus();
      return;
    }
    this._alert('verify', '');
    this._setBusy('confirmBtn', true, 'Potwierdzanie…');
    this._request('/api/verify-otp', { bookingId: this.hold.bookingId, code: code })
      .then(function (res) {
        self.busy = false;
        self._success(res.booking);
      })
      .catch(function (err) {
        self._setBusy('confirmBtn', false, 'Potwierdź rezerwację');
        if (err.code === 'OTP_INVALID') {
          self._setError(
            'code',
            'Nieprawidłowy kod.' + (err.attemptsLeft != null ? ' Pozostało prób: ' + err.attemptsLeft + '.' : ''),
          );
          input.select();
        } else if (err.code === 'OTP_EXPIRED' || err.code === 'OTP_LOCKED') {
          self._setError('code', err.message);
          input.value = '';
        } else if (['HOLD_EXPIRED', 'BOOKING_NOT_FOUND', 'SLOT_UNAVAILABLE'].indexOf(err.code) !== -1) {
          self._resetToSelect(err.message);
        } else {
          self._alert('verify', err.message + (err.code === 'CONFIRM_IN_PROGRESS' ? '' : self._contactSuffix()));
        }
      });
  };

  Widget.prototype._holdExpired = function () {
    this._resetToSelect('Czas na wpisanie kodu minął i termin został zwolniony. Wybierz termin ponownie.');
  };

  /** Powrót do wyboru terminu (dane w formularzu zostają). */
  Widget.prototype._resetToSelect = function (message) {
    this._stopTimer();
    this._stopWebOtp();
    this.phase = 'select';
    this.hold = null;
    this.busy = false;
    this.slot = null;
    this._lock(false);
    this._renderSummary();
    this._renderVerify();
    if (message) {
      this._alert('when', message, 'error');
      this.$('whenCard').scrollIntoView({ block: 'start' });
    }
    this.loadedMonths = {};
    this._loadMonth(true);
  };

  Widget.prototype.changeData = function () {
    var self = this;
    if (this.hold) {
      this._request('/api/release-hold', { bookingId: this.hold.bookingId }).catch(function () {});
    }
    var keep = this.slot;
    this._stopTimer();
    this._stopWebOtp();
    this.phase = 'select';
    this.hold = null;
    this._lock(false);
    this._renderVerify();
    this._alert('verify', '');
    // Zostawiamy wybrany termin, ale odświeżamy dostępność.
    this.slot = keep;
    this._renderSummary();
    this.loadedMonths = {};
    this._loadMonth(true).then(function () {
      self.$('form').elements.phone.focus();
    });
  };

  // ---------- sukces ----------

  Widget.prototype._success = function (booking) {
    this._stopTimer();
    this._stopWebOtp();
    this.phase = 'done';
    this.booking = booking;
    var tz = this.cfg.timezone;
    var timeFmt = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    var dateFmt = new Intl.DateTimeFormat('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
    var start = new Date(booking.start);
    var end = new Date(booking.end);
    this.$('main').innerHTML =
      '<section class="plb-card plb-success" tabindex="-1" data-ref="success" aria-live="polite">' +
      '<div class="plb-success-icon">' + ICON.check + '</div>' +
      '<h3>Zarezerwowano!</h3>' +
      '<p>Dziękujemy' + (booking.firstName ? ', ' + esc(booking.firstName) : '') + '. Twoja rezerwacja została potwierdzona – do zobaczenia na zajęciach!</p>' +
      '<dl class="plb-success-details">' +
      '<div><dt>Termin</dt><dd>' + esc(dateFmt.format(start)) + '</dd></div>' +
      '<div><dt>Godzina</dt><dd>' + esc(timeFmt.format(start)) + '–' + esc(timeFmt.format(end)) + '</dd></div>' +
      (booking.phone ? '<div><dt>Telefon</dt><dd>' + esc(booking.phone) + '</dd></div>' : '') +
      '</dl>' +
      '<div class="plb-success-actions">' +
      '<button type="button" class="plb-btn" data-action="ics">Dodaj do swojego kalendarza</button>' +
      '<button type="button" class="plb-btn plb-btn-secondary" data-action="again">Zarezerwuj kolejny termin</button>' +
      '</div></section>';
    var card = this.$('success');
    card.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'center' });
    this._emit('pilanka:booked', { bookingId: booking.id, start: booking.start, end: booking.end });
  };

  Widget.prototype.downloadIcs = function () {
    var b = this.booking;
    if (!b) return;
    var stamp = function (iso) {
      return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };
    var name = (this.cfg.businessName || 'Pilates').replace(/[,;\\]/g, ' ');
    var ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Pilanka Booking//PL',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:' + b.id + '@pilanka-booking',
      'DTSTAMP:' + stamp(new Date().toISOString()),
      'DTSTART:' + stamp(b.start),
      'DTEND:' + stamp(b.end),
      'SUMMARY:Zajęcia – ' + name,
      'DESCRIPTION:Rezerwacja potwierdzona online.',
      'BEGIN:VALARM',
      'TRIGGER:-PT2H',
      'ACTION:DISPLAY',
      'DESCRIPTION:Zajęcia – ' + name,
      'END:VALARM',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    var url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar;charset=utf-8' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = 'rezerwacja-pilates.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  };

  Widget.prototype.reset = function () {
    var captcha = this.captchaEl;
    this.phase = 'select';
    this.slot = null;
    this.date = null;
    this.hold = null;
    this.booking = null;
    this.loadedMonths = {};
    this.days = {};
    this._renderShell();
    if (captcha) this.host.appendChild(captcha);
    this._bindForm();
    this._start();
  };

  Widget.prototype._emit = function (name, detail) {
    try {
      this.host.dispatchEvent(new CustomEvent(name, { detail: detail, bubbles: true }));
    } catch (e) {
      /* starsze przeglądarki */
    }
  };

  // ---------- inicjalizacja ----------

  function optionsFrom(el) {
    return {
      api: el.getAttribute('data-api') || undefined,
      title: el.getAttribute('data-title') || undefined,
      subtitle: el.getAttribute('data-subtitle') || undefined,
      contactPhone: el.getAttribute('data-contact-phone') || undefined,
      privacyUrl: el.getAttribute('data-privacy-url') || undefined,
    };
  }

  function mount(el, options) {
    if (!el || el.__pilankaBooking) return el && el.__pilankaBooking;
    el.__pilankaBooking = new Widget(el, Object.assign(optionsFrom(el), options || {}));
    return el.__pilankaBooking;
  }

  function init() {
    var els = document.querySelectorAll('[data-pilanka-booking]');
    for (var i = 0; i < els.length; i++) mount(els[i]);
  }

  window.PilankaBooking = { mount: mount, version: '1.0.0' };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
