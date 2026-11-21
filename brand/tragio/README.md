# Tragio — ikona aplikacji

Runda 1: sześć konceptów ikony (słoń z profilu w ruchu, dwa kartony z taśmą pakową).

| # | Nazwa | Technika |
|---|-------|----------|
| 1 | Plastelina | miękkie 3D clay |
| 2 | Twardy cień | ilustracja z płaskimi, twardymi cieniami |
| 3 | Odbitka | linoryt / szyld retro |
| 4 | Wycinanka z derką | papierowa wycinanka |
| 5 | Naklejka | gruba linia z wypełnieniem |
| 6 | Tragarz | półrealistyczny |

- `runda-1/png/` — ikony 1024×1024 (kwadrat pod maskę iOS)
- `runda-1/svg/` — wektorowe źródła
- `src/` — generatory: `geo.js` (wspólna geometria postaci i kartonów), `c1.js`–`c6.js` (style), `render.js` (render SVG → PNG przez Playwright)

Render: `cd src && node c2.js && node render.js c2.svg` (wynik w `out/`).
