# Širé moře — design & module contract

A browser 3D survival game in the spirit of *Raft*: you drift on a small raft in the open sea,
hook floating debris, craft tools, expand and upgrade the raft, fish, cook, purify water,
fight a shark and pirate raids, and explore passing islands. First-person view.

This file is the **contract** between modules. Every module is written against it. If you need
something another module does not expose, do not reach into its internals — use only the APIs
listed here (or add a clearly documented extra to *your own* module).

---------------------------------------------------------------------------------------------------

## 1. Technical ground rules

- **Plain browser JS, no build step, no ES modules.** Each file is a classic `<script>` loaded by
  `index.html` in this order: `core, items, world, raft, player, debris, fishing, creatures,
  pirates, islands, audio, goals, ui, touch`. Wrap each file in `(function () { 'use strict'; ... })();`.
- **three.js r160 UMD** is loaded as the global `THREE` (from cdnjs). Do not import anything else.
  No external assets: all geometry is procedural (Box/Cylinder/Cone/Sphere/Lathe/Extrude… or
  BufferGeometry), textures are generated with `<canvas>` → `THREE.CanvasTexture`.
  Audio is synthesized with WebAudio. No fetches.
- The game must run both from `file://` (double-clicking `index.html`) and when served over http.
- **Public API objects are created at script load time** (top level of your IIFE, e.g.
  `G.raft = { ... }`), so any module's `init()` may call any other module's API functions.
  Build three.js objects inside `init()` (the renderer/scene/camera exist only from `init()` on).
  In `init()`, only register things / build your own objects. Touch other modules' *state*
  (inventory, raft tiles, player…) only from `reset()`, `load()`, `update()`, `frame()`, event
  handlers and user actions.
- Register with `G.register({ name, order, init, reset, save, load, update, frame })` (see core.js).
  Orders: items 5, world 10, raft 20, islands 25, player 30, debris 40, fishing 45, creatures 50,
  pirates 55, goals 80, audio 85, ui 90, touch 95.
- `reset()` must fully restore a fresh-game state and remove any leftover objects from a previous run
  (new game can start after a death without reloading the page). `load(data)` runs after `reset()`.
  Keep save data small and JSON-only. Tolerate missing / older fields in `load` (use defaults).
- **All player-facing text is Czech with correct diacritics** (ě š č ř ž ý á í é ú ů ň ť ď).
  Code identifiers and comments are English. Tone: short, plain, friendly; the player may be a kid.
- **Performance**: target 60 fps on a mid laptop. No per-frame allocations in hot loops (reuse
  `THREE.Vector3` scratch objects), share geometries/materials, use `InstancedMesh` for repeated
  props, dispose geometries/materials/textures you create when removing objects. Only the raft,
  structures, player-adjacent props, sharks, pirates and the pirate ship cast shadows.
- Style: stylized low-poly, `flatShading: true` on MeshStandardMaterial/MeshLambertMaterial,
  warm natural palette (sun-bleached wood, teal sea, sand, rope, brass, rust). Readable silhouettes.
- No `console.log` spam. Throwing inside `update()` is caught by core but disables nothing — avoid it.
- Keep each module self-contained in its own file. Do not edit other modules' files.

## 2. Space & motion model

- Units are metres and seconds. `+Y` is up. Sea level is `y = 0` (the animated surface is
  `G.world.waveHeight(x, z)`).
- **The raft never moves in the XZ plane**: it stays around the world origin and only bobs in Y
  (`G.raft.group.position.y`). It never rotates. The rest of the world moves relative to it:
  - `G.raft.velocity` (Vector3, y = 0) is the raft's speed over the ground, along `G.world.windDir`.
    Drift 0.35 m/s, sail raised 2.2 m/s, anchored 0.
  - **Ground-fixed things** (islands, the ocean wave pattern) move by `-G.raft.velocity * dt` each frame.
  - **Floating things** (debris, loot, the swimming player) move by `G.world.driftVelocity * dt`,
    which world.js computes as `-windDir * (0.9 + 0.6 * |G.raft.velocity|)`. So debris always
    streams past the raft, faster with the sail up.
  - The shark and the pirate ship steer in raft-relative coordinates directly.
- Raft grid: tile size `G.C.TILE = 2`. Tile `(i, j)` covers `x ∈ [2i, 2i+2]`, `z ∈ [2j, 2j+2]`,
  its centre is `((i + 0.5) * 2, (j + 0.5) * 2)`. A new game starts with the 2×2 tiles
  `i, j ∈ {-1, 0}` (so the raft is centred on the origin). The deck top is at
  `G.raft.deckY()` = `group.position.y + G.C.DECK_Y`.
