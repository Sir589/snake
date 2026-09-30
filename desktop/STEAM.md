# Širé moře na Steamu – postup krok za krokem

Tenhle návod popisuje, jak dostat hru z téhle složky až do obchodu Steam.
Kroky označené **👤 JEN TY** musíš udělat sám (účet, platby, daně, souhlasy) – nikdo jiný to za tebe udělat nesmí.

---

## 0. Co už je hotové

| Co | Kde |
|---|---|
| Hra běží bez internetu (three.js a písma jsou přibalené) | `vor/lib/`, `vor/fonts/` |
| Windows aplikace (Electron), celá obrazovka, bez menu lišty, F11, tlačítko „Ukončit hru“ | `desktop/main.js`, `vor/js/desktop.js` |
| Spustitelná hra | `desktop/dist/win-unpacked/SireMore.exe` |
| Ikony 256×256 a 512×512 (`.png`) a `.ico` | `desktop/build/` (zdroj `desktop/tools/icon.svg`) |
| Steam knihovna **steamworks.js** – hra běží i bez Steamu | `desktop/steam.js` |
| Testovací App ID 480 (Spacewar) | `desktop/steam_appid.txt` |
| Steam úspěchy (achievementy) za splněné úkoly – připravené | viz kapitola 6 |
| Šablony pro nahrání buildu (SteamPipe) | `desktop/steampipe/` |

### Jak hru sestavit znovu (po změnách ve hře)

Potřebuješ Node.js (je v `C:\Claude\tools\node-v22.14.0-win-x64`). V PowerShellu:

```bash
cd C:\Users\jiril\Documents\SireMore\desktop
```

```bash
npm install
```

```bash
npm run build
```

