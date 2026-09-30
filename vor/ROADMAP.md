# Širé moře – přání hráče (další vývoj)

Seřazeno od nejlevnějšího po nejdražší. Každý bod je samostatný úkol pro další relaci.

1. ✅ **HOTOVO – Volné umísťování vybavení** (gril, vlajka, síť, truhla…): položit kamkoli – na libovolný blok, na kraj
   i doprostřed dílu, s otáčením po malých krocích; nesmí jít ani napůl do zdi (kolize s bloky z `build.js`).
   *Hotovo:* vybavení stojí kdekoli na palubě i na blocích, otáčí se po 15° (R / Shift+R, držením plynule),
   nesmí do bloků ani do jiného vybavení, samo se přisune ke zdi; když zmizí podlaha, spadne níž nebo do moře.
   Test: `tools/scenarios/placement.mjs`.
2. ✅ **HOTOVO – Jemnější stavění**: vedle 1m bloků i prkna, trámy a sloupy s polovičním/čtvrtinovým krokem mřížky.
   *Hotovo:* v nabídce kladiva jsou Prkénko, Trám, Sloup a Půlblok; mřížka 25 cm, klávesa G přepne na 50 cm, R otáčí.
   Dá se po nich chodit, stavět na ně vybavení, ukládají se. Test: `tools/scenarios/fine.mjs`.
3. **Lepší plachta** přes celý vor (větší rychlost), **stožár, dalekohled** (přiblížení kamery), **postel**
   (přespat noc), **podpalubí** (bloky pod úrovní paluby).
4. **Vylepšení podvozku voru**: úrovně dílů (dřevo → zpevněné → kovové), vor větší než 24×24.
5. **Bouře různé síly**: silná bouře houpe celým vorem, nevylepšené díly praskají, hráč může vypadnout.
6. **Potápění**: plavání pod hladinu, pěkné dno (korály, ryby, poklady), dech.
7. **Ostrovy**: každý jiný – velikost, tvar, druhy stromů, skály, jeskyně.
8. **Zvířata na voru**: kráva, slepice, ovce, koza, prase (krmení, produkty) a papoušek, kterého jde pojmenovat.
9. **Pohled z první osoby u kanónu** (kanón už se otáčí o 360°).
10. **Multiplayer** – vyžaduje server (např. WebSocket/WebRTC), synchronizaci voru a hráčů. Velký projekt.
11. **Steam** – zabalit hru (Electron nebo Tauri), účet Steamworks (poplatek 100 USD za hru),
    stránka obchodu, ikony, testování. Registraci a platbu musí udělat majitel účtu sám.

Už hotové: stavění z bloků (`build.js`), vybavení jde vzít zpět (kladivo → podržet pravé tlačítko
na vybavení = rozebrat a vrátit do inventáře), vor až 24×24, kanón 360°.