- `windDir` rotates slowly (at most ±25° from its initial heading over minutes), so passing
  objects travel roughly along `-windDir`. Things spawn upstream at `+windDir * distance`.

## 3. Core (js/core.js — already written, read it)

`G.C` constants, `G.rand/randInt/pick/chance/clamp/lerp/damp/weighted`, `G.events.on/off/emit`,
`G.notify(text, kind)` (kind: `info|good|warn|danger`), `G.sfx(name, {position, volume})`,
`G.stats` counters (days, piratesSunk, piratesDefeated, sharksKilled, fishCaught, tilesBuilt,
itemsCrafted, islandsVisited, debrisCollected — modules increment the ones they own),
`G.settings` (sensitivity, volume, music, invertY, quality) + `G.saveSettings()`,
`G.input` (keys by `KeyboardEvent.code`: `down/pressed/released`, `mouseDown/mousePressed/mouseReleased(b)`,
`mouse.dx/dy/wheel`, `axes()` → `{x, y}` with y = forward, `looking()`, `touchMode`,
virtual input for touch), `G.state` (`boot|menu|playing|dead`), `G.paused`, `G.isPlaying()`,
`G.time` (seconds played), `G.newGame()`, `G.continueGame()`, `G.toMenu()`, `G.gameOver(reason)`,
`G.setPaused(bool)`, `G.uiBlocking()`, `G.setUIBlock(id, on)`, `G.save.write/read/exists/clear`,
registries `G.ground`, `G.interaction`, `G.combat`, `G.tools`, the HUD channel `G.hud`
(`setToolHint(text)`, `setProgress(0..1|null, label)`, `crosshair`), `G.debug`, and
`G.renderer`, `G.scene`, `G.camera` (camera is added to the scene; parent view models to it).

The interaction system (`G.interaction`) picks the thing under the crosshair within range and fires
`onInteract()` when **E** is pressed; ui.js shows `[E] <label>` for `G.interaction.current`.

## 4. Controls

| Action | Keyboard / mouse | Touch (touch.js) |
|---|---|---|
| Move | WASD / arrows | left joystick |
| Look | mouse (pointer lock; free-look fallback) | drag on right half |
| Sprint | Shift | — (joystick fully pushed) |
| Jump / swim up / climb onto raft | Space | ⤒ button |
| Use held item | Left mouse (hold/release where relevant) | ● button (hold) |
| Secondary use | Right mouse | ◐ button |
| Interact | E | E button |
| Hotbar | 1–8, mouse wheel | tap hotbar slot |
| Inventory + crafting | Tab or I (C opens straight to crafting) | 🎒 button |
| Rotate placement | R | — |
| Pause / close panel | Esc (P also pauses) | ❚❚ button |
| Help | H | — |
| Mute | M | — |

## 5. Items (js/items.js owns the table)

`def = { id, name, icon, color, stack, category, desc, tool?, place?, food?, maxDur?, cooked? }`.
`category`: `material | food | water | tool | weapon | placeable | ammo | treasure`.
`tool` names a `G.tools` handler. `place` names a raft structure type (tool handler `place`).
`food = { hunger, thirst, health, returns? }` (tool handler `consume`, owned by player.js).
Icons are emoji; `color` is used as the slot tint / held-model colour.

| id | name | icon | stack | category | extra |
|---|---|---|---|---|---|
| prkno | Prkno | 🪵 | 50 | material | |
| plast | Plast | 🧴 | 50 | material | |
| list | Palmový list | 🌿 | 50 | material | |
| provaz | Provaz | 🪢 | 30 | material | |
| kov | Kovový šrot | 🔩 | 30 | material | |
| kamen | Kámen | 🪨 | 30 | material | |
| zlato | Zlaté mince | 🪙 | 999 | treasure | |
| kokos | Kokos | 🥥 | 10 | food | hunger 12, thirst 18 |
| sardinka | Syrová sardinka | 🐟 | 10 | food | hunger 6, health -2 |
| makrela | Syrová makrela | 🐟 | 10 | food | hunger 9, health -3 |
| tunak | Syrový tuňák | 🐠 | 10 | food | hunger 12, health -4 |
| zralok_maso | Syrové žraločí maso | 🥩 | 10 | food | hunger 10, health -4 |
| sardinka_pecena | Pečená sardinka | 🐟 | 10 | food | cooked, hunger 22 |
| makrela_pecena | Pečená makrela | 🐟 | 10 | food | cooked, hunger 32 |
| tunak_peceny | Pečený tuňák | 🐠 | 10 | food | cooked, hunger 48, health 5 |
| zralok_peceny | Pečené žraločí maso | 🍖 | 10 | food | cooked, hunger 42, health 5 |
| kelimek | Prázdný kelímek | 🥤 | 5 | water | tool `cup` |
| kelimek_slany | Slaná voda | 🌊 | 5 | water | food: thirst -12, health -6, returns kelimek |
| kelimek_sladky | Pitná voda | 💧 | 5 | water | food: thirst 40, returns kelimek |
| hak | Hák | 🪝 | 1 | tool | tool `hook`, maxDur 80 |
| kladivo | Kladivo | 🔨 | 1 | tool | tool `hammer`, maxDur 200 |
| udice | Udice | 🎣 | 1 | tool | tool `rod`, maxDur 30 |
| ostep | Oštěp | 🔱 | 1 | weapon | tool `spear`, maxDur 60 |
| cisticka | Čistička vody | ⚗️ | 5 | placeable | place `purifier` |
| gril | Gril | 🔥 | 5 | placeable | place `grill` |
| truhla | Truhla | 🧰 | 5 | placeable | place `chest` |
| sit | Síť na trosky | 🕸️ | 5 | placeable | place `net` |
| plachta | Plachta | ⛵ | 1 | placeable | place `sail` |
| kotva | Kotva | ⚓ | 1 | placeable | place `anchor` |
| kanon | Kanón | 💥 | 2 | placeable | place `cannon` |
| koule | Dělová koule | ⚫ | 20 | ammo | |

