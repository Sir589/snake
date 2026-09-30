# 🌊 Širé moře (3D hra) + 🐍 Had

## Širé moře – `vor/`
3D hra o přežití na voru (ve stylu hry *Raft*). Loviš trosky hákem, craftíš, rozšiřuješ a zpevňuješ vor,
rybaříš, čistíš vodu, bráníš se žralokovi a pirátům a objevuješ ostrovy. Běží v prohlížeči na PC i na mobilu.

- Spuštění: otevři `vor/index.html` v prohlížeči. Hra běží úplně offline (three.js je v `vor/lib/`, písma ve `vor/fonts/`).
- Ovládání PC: WASD pohyb, myš rozhlížení, levé tlačítko = použít (hák: drž a pusť, pak drž = navíjet),
  E = akce, Tab = batoh a crafting, 1–8 = výběr předmětu, Esc = pauza, H = nápověda.
- Stavění jako v Minecraftu: s kladivem v ruce vyber blok (Z / X nebo klepnutím v nabídce) – dřevo, podlaha,
  schody, okna, dveře, střecha, kámen, zábradlí, lucerny a barevné bloky. Levé tlačítko staví, pravé bourá (materiál se vrátí),
  R otáčí. Stavět jde do výšky až 16 bloků, takže i vícepatrové domy.
- Mobil: joystick vlevo, tažení prstem vpravo = rozhlížení, tlačítka pro akce.
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
