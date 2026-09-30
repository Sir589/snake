# 🌊 Širé moře (3D hra) + 🐍 Had

## Širé moře – `vor/`
3D hra o přežití na voru (ve stylu hry *Raft*). Loviš trosky hákem, craftíš, rozšiřuješ a zpevňuješ vor,
rybaříš, čistíš vodu, bráníš se žralokovi a pirátům a objevuješ ostrovy. Běží v prohlížeči na PC i na mobilu.

- Spuštění: otevři `vor/index.html` v prohlížeči. Hra běží úplně offline (three.js je v `vor/lib/`, písma ve `vor/fonts/`).
- Ovládání PC: WASD pohyb, myš rozhlížení, levé tlačítko = použít (hák: drž a pusť, pak drž = navíjet),
  E = akce, Tab = batoh a crafting, 1–8 = výběr předmětu, Esc = pauza, H = nápověda, Q = potopit se.
- Stavění jako v Minecraftu: s kladivem v ruce vyber blok (Z / X nebo klepnutím v nabídce) – dřevo, podlaha,
  schody, okna, dveře, střecha, kámen, zábradlí, lucerny a barevné bloky. Levé tlačítko staví, pravé bourá (materiál se vrátí),
  R otáčí. Stavět jde do výšky až 16 bloků, takže i vícepatrové domy.
- Jemné stavění: prkénka, trámy, sloupy a půlbloky na mřížce 25 cm (G přepne na 50 cm), R otáčí.
- Potápění: ve vodě Q = dolů, Mezerník = nahoru; na dně jsou korály, rybky a truhly s pokladem. Pozor na dech!
- Bouře mají různou sílu: v silné bouři se vor naklání, láme nezpevněné díly a velké vlny smetou hráče od okraje.
- Díly voru mají tři úrovně: dřevo → zpevněný → okovaný (kladivem); vor může mít až 32 × 32 dílů.
- Velká plachta přes celý vor (rychlejší plavba), stožár s košem na rozhlížení, dalekohled (podrž levé tlačítko),
  postel (v noci se vyspíš do rána) a podpalubí pod vorem (kladivo → Podpalubí, vstup poklopem).
- Vybavení (gril, truhla, síť, vlajka…) jde položit kamkoli na palubu i na bloky, otáčí se po 15° (R, zpět Shift+R).
- Mobil: joystick vlevo, tažení prstem vpravo = rozhlížení, tlačítka pro akce.
- **Verze pro Windows (Steam):** složka `desktop/` (Electron). Hotová hra: `desktop/dist/win-unpacked/SireMore.exe`.
  Sestavení: `cd desktop`, `npm install`, `npm run build`. Postup vydání na Steamu: `desktop/STEAM.md`.
  F11 = celá obrazovka, v menu je tlačítko „Ukončit hru“.
- Návrh a rozhraní modulů: `vor/DESIGN.md`. Testy: `node vor/tools/run-all.mjs` (potřebuje Playwright).

---

## 🐍 Had (Snake) – `index.html`

Klasická hra Had v jednom HTML souboru – stačí otevřít `index.html` v prohlížeči.

## Ovládání
- **Šipky / WASD** – pohyb
- **Mezerník / P** – pauza
- **Mobil** – tlačítka pod hrací plochou nebo swipe prstem po ploše

## Pravidla
- Červené jablko = body podle aktuální úrovně, had se prodlouží.
- Zlaté jablko se občas objeví a po chvíli zmizí – dává 5× víc bodů.
- Každých 5 snědených jablek = další úroveň, had zrychlí.
- Náraz do zdi nebo do sebe = konec hry. Rekord se ukládá v prohlížeči.
