=== Pilanka – Rezerwacje online ===
Requires at least: 6.3
Tested up to: 6.8
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later

Osadza widget rezerwacji (Google Calendar + weryfikacja SMS) z serwera rezerwacji Pilanka.

== Instalacja ==

1. Spakuj katalog `pilanka-booking` do ZIP (albo użyj gotowego pilanka-booking-wp.zip).
2. Kokpit → Wtyczki → Dodaj nową → Wyślij wtyczkę na serwer → wybierz ZIP → Zainstaluj → Włącz.
3. Ustawienia → Rezerwacje Pilanka → wpisz adres serwera (np. https://rezerwacje.pilankapilatestczew.pl)
   i telefon studia.
4. Na stronie „Rezerwacja” dodaj blok „Shortcode” z treścią: [pilanka_rezerwacja]

Na serwerze rezerwacji domena strony musi być w zmiennej ALLOWED_ORIGINS.

== Shortcode ==

[pilanka_rezerwacja]
[pilanka_rezerwacja title="Umów pierwszy trening" theme="dark" phone="+48 600 000 000"]

== Kolory ==

Widget ma własne style (Shadow DOM), więc motyw strony go nie psuje. Kolory dopasujesz w
Wygląd → Dostosuj → Dodatkowy CSS:

.pilanka-booking { --plb-accent: #1f4f5b; --plb-accent-hover: #163e48; --plb-accent-soft: #e2edf0; }

== Prywatność ==

Wtyczka nie zapisuje danych klientów w WordPressie. Dane rezerwacji trafiają wyłącznie na serwer
rezerwacji (opisz go w polityce prywatności razem z dostawcą SMS i Google Calendar).