Cooking (grill): sardinka→sardinka_pecena, makrela→makrela_pecena, tunak→tunak_peceny,
zralok_maso→zralok_peceny. Purifying: kelimek_slany→kelimek_sladky.

### Recipes (crafting menu)

| id | makes | needs | category |
|---|---|---|---|
| provaz | 1 provaz | 2 list | Materiály |
| kladivo | kladivo | 3 prkno, 2 plast | Nástroje |
| kelimek | kelimek | 4 plast | Jídlo a voda |
| hak | hak | 2 prkno, 4 plast, 2 provaz | Nástroje |
| udice | udice | 4 prkno, 3 provaz, 1 plast | Nástroje |
| ostep | ostep | 4 prkno, 1 kov, 2 provaz | Zbraně |
| cisticka | cisticka | 6 plast, 4 prkno, 2 list | Jídlo a voda |
| gril | gril | 6 prkno, 4 plast, 1 kov | Jídlo a voda |
| truhla | truhla | 8 prkno, 2 plast | Vor |
| sit | sit | 6 provaz, 4 prkno | Vor |
| plachta | plachta | 8 prkno, 6 provaz, 6 plast | Vor |
| kotva | kotva | 4 kov, 4 provaz, 2 kamen | Vor |
| kanon | kanon | 8 kov, 6 prkno, 2 provaz | Zbraně |
| koule_kov | 3 koule | 2 kov | Zbraně |
| koule_kamen | 3 koule | 1 kov, 2 kamen | Zbraně |

Hammer (built directly, no item): **foundation** 2 prkno + 2 plast; **reinforce** a tile
2 prkno + 1 kov; **repair** a damaged tile 1 prkno (restores to full).

Starting inventory: `hak` ×1 (selected, slot 0), `prkno` ×4, `plast` ×4.

## 6. Module APIs

### items.js — `G.items`, `G.inventory` (order 5)
- `G.items.defs` (id → def), `G.items.def(id)`, `G.items.recipes` (array of
  `{ id, out, count, needs: {id: n}, category }`), `G.items.categories` (ordered Czech names),
  `G.items.cookResult(id)` → id|null, `G.items.purifyResult(id)` → id|null,
  `G.items.name(id)`.
- `G.inventory.slots` — array of 28 (`0..7` = hotbar). Slot = `null | { id, count, dur? }`.
- `G.inventory.selected` (0..7), `getSelected()` → slot|null, `select(i)`.
  Hotbar keys `Digit1..Digit8` and mouse wheel change selection (in `update`, only when
  `G.isPlaying() && !G.uiBlocking()`). Emits `equip:changed`.
- `add(id, count, source?)` → leftover count (0 = everything fit). Emits `item:gained`
  `{id, count, source}` for the part that fit and `inventory:changed`. If something did not fit,
  `G.notify('Inventář je plný', 'warn')`. Tools get `dur = maxDur` when created.
- `remove(id, count)` → bool (all-or-nothing), `count(id)`, `hasAll(needs)`, `canCraft(recipeId)`,
  `craft(recipeId)` → bool (emits `craft` `{recipeId, id, count}`, `G.stats.itemsCrafted++`,
  `G.sfx('craft')`), `consumeSelected(n = 1)`, `damageSelected(n = 1)` (tool breaks at 0 →
  removed, `G.notify('<Name> se rozbil…')`, `G.sfx('break_wood')`), `replaceSelected(id)`.