Výsledek je ve složce `desktop\dist\win-unpacked\` – spouští se `SireMore.exe`.
Na vyzkoušení bez sestavování stačí `npm start`.

### ⚠️ Důležité: Smart App Control a podpis exe

Na tvém PC je zapnutá ochrana Windows **Smart App Control**. Ta blokuje nepodepsané `.exe`, které Microsoft nezná.
Proto se `npm run build` staví tak, že `SireMore.exe` je **nezměněný oficiální Electron** (jen přejmenovaný) – tomu Windows
věří a hra se spustí. Nevýhoda: v Průzkumníku má exe ikonu Electronu (v okně hry a na liště je ikona hry
a na Steamu se ikona nahrává zvlášť, takže hráči to skoro nepoznají).

Na ostré vydání doporučuju **podepsat exe certifikátem** (code signing). Pak můžeš použít
`npm run build:signed`, který do exe vloží i ikonu a údaje o hře. Možnosti:
- **Azure Trusted Signing** (Microsoft, cca 10 USD/měsíc) – nejlevnější, ale ověřují identitu a ne pro každou zemi/typ účtu je dostupný.
- Klasický certifikát (Certum, Sectigo…) – cca 100–400 USD/rok; Certum má levnější „Open Source“ variantu jen pro open-source projekty.

Bez podpisu hra na Steamu funguje taky (mnoho indie her podepsaných není) – jen hráčům se zapnutým Smart App Control
se může stát, že Windows hru zablokuje. Proto nech zatím variantu `npm run build` (nezměněný Electron).

---

## 1. Účet Steamworks 👤 JEN TY

1. Jdi na **https://partner.steamgames.com** a přihlas se svým Steam účtem (nebo si založ nový jen pro vývoj – doporučuju,
   ať máš hraní a firmu oddělené).
2. Klikni na **„Join the Steamworks Partner Program“** / „Zaregistrovat se jako vývojář“.
3. Vyplň:
   - **Právní jméno** (tvoje jméno, nebo firma, pokud máš IČO/firmu) a adresu.
   - Podepiš elektronicky **Steam Distribution Agreement** (smlouva o distribuci).
4. **Ověření identity** – Valve po tobě bude chtít doklad (občanka/pas) a případně ověření přes banku.
   Vyřízení trvá několik dní.

> Pokud ti ještě není 18 let, smlouvu musí uzavřít rodič/zákonný zástupce (na jeho jméno a jeho údaje).

## 2. Zaplacení poplatku (Steam Direct) 👤 JEN TY

- Poplatek je **100 USD za každou hru** (za „App ID“). Platí se kartou/PayPalem v Steamworks.
- Poplatek se ti **vrátí** (připíše k výplatě), jakmile hra vydělá aspoň 1 000 USD.
- Po zaplacení prvního poplatku musí uběhnout **30 dní**, než můžeš hru poprvé vydat.

## 3. Daně a banka 👤 JEN TY

V Steamworks → **Payments / Tax** vyplníš:
1. **Bankovní účet** (IBAN + SWIFT/BIC) – sem ti Valve posílá peníze (jednou měsíčně).
2. **Daňový dotazník (Tax interview)** – jako občan ČR vyplňuješ formulář **W-8BEN** (fyzická osoba) nebo **W-8BEN-E** (firma).
   Díky smlouvě mezi ČR a USA o zamezení dvojího zdanění je srážková daň v USA na hry většinou **0 %** –
   v dotazníku to uvedeš (bude chtít české DIČ / rodné číslo jako daňové ID).
3. Příjmy ze Steamu pak **přiznáváš v Česku** (daňové přiznání). Poraď se s účetní.
- Valve si z každého prodeje bere 30 % (od vyšších tržeb méně).

## 4. Získání App ID

1. Po zaplacení poplatku ti Steamworks vytvoří hru a přidělí jí **App ID** (číslo, např. `3456780`).
   Zároveň vznikne **Depot ID** (obvykle App ID + 1) – to je „krabice“, do které se nahrávají soubory hry.
2. V této složce pak:
   - v `desktop/steam_appid.txt` přepiš `480` na své App ID (to se používá jen při testování mimo Steam),
   - v `desktop/steampipe/app_build.vdf` nahraď `CISLO_APP_ID` a `CISLO_DEPOT_ID`,
   - v `desktop/steampipe/depot_build.vdf` nahraď `CISLO_DEPOT_ID`.
3. Znovu sestav hru: `npm run build`.

> S číslem 480 (Spacewar) se hra hlásí jako testovací hra od Valve – to je normální a slouží jen k vyzkoušení,
> že Steam knihovna funguje. Když je Steam spuštěný, v Steamu se ti na chvíli ukáže, že hraješ „Spacewar“.

## 5. Nastavení hry ve Steamworks

Na stránce své hry v Steamworks (**App Admin**):

1. **Installation → General Installation**
   - *Install Folder*: `SireMore`
   - *Launch Options* → Add new launch option: **Executable** = `SireMore.exe`, **Operating System** = Windows, **CPU** = 64-bit.
2. **Installation → Redistributables**: nic není potřeba (Electron obsahuje vše).
3. **SteamPipe → Depots**: zkontroluj, že existuje depot (Depot ID) pro Windows, jazyk „All languages“.
4. **Stats & Achievements** (volitelné) – viz kapitola 6.
5. Po každé změně nastavení: záložka **Publish** → „Prepare for Publishing“ → „Publish to Steam“.

## 6. Steam úspěchy (achievementy) – volitelné

Hra už sama odemyká úspěch, když splníš úkol. Stačí je ve Steamworks založit
(**Stats & Achievements → Achievements → New Achievement**) s přesně těmito **API Name**:

| API Name | Název (česky) | Popis |
|---|---|---|
| `GOAL_PRKNA` | Lovec trosek | Seber hákem 6 prken |
| `GOAL_KLADIVO` | Tesař | Vyrob kladivo |
| `GOAL_ZAKLADY` | Větší vor | Rozšiř vor o 2 nové základy |
| `GOAL_KELIMEK` | Mořská voda | Vyrob kelímek a naber mořskou vodu |
| `GOAL_CISTICKA` | Pitná voda | Postav čističku a vyčisti vodu |
| `GOAL_RYBA` | Rybář | Vyrob udici a chyť rybu |
| `GOAL_GRIL` | Kuchař | Postav gril a upeč rybu |
| `GOAL_OSTEP` | Na žraloka | Vyrob oštěp |
| `GOAL_PLACHTA` | Plnou parou | Postav plachtu a vytáhni ji |
| `GOAL_OSTROV` | Země na obzoru | Navštiv ostrov |
| `GOAL_KANON` | Dělostřelec | Postav kanón |
| `GOAL_LOD` | Postrach pirátů | Potop pirátskou loď |
| `GOAL_DNY` | Širé moře je tvoje | Přežij 7 dní |

Každý úspěch potřebuje dvě ikony 64×64 px (barevnou a šedou). Pak **Publish**.

## 7. Nahrání buildu přes SteamPipe

1. Ve Steamworks → **SDK** stáhni **Steamworks SDK** (zip) a rozbal ho třeba do `C:\SteamworksSDK`.
2. Zkopíruj soubory z `desktop\steampipe\` (`app_build.vdf`, `depot_build.vdf`) do
   `C:\SteamworksSDK\tools\ContentBuilder\scripts\`.
3. V `app_build.vdf` uprav **ContentRoot** na plnou cestu k hotové hře:
   `"ContentRoot" "C:\Users\jiril\Documents\SireMore\desktop\dist\win-unpacked\"`
4. Spusť (PowerShell):

```bash
cd C:\SteamworksSDK\tools\ContentBuilder\builder
```

```bash
.\steamcmd.exe +login TVUJ_STEAM_LOGIN +run_app_build ..\scripts\app_build.vdf +quit
```

   Poprvé se zeptá na heslo a kód ze Steam Guardu. Nahrávání trvá pár minut (hra má cca 250 MB).
5. Ve Steamworks → **SteamPipe → Builds** uvidíš nový build. U něj zvol větev **default** → „Set build live“ →
   potvrď. (Pro testování můžeš nejdřív založit větev „beta“ s heslem.)
