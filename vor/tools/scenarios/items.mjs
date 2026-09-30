// Scenario for items.js: tables, add/remove, crafting, durability, held-item helpers, storage,
// save/load and hotbar input. Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/items.mjs --shot /tmp/items.png
export default async (page, h) => {
  const note = (t) => process.stderr.write('[items scenario] ' + t + '\n');

  const result = await h.eval(() => {
    const I = G.inventory, It = G.items, mod = G.mod('items');
    const fail = (m) => { throw new Error('[items] ' + m); };
    const ok = (c, m) => { if (!c) fail(m); };
    const eq = (a, b, m) => { if (a !== b) fail(m + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
    const ev = [];
    const names = ['inventory:changed', 'item:gained', 'equip:changed', 'craft', 'notify', 'storage:changed', 'item:broken'];
    const hs = names.map((n) => [n, G.events.on(n, (d) => ev.push({ n, d }))]);
    const last = (n) => { for (let i = ev.length - 1; i >= 0; i--) if (ev[i].n === n) return ev[i].d; return null; };
    const clearEv = () => { ev.length = 0; };
    const idx = (id) => I.firstIndexOf(id);
    const checks = [];
    const step = (name, fn) => { fn(); checks.push(name); };

    try {
      step('tables', () => {
        eq(It.list.length, 49, 'item count');
        eq(Object.keys(It.defs).length, 49, 'defs map size');
        eq(It.recipes.length, 22, 'recipe count');
        eq(JSON.stringify(It.categories), JSON.stringify(['Nástroje', 'Zbraně', 'Jídlo a voda', 'Vor', 'Materiály']), 'categories');
        const cats = ['material', 'food', 'water', 'tool', 'weapon', 'placeable', 'ammo', 'treasure', 'animal'];
        for (const d of It.list) {
          ok(d.name && d.icon && d.desc && d.color, 'def fields ' + d.id);
          ok(cats.includes(d.category), 'category ' + d.id);
          ok(d.stack >= 1, 'stack ' + d.id);
          if (d.maxDur) eq(d.stack, 1, 'durable stack ' + d.id);
          if (d.food) ok(typeof d.food.hunger === 'number' && typeof d.food.thirst === 'number' && typeof d.food.health === 'number', 'food ' + d.id);
          if (d.food && d.food.returns) ok(It.def(d.food.returns), 'returns ' + d.id);
        }
        for (const r of It.recipes) {
          ok(It.def(r.out), 'recipe out ' + r.id);
          ok(It.categories.includes(r.category), 'recipe category ' + r.id);
          for (const k in r.needs) ok(It.def(k), 'recipe need ' + r.id + ':' + k);
        }
        eq(It.def('hak').maxDur, 80, 'hak maxDur'); eq(It.def('hak').tool, 'hook', 'hak tool');
        eq(It.def('kladivo').tool, 'hammer', 'kladivo tool'); eq(It.def('udice').maxDur, 30, 'udice maxDur');
        eq(It.def('ostep').category, 'weapon', 'ostep category'); eq(It.def('kelimek').tool, 'cup', 'cup tool');
        eq(It.def('sit').place, 'net', 'sit place'); eq(It.def('kanon').stack, 2, 'kanon stack');
        eq(It.def('zlato').stack, 999, 'zlato stack'); eq(It.def('tunak_peceny').food.health, 5, 'tuna health');
        eq(It.def('kelimek_slany').food.returns, 'kelimek', 'salt returns');
        eq(It.def('kelimek_sladky').food.thirst, 40, 'fresh thirst');
        ok(It.def('makrela_pecena').cooked === true, 'cooked flag');
        eq(It.cookResult('sardinka'), 'sardinka_pecena', 'cook sardinka');
        eq(It.cookResult('zralok_maso'), 'zralok_peceny', 'cook shark');
        eq(It.cookResult('prkno'), null, 'cook prkno');
        eq(It.purifyResult('kelimek_slany'), 'kelimek_sladky', 'purify');
        eq(It.purifyResult('kelimek'), null, 'purify cup');
        eq(It.name('udice'), 'Udice', 'name'); eq(It.def('nope'), null, 'unknown def');
        eq(It.recipe('koule_kamen').count, 3, 'koule count');
      });

      step('reset / starting inventory', () => {
        mod.reset();
        eq(I.slots.length, 28, 'slots length');
        eq(I.selected, 0, 'selected');
        eq(I.slots[0].id, 'hak', 'slot0'); eq(I.slots[0].dur, 80, 'hak dur');
        eq(I.getSelected(), I.slots[0], 'getSelected');
        eq(I.count('prkno'), 4, 'start prkno'); eq(I.count('plast'), 4, 'start plast');
        eq(I.freeSlots(), 25, 'free slots');
      });

      step('add', () => {
        clearEv();
        eq(I.add('prkno', 60, 'debris'), 0, 'leftover');
        eq(I.count('prkno'), 64, 'prkno count');
        eq(I.slots[1].count, 50, 'merged into first stack');
        eq(I.slots[3].id, 'prkno', 'overflow into next empty hotbar slot'); eq(I.slots[3].count, 14, 'overflow count');
        const g = last('item:gained');
        ok(g && g.id === 'prkno' && g.count === 60 && g.source === 'debris', 'item:gained payload');
        ok(last('inventory:changed') !== null || ev.some((e) => e.n === 'inventory:changed'), 'inventory:changed');
        eq(I.add('udice', 2), 0, 'two rods');
        const rods = I.slots.filter((s) => s && s.id === 'udice');
        eq(rods.length, 2, 'rods do not stack'); eq(rods[0].dur, 30, 'rod dur');
        eq(I.add('nonexistent', 3), 3, 'unknown id leftover');
        eq(I.add('plast', 0), 0, 'zero add');
      });

      step('remove', () => {
        eq(I.remove('prkno', 1000), false, 'remove too many');
        eq(I.count('prkno'), 64, 'all-or-nothing');
        eq(I.remove('prkno', 14), true, 'remove 14');
        eq(I.count('prkno'), 50, 'after remove');
        ok(I.hasAll({ prkno: 50, plast: 4 }), 'hasAll');
        ok(!I.hasAll({ prkno: 51 }), 'hasAll false');
        eq(I.removeAll({ prkno: 2, kov: 1 }), false, 'removeAll all-or-nothing');
        eq(I.count('prkno'), 50, 'removeAll kept items');
        const miss = I.missing({ prkno: 2, kov: 1 });
        ok(miss.length === 1 && miss[0].id === 'kov' && miss[0].have === 0 && miss[0].name === 'Kovový šrot', 'missing()');
        eq(It.needsText({ prkno: 2, kov: 1 }), '2× Prkno, 1× Kovový šrot', 'needsText');
        eq(I.removeAll({ prkno: 2, plast: 1 }), true, 'removeAll');
        eq(I.count('prkno'), 48, 'removeAll prkno'); eq(I.count('plast'), 3, 'removeAll plast');
        I.add('prkno', 2); I.add('plast', 1);
      });

      step('craft', () => {
        clearEv();
        const crafted = G.stats.itemsCrafted;
        ok(I.canCraft('kladivo'), 'canCraft kladivo');
        eq(I.craft('kladivo'), true, 'craft kladivo');
        eq(I.count('kladivo'), 1, 'kladivo made');
        eq(I.slots[idx('kladivo')].dur, 200, 'kladivo dur');
        eq(I.count('prkno'), 47, 'prkno spent'); eq(I.count('plast'), 2, 'plast spent');
        eq(G.stats.itemsCrafted, crafted + 1, 'stats');
        const c = last('craft');
        ok(c && c.recipeId === 'kladivo' && c.id === 'kladivo' && c.count === 1, 'craft event');
        const g = last('item:gained');
        ok(g && g.source === 'craft' && g.id === 'kladivo', 'craft item:gained');
        ok(!I.canCraft('kanon'), 'cannot craft kanon');
        clearEv();
        eq(I.craft('kanon'), false, 'craft kanon refused');
        ok(last('notify') && /Chybí/.test(last('notify').text), 'missing notify');
        eq(I.craft('nope'), false, 'unknown recipe');
        I.add('kov', 2);
        eq(I.craft('koule_kov'), true, 'craft koule');
        eq(I.count('koule'), 3, 'koule x3'); eq(I.count('kov'), 0, 'kov spent');
      });

      step('full inventory', () => {
        mod.reset();
        I.add('list', 4);
        clearEv();
        const left = I.add('kamen', 10000);
        eq(I.freeSlots(), 0, 'full');
        eq(left, 10000 - 24 * 30, 'leftover when full');
        ok(ev.some((e) => e.n === 'notify' && e.d.text === 'Inventář je plný'), 'full notify');
        eq(I.add('kamen', 5), 5, 'no room at all');
        clearEv();
        eq(I.craft('provaz'), false, 'no room for output');
        ok(last('notify') && /místo/.test(last('notify').text), 'no room notify');
        eq(I.count('list'), 4, 'nothing spent on refusal');
        eq(I.remove('kamen', 30), true, 'free a slot');
        eq(I.slots[27], null, 'last slot freed first');
        eq(I.craft('provaz'), true, 'craft into freed slot');
        eq(I.slots[27].id, 'provaz', 'provaz landed');
        // craft whose ingredients free the needed slot
        mod.reset();
        I.add('list', 2);
        I.add('kamen', 10000);
        eq(I.craft('provaz'), true, 'ingredients free their own slot');
        eq(I.count('provaz'), 1, 'provaz made');
      });

      step('durability', () => {
        mod.reset();
        I.select(0, true);
        clearEv();
        eq(I.damageSelected(10), false, 'not broken');
        eq(I.slots[0].dur, 70, 'dur 70');
        I.damageSelected(69);
        eq(I.slots[0].dur, 1, 'dur 1');
        ok(ev.some((e) => e.n === 'notify' && /brzy/.test(e.d.text)), 'low durability warning');
        clearEv();
        eq(I.damageSelected(), true, 'broke');
        eq(I.slots[0], null, 'removed');
        ok(ev.some((e) => e.n === 'notify' && e.d.text === 'Hák se rozbil…'), 'break notify');
        const eqv = last('equip:changed');
        ok(eqv && eqv.index === 0 && eqv.slot === null, 'equip:changed on break');
        I.add('udice', 1);
        I.select(idx('udice'), true);
        clearEv();
        I.damageSelected(30);
        ok(ev.some((e) => e.n === 'notify' && e.d.text === 'Udice se rozbila…'), 'feminine break text');
        I.add('kladivo', 1);
        I.select(idx('kladivo'), true);
        clearEv();
        I.damageSelected(500);
        ok(ev.some((e) => e.n === 'notify' && e.d.text === 'Kladivo se rozbilo…'), 'neuter break text');
        I.select(idx('prkno'), true);
        eq(I.damageSelected(), false, 'non-durable ignored');
      });

      step('consume / replace', () => {
        mod.reset();
        I.add('kokos', 3);
        I.select(idx('kokos'), true);
        eq(I.consumeSelected(), true, 'eat one');
        eq(I.getSelected().count, 2, 'two left');
        eq(I.consumeSelected(5), false, 'not enough');
        eq(I.consumeSelected(2), true, 'eat two');
        eq(I.getSelected(), null, 'slot emptied');
        I.add('kelimek', 3);
        const ci = idx('kelimek');
        I.select(ci, true);
        clearEv();
        eq(I.replaceSelected('kelimek_slany'), true, 'fill one of three');
        eq(I.slots[ci].id, 'kelimek', 'stack stays in hand'); eq(I.slots[ci].count, 2, 'two empty left');
        eq(I.count('kelimek_slany'), 1, 'one salt water');
        ok(!ev.some((e) => e.n === 'equip:changed'), 'no equip change when id stays');
        I.consumeSelected(1);
        clearEv();
        eq(I.replaceSelected('kelimek_slany'), true, 'fill the last one');
        eq(I.slots[ci].id, 'kelimek_slany', 'replaced in place'); eq(I.slots[ci].count, 1, 'single');
        ok(last('equip:changed') && last('equip:changed').slot.id === 'kelimek_slany', 'equip:changed on id change');
        eq(I.count('kelimek_slany'), 2, 'two salt waters');
      });

      step('storage', () => {
        mod.reset();
        const st = I.createStorage(4);
        eq(st.slots.length, 4, 'storage size');
        eq(I.addTo(st, 'prkno', 120), 0, 'addTo fits');
        eq(st.slots.map((s) => s && s.count).join(), '50,50,20,', 'addTo stacks');
        eq(I.addTo(st, 'kov', 100), 70, 'addTo leftover');
        eq(st.slots[3].count, 30, 'kov stack');
        // partial merge
        st.slots[0].count = 45;
        eq(I.transfer(st.slots, 2, st.slots, 0), true, 'merge');
        eq(st.slots[0].count, 50, 'merged to full'); eq(st.slots[2].count, 15, 'rest stays');
        // swap different items
        eq(I.transfer(st.slots, 3, st.slots, 2), true, 'swap');
        eq(st.slots[2].id, 'kov', 'swapped a'); eq(st.slots[3].id, 'prkno', 'swapped b'); eq(st.slots[3].count, 15, 'swapped count');
        // move into an empty slot, and a partial count
        eq(I.transfer(st.slots, 3, I.slots, 10, 5), true, 'partial move');
        eq(I.slots[10].count, 5, 'partial moved'); eq(st.slots[3].count, 10, 'partial rest');
        eq(I.transfer(st.slots, 3, I.slots, 10), true, 'merge rest');
        eq(I.slots[10].count, 15, 'merged'); eq(st.slots[3], null, 'source emptied');
        // toIndex omitted: merges into the prkno stacks, then the first empty slot
        eq(I.transfer(st.slots, 0, I.slots), true, 'auto transfer');
        eq(I.count('prkno'), 4 + 15 + 50, 'auto transfer count');
        eq(I.slots[1].count, 50, 'first stack filled'); eq(I.slots[10].count, 19, 'second stack topped up');
        eq(st.slots[0], null, 'emptied');
        eq(I.transfer(st.slots, 1, I.slots), true, 'auto transfer 2');
        eq(I.slots[10].count, 50, 'second stack filled');
        eq(I.slots[3].count, 19, 'rest into first empty');
        eq(st.slots[1], null, 'emptied 2');
        // same-array whole-stack move / no-op
        eq(I.transfer(I.slots, 3, I.slots, 3), false, 'self no-op');
        eq(I.moveToRange(I.slots, 3, I.slots, 8, 28) > 0, true, 'moveToRange');
        eq(I.slots[3], null, 'moved out of hotbar');
        ok(I.slots[8] && I.slots[8].id === 'prkno' && I.slots[8].count === 19, 'into first backpack slot');
        // split
        eq(I.split(I.slots, 1), true, 'split');
        eq(I.slots[1].count, 25, 'split half a'); eq(I.slots[3].count, 25, 'split half b into first empty');
        eq(I.split(I.slots, 0), false, 'cannot split a tool');
        // swap across arrays
        eq(I.swap(I.slots, 0, st.slots, 0), true, 'swap across');
        eq(st.slots[0].id, 'hak', 'hook in storage'); eq(I.slots[0], null, 'hand empty');
        // takeAll keeps durability and leaves what does not fit
        st.slots[0].dur = 7;
        const st2 = I.createStorage(3);
        st2.slots[0] = { id: 'udice', count: 1, dur: 5 };
        I.addTo(st2, 'plast', 7);
        clearEv();
        eq(I.takeAll(st2), 8, 'takeAll moved');
        eq(st2.slots.filter(Boolean).length, 0, 'net emptied');
        eq(I.slots[idx('udice')].dur, 5, 'durability kept');
        ok(ev.some((e) => e.n === 'item:gained' && e.d.source === 'net' && e.d.id === 'plast' && e.d.count === 7), 'takeAll item:gained');
        eq(I.takeAll(st2), 0, 'nothing to take');
        // fill every empty slot directly (add() would already have shown the "full" notice)
        for (let i = 0; i < I.slots.length; i++) if (!I.slots[i]) I.slots[i] = { id: 'kamen', count: 30 };
        G.events.emit('inventory:changed');
        I.addTo(st2, 'kamen', 50);
        I.addTo(st2, 'plast', 3);
        clearEv();
        const moved = I.takeAll(st2);
        eq(moved, 3, 'full inventory still merges into a plast stack');
        eq(I.countIn(st2, 'kamen'), 50, 'rest stays in storage');
        eq(I.countIn(st2, 'plast'), 0, 'plast taken');
        ok(ev.some((e) => e.n === 'notify' && e.d.text === 'Inventář je plný'), 'takeAll full notify');
        // sanitize saved storage
        const s3 = I.sanitize({ slots: [{ id: 'xx', count: 3 }, { id: 'prkno', count: 999 }, null, { id: 'hak', count: 1, dur: -3 }] }, 5);
        eq(s3.slots.length, 5, 'sanitize length');
        eq(s3.slots[0], null, 'unknown dropped'); eq(s3.slots[1].count, 50, 'clamped');
        eq(s3.slots[3].dur, 80, 'bad dur fixed');
      });

      step('save / load', () => {
        mod.reset();
        I.add('kov', 7); I.add('udice', 1);
        I.select(idx('udice'), true);
        I.damageSelected(4);
        const data = JSON.parse(JSON.stringify(mod.save()));
        mod.reset();
        eq(I.count('kov'), 0, 'reset cleared');
        clearEv();
        mod.load(data);
        eq(I.count('kov'), 7, 'kov restored');
        eq(I.getSelected().id, 'udice', 'selected restored');
        eq(I.getSelected().dur, 26, 'dur restored');
        ok(ev.some((e) => e.n === 'equip:changed'), 'equip after load');
        mod.load({});
        mod.load({ slots: 'garbage', selected: 'x' });
        eq(I.selected, 0, 'bad selected tolerated');
        mod.load({ slots: [{ id: 'hak', count: 1 }, { id: 'zzz', count: 1 }, { id: 'prkno', count: 3.7 }] });
        eq(I.slots[0].dur, 80, 'missing dur defaulted'); eq(I.slots[1], null, 'unknown dropped');
        eq(I.slots[2].count, 3, 'count floored');
        eq(I.slots.length, 28, 'length kept');
      });

      step('select events', () => {
        mod.reset();
        clearEv();
        I.select(4, true);
        const e = last('equip:changed');
        ok(e && e.index === 4 && e.slot === null, 'equip:changed on select');
        clearEv();
        I.select(4, true);
        ok(!ev.some((x) => x.n === 'equip:changed'), 'same index no event');
        I.select(99, true);
        eq(I.selected, 7, 'clamped');
        I.select(0, true);
      });
    } finally {
      hs.forEach(([n, f]) => G.events.off(n, f));
    }
    mod.reset();
    return checks;
  });
  note('passed: ' + result.join(', '));

  // Hotbar input: number keys and mouse wheel (needs the game running and no UI panel open).
  const canInput = await h.eval(() => G.isPlaying() && !G.uiBlocking() && !G.interaction.blocked);
  if (!canInput) {
    note('skipping hotbar input test (game not in a playable state: another module blocks input)');
  } else {
    // headless SwiftShader frames can take a second or more: poll instead of fixed waits
    const waitSel = async (want, what) => {
      let sel = -1;
      for (const t0 = Date.now(); Date.now() - t0 < 6000;) {
        sel = await h.eval(() => G.inventory.selected);
        if (sel === want) return;
        await h.wait(50);
      }
      throw new Error('[items] ' + what + ' should select slot ' + want + ', got ' + sel);
    };
    await h.key('Digit3');
    await waitSel(2, 'Digit3');
    await page.mouse.move(640, 360);
    await page.mouse.wheel(0, 120);
    await waitSel(3, 'wheel down');
    await h.wait(100);
    await page.mouse.wheel(0, -120);
    await waitSel(2, 'wheel up');
    await h.key('Digit1');
    await waitSel(0, 'Digit1');
    note('hotbar input ok');
  }

  // Leave a well-stocked inventory for the screenshot / other checks.
  const filled = await h.eval(() => { G.debug.giveAll(); return G.inventory.slots.filter(Boolean).length; });
  if (filled < 20) throw new Error('[items] giveAll filled only ' + filled + ' slots');
  note('giveAll filled ' + filled + ' slots');
};
