# Pilanka Booking – system rezerwacji z weryfikacją SMS

System rezerwacji zajęć dla **pilankapilatestczew.pl**. Klient wybiera wolny termin, czyli taki,
który nie jest zajęty w Google Calendar studia. Następnie podaje dane i potwierdza numer telefonu
kodem SMS. Po weryfikacji rezerwacja trafia do kalendarza jako
`Rezerwacja: Imię Nazwisko - +48 600 123 456`.

System działa jako osobna usługa (Node.js + PostgreSQL w Dockerze, na własnym VPS lub w chmurze). Na stronę wkleja się
**jeden fragment kodu**, więc działa niezależnie od technologii strony: WordPress, czysty HTML, kreatory stron.

---

## Spis treści

1. [Jak to działa](#jak-to-działa)
2. [Bezpieczeństwo](#bezpieczeństwo)
3. [Grupa docelowa: mężczyźni 35+](#grupa-docelowa-mężczyźni-35)
4. [Uruchomienie lokalne (bez kluczy)](#uruchomienie-lokalne-bez-kluczy)
5. [Konfiguracja Google Calendar](#konfiguracja-google-calendar-service-account)
6. [Konfiguracja bramki SMS](#konfiguracja-bramki-sms)
7. [Wdrożenie na własnym VPS](#wdrożenie-na-własnym-vps-zalecane) (alternatywa: [Railway](#alternatywa-railway))
8. [Osadzenie na stronie](#osadzenie-na-stronie)
9. [Codzienna obsługa przez studio](#codzienna-obsługa-przez-studio)
10. [API](#api)
11. [Testy](#testy)
12. [RODO](#rodo)

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
| Podwójna rezerwacja (wyścig) | Przydział terminu i limity w jednej transakcji z blokadą `pg_advisory_xact_lock` (przetestowane 5 równoległymi żądaniami). Baza twardo blokuje potwierdzone terminy, niezależnie od opóźnień Free/Busy w Google |
| Przejęcie cudzej blokady | Zmiana danych/terminu i zwolnienie blokady tylko z losowym tokenem blokady. Znajomość numeru telefonu ani ID rezerwacji nie wystarcza |
| Podwójne wydarzenie w GCal | ID wydarzenia wyliczany z ID rezerwacji, więc ponowienie po błędzie sieci nie tworzy duplikatu |
| Awaria w trakcie zapisu | Zadanie okresowe naprawia rezerwacje zawieszone w stanie `confirming` |
| Nadużycia z obcych stron | CORS tylko dla domen z `ALLOWED_ORIGINS`; nagłówki bezpieczeństwa (Helmet) |
| Konflikt stylów z motywem WP | Widget w Shadow DOM, w pełni odizolowany od CSS strony |

Klucze (Service Account, token SMS) są **wyłącznie na serwerze**. Nigdy nie trafiają do przeglądarki ani na hosting strony.

## Uruchomienie lokalne (bez kluczy)

Tryb deweloperski: kalendarz w pamięci (`GCAL_PROVIDER=mock`), a kody SMS trafiają do logów (`SMS_PROVIDER=console`).

```bash
cd pilanka-booking
docker compose up --build
# → http://localhost:8080/demo   (kod SMS znajdziesz w logach kontenera "app")
```

Bez Dockera (wymagany PostgreSQL ≥ 13 i Node.js ≥ 20):

```bash
cd pilanka-booking
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

> Na serwerze najwygodniej podać klucz jako jedną linię base64: `GOOGLE_SERVICE_ACCOUNT_BASE64=$(base64 -w0 klucz.json)`.

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

## Wdrożenie na własnym VPS (zalecane)

Wymagania: Linux (Ubuntu/Debian), Docker z Compose v2 (`curl -fsSL https://get.docker.com | sh`), rekord DNS
`rezerwacje.pilankapilatestczew.pl` (typ A) wskazujący na IP serwera. Wystarczy 1 vCPU i 1 GB RAM.
Usługa zużywa ok. 160 MB RAM (zmierzone: aplikacja ~90 MB, PostgreSQL ~70 MB).

```bash
sudo mkdir -p /opt/pilanka-booking && sudo chown $USER /opt/pilanka-booking
git clone https://github.com/improvenoooow/pilanka-booking.git /opt/pilanka-booking
cd /opt/pilanka-booking/deploy/vps
cp .env.example .env && nano .env        # hasła: openssl rand -hex 24 / openssl rand -hex 32
```

**Wariant A: na VPS nie działa inna strona** (porty 80/443 wolne). Caddy sam zrobi HTTPS:

```bash
docker compose --profile caddy up -d --build
```

**Wariant B: na VPS działa już nginx albo Apache** (np. strona studia). Aplikacja słucha tylko na `127.0.0.1:8080`,
a ruch przekazuje istniejący serwer WWW:

```bash
docker compose up -d --build
# nginx:  deploy/vps/nginx-rezerwacje.conf  → /etc/nginx/sites-available/ + certbot --nginx
# Apache: deploy/vps/apache-rezerwacje.conf → /etc/apache2/sites-available/ + certbot --apache
```

Sprawdzenie i diagnostyka:

```bash
curl https://rezerwacje.pilankapilatestczew.pl/health       # {"status":"ok","db":"ok"}
docker compose exec app node scripts/gcal-check.js --write  # połączenie z Google Calendar
docker compose exec app node scripts/sms-check.js +48600123456
docker compose logs -f app                                  # logi na żywo
```

Utrzymanie:

| Co | Jak |
|---|---|
| Restart po awarii / restarcie serwera | automatycznie (`restart: unless-stopped`, Docker uruchamia się z systemem) |
| Certyfikat HTTPS | odnawiany automatycznie (Caddy albo certbot) |
| Kopie zapasowe bazy | `deploy/vps/backup.sh`, w cronie codziennie, rotacja 14 dni (instrukcja w pliku) |
| Aktualizacja wersji | `deploy/vps/update.sh` (git pull + przebudowa + restart, dane zostają) |
| Logi | rotowane (5 × 10 MB na kontener) |

Bezpieczeństwo VPS: port aplikacji jest dostępny tylko lokalnie. Z internetu otwarte są wyłącznie 80/443
(np. `ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`). Plik `.env` zawiera sekrety, więc `chmod 600 .env`.
Potwierdzone rezerwacje są też w Google Calendar, więc nawet utrata bazy nie kasuje grafiku.
Zginęłyby tylko trwające w danej chwili blokady i dziennik limitów SMS.

## Alternatywa: Railway

1. W projekcie Railway: **New → Database → PostgreSQL**.
2. **New → GitHub Repo** → repozytorium `pilanka-booking` (Railway sam użyje `railway.json` i `Dockerfile`).
3. **Variables** (pełna lista z opisami w [`.env.example`](.env.example)), minimum:
   ```
   NODE_ENV=production
   TRUST_PROXY=1
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
- **WordPress – wtyczka (zalecane):** `integrations/wordpress/pilanka-booking`. Spakuj katalog do ZIP i wgraj
  w *Wtyczki → Dodaj nową*. Adres serwera i telefon ustawisz w *Ustawienia → Rezerwacje Pilanka*, a formularz wstawisz
  shortcodem `[pilanka_rezerwacja]`. Wtyczka ładuje skrypt tylko na stronie z formularzem i dodaje zdarzenie konwersji
  dla GA4, Meta Pixel i GTM.
- **Czysty HTML:** wklej w treść strony.

Opcje (atrybuty `data-*`):

| Atrybut | Opis |
|---|---|
| `data-title`, `data-subtitle` | Własny nagłówek i opis |
| `data-contact-phone` | Telefon studia pokazywany przy błędach (np. awaria bramki SMS) |
| `data-privacy-url` | Link do polityki prywatności w zgodzie RODO (lub zmienna `PRIVACY_POLICY_URL`) |
| `data-theme` | `light` (domyślnie), `dark`, `auto` |

**Kolory i czcionka.** Domyślny motyw to grafit z ciemnym petrolem (patrz [Grupa docelowa](#grupa-docelowa-mężczyźni-35)).
Widget dziedziczy czcionkę strony. Kolory zmienisz w CSS motywu:

```css
[data-pilanka-booking] {
  --plb-accent: #1f4f5b;        /* kolor przycisków i zaznaczeń */
  --plb-accent-hover: #163e48;
  --plb-accent-soft: #e2edf0;   /* tło dni z wolnymi terminami */
  --plb-radius: 12px;
  --plb-btn-radius: 10px;
  --plb-font: "Inter", sans-serif;
}
```

Zmieniając kolory, zachowaj kontrast tekstu co najmniej 4.5:1 (najlepiej 7:1), np. sprawdzając go na webaim.org/resources/contrastchecker.

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

## Grupa docelowa: mężczyźni 35+

Widget jest domyślnie ustawiony pod główną grupę odbiorców studia.

- **Język:** „trening” zamiast „zajęć”, krótkie i konkretne komunikaty, podtytuł usuwający tarcie
  („Trzy kroki, bez zakładania konta”). Wszystkie formy są **neutralne płciowo**, bez „zarezerwowałeś/aś”,
  więc kobiety też rezerwują bez zgrzytu.
- **Godziny pogrupowane** na *Rano / W ciągu dnia / Po pracy*. Osoba pracująca od razu widzi terminy przed pracą
  i po niej.
- **Czytelność:** bazowa czcionka 17 px, kontrast wszystkich tekstów co najmniej 7:1 (WCAG AAA), przyciski i godziny
  o wysokości min. 48 px. Wzrok po 40. roku życia gorzej radzi sobie z małym, szarym tekstem.
- **Telefon jako alternatywa:** z atrybutem `data-contact-phone` pod formularzem pojawia się
  „Wolisz zarezerwować telefonicznie? Zadzwoń: …” (klikalny link `tel:`).
- **Stylistyka:** grafit i ciemny petrol, mniejsze zaokrąglenia, rzeczowy wygląd zamiast pastelowego „spa”.

Rekomendowany grafik pod osoby pracujące (do decyzji studia):

```
WORKING_HOURS=mon-fri=06:30-09:30,16:00-21:00;sat=08:00-13:00
```

## Codzienna obsługa przez studio

- **Blokowanie czasu** (urlop, prywatne sprawy, zajęcia grupowe): dodaj wydarzenie w Google Calendar.
  Musi mieć ustawienie **„Zajęty”**. Uwaga: wydarzenia całodniowe Google domyślnie oznacza jako **„Dostępny”**,
  więc przy blokowaniu całych dni zmień to na „Zajęty”.
- **Odwołanie rezerwacji:** usuń wydarzenie z kalendarza. Termin (albo miejsce w grupie) wróci do puli w ciągu
  około minuty. **Przesunięcie** wydarzenia w kalendarzu też jest automatycznie przenoszone do systemu.
- **Święta / zamknięcie:** wydarzenie „Zajęty” w kalendarzu albo zmienna `CLOSED_DATES`.
- **Zmiana godzin pracy / długości zajęć:** zmienne `WORKING_HOURS`, `SLOT_DURATION_MIN`, `BUFFER_MIN`.
- **Zajęcia grupowe:** `SLOT_CAPACITY=6` (liczba miejsc). Wydarzenia rezerwacji są wtedy „Dostępne”,
  żeby nie blokowały pozostałych miejsc, a zajętość liczy baza.
- **Alerty na telefon:** zainstaluj aplikację **ntfy** (Android/iOS), zasubskrybuj trudny do zgadnięcia temat,
  np. `pilanka-rezerwacje-7f3k9q`, i ustaw `ALERT_WEBHOOK_URL=https://ntfy.sh/pilanka-rezerwacje-7f3k9q`
  (działa też webhook Discord/Slack). Dostaniesz powiadomienie, gdy: bramka SMS odrzuca wysyłkę (brak punktów,
  zły token), saldo spada poniżej `SMS_LOW_BALANCE_ALERT`, padnie dzienny limit SMS albo Google Calendar nie odpowiada.
- **Monitoring:** w logach (`docker compose logs app`) szukaj `sms_provider_config_error` (zły token lub brak środków) oraz
  `sms_global_daily_limit_reached`.

## API

| Metoda | Ścieżka | Opis |
|---|---|---|
| GET | `/api/config` | Parametry dla widgetu (strefa, długość zajęć, horyzont, klucz Turnstile) |
| GET | `/api/slots?from=RRRR-MM-DD&to=RRRR-MM-DD` | Wolne terminy (max 62 dni). Nagłówek `X-Hold-Token` ukrywa własną blokadę klienta |
| POST | `/api/send-otp` | `{ slotStart, firstName, lastName, phone, email?, consent: true, captchaToken?, holdToken?, resend? }` → soft lock + SMS. Przy nowej blokadzie zwraca `holdToken` |
| POST | `/api/verify-otp` | `{ bookingId, code }` → potwierdzenie i wydarzenie w GCal |
| POST | `/api/release-hold` | `{ holdToken }` → natychmiastowe zwolnienie blokady (np. przy zamknięciu strony) |

**Token blokady (`holdToken`).** To losowy sekret zwracany przy utworzeniu blokady, w bazie przechowywany tylko jako
SHA-256. Jest jedynym dowodem, że kolejne żądanie pochodzi od tego samego klienta. Z tokenem można zmienić termin
lub dane bez nowego SMS-a (`smsSent: false`, jeśli kod jest nadal ważny), wymusić nowy kod (`resend: true`) i
zwolnić blokadę. Samo ID rezerwacji nie daje żadnej kontroli, bo nie jest tajne: trafia do analityki i do opisu
wydarzenia. Jeden numer może mieć najwyżej 2 niepotwierdzone blokady naraz. Potwierdzenie jednej z nich zwalnia
pozostałe blokady tego numeru, więc dwie osoby rezerwujące równocześnie z jednego numeru muszą zrobić to po kolei.

Bez tokenu dane istniejącej rezerwacji nigdy się nie zmieniają. Ponowne wysłanie formularza z tym samym numerem,
terminem i danymi wyśle nowy kod do tej samej rezerwacji. Inne dane (np. poprawka literówki po zamknięciu karty)
zastąpią blokadę nową rezerwacją. Kod SMS jest związany z ID rezerwacji, więc potwierdzone dane to zawsze te,
z którymi wysłano wpisany kod.
| GET | `/health` | Stan usługi i bazy |

Błędy mają format `{ "error": { "code": "SLOT_UNAVAILABLE", "message": "…po polsku…" } }`.
Kody: `VALIDATION_ERROR`, `SLOT_UNAVAILABLE`, `RATE_LIMITED`, `RESEND_COOLDOWN`, `SMS_DAILY_LIMIT`,
`SMS_SEND_FAILED`, `CALENDAR_UNAVAILABLE`, `CAPTCHA_FAILED`, `OTP_INVALID` (+`attemptsLeft`), `OTP_EXPIRED`,
`OTP_LOCKED`, `HOLD_EXPIRED`, `BOOKING_NOT_FOUND`, `CONFIRM_IN_PROGRESS`, `TOO_MANY_HOLDS`. Przy 429 serwer wysyła też nagłówek `Retry-After`.

## Testy

```bash
npm test             # jednostkowe + integracyjne (wymaga PostgreSQL: TEST_DATABASE_URL)
npm run test:e2e     # przeglądarka + audyt dostępności WCAG 2.1 AA (npx playwright install chromium)
npm run test:wp      # wtyczka WordPress (wymaga PHP)
```

W repozytorium jest gotowe CI (`.github/workflows/ci.yml`). Przy każdym pushu uruchamia wszystkie testy na
PostgreSQL, buduje obraz Dockera i sprawdza konfigurację VPS.

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
  Google (kalendarz) i dostawcę serwera (VPS).