- Storage for chests/nets: `G.inventory.createStorage(n)` → `{ slots: Array(n) }`,
  `addTo(storage, id, count)` → leftover, `transfer(fromSlots, fromIndex, toSlots, toIndex?)`
  (moves/merges/swaps; toIndex omitted = first fitting slot), `swap(slotsA, i, slotsB, j)`,
  `takeAll(storage)` → moves everything into the player inventory.
- Save: slots + selected.

### world.js — `G.world`, `G.fx` (order 10)
- Ocean: large plane mesh following the camera (snapped to the wave grid to avoid swimming),
  custom `ShaderMaterial` with vertex displacement = the **same** sum-of-waves function as
  `waveHeight`, depth colour, sun glint, foam on crests, fog matching the scene fog.
  The wave pattern scrolls with the ground (accumulated `-G.raft.velocity`).
- Sky dome with gradient + sun disc + stars at night; `DirectionalLight` sun with shadows
  covering about ±18 m around the origin, hemisphere light; `scene.fog`. Day/night cycle:
  `G.C.DAY_LENGTH` seconds per day; new game starts at `dayFraction = 0.30` (morning).
  Nights are dark blue but still playable (never black).
- Weather: occasional storms (from day 2, every few minutes of calm, lasting 60–120 s):
  bigger waves, darker sky, rain particles, occasional lightning flash + `G.sfx('thunder')`.
- API: `G.world.time` (seconds into the current day), `dayFraction` (0..1, 0.5 = noon),
  `day` (starts 1; at midnight increments, sets `G.stats.days`, emits `world:day {day}`),
  `isNight()`, `windDir` (Vector3), `driftVelocity` (Vector3), `storm` (0..1),
  `waveHeight(x, z)`, `waveNormal(x, z, out)`, `sun` (the light), `groundOffset` (Vector2 of
  accumulated ground motion).
- `G.fx` — pooled particle effects usable by everyone: `splash(pos, scale = 1)`,
  `debris(pos, color, count)` (wood chips), `smoke(pos, scale)`, `explosion(pos, scale)`,
  `bubbles(pos)`, `sparkle(pos, color)` (pickup), `blood(pos)` (a few red droplets, not gory).
- Save: time, day, windDir angle, storm state.
- Debug: `G.debug.setTime(f)` (dayFraction), `G.debug.storm(on)`.

### raft.js — `G.raft` (order 20)
- Visuals: each foundation tile is a mini platform of 4–5 plank boards over two floating logs /
  barrels, with rope lashings; reinforced tiles get metal corner plates and a darker frame.
  Damaged tiles show cracks/missing boards (by hp ratio). Tiles share geometries/materials.
- API: `group` (THREE.Group at origin), `deckY()`, `tiles` (Map `"i,j"` → tile),
  tile = `{ i, j, hp, maxHp, reinforced, mesh, structure }`, `tileAt(x, z)` → tile|null,
  `tileCenter(tile, out)` (world, deck top), `count()`, `edgeTiles()`, `randomTile()`,
  `randomEdgeTile()`, `bounds()` → `{minX, maxX, minZ, maxZ}`, `radius()`,
  `damageTile(tile, amount, source)` (source `'shark'|'cannon'|'storm'`; reinforced tiles take
  no shark damage and half cannon damage; emits `tile:damaged`; at 0 hp the tile is destroyed
  with `G.fx.debris`, `G.sfx('break_wood')`, its structure is lost, emits `tile:destroyed`;
  **the last remaining tile never drops below 1 hp**), `addTile(i, j)`, `velocity`, `sailUp`,
  `anchored`.
- Ground provider (`G.ground.add`): deck height over any tile, `kind: 'raft'`.
- Bobbing: `group.position.y` follows the average `waveHeight` at the raft corners (smoothed).
- **Structures**: `registerStructure(type, def)` with
  `def = { name, item, create(s) → Object3D, interact?: { label(s), onInteract(s) },
  update?(s, dt), save?(s), load?(s, data), remove?(s), size? }`.
  A structure instance is `s = { type, tile, object, data, rotation }`; one structure per tile;
  its object sits on the tile centre at deck height inside `group`. Default save = `s.data`.
  `structures` (array), `findStructures(type)`, `placeStructure(type, tile, rotation)`,
  `removeStructure(s, refund)`.
