// items.js — item table, crafting recipes, the player inventory, storage helpers and the hotbar.
// Contract: ../DESIGN.md §5 (items) and §6 "items.js". Registers as module 'items' (order 5).
(function () {
  'use strict';

  const G = window.G;
  const INV_SIZE = 28;   // 0..7 hotbar, 8..27 backpack
  const HOTBAR = 8;

  // ---------------------------------------------------------------------------
  // Item definitions
  // ---------------------------------------------------------------------------
  // def = { id, name, icon, color, stack, category, desc, tool?, place?, food?, maxDur?, cooked?,
  //         g? (grammatical gender m/f/n for messages), cookTo?, purifyTo? }
  const defs = Object.create(null);
  const list = [];

  function D(id, name, icon, stack, category, color, desc, extra) {
    const def = Object.assign({ id, name, icon, color, stack, category, desc }, extra || null);
    if (def.maxDur) def.stack = 1;          // durable items never stack
    defs[id] = def;
    list.push(def);
    return def;
  }
  function food(hunger, thirst, health, returns) {
    const f = { hunger: hunger || 0, thirst: thirst || 0, health: health || 0 };
    if (returns) f.returns = returns;
    return f;
  }

  // Materials & treasure
  D('prkno', 'Prkno', '🪵', 50, 'material', '#b48a58', 'Dřevo z trosek. Základ skoro všeho, co postavíš.');
  D('plast', 'Plast', '🧴', 50, 'material', '#7cc0d8', 'Kus plastu z moře. Hodí se na nástroje i kelímky.');
  D('list', 'Palmový list', '🌿', 50, 'material', '#6fae4a', 'Velký palmový list. Spleteš z něj provaz.');
  D('provaz', 'Provaz', '🪢', 30, 'material', '#cfae72', 'Pevný provaz. Na nástroje, síť i plachtu.');
  D('kov', 'Kovový šrot', '🔩', 30, 'material', '#8d949b', 'Rezavý kovový šrot. Na oštěp, kotvu i kanón.');
  D('kamen', 'Kámen', '🪨', 30, 'material', '#9b9a90', 'Tvrdý kámen z ostrova. Na kotvu a dělové koule.');
  D('zlato', 'Zlaté mince', '🪙', 999, 'treasure', '#e8b923', 'Pirátský poklad. Blyští se a cinká!');

  // Food (raw → grill → cooked)
  D('kokos', 'Kokos', '🥥', 10, 'food', '#7a5230', 'Kokos z palmy. Zasytí a trochu zažene žízeň.',
    { tool: 'consume', food: food(12, 18, 0) });
  D('sardinka', 'Syrová sardinka', '🐟', 10, 'food', '#a9bfcf', 'Malá syrová rybka. Lepší ji upéct na grilu.',
    { tool: 'consume', food: food(6, 0, -2), cookTo: 'sardinka_pecena' });
  D('makrela', 'Syrová makrela', '🐟', 10, 'food', '#5f93ad', 'Syrová makrela. Na grilu z ní bude dobrá večeře.',
    { tool: 'consume', food: food(9, 0, -3), cookTo: 'makrela_pecena' });
  D('tunak', 'Syrový tuňák', '🐠', 10, 'food', '#c8615c', 'Velký syrový tuňák. Upeč ho, ať ti není zle.',
    { tool: 'consume', food: food(12, 0, -4), cookTo: 'tunak_peceny' });
  D('zralok_maso', 'Syrové žraločí maso', '🥩', 10, 'food', '#d9837a', 'Tuhé syrové maso ze žraloka. Patří na gril.',
    { tool: 'consume', food: food(10, 0, -4), cookTo: 'zralok_peceny' });
  D('sardinka_pecena', 'Pečená sardinka', '🐟', 10, 'food', '#c98e4e', 'Křupavá pečená sardinka. Mňam!',
    { tool: 'consume', food: food(22, 0, 0), cooked: true });
  D('makrela_pecena', 'Pečená makrela', '🐟', 10, 'food', '#b8773d', 'Voňavá pečená makrela. Pořádně zasytí.',
    { tool: 'consume', food: food(32, 0, 0), cooked: true });
  D('tunak_peceny', 'Pečený tuňák', '🐠', 10, 'food', '#a8632f', 'Šťavnatý pečený tuňák. Zasytí a přidá zdraví.',
    { tool: 'consume', food: food(48, 0, 5), cooked: true });
  D('zralok_peceny', 'Pečené žraločí maso', '🍖', 10, 'food', '#9a5a36', 'Pečené žraločí maso. Sladká odplata!',
    { tool: 'consume', food: food(42, 0, 5), cooked: true });

  // Water
  D('kelimek', 'Prázdný kelímek', '🥤', 5, 'water', '#ece4cf', 'Prázdný kelímek. Naber do něj mořskou vodu.',
    { tool: 'cup' });
  D('kelimek_slany', 'Slaná voda', '🌊', 5, 'water', '#3a8fb0', 'Slaná mořská voda. Nepij ji! Vyčisti ji v čističce.',
    { tool: 'consume', food: food(0, -12, -6, 'kelimek'), purifyTo: 'kelimek_sladky' });
  D('kelimek_sladky', 'Pitná voda', '💧', 5, 'water', '#86d4f2', 'Čistá pitná voda. Zažene žízeň.',
    { tool: 'consume', food: food(0, 40, 0, 'kelimek') });

  // Tools & weapons (durable)
  D('hak', 'Hák', '🪝', 1, 'tool', '#8c9096', 'Hák na provaze. Hoď ho do moře a přitáhni si trosky.',
    { tool: 'hook', maxDur: 80, g: 'm' });
  D('kladivo', 'Kladivo', '🔨', 1, 'tool', '#8b5a2b', 'Staví a opravuje vor. S ním ho rozšíříš.',
    { tool: 'hammer', maxDur: 200, g: 'n' });
  D('udice', 'Udice', '🎣', 1, 'tool', '#a47a4a', 'Nahoď, počkej na záběr a rychle klikni!',
    { tool: 'rod', maxDur: 30, g: 'f' });
  D('ostep', 'Oštěp', '🔱', 1, 'weapon', '#bdb6a2', 'Ostrý oštěp. Obrana proti žralokovi i pirátům.',
    { tool: 'spear', maxDur: 60, g: 'm' });

  // Placeables (built on a raft tile with the 'place' tool)
  D('cisticka', 'Čistička vody', '⚗️', 5, 'placeable', '#5a9fb5', 'Postav ji na vor. Udělá z mořské vody pitnou.',
    { tool: 'place', place: 'purifier' });
  D('gril', 'Gril', '🔥', 5, 'placeable', '#5a5e64', 'Postav ho na vor a upeč si na něm ryby.',
    { tool: 'place', place: 'grill' });
  D('truhla', 'Truhla', '🧰', 5, 'placeable', '#8b5e34', 'Truhla na vor. Schováš do ní spoustu věcí.',
    { tool: 'place', place: 'chest' });
  D('sit', 'Síť na trosky', '🕸️', 5, 'placeable', '#d8c9a0', 'Postav ji na okraj voru. Sama chytá trosky.',
    { tool: 'place', place: 'net' });
  D('plachta', 'Plachta', '⛵', 1, 'placeable', '#efe6d0', 'Vytáhni ji a vor popluje rychleji.',
    { tool: 'place', place: 'sail' });
  D('kotva', 'Kotva', '⚓', 1, 'placeable', '#4d5359', 'Spusť ji a vor zůstane stát na místě.',
    { tool: 'place', place: 'anchor' });
  D('kanon', 'Kanón', '💥', 2, 'placeable', '#3c3f44', 'Postav ho na vor a střílej na piráty.',
    { tool: 'place', place: 'cannon' });
  D('koule', 'Dělová koule', '⚫', 20, 'ammo', '#2c2c30', 'Náboj do kanónu. Bum!');

  const COOK = Object.create(null), PURIFY = Object.create(null);
  for (const d of list) {
    if (d.cookTo) COOK[d.id] = d.cookTo;
    if (d.purifyTo) PURIFY[d.id] = d.purifyTo;
  }

  // ---------------------------------------------------------------------------
  // Recipes
  // ---------------------------------------------------------------------------
  const CATEGORIES = ['Nástroje', 'Zbraně', 'Jídlo a voda', 'Vor', 'Materiály'];
  function R(id, out, count, needs, category, name) {
    return { id, out, count, needs, category, name: name || defs[out].name };
  }
  const recipes = [
    R('provaz', 'provaz', 1, { list: 2 }, 'Materiály'),
    R('kladivo', 'kladivo', 1, { prkno: 3, plast: 2 }, 'Nástroje'),
    R('kelimek', 'kelimek', 1, { plast: 4 }, 'Jídlo a voda'),
    R('hak', 'hak', 1, { prkno: 2, plast: 4, provaz: 2 }, 'Nástroje'),
    R('udice', 'udice', 1, { prkno: 4, provaz: 3, plast: 1 }, 'Nástroje'),
    R('ostep', 'ostep', 1, { prkno: 4, kov: 1, provaz: 2 }, 'Zbraně'),
    R('cisticka', 'cisticka', 1, { plast: 6, prkno: 4, list: 2 }, 'Jídlo a voda'),
    R('gril', 'gril', 1, { prkno: 6, plast: 4, kov: 1 }, 'Jídlo a voda'),
    R('truhla', 'truhla', 1, { prkno: 8, plast: 2 }, 'Vor'),
    R('sit', 'sit', 1, { provaz: 6, prkno: 4 }, 'Vor'),
    R('plachta', 'plachta', 1, { prkno: 8, provaz: 6, plast: 6 }, 'Vor'),
    R('kotva', 'kotva', 1, { kov: 4, provaz: 4, kamen: 2 }, 'Vor'),
    R('kanon', 'kanon', 1, { kov: 8, prkno: 6, provaz: 2 }, 'Zbraně'),
    R('koule_kov', 'koule', 3, { kov: 2 }, 'Zbraně', 'Dělové koule (z kovu)'),
    R('koule_kamen', 'koule', 3, { kov: 1, kamen: 2 }, 'Zbraně', 'Dělové koule (z kamene)'),
  ];
  const recipeMap = Object.create(null);
  for (const r of recipes) recipeMap[r.id] = r;

  G.items = {
    defs,
    list,                       // defs in table order
    recipes,
    categories: CATEGORIES,     // recipe categories, in crafting-menu order
    // Czech labels for def.category (tooltips)
    kindNames: { material: 'Materiál', food: 'Jídlo', water: 'Voda', tool: 'Nástroj', weapon: 'Zbraň',
      placeable: 'Stavba na vor', ammo: 'Munice', treasure: 'Poklad' },
    def: (id) => defs[id] || null,
    name: (id) => (defs[id] ? defs[id].name : String(id)),
    icon: (id) => (defs[id] ? defs[id].icon : '❔'),
    stackOf: (id) => stackOf(id),
    recipe: (id) => recipeMap[id] || null,
    cookResult: (id) => COOK[id] || null,
    purifyResult: (id) => PURIFY[id] || null,
    // Czech cost text for hints: { prkno: 2, kov: 1 } → '2× Prkno, 1× Kovový šrot'
    needsText(needs) {
      const parts = [];
      for (const k in needs || {}) parts.push(needs[k] + '× ' + G.items.name(k));
      return parts.join(', ');
    },
  };

  // ---------------------------------------------------------------------------
  // Slot-array primitives (work on the inventory and on any storage)
  // ---------------------------------------------------------------------------
  function stackOf(id) {
    const d = defs[id];
    if (!d) return 0;
    return d.maxDur ? 1 : Math.max(1, d.stack | 0);
  }
  function makeSlot(id, count, dur) {
    const s = { id, count };
    const d = defs[id];
    if (d && d.maxDur) s.dur = dur == null ? d.maxDur : dur;
    return s;
  }
  function arr(x) { return Array.isArray(x) ? x : (x && Array.isArray(x.slots) ? x.slots : null); }
  function countIn(a, id) {
    let c = 0;
    for (let i = 0; i < a.length; i++) { const s = a[i]; if (s && s.id === id) c += s.count; }
    return c;
  }
  function roomIn(a, id) {
    const max = stackOf(id);
    if (!max) return 0;
    let r = 0;
    for (let i = 0; i < a.length; i++) {
      const s = a[i];
      if (!s) r += max;
      else if (s.id === id && max > 1) r += Math.max(0, max - s.count);
    }
    return r;
  }
  // Put up to n new items of id into a: merge into existing stacks, then empty slots (index order,
  // so for the inventory that is hotbar first, then backpack). Returns how many were placed.
  function putInto(a, id, n) {
    const max = stackOf(id);
    if (!max || n <= 0) return 0;
    let left = n;
    if (max > 1) {
      for (let i = 0; i < a.length && left > 0; i++) {
        const s = a[i];
        if (!s || s.id !== id || s.count >= max) continue;
        const m = Math.min(max - s.count, left);
        s.count += m; left -= m;
      }
    }
    for (let i = 0; i < a.length && left > 0; i++) {
      if (a[i]) continue;
      const m = Math.min(max, left);
      a[i] = makeSlot(id, m);
      left -= m;
    }
    return n - left;
  }
  // Remove n of id from a. Takes from the end first and from index `lastIdx` (the held slot) last.
  function takeFrom(a, id, n, lastIdx) {
    let left = n;
    for (let i = a.length - 1; i >= 0 && left > 0; i--) {
      if (i === lastIdx) continue;
      const s = a[i];
      if (!s || s.id !== id) continue;
      const m = Math.min(s.count, left);
      s.count -= m; left -= m;
      if (s.count <= 0) a[i] = null;
    }
    if (left > 0 && lastIdx >= 0 && lastIdx < a.length) {
      const s = a[lastIdx];
      if (s && s.id === id) {
        const m = Math.min(s.count, left);
        s.count -= m; left -= m;
        if (s.count <= 0) a[lastIdx] = null;
      }
    }
    return n - left;
  }
  // Merge obj into same-id stacks of a[start..end), then drop the rest of obj itself (keeping dur)
  // into the first empty slot. Slot (skipA, skipI) is ignored (the source). Returns moved count;
  // `placedRef` tells whether obj itself was placed into a.
  let placedRef = false;
  function placeObject(a, obj, start, end, skipA, skipI) {
    placedRef = false;
    const max = stackOf(obj.id);
    if (!max || obj.count <= 0) return 0;
    const before = obj.count;
    if (max > 1) {
      for (let i = start; i < end && obj.count > 0; i++) {
        if (a === skipA && i === skipI) continue;
        const t = a[i];
        if (!t || t === obj || t.id !== obj.id || t.count >= max) continue;
        const m = Math.min(max - t.count, obj.count);
        t.count += m; obj.count -= m;
      }
    }
    if (obj.count > 0) {
      for (let i = start; i < end; i++) {
        if (a[i] || (a === skipA && i === skipI)) continue;
        a[i] = obj;
        placedRef = true;
        return before;
      }
    }
    return before - obj.count;
  }
  // Move the whole stack fa[fi] into ta[start..end) (merge first, then empty slot).
  function moveSlot(fa, fi, ta, start, end) {
    const src = fa[fi];
    if (!src) return 0;
    const moved = placeObject(ta, src, start, end, fa, fi);
    if (placedRef || src.count <= 0) fa[fi] = null;
    return moved;
  }
  function cleanSlot(o) {
    if (!o || typeof o !== 'object') return null;
    const d = defs[o.id];
    if (!d) return null;
    const c = Math.min(stackOf(o.id), Math.floor(Number(o.count) || 0));
    if (c <= 0) return null;
    const s = { id: o.id, count: c };
    if (d.maxDur) {
      const du = Number(o.dur);
      s.dur = Number.isFinite(du) && du > 0 ? Math.min(d.maxDur, du) : d.maxDur;
    }
    return s;
  }

  // ---------------------------------------------------------------------------
  // Player inventory
  // ---------------------------------------------------------------------------
  const slots = new Array(INV_SIZE).fill(null);   // the same array for the whole session
  let lastIdx = -1, lastRef, lastId;              // equip:changed tracking
  let fullNotifyAt = -1e9;
  let wheelCooldown = 0;
  const warnedUnknown = new Set();
  const DIGITS = [], NUMPAD = [];
  for (let k = 1; k <= HOTBAR; k++) { DIGITS.push('Digit' + k); NUMPAD.push('Numpad' + k); }
  const STARTING = [['hak', 1], ['prkno', 4], ['plast', 4]];

  function now() { return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000; }
  function notifyFull() {
    const t = now();
    if (t - fullNotifyAt < 1.5) return;       // one warning per burst (hook + several debris…)
    fullNotifyAt = t;
    G.notify('Inventář je plný', 'warn');
  }
  function unknown(id) {
    if (warnedUnknown.has(id)) return;
    warnedUnknown.add(id);
    console.warn('[items] unknown item id: ' + id);
  }
  function checkEquip(force) {
    let i = inv.selected | 0;
    if (i < 0 || i >= HOTBAR) i = inv.selected = G.clamp(i, 0, HOTBAR - 1);
    const s = slots[i] || null;
    const id = s ? s.id : null;
    if (force || i !== lastIdx || s !== lastRef || id !== lastId) {
      lastIdx = i; lastRef = s; lastId = id;
      G.events.emit('equip:changed', { index: i, slot: s });
    }
  }
  function changed() {
    inv.version++;
    G.events.emit('inventory:changed');
    checkEquip(false);
  }
  function storageChanged(a) {
    if (a !== slots) G.events.emit('storage:changed', { slots: a });
  }
  // After a UI-driven move between arrays (transfer / swap / split).
  function afterMove(a, b) {
    storageChanged(a);
    if (b !== a) storageChanged(b);
    changed();
  }
  function breakText(d) {
    const g = d.g || 'm';
    return d.name + (g === 'f' ? ' se rozbila…' : g === 'n' ? ' se rozbilo…' : ' se rozbil…');
  }
  // Put an item that did not fit back into the world (floating bundle next to the player).
  function spill(id, n) {
    try {
      if (G.debris && G.debris.spawnItem && G.player && G.player.position) {
        const p = G.player.position.clone();
        if (G.player.forward) {
          const f = G.player.forward(new THREE.Vector3());
          p.x += f.x * 1.2; p.z += f.z * 1.2;
        }
        p.y = 0;
        G.debris.spawnItem(id, n, p);
      }
    } catch (e) { /* the item is lost; not worth crashing over */ }
  }

  function add(id, count, source) {
    count = Math.floor(Number(count == null ? 1 : count) || 0);
    if (!defs[id]) { unknown(id); return Math.max(0, count); }
    if (count <= 0) return 0;
    const placed = putInto(slots, id, count);
    const left = count - placed;
    if (placed > 0) {
      changed();
      G.events.emit('item:gained', { id, count: placed, source: source || 'loot' });
    }
    if (left > 0) notifyFull();
    return left;
  }

  function remove(id, count) {
    count = Math.floor(Number(count == null ? 1 : count) || 0);
    if (count <= 0) return true;
    if (countIn(slots, id) < count) return false;
    takeFrom(slots, id, count, inv.selected);
    changed();
    return true;
  }

  function hasAll(needs) {
    if (!needs) return true;
    for (const k in needs) if (countIn(slots, k) < needs[k]) return false;
    return true;
  }

  // All-or-nothing removal of a whole cost map, e.g. { prkno: 2, plast: 2 }.
  function removeAll(needs) {
    if (!needs) return true;
    if (!hasAll(needs)) return false;
    let any = false;
    for (const k in needs) {
      const n = Math.floor(Number(needs[k]) || 0);
      if (n > 0) { takeFrom(slots, k, n, inv.selected); any = true; }
    }
    if (any) changed();
    return true;
  }

  // What is missing from a cost map: [{ id, name, need, have }] (empty = affordable).
  function missing(needs) {
    const out = [];
    if (!needs) return out;
    for (const k in needs) {
      const have = countIn(slots, k);
      if (have < needs[k]) out.push({ id: k, name: G.items.name(k), need: needs[k], have });
    }
    return out;
  }

  function canCraft(recipeId) {
    const r = recipeMap[recipeId];
    return !!r && hasAll(r.needs);
  }

  function craft(recipeId) {
    const r = recipeMap[recipeId];
    if (!r) return false;
    if (!hasAll(r.needs)) {
      G.notify('Chybí ti suroviny.', 'warn');
      G.sfx('error');
      return false;
    }
    // Is there room for the output once the ingredients are gone? Simulate on a copy.
    const sim = new Array(INV_SIZE);
    for (let i = 0; i < INV_SIZE; i++) { const s = slots[i]; sim[i] = s ? { id: s.id, count: s.count } : null; }
    for (const k in r.needs) takeFrom(sim, k, r.needs[k], inv.selected);
    if (roomIn(sim, r.out) < r.count) {
      G.notify('Nemáš místo v inventáři.', 'warn');
      G.sfx('error');
      return false;
    }
    for (const k in r.needs) takeFrom(slots, k, r.needs[k], inv.selected);
    const placed = putInto(slots, r.out, r.count);
    G.stats.itemsCrafted = (G.stats.itemsCrafted || 0) + 1;
    changed();
    G.events.emit('item:gained', { id: r.out, count: placed, source: 'craft' });
    G.events.emit('craft', { recipeId: r.id, id: r.out, count: r.count });
    G.sfx('craft');
    return true;
  }

  function consumeSelected(n) {
    n = Math.floor(Number(n == null ? 1 : n) || 0);
    const s = slots[inv.selected];
    if (!s || n <= 0 || s.count < n) return false;
    s.count -= n;
    if (s.count <= 0) slots[inv.selected] = null;
    changed();
    return true;
  }

  // Wear the held durable item. Returns true when it broke (and was removed).
  function damageSelected(n) {
    n = Number(n == null ? 1 : n) || 0;
    const i = inv.selected;
    const s = slots[i];
    if (!s || s.dur == null || n <= 0) return false;
    const d = defs[s.id];
    const before = s.dur;
    s.dur = Math.max(0, s.dur - n);
    if (s.dur <= 0) {
      slots[i] = null;
      G.notify(d ? breakText(d) : 'Něco se rozbilo…', 'warn');
      G.sfx('break_wood');
      changed();
      G.events.emit('item:broken', { id: s.id, index: i });
      return true;
    }
    if (d && d.maxDur) {
      const warnAt = Math.ceil(d.maxDur * 0.15);
      if (before > warnAt && s.dur <= warnAt) G.notify(d.name + ' se brzy rozbije.', 'info');
    }
    changed();
    return false;
  }

  // Turn one unit of the held stack into one `id` (cup → sea water, water → empty cup…).
  // A single item is swapped in place; from a bigger stack the new item goes into the inventory
  // (or floats next to the player if there is no room). Returns true if it ended in the inventory.
  function replaceSelected(id, source) {
    if (!defs[id]) { unknown(id); return false; }
    const i = inv.selected;
    const s = slots[i];
    const src = source || 'replace';
    if (!s || s.count <= 1) {
      slots[i] = makeSlot(id, 1);
      changed();
      G.events.emit('item:gained', { id, count: 1, source: src });
      return true;
    }
    s.count -= 1;
    const placed = putInto(slots, id, 1);
    changed();
    if (placed) {
      G.events.emit('item:gained', { id, count: 1, source: src });
      return true;
    }
    notifyFull();
    spill(id, 1);
    return false;
  }

  function select(i, silent) {
    i = G.clamp(Math.floor(Number(i) || 0), 0, HOTBAR - 1);
    if (i === inv.selected && i === lastIdx) return;
    inv.selected = i;
    if (!silent) G.sfx('ui_click', { volume: 0.35 });
    checkEquip(true);
  }

  // ---------------------------------------------------------------------------
  // Storage (chests, nets) and moving stacks around
  // ---------------------------------------------------------------------------
  function createStorage(n) {
    return { slots: new Array(Math.max(0, Math.floor(n) || 0)).fill(null) };
  }

  function addTo(storage, id, count) {
    const a = arr(storage);
    count = Math.floor(Number(count == null ? 1 : count) || 0);
    if (!a) return Math.max(0, count);
    if (a === slots) return add(id, count, 'loot');
    if (!defs[id]) { unknown(id); return Math.max(0, count); }
    if (count <= 0) return 0;
    const placed = putInto(a, id, count);
    if (placed) storageChanged(a);
    return count - placed;
  }

  // Move a stack (or `count` of it) from fromSlots[fromIndex] to toSlots[toIndex].
  // Empty target → move; same item → merge as much as fits (rest stays); other item → swap.
  // toIndex omitted → merge into matching stacks, then the first empty slot.
  function transfer(fromSlots, fromIndex, toSlots, toIndex, count) {
    const fa = arr(fromSlots), ta = arr(toSlots);
    if (!fa || !ta) return false;
    const src = fa[fromIndex];
    if (!src) return false;
    const max = stackOf(src.id) || 1;
    const n = count == null ? src.count : Math.min(src.count, Math.floor(Number(count) || 0));
    if (n <= 0) return false;
    let moved = false;

    if (toIndex == null || toIndex < 0) {
      if (n >= src.count) {
        moved = moveSlot(fa, fromIndex, ta, 0, ta.length) > 0;
      } else {
        const part = { id: src.id, count: n };
        const m = placeObject(ta, part, 0, ta.length, fa, fromIndex);
        if (m > 0) {
          src.count -= m;
          if (src.count <= 0) fa[fromIndex] = null;
          moved = true;
        }
      }
    } else {
      toIndex = Math.floor(toIndex);
      if (toIndex >= ta.length || (fa === ta && toIndex === fromIndex)) return false;
      const dst = ta[toIndex];
      if (!dst) {
        if (n >= src.count) { ta[toIndex] = src; fa[fromIndex] = null; }
        else { ta[toIndex] = { id: src.id, count: n }; src.count -= n; }
        moved = true;
      } else if (dst.id === src.id && max > 1 && dst.count < max) {
        const m = Math.min(max - dst.count, n);
        dst.count += m; src.count -= m;
        if (src.count <= 0) fa[fromIndex] = null;
        moved = true;
      } else if (n >= src.count) {
        ta[toIndex] = src; fa[fromIndex] = dst;          // swap
        moved = true;
      }
    }
    if (moved) afterMove(fa, ta);
    return moved;
  }

  // Move a whole stack into a slot range (e.g. shift-click hotbar ↔ backpack). Returns moved count.
  function moveToRange(fromSlots, fromIndex, toSlots, start, end) {
    const fa = arr(fromSlots), ta = arr(toSlots);
    if (!fa || !ta || !fa[fromIndex]) return 0;
    const s = G.clamp(start | 0, 0, ta.length), e = G.clamp(end == null ? ta.length : end | 0, 0, ta.length);
    const moved = moveSlot(fa, fromIndex, ta, s, e);
    if (moved) afterMove(fa, ta);
    return moved;
  }

  function swap(slotsA, i, slotsB, j) {
    const a = arr(slotsA), b = arr(slotsB);
    if (!a || !b || i < 0 || j < 0 || i >= a.length || j >= b.length) return false;
    if (a === b && i === j) return false;
    const t = a[i]; a[i] = b[j]; b[j] = t;
    afterMove(a, b);
    return true;
  }

  // Move everything that fits from a storage into the player inventory. Returns moved count.
  function takeAll(storage, source) {
    const a = arr(storage);
    if (!a || a === slots) return 0;
    let total = 0, left = false;
    const gained = {};
    for (let i = 0; i < a.length; i++) {
      const s = a[i];
      if (!s) continue;
      if (!defs[s.id]) { a[i] = null; continue; }
      const id = s.id;
      const m = moveSlot(a, i, slots, 0, INV_SIZE);
      if (m) { total += m; gained[id] = (gained[id] || 0) + m; }
      if (a[i]) left = true;
    }
    if (total) {
      storageChanged(a);
      changed();
      for (const id in gained) G.events.emit('item:gained', { id, count: gained[id], source: source || 'net' });
    }
    if (left) notifyFull();
    return total;
  }

  // Halve a stack into the first empty slot of the same array.
  function split(slotsA, i) {
    const a = arr(slotsA);
    const s = a && a[i];
    if (!s || s.count < 2) return false;
    let e = -1;
    for (let k = 0; k < a.length; k++) if (!a[k]) { e = k; break; }
    if (e < 0) return false;
    const half = Math.floor(s.count / 2);
    s.count -= half;
    a[e] = { id: s.id, count: half };
    afterMove(a, a);
    return true;
  }

  function freeSlots(slotsA) {
    const a = slotsA ? arr(slotsA) : slots;
    if (!a) return 0;
    let n = 0;
    for (let i = 0; i < a.length; i++) if (!a[i]) n++;
    return n;
  }

  function firstIndexOf(id, slotsA) {
    const a = slotsA ? arr(slotsA) : slots;
    if (!a) return -1;
    for (let i = 0; i < a.length; i++) if (a[i] && a[i].id === id) return i;
    return -1;
  }

  // Rebuild a storage from saved data: drops unknown items, clamps counts, fixes the length.
  function sanitize(data, n) {
    const src = arr(data) || [];
    const len = n == null ? src.length : Math.max(0, Math.floor(n) || 0);
    const st = createStorage(len);
    for (let i = 0; i < len && i < src.length; i++) st.slots[i] = cleanSlot(src[i]);
    return st;
  }

  const inv = (G.inventory = {
    SIZE: INV_SIZE,
    HOTBAR,
    slots,
    selected: 0,
    version: 0,               // bumps on every change (cheap dirty check for UI)
    getSelected: () => slots[inv.selected] || null,
    select: (i, silent) => select(i, silent),
    add,
    remove,
    count: (id) => countIn(slots, id),
    countIn: (storage, id) => { const a = arr(storage); return a ? countIn(a, id) : 0; },
    roomFor: (id, storage) => { const a = storage ? arr(storage) : slots; return a ? roomIn(a, id) : 0; },
    hasAll,
    removeAll,
    missing,
    canCraft,
    craft,
    consumeSelected,
    damageSelected,
    replaceSelected,
    createStorage,
    addTo,
    transfer,
    moveToRange,
    swap,
    takeAll,
    split,
    freeSlots,
    firstIndexOf,
    sanitize,
  });

  // ---------------------------------------------------------------------------
  // Module
  // ---------------------------------------------------------------------------
  function onGameStart(e) {
    if (!e || !e.fresh) return;
    for (const [id, n] of STARTING) G.events.emit('item:gained', { id, count: n, source: 'start' });
  }

  G.register({
    name: 'items',
    order: 5,

    init() {
      G.events.on('game:start', onGameStart);
      // Other modules may edit slots directly and announce it; keep equip state in sync.
      G.events.on('inventory:changed', () => checkEquip(false));
    },

    reset() {
      slots.fill(null);
      inv.selected = 0;
      for (const [id, n] of STARTING) putInto(slots, id, n);
      fullNotifyAt = -1e9;
      wheelCooldown = 0;
      lastIdx = -1;
      changed();
    },

    save() {
      return {
        slots: slots.map((s) => (s ? (s.dur != null ? { id: s.id, count: s.count, dur: s.dur } : { id: s.id, count: s.count }) : null)),
        selected: inv.selected,
      };
    },

    load(data) {
      if (!data || typeof data !== 'object') return;
      if (Array.isArray(data.slots)) {
        for (let i = 0; i < INV_SIZE; i++) slots[i] = i < data.slots.length ? cleanSlot(data.slots[i]) : null;
      }
      const sel = Math.floor(Number(data.selected));
      inv.selected = Number.isFinite(sel) ? G.clamp(sel, 0, HOTBAR - 1) : 0;
      lastIdx = -1;
      changed();
    },

    update(dt) {
      if (wheelCooldown > 0) wheelCooldown -= dt;
      if (G.isPlaying() && !G.uiBlocking() && !G.interaction.blocked) {
        const input = G.input;
        for (let k = 0; k < HOTBAR; k++) {
          if (input.pressed(DIGITS[k]) || input.pressed(NUMPAD[k])) { select(k); break; }
        }
        const w = input.mouse.wheel;
        if (w && wheelCooldown <= 0) {
          select((inv.selected + (w > 0 ? 1 : -1) + HOTBAR) % HOTBAR);
          wheelCooldown = 0.05;
        }
      }
      checkEquip(false);
    },
  });

  // ---------------------------------------------------------------------------
  // Debug
  // ---------------------------------------------------------------------------
  G.debug.give = (id, n = 1) => {
    if (!defs[id]) { G.notify('Neznámá věc: ' + id, 'warn'); return n; }
    return add(id, n, 'debug');
  };
  G.debug.giveAll = () => {
    // Most useful first, so the important things fit into the 28 slots.
    for (const d of list) if (d.category === 'material') add(d.id, 20, 'debug');
    for (const d of list) if ((d.category === 'tool' || d.category === 'weapon') && countIn(slots, d.id) === 0) add(d.id, 1, 'debug');
    for (const d of list) if (d.category === 'placeable') add(d.id, 1, 'debug');
    add('koule', 10, 'debug');
    for (const d of list) if (d.category === 'water') add(d.id, 5, 'debug');
    for (const d of list) if (d.category === 'food' && (d.cooked || d.id === 'kokos')) add(d.id, 5, 'debug');
    for (const d of list) if (d.category === 'food' && !d.cooked && d.id !== 'kokos') add(d.id, 5, 'debug');
  };
})();