6. Vyzkoušej: ve Steamworks → **Request Steam Product Keys** si vygeneruj pár klíčů (Developer Comp),
   aktivuj jeden ve Steamu, hru nainstaluj a spusť. Zkontroluj overlay (Shift+Tab) a úspěchy.

`steam_appid.txt` se na Steam nenahrává (je vyřazený v `depot_build.vdf`) – Steam App ID předá hře sám.

## 8. Stránka v obchodě

Ve Steamworks → **Store Page Admin**. Stránka musí být zveřejněná jako **„Připravujeme“ (Coming Soon) aspoň 2 týdny**
před vydáním. Valve ji i build před vydáním kontroluje (obvykle 3–5 pracovních dní).

### Obrázky (grafika – vše PNG/JPG, přesné rozměry)
| Obrázek | Rozměr | Poznámka |
|---|---|---|
| Header Capsule | 920 × 430 | hlavní obrázek s logem |
| Small Capsule | 462 × 174 | logo musí být čitelné i malé |
| Main Capsule | 1232 × 706 | na hlavní stránce Steamu |
| Vertical Capsule | 748 × 896 | pro akce/výprodeje |
| Screenshoty | min. 1920 × 1080, aspoň 5 | skutečné záběry ze hry (bez textů přes obraz) |
| Page Background | 1438 × 810 | volitelné pozadí stránky |
| Library Capsule | 600 × 900 | obal v knihovně |
| Library Hero | 3840 × 1240 | široký obrázek nahoře v knihovně, bez loga |
| Library Logo | 1280 × 720 (průhledné PNG) | logo přes hero obrázek |
| Library Header | 920 × 430 | |
| Community Icon | 184 × 184 | použij `desktop/build/icon-256.png` zmenšený |
| Client Icon | `.ico` | `desktop/build/icon.ico` |

Na capsule obrázcích smí být jen obrázek hry a **název** – žádné „Nejlepší hra!“, hodnocení ani slevy.

### Popis
- **Krátký popis** (max. ~300 znaků), **Dlouhý popis** (O hře), **Hlavní rysy**.
- Doporučuju mít stránku česky **i anglicky** (většina hráčů na Steamu čte anglicky). Hra je zatím jen česky –
  v Steamworks u jazyků zaškrtni jen **Čeština** (rozhraní + titulky), ať nikdo není zklamaný.

Návrh krátkého popisu (česky):
> Ztroskotal jsi uprostřed oceánu jen na pár prknech. Loviš trosky hákem, staví vor, rybaříš, čistíš vodu
> a bráníš se žralokovi i pirátům. Kolik dní na širém moři přežiješ?

Návrh (anglicky):
> Stranded in the middle of the ocean on a few planks. Hook floating debris, build your raft, fish, purify water
> and fight off a shark and pirates. How long can you survive the open sea? (Czech language only.)

### Trailer
- Video **MP4 (H.264)**, 1920×1080, 30 nebo 60 fps, ideálně 30–90 s. První 3 sekundy musí zaujmout.
- Natočíš ho třeba programem **OBS Studio** (zdarma) přímo při hraní; stříhat jde v **DaVinci Resolve** (zdarma)
  nebo **Clipchamp** (ve Windows).
- Ukaž: chytání trosek hákem → stavbu voru → žraloka → ostrov → piráty a kanón → název hry na konci.

### Další formuláře
- **Content Survey** (obsah hry – násilí apod.) a **věkové hodnocení** (dotazník IARC je zdarma).
- **Používání AI**: Steam se ptá, jestli hra obsahuje obsah vytvořený AI. Odpověz pravdivě podle aktuálního formuláře.
- **Systémové požadavky** – návrh: Windows 10/11 64-bit, 4 GB RAM, grafika s podporou WebGL 2 / DirectX 11, 500 MB místa.
- **Cena** – Valve doporučí ceny v jiných měnách podle tvé ceny v USD.

## 9. Vydání

1. Stránka je ve stavu „Coming Soon“ aspoň 2 týdny a od zaplacení poplatku uběhlo 30 dní.
2. Stránka i build prošly kontrolou Valve (**Release checklist** v Steamworks je celý zelený).
3. Klikni **Release App** (nebo nastav datum vydání).

---

## Shrnutí: co musíš udělat ty sám 👤

1. Založit účet ve Steamworks, podepsat smlouvu, ověřit identitu (u neplnoletých rodič).
2. Zaplatit 100 USD poplatek.
3. Vyplnit banku a daňový dotazník (W-8BEN), pak daně v ČR.
4. Zapsat App ID do souborů (kapitola 4) – nebo mi ho pošli a udělám to.
5. Nahrát build přes steamcmd (musíš zadat své heslo a Steam Guard kód).
6. Připravit obrázky, trailer a texty obchodu a odeslat je ke kontrole.
7. Rozhodnout o ceně a datu vydání a kliknout na vydání.
8. (Doporučeno) Pořídit certifikát pro podpis exe.