- raft.js implements these structure types:
  - `purifier` (Čistička vody): E with `kelimek_slany` selected (or in inventory) starts 20 s
    purifying (steam effect), E when done returns `kelimek_sladky` (`purify:done`).
  - `grill` (Gril): E with a raw food item selected (or first cookable in inventory) cooks it in
    15 s (flames, smoke, `sizzle`), E when done collects (`cook:done {id}`). Burns if left
    60 s after done? No — keep it forgiving.
  - `chest` (Truhla): 20-slot storage; E → `G.ui.openStorage(s.data.storage, 'Truhla')`.
  - `net` (Síť na trosky): a frame with netting on the tile; every frame it catches debris that
    passes within 2.5 m of its tile (calls `G.debris.collect(d, s.data.storage)`); 10 slots;
    E → take everything (`G.inventory.takeAll`).
  - `sail` (Plachta): mast + cloth; E toggles raised/lowered (animated), `G.raft.sailUp` true
    if any sail is raised; `sail:toggled {up}`.
  - `anchor` (Kotva): E toggles dropped/raised (rope animation), `G.raft.anchored`;
    `anchor:toggled {down}`.
  - (The `cannon` type is registered by pirates.js.)
- Tools: `hammer` (ghost preview: aiming at water next to the raft edge → green/red ghost
  foundation; LMB builds; aiming at a damaged tile → LMB repairs; aiming at an undamaged normal
  tile → LMB reinforces; RMB on a structure → dismantles it and refunds its item; hint text
  shows cost and what is missing) and `place` (ghost of the selected placeable on the aimed
  empty tile, R rotates 90°, LMB places and consumes the item).
- Emits `build:tile`, `build:reinforce`, `build:repair`, `build:structure {type}`,
  `structure:removed`. Increments `G.stats.tilesBuilt`.
- Save: tiles (i, j, hp, reinforced), structures (type, i, j, rotation, data).
- Debug: `G.debug.buildRing()` adds a ring of tiles, `G.debug.damageRaft()`.

### player.js — `G.player` (order 30)
- First-person controller. `position` (feet, world), `velocity`, `yaw`, `pitch`, `health`,
  `hunger`, `thirst` (0..100), `alive`, `inWater`, `onGround`, `groundKind`,
  `eye(out)`, `forward(out)`, `damage(amount, source, dir?)` (screen flash via `player:damaged`),
  `heal(n)`, `eat(id)`, `setControlOverride(o|null)` where `o = { update(dt) }` takes over the
  camera (movement and tools are suspended while an override is active).
- Walk 4.2 m/s, sprint 6.5 m/s, jump 7 m/s, gravity `G.C.GRAVITY`; stands on `G.ground`
  surfaces (step-up 0.45 m); walking off the raft edge drops you into the sea.
  In water: head stays at the surface, swim 2.8 m/s, drift with `driftVelocity * 0.5`,
  **Space near a raft edge (within 0.8 m) climbs back onto the deck**; Space near an island shore
  walks up it. Standing on an island moves you with the island (provider `velocity`).
  Mouse sensitivity from `G.settings`. Subtle head bob; camera sway on the raft.
- Stats: hunger −100 per 9 min, thirst −100 per 6.5 min (×1.5 while sprinting/swimming);
  at 0 you lose 1.5 hp/s; regen 0.6 hp/s when hunger > 50 and thirst > 50. Death →
  `G.gameOver(reason)` with a Czech reason (`'Umřel jsi hlady.'`, `'Umřel jsi žízní.'`,
  `'Sežral tě žralok.'`, `'Porazili tě piráti.'`, `'Zasáhla tě dělová koule.'`).
- Held items: reads `G.inventory.getSelected()`; dispatches to `G.tools.get(def.tool)` —
  or `'place'` for placeables, `'consume'` for foods/drinks. On selection change: `onUnequip`
  on the old handler, `onEquip` on the new one. Mouse edges → `primaryDown/Up`,
  `secondaryDown/Up`; `update(dt, slot)` every frame. No dispatch while UI is blocking or an
  override is active (release held buttons first). Shows a simple first-person held model
  (a tinted box/icon card) for items whose handler has no `viewModel`.
- player.js registers tools: `consume` (LMB eat/drink with a short animation → `eat(id)`,
  emits `player:ate` / `player:drank`, returns cups), `cup` (LMB while aiming at the sea within
  4 m, or while swimming → `kelimek_slany`, `G.sfx('splash')`), `spear` (LMB thrust, 0.6 s
  cooldown, 25 dmg via `G.combat.findInFront(eye, forward, 3.2)`, durability −1 per hit,
  `G.sfx('hit')`/`'whoosh'`).
- Save: position, yaw, pitch, health, hunger, thirst.
- Debug: `G.debug.god()` (no stat drain / damage), `G.debug.teleport(x, z)`.

