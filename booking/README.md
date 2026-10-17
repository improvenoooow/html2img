# Pilanka Booking – system rezerwacji z weryfikacją SMS

System rezerwacji zajęć dla **pilankapilatestczew.pl**. Klient wybiera wolny termin, czyli taki,
który nie jest zajęty w Google Calendar studia. Następnie podaje dane i potwierdza numer telefonu
kodem SMS. Po weryfikacji rezerwacja trafia do kalendarza jako
`Rezerwacja: Imię Nazwisko - +48 600 123 456`.

System działa jako osobna usługa (Node.js + PostgreSQL, np. na Railway). Na stronę wkleja się
**jeden fragment kodu**, więc działa niezależnie od technologii strony: WordPress, czysty HTML, kreatory stron.

---

## Spis treści

1. [Jak to działa](#jak-to-działa)
2. [Bezpieczeństwo](#bezpieczeństwo)
3. [Uruchomienie lokalne (bez kluczy)](#uruchomienie-lokalne-bez-kluczy)
4. [Konfiguracja Google Calendar](#konfiguracja-google-calendar-service-account)
5. [Konfiguracja bramki SMS](#konfiguracja-bramki-sms)
6. [Wdrożenie na Railway](#wdrożenie-na-railway)
7. [Osadzenie na stronie](#osadzenie-na-stronie)
8. [Codzienna obsługa przez studio](#codzienna-obsługa-przez-studio)
9. [API](#api)
10. [Testy](#testy)
11. [RODO](#rodo)

---

## Jak to działa

```
 Klient (widget na stronie)               Serwer rezerwacji                      Zewnętrzne
 ─────────────────────────                ──────────────────                     ───────────
 1. Otwiera kalendarz      ── GET /api/slots ──▶  godziny pracy
                                                  − zajętość Free/Busy   ◀────────  Google Calendar
                                                  − blokady w bazie
 2. Wybiera termin, wpisuje dane
    i klika „Wyślij kod SMS”  ── POST /api/send-otp ──▶ walidacja + limity
                                                  SOFT LOCK terminu (10 min)
                                                  kod 6 cyfr (hash, 5 min) ──────▶  SMSAPI / Twilio
 3. Telefon read-only, pole na kod
 4. Wpisuje kod            ── POST /api/verify-otp ─▶ weryfikacja kodu
                                                  ponowne sprawdzenie Free/Busy
                                                  utworzenie wydarzenia ───────────▶  Google Calendar
 5. „Zarezerwowano!”       ◀──────────────────────  status = confirmed

 Brak weryfikacji w 10 min → blokada wygasa, termin wraca do puli.
```

**Stany rezerwacji:** `pending` (soft lock, czeka na kod) → `confirming` (zapis do GCal) → `confirmed`,
albo `expired` (minęło 10 min) / `cancelled` (klient zmienił dane lub termin).

Zasady zajętości:
- Termin jest zajęty, jeśli w Google Calendar w tym czasie jest wydarzenie oznaczone jako **„Zajęty”**
  albo jeśli w bazie jest aktywna rezerwacja: potwierdzona lub z ważnym soft lockiem.
- Przy rezerwacji i potwierdzeniu kalendarz jest zawsze odczytywany na świeżo. Lista terminów korzysta z 30-sekundowego cache.
- Jeśli Google jest niedostępny, system **nie pokazuje terminów** i nie przyjmuje rezerwacji (fail-closed).
  Lepiej chwilowo nie przyjmować rezerwacji, niż przyjąć dwie na ten sam termin.

## Bezpieczeństwo

| Zagrożenie | Zabezpieczenie |
|---|---|
| Wyczerpanie środków SMS („SMS pumping”) | Wysyłka tylko na **polskie numery komórkowe**; max **3 SMS / numer / h**; max **5 SMS / IP / h**; min. **60 s** między SMS-ami na numer; **dzienny limit globalny** (domyślnie 150); limit żądań HTTP na IP; honeypot; opcjonalnie **Cloudflare Turnstile** |
| Zgadywanie kodu | Kod 6 cyfr z CSPRNG, ważny 5 min, max 5 prób na kod, porównanie w stałym czasie, limit prób weryfikacji na IP |
| Wyciek bazy | Kod OTP zapisywany tylko jako HMAC-SHA256; numery i IP w dzienniku limitów tylko jako HMAC (pseudonimizacja) |
| Podwójna rezerwacja (wyścig) | Przydział terminu i limity w jednej transakcji z blokadą `pg_advisory_xact_lock` (przetestowane 5 równoległymi żądaniami) |
| Podwójne wydarzenie w GCal | ID wydarzenia wyliczany z ID rezerwacji, więc ponowienie po błędzie sieci nie tworzy duplikatu |
| Awaria w trakcie zapisu | Zadanie okresowe naprawia rezerwacje zawieszone w stanie `confirming` |
| Nadużycia z obcych stron | CORS tylko dla domen z `ALLOWED_ORIGINS`; nagłówki bezpieczeństwa (Helmet) |
| Konflikt stylów z motywem WP | Widget w Shadow DOM, w pełni odizolowany od CSS strony |

Klucze (Service Account, token SMS) są **wyłącznie na serwerze**. Nigdy nie trafiają do przeglądarki ani na hosting strony.

## Uruchomienie lokalne (bez kluczy)

Tryb deweloperski: kalendarz w pamięci (`GCAL_PROVIDER=mock`), a kody SMS trafiają do logów (`SMS_PROVIDER=console`).

```bash
cd booking
docker compose up --build
# → http://localhost:8080/demo   (kod SMS znajdziesz w logach kontenera "app")
```

Bez Dockera (wymagany PostgreSQL ≥ 13 i Node.js ≥ 20):

```bash
cd booking
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/booking npm run dev
```

## Konfiguracja Google Calendar (Service Account)

1. **Google Cloud Console** → utwórz projekt (np. `pilanka-booking`).
2. **APIs & Services → Library** → włącz **Google Calendar API**.
3. **IAM & Admin → Service Accounts → Create service account** (np. `booking`). Role w projekcie nie są potrzebne.
4. Na koncie usługi: **Keys → Add key → Create new key → JSON**. Pobierze się plik `.json`, czyli klucz.
   Traktuj go jak hasło.
5. **Google Calendar** (konto studia) → kalendarz z grafikiem → ⋮ → **Ustawienia i udostępnianie**:
   - **Udostępnij określonym osobom** → dodaj adres `client_email` z pliku JSON
     (`...@...iam.gserviceaccount.com`) z uprawnieniem **„Wprowadzanie zmian w wydarzeniach”**.
   - Sekcja **Integracja kalendarza** → skopiuj **Identyfikator kalendarza**. To będzie `GOOGLE_CALENDAR_ID`
     (dla głównego kalendarza jest to adres Gmail).
6. Ustaw zmienne i uruchom test połączenia:

```bash
GOOGLE_CALENDAR_ID=... GOOGLE_SERVICE_ACCOUNT_FILE=./klucz.json npm run gcal:check
GOOGLE_CALENDAR_ID=... GOOGLE_SERVICE_ACCOUNT_FILE=./klucz.json npm run gcal:check -- --write   # + test zapisu
```

Skrypt sprawdza kolejno: uwierzytelnienie, dostęp do kalendarza, odczyt Free/Busy i listę wolnych terminów.
Przy problemie podpowiada, co poprawić.

> Na Railway najwygodniej wkleić całą zawartość pliku JSON do zmiennej `GOOGLE_SERVICE_ACCOUNT_JSON`.

## Konfiguracja bramki SMS

### SMSAPI.pl (zalecane w Polsce)
1. Załóż konto na smsapi.pl i doładuj punkty.
2. **Ustawienia API → Tokeny API (OAuth)** → nowy token z uprawnieniem **SMS**. To będzie `SMSAPI_TOKEN`.
3. (Zalecane) **Pola nadawcy** → zgłoś nazwę, np. `Pilanka`, i po zatwierdzeniu ustaw `SMSAPI_SENDER=Pilanka`.
4. Test: `SMS_PROVIDER=smsapi SMSAPI_TOKEN=... npm run sms:check -- +48600123456`.
   Bez kosztów: dodaj `SMSAPI_TEST_MODE=true`.

### Twilio
`SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` oraz `TWILIO_FROM` (numer Twilio)
albo `TWILIO_MESSAGING_SERVICE_SID` (z zarejestrowaną nazwą nadawcy).

Domyślna treść SMS-a nie ma polskich znaków, dzięki czemu mieści się w jednej wiadomości (160 znaków GSM-7):
`482913 - Twoj kod do rezerwacji w Pilanka Pilates Tczew. Wazny 5 min.`
Po ustawieniu `OTP_WEBOTP_DOMAIN=pilankapilatestczew.pl` Chrome na Androidzie sam podpowie kod z SMS-a.
Safari na iPhonie robi to automatycznie.

## Wdrożenie na Railway

1. W projekcie Railway: **New → Database → PostgreSQL**.
2. **New → GitHub Repo** → to repozytorium, a w ustawieniach nowej usługi:
   - **Root Directory:** `booking`
   - **Config file path:** `/booking/railway.json`
3. **Variables** (pełna lista z opisami w [`.env.example`](.env.example)), minimum:
   ```
   NODE_ENV=production
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   OTP_SECRET=<openssl rand -hex 32>
   ALLOWED_ORIGINS=https://pilankapilatestczew.pl,https://www.pilankapilatestczew.pl
   GOOGLE_CALENDAR_ID=...
   GOOGLE_SERVICE_ACCOUNT_JSON=<zawartość pliku .json>
   SMS_PROVIDER=smsapi
   SMSAPI_TOKEN=...
   WORKING_HOURS=mon-fri=08:00-20:00;sat=09:00-14:00
   SLOT_DURATION_MIN=60
   ```
4. **Settings → Networking → Custom Domain:** np. `rezerwacje.pilankapilatestczew.pl` (rekord CNAME u rejestratora).
5. Po wdrożeniu `https://<domena>/health` zwraca `{"status":"ok","db":"ok"}`.
   Migracje bazy uruchamiają się automatycznie przy starcie.

Przy błędnej konfiguracji serwer nie wystartuje i wypisze w logach **pełną listę** brakujących lub błędnych zmiennych.

## Osadzenie na stronie

Wklej w miejscu, gdzie ma się pojawić formularz:

```html
<div data-pilanka-booking data-contact-phone="+48 600 000 000"></div>
<script src="https://rezerwacje.pilankapilatestczew.pl/widget.js" defer></script>
```

- **WordPress (Gutenberg):** blok **„Własny HTML”** → wklej kod powyżej.
- **Elementor:** widżet **HTML**.
- **Czysty HTML:** wklej w treść strony.

Opcje (atrybuty `data-*`):

| Atrybut | Opis |
|---|---|
| `data-title`, `data-subtitle` | Własny nagłówek i opis |
| `data-contact-phone` | Telefon studia pokazywany przy błędach (np. awaria bramki SMS) |
| `data-privacy-url` | Link do polityki prywatności w zgodzie RODO (lub zmienna `PRIVACY_POLICY_URL`) |
| `data-theme` | `light` (domyślnie), `dark`, `auto` |

**Kolory i czcionka.** Widget domyślnie dziedziczy czcionkę strony. Kolory zmienisz w CSS motywu:

```css
[data-pilanka-booking] {
  --plb-accent: #8a6f5a;        /* kolor przycisków i zaznaczeń */
  --plb-accent-hover: #765d4a;
  --plb-accent-soft: #f3ece6;   /* tło dni z wolnymi terminami */
  --plb-radius: 8px;
  --plb-font: "Poppins", sans-serif;
}
```

**Analityka (GA4 / Meta Pixel).** Widget emituje zdarzenia `pilanka:otp-sent` i `pilanka:booked`:

```html
<script>
  document.addEventListener('pilanka:booked', function (e) {
    window.gtag && gtag('event', 'booking_confirmed', { booking_id: e.detail.bookingId });
    window.fbq && fbq('track', 'Schedule');
  });
</script>
```

**Content-Security-Policy.** Jeśli strona ma CSP, dodaj domenę serwera rezerwacji do `script-src`, `style-src`
i `connect-src`. Przy włączonym Turnstile dodaj też `https://challenges.cloudflare.com` do `script-src` i `frame-src`.

## Codzienna obsługa przez studio

- **Blokowanie czasu** (urlop, prywatne sprawy, zajęcia grupowe): dodaj wydarzenie w Google Calendar.
  Musi mieć ustawienie **„Zajęty”**. Uwaga: wydarzenia całodniowe Google domyślnie oznacza jako **„Dostępny”**,
  więc przy blokowaniu całych dni zmień to na „Zajęty”.
- **Odwołanie rezerwacji:** usuń wydarzenie z kalendarza. Termin od razu znów będzie dostępny.
- **Święta / zamknięcie:** wydarzenie „Zajęty” w kalendarzu albo zmienna `CLOSED_DATES`.
- **Zmiana godzin pracy / długości zajęć:** zmienne `WORKING_HOURS`, `SLOT_DURATION_MIN`, `BUFFER_MIN`.
- **Zajęcia grupowe:** `SLOT_CAPACITY=6` (liczba miejsc). Wydarzenia rezerwacji są wtedy „Dostępne”,
  żeby nie blokowały pozostałych miejsc, a zajętość liczy baza.
- **Monitoring:** w logach Railway szukaj `sms_provider_config_error` (zły token lub brak środków) oraz
  `sms_global_daily_limit_reached`.

## API

| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/api/config` | Parametry dla widgetu (strefa, długość zajęć, horyzont, klucz Turnstile) |
| GET | `/api/slots?from=RRRR-MM-DD&to=RRRR-MM-DD` | Wolne terminy (max 62 dni) |
| POST | `/api/send-otp` | `{ slotStart, firstName, lastName, phone, email?, consent: true, captchaToken? }` → soft lock + SMS |
| POST | `/api/verify-otp` | `{ bookingId, code }` → potwierdzenie i wydarzenie w GCal |
| POST | `/api/release-hold` | `{ bookingId }` → natychmiastowe zwolnienie blokady |
| GET | `/health` | Stan usługi i bazy |

Błędy mają format `{ "error": { "code": "SLOT_UNAVAILABLE", "message": "…po polsku…" } }`.
Kody: `VALIDATION_ERROR`, `SLOT_UNAVAILABLE`, `RATE_LIMITED`, `RESEND_COOLDOWN`, `SMS_DAILY_LIMIT`,
`SMS_SEND_FAILED`, `CALENDAR_UNAVAILABLE`, `CAPTCHA_FAILED`, `OTP_INVALID` (+`attemptsLeft`), `OTP_EXPIRED`,
`OTP_LOCKED`, `HOLD_EXPIRED`, `BOOKING_NOT_FOUND`, `CONFIRM_IN_PROGRESS`. Przy 429 serwer wysyła też nagłówek `Retry-After`.

## Testy

```bash
npm test             # jednostkowe + integracyjne (wymaga PostgreSQL: TEST_DATABASE_URL)
npm run test:e2e     # przeglądarka (Playwright + Chromium: npx playwright install chromium)
```

Testy integracyjne działają na prawdziwym PostgreSQL przez HTTP, z kontrolowanym zegarem. Obejmują m.in.
wyścig 5 osób o jeden termin, wygasanie soft locka po 10 min i kodu po 5 min, wszystkie limity SMS,
awarie bramki SMS i Google (odczyt i zapis), idempotencję, honeypot i CORS.
Testy jednostkowe obejmują m.in. zmianę czasu letni/zimowy, podpis JWT Service Account oraz formaty żądań SMSAPI i Twilio.

## RODO

- Formularz wymaga zgody na przetwarzanie danych (z linkiem do polityki prywatności).
- Dane niepotwierdzonych rezerwacji są usuwane po 24 h, a potwierdzonych `BOOKING_RETENTION_DAYS` (90) dni po zajęciach.
  Wpis w Google Calendar zostaje i zarządza nim studio.
- Dziennik limitów SMS przechowuje tylko pseudonimy (HMAC) numerów i IP i jest czyszczony po 48 h.
- Logi serwera maskują numery (`+48 600 *** 456`) i nigdy nie zawierają kodów.
- W polityce prywatności studia warto wymienić odbiorców danych: dostawcę SMS (SMSAPI/Twilio),
  Google (kalendarz) i hosting (Railway).
