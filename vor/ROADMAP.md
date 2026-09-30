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
3. ✅ **HOTOVO – Lepší plachta** přes celý vor (větší rychlost), **stožár, dalekohled** (přiblížení kamery), **postel**
   (přespat noc), **podpalubí** (bloky pod úrovní paluby).
   *Hotovo:* Velká plachta (roztáhne se přes vor, 3,5 m/s místo 2,2), Stožár s košem (E = vylézt / slézt),
   Dalekohled (podrž levé tl., pravé = 4× / 8×, ukáže název a vzdálenost ostrova nebo lodi), Postel (v noci E = spát do rána),
   Podpalubí: kladivem → Podpalubí pod díl voru, vstup Poklopem; uvnitř sucho, stěny, strop, lucerna, dá se tam
   postavit vybavení (truhly…). Bloky se pod palubu zatím stavět nedají – místo nich je celé podpalubí pod dílem.
   Testy: `tools/scenarios/lookout.mjs`, `tools/scenarios/hold.mjs`.
4. ✅ **HOTOVO – Vylepšení podvozku voru**: úrovně dílů (dřevo → zpevněné → kovové), vor větší než 24×24.
   *Hotovo:* kladivem na zpevněný díl → „Okovat základ“ (4× kov, 1× prkno): 250 HP, žralok ho neukousne, dělo bere
   jen 35 %, bouře 30 %. Vor může mít až 32 × 32 dílů (voda pod palubou i stíny to zvládají). Test: `tools/scenarios/tiers.mjs`.
5. ✅ **HOTOVO – Bouře různé síly**: silná bouře houpe celým vorem, nevylepšené díly praskají, hráč může vypadnout.
   *Hotovo:* Přeháňka / Bouře / Silná bouře (s dny přibývá silných), vlny podle síly, vor se ve vlnách naklání,
   bouře láme hlavně nezpevněné díly (zpevněné berou 60 %, kovové 30 %), v silné bouři chodí velké vlny s varováním –
   kdo stojí u okraje, spadne do moře; zeď nebo zábradlí ho udrží. Test: `tools/scenarios/storms.mjs`.
6. ✅ **HOTOVO – Potápění**: plavání pod hladinu, pěkné dno (korály, ryby, poklady), dech.
   *Hotovo:* ve vodě Q = potopit se, Mezerník = nahoru, pod vodou se plave směrem pohledu. Dech ~30 s (ukazatel v HUD),
   pak se hráč topí. Dno ~10–16 m: písečné duny, korály, mořská tráva, kameny, mušle, barevné rybky a občas truhla
   s pokladem (zlato, kov…). Vor je zespodu strop. Na mobilu tlačítko ⤓. Test: `tools/scenarios/dive.mjs`.
7. ✅ **HOTOVO – Ostrovy**: každý jiný – velikost, tvar, druhy stromů, skály, jeskyně.
   *Hotovo:* malé / střední / velké ostrovy; tvary kulatý, protáhlý, se zátokou, laločnatý a dvojhorka; vedle palem
   listnaté stromy (větve → prkna, listy), borovice (větve) a banánovníky (nová potravina Banán); skalnaté ostrovy
   s borovicemi; jeskyně ve svahu se svítícími krystaly a truhlou s pokladem. Nové ostrovy: Jeskynní ostrov, Borový ostrov,
   Banánová zátoka, Dlouhý ostrov, Dvojhorka, Džunglový ostrov, Laločnatý ostrov. Test: `tools/scenarios/isles.mjs`.
8. ✅ **HOTOVO – Zvířata na voru**: kráva, slepice, ovce, koza, prase (krmení, produkty) a papoušek, kterého jde pojmenovat.
   *Hotovo:* zvířata žijí na některých ostrovech (podle druhu ostrova), chytají se provazem (papoušek na banán nebo kokos),
   z lišty se pustí na palubu a chodí po voru. Nakrmená dávají: kráva a koza mléko, ovce vlnu (→ provaz), prase lanýže,
   slepice vejce (na grilu pečené vejce). Papoušek létá po voru, E = pojmenovat, mluví a varuje před žralokem a piráty.
   Test: `tools/scenarios/animals.mjs`.
9. **Pohled z první osoby u kanónu** (kanón už se otáčí o 360°).
10. **Multiplayer** – vyžaduje server (např. WebSocket/WebRTC), synchronizaci voru a hráčů. Velký projekt.
11. **Steam** – zabalit hru (Electron nebo Tauri), účet Steamworks (poplatek 100 USD za hru),
    stránka obchodu, ikony, testování. Registraci a platbu musí udělat majitel účtu sám.

Už hotové: stavění z bloků (`build.js`), vybavení jde vzít zpět (kladivo → podržet pravé tlačítko
na vybavení = rozebrat a vrátit do inventáře), vor až 24×24, kanón 360°.