### debris.js — `G.debris` (order 40)
- Spawns floating debris upstream (`+windDir * 55..70 m`, lateral ±30 m) every 1.1–2.4 s,
  weights prkno 34, plast 34, list 20, sud 12; max 70 alive; removed when 90 m downstream.
  Items bob on `waveHeight` and slowly spin. Meshes: plank, plastic bottle/cluster, palm leaf,
  barrel (sud). Instanced where practical.
- Barrel loot: prkno 2–4, plast 2–4, list 1–3 (always); kov 1–2 (40 %), provaz 1 (30 %),
  sardinka 1 (20 %), kokos 1 (15 %), kelimek 1 (8 %).
- API: `list`, `spawn(type, pos?)`, `spawnItem(id, count, pos)` (floating crate/bundle with any
  items — used for shark meat and pirate loot), `collect(d, storage?)` (into the player inventory
  by default, or into a storage object; emits `debris:collected`, `G.stats.debrisCollected++`,
  `G.sfx('pickup')`, `G.fx.sparkle`).
- Hand pickup: every debris item is an interactable (`[E] Sebrat …`) within 2.2 m (reachable
  while swimming or leaning over the raft edge).
- Tool `hook`: hold LMB to charge (0.2–1 s, HUD progress), release to throw the hook in an arc
  (6–22 m depending on charge) with a visible rope from the raft; it floats; **hold LMB to reel
  in** (5 m/s); any debris within 1.3 m of the hook attaches and is pulled along; when the hook
  reaches the player it is collected automatically. RMB cancels (reels instantly).
  Durability −1 per throw. HUD hints in Czech.
- Debug: `G.debug.debrisRain()` spawns 20 items near the raft.

### fishing.js — `G.fishing` (order 45)
- Tool `rod`: hold LMB to charge, release to cast a bobber (4–16 m). After 4–12 s a bite: bobber
  dips, `G.sfx('fish_bite')`, splash, HUD `Záběr! Klikni!` for 1.2 s. LMB in the window → catch
  (sardinka 55 %, makrela 35 %, tunak 10 %; bonus tuna chance at night), flapping fish
  animation, `fish:caught {id}`, `G.stats.fishCaught++`, durability −1. LMB too early reels
  in empty. RMB cancels. Line rendered as a sagging curve. Bobber drifts with the water.
- Ambient life: small fish schools visible under the surface near the raft (cosmetic).

### creatures.js — `G.shark` (order 50)
- Shark model (grey body, dorsal fin visible above water, tail animation). Appears after 90 s of
  play. States: `circle` (radius 7–10 m around the raft, fin above water), `attackRaft` (every
  45–80 s picks `randomEdgeTile()`, bites it for up to 8 s: `damageTile(tile, 10/s, 'shark')`,
  shaking, splashes, `G.sfx('shark_bite')`, `shark:attack {target:'raft'}`, HUD warning),
  `attackPlayer` (whenever the player is in water: rushes, bites 20 dmg per 2 s),
  `flee` (after being hit: swims away 30 s), `dead` (floats belly-up, drops
  `spawnItem('zralok_maso', 3)`, respawns after 180 s).
- Combat target: 100 hp; spear hit 25 → flee. Reinforced tiles cannot be bitten; if all edge
  tiles are reinforced it only circles.
- Also cosmetic seagulls circling overhead during the day.
- Save: state timer basics (not position). Debug: `G.debug.sharkAttack()`.

### pirates.js — `G.pirates` (order 55)
- Registers structure type `cannon` (Kanón) with raft.js: E sits at the cannon →
  `G.player.setControlOverride` (camera behind the barrel, mouse aims yaw ±70° / pitch,
  LMB fires if the inventory has `koule` (consumes one; 2.5 s reload), E or Esc gets up).
  Cannonball = ballistic projectile, splash on water, `explosion` on hit.
- Pirate raids: first when `G.time > 600` and the raft has ≥ 6 tiles (checked every 30 s),
  then every 480–720 s. `pirates:sighted` + `G.notify('Piráti na obzoru!', 'danger')` +
  `G.sfx('warning')`. A three-masted-ish pirate ship (hull, deck, masts, black sails with a
  skull drawn on a canvas texture, cannons, flag, lanterns at night) sails in from 180 m,
  then circles at ~35–45 m.
  - Every 6–8 s it fires a cannonball at a random tile (35 % miss into the sea); a hit calls
    `G.raft.damageTile(tile, 35, 'cannon')`; within 2 m of the player → `damage(25, 'cannon')`.
  - After 20 s it launches a rowboat with 2–3 boarders who climb onto the raft and chase the
    player (walk on `G.ground`), melee 10 dmg per 1.2 s. Boarders are combat targets (60 hp;
    spear 25 dmg → knock-back). Killing one: `pirate:killed`, `G.stats.piratesDefeated++`,
    drops `zlato` 3–8 directly into the inventory.
  - Ship: combat target with 300 hp, player cannonball 60 dmg. At 0 hp it lists, burns and
    sinks (smoke, explosions), `pirates:sunk`, `G.stats.piratesSunk++`, floats 4–6 loot bundles
    (`kov` 3–6, `koule` 3–5, `zlato` 10–30, `prkno` 5–10, maybe `kelimek_sladky`).
  - If the ship is not sunk it leaves after 150 s of combat (and once the boarders are
    defeated): `pirates:left`.
- API: `active`, `ship`, `nextRaidAt`, `spawnRaid()`.
- Save: `nextRaidAt` (a raid in progress is not saved; it simply ends).
- Debug: `G.debug.pirates()`.

### islands.js — `G.islands` (order 25)
- First island at ~180 s, then every 240–400 s: spawned upstream `+windDir * 220 m` with a
  lateral offset of 28–60 m (never on a collision course with the raft), moves with the ground
  (`-G.raft.velocity`), removed 260 m downstream. With the anchor down it stays put.
- Island = sand disc + grassy hill, 3–7 palm trees (with coconuts), rocks, sometimes a small
  shipwreck (scrap). Shallow turquoise water ring around it. Ground provider (`kind: 'island'`,
  `velocity` = `-G.raft.velocity`). Distance ≥ 25 m radius from the raft at all times.
- Gatherables (interactables): palm tree → 2–3 `list` + 50 % `kokos` (once per tree),
  rock → 1–2 `kamen` (2 uses), wreck → 2–4 `kov` + 1–3 `prkno` (once). First time the player
  stands on an island: `island:visited`, `G.stats.islandsVisited++`, notify.
- `island:near` event and HUD notice when an island comes within 80 m
  (`'Na obzoru je ostrov!'`).
- API: `list`, `spawnIsland(opts)`, `nearest()`. Debug: `G.debug.island()` spawns one nearby.

### audio.js — `G.audio` (order 85)
- WebAudio, created/resumed on the first user gesture. Master volume from
  `G.settings.volume`, M toggles mute. Listens to `sfx` events; positional attenuation and stereo
  pan by distance/direction from the camera when `position` is given.
- Synthesized SFX names (all must exist): `pickup, craft, build, place, break_wood, hammer,
  splash, splash_big, hook_throw, hook_land, reel, shark_bite, hit, hurt, eat, drink, cannon,
  explosion, fish_bite, fish_catch, cast, ui_click, ui_open, ui_close, warning, sail, anchor,
  sizzle, bubble, swim, step, jump, death, thunder, coins, sword, pirate_yell, whoosh, error`.
  Unknown names are ignored.
- Ambience: sea wash (filtered noise with slow swell), wind (louder in storms and with sail up),
  rain during storms, creaking wood now and then, gulls in daytime, a soft low drone at night.
  Optional gentle music (sea-shanty-like motif on a plucked synth, volume `G.settings.music`),
  a tense drum loop while pirates are active.

### goals.js — `G.goals` (order 80)
- A guided chain of objectives (Czech), shown by ui.js in the top-left:
  1. Seber hákem 6 prken (count `prkno` gained with source `debris`/`hook`)
  2. Vyrob kladivo
  3. Rozšiř vor o 2 nové základy
  4. Vyrob kelímek a naber mořskou vodu
  5. Postav čističku a vyčisti vodu
  6. Vyrob udici a chyť rybu
  7. Postav gril a upeč rybu
  8. Vyrob oštěp (proti žralokovi)
  9. Postav plachtu a vytáhni ji
  10. Navštiv ostrov
  11. Postav kanón
  12. Potop pirátskou loď
  13. Přežij 7 dní (final: `Jsi pán širého moře!`)
- API: `list` (`{id, text, hint, done, progress, target}`), `current()`, emits `goal:done`,
  notifies `'Úkol splněn: …'` (kind good). Save: completed ids + counters.

### ui.js — `G.ui` (order 90) + css/ui.css
- DOM overlay inside `#ui` (replace the boot message). HUD: health/hunger/thirst bars with icons
  (bottom-left), 8-slot hotbar (bottom-centre, icon, count, durability bar, key number,
  selected state, clickable/tappable), crosshair + interaction prompt `[E] …` + tool hint +
  progress ring, notifications (top-right stack, fade), current goal card (top-left), day
  counter + time-of-day dial + wind/sail/anchor state (top-centre), damage vignette on
  `player:damaged`, big warning banner for pirates/shark/storm, low-stat pulses.
- Panels (each calls `G.setUIBlock(id, true/false)`): **Inventory + crafting** (Tab/I; C opens
  crafting tab): 28-slot grid, click to pick up / drop / swap, shift-click moves between hotbar
  and backpack (or to/from an open storage), right-click splits a stack, item tooltip (name,
  description, food values, durability); crafting list grouped by category with needs shown
  have/need, disabled state, craft button (Enter/click), eat/drink buttons for food.
  **Storage** (`G.ui.openStorage(storage, title)`): storage grid beside the inventory.
- Screens: **Main menu** (title "Širé moře", animated sea behind it — the 3D scene renders in
  menu state; buttons *Nová hra*, *Pokračovat* (only if a save exists), *Ovládání*,
  *Nastavení*), **Pause** (*Pokračovat*, *Ovládání*, *Nastavení*, *Uložit a do menu*),
  **Game over** (reason, stats: dny, ryby, potopené lodě…, *Hrát znovu*, *Do menu*),
  **Help** (controls table incl. touch), **Settings** (citlivost myši, hlasitost, hudba,
  invertovat osu Y, kvalita). Victory card when the final goal completes (continue playing).
- API: `G.ui.openInventory(tab)`, `G.ui.openStorage(storage, title)`, `G.ui.closeAll()`,
  `G.ui.isOpen()`, `G.ui.banner(text, kind, seconds)`.
- Keys: Tab/I/C toggle inventory, Esc/P pause or close, H help. Visual language: see §8.

### touch.js (order 95)
- Activates when `G.input.touchMode` becomes true (event `input:touchmode`) or on
  `(pointer: coarse)` devices: renders into `#touch` a left virtual joystick (writes
  `G.input.move`), right-half drag look (`G.input.addLook`), buttons for jump (Space),
  use (mouse 0, hold), secondary (mouse 2), interact (KeyE), inventory (Tab), pause (Escape →
  `G.setPaused(true)`). Hidden in menus. Respect safe-area insets.

## 7. Events (names and payloads)

`game:start {fresh}`, `game:paused`, `game:resumed`, `game:menu`, `game:over {reason, stats, time}`,
`boot`, `ui:blocking (bool)`, `settings:changed`, `input:touchmode`, `notify {text, kind}`,
`sfx {name, position?, volume?}`, `error {module, error}`,
`inventory:changed`, `item:gained {id, count, source}`, `equip:changed {index, slot}`,
`craft {recipeId, id, count}`, `build:tile {i, j}`, `build:reinforce {i, j}`, `build:repair {i, j}`,
`build:structure {type, tile}`, `structure:removed {type}`, `tile:damaged {tile, amount, source}`,
`tile:destroyed {i, j, source}`, `player:damaged {amount, source}`, `player:ate {id}`,
`player:drank {id}`, `player:water (bool)`, `fish:caught {id}`, `cook:done {id}`, `purify:done`,
`shark:attack {target}`, `shark:fled`, `shark:killed`, `pirates:sighted`, `pirates:boarding`,
`pirates:sunk`, `pirates:left`, `pirate:killed`, `island:near`, `island:visited`,
`world:day {day}`, `world:storm {active}`, `sail:toggled {up}`, `anchor:toggled {down}`,
`debris:collected {type}`, `goal:done {id}`.

Item gain `source` values: `debris`, `hook`, `net`, `craft`, `fish`, `loot`, `island`, `cook`,
`purify`, `refund`, `pirate`, `start`.

## 8. Visual language of the UI

Dark-first single look over the 3D scene (tokens in index.html `:root`): deep sea teal panels
(`--sea-deep`, `--sea`) with a hint of transparency and blur, foam-white text (`--foam`),
sand (`--sand`) for headings/labels, brass (`--brass`) as the single accent (selected slot,
primary buttons, progress), coral (`--coral`) for danger, rope-like borders (2px dashed/double
`--sand` at low opacity) instead of generic rounded cards. Display face **Pirata One** only for
the title, screen headings and banners; **Alegreya Sans** for everything else;
`font-variant-numeric: tabular-nums` for counts. Keep HUD compact and legible at 400 px width.
Respect `prefers-reduced-motion`. Visible keyboard focus on buttons.

## 9. Testing

`node vor/tools/smoke.mjs [--seconds N] [--scenario path.mjs] [--shot out.png]` serves `vor/`
over http, opens it in headless Chromium (SwiftShader WebGL), starts a new game, runs the
optional scenario (`export default async (page, h) => {...}`; `h.key(code, ms)`,
`h.hold(code)`, `h.release(code)`, `h.mouse(button, ms)`, `h.eval(fn)`, `h.wait(ms)`,
`h.shot(path)`), and prints JSON: page errors, console errors, final state, fps.
Debug hooks (`G.debug.*`) exist so scenarios can jump straight to pirates, storms, islands, etc.
