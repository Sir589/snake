// Scenario for raft.js: grid & API, paid hammer actions, the hammer / place tool handlers with a
// stubbed aim, damage & destroy rules, every structure type and its interactions, drift speed,
// storm damage, save/load and the debug hooks. Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 2 --scenario vor/tools/scenarios/raft.mjs --shot /tmp/raft.png
export default async (page, h) => {
  const note = (t) => process.stderr.write('[raft scenario] ' + t + '\n');

  const result = await h.eval(() => {
    const R = G.raft, I = G.inventory, mod = G.mod('raft');
    const fail = (m) => { throw new Error('[raft] ' + m); };
    const ok = (c, m) => { if (!c) fail(m); };
    const js = (x) => {
      if (x && typeof x === 'object' && x.mesh && x.i != null) return '[tile ' + x.i + ',' + x.j + ']';
      if (x && typeof x === 'object' && x.object && x.type) return '[structure ' + x.type + ']';
      try { return JSON.stringify(x); } catch (e) { return String(x); }
    };
    const eq = (a, b, m) => { if (a !== b) fail(m + ': expected ' + js(b) + ', got ' + js(a)); };
    const near = (a, b, eps, m) => { if (!(Math.abs(a - b) <= eps)) fail(m + ': expected ~' + b + ', got ' + a); };
    const ev = [];
    const names = ['build:tile', 'build:reinforce', 'build:repair', 'build:structure', 'structure:removed', 'tile:damaged',
      'tile:destroyed', 'purify:done', 'cook:done', 'sail:toggled', 'anchor:toggled', 'notify'];
    const hs = names.map((n) => [n, G.events.on(n, (d) => ev.push({ n, d }))]);
    const evs = (n) => ev.filter((e) => e.n === n).map((e) => e.d);
    const last = (n) => { const l = evs(n); return l.length ? l[l.length - 1] : null; };
    const clearEv = () => { ev.length = 0; };
    const checks = [];
    const step = (name, fn) => { fn(); checks.push(name); };
    const run = (sec, dt = 0.05) => { for (let t = 0; t < sec - 1e-9; t += dt) { mod.update(dt); mod.frame(dt); } };

    // Aim stub: the tools read G.player.eye()/forward() (camera fallback when player.js is absent)
    const hadPlayer = !!G.player;
    const P = G.player || (G.player = {});
    const oldEye = P.eye, oldFwd = P.forward;
    const aim = (ex, ey, ez, tx, ty, tz) => {
      const e = new THREE.Vector3(ex, ey, ez), f = new THREE.Vector3(tx - ex, ty - ey, tz - ez).normalize();
      P.eye = (o) => (o || new THREE.Vector3()).copy(e);
      P.forward = (o) => (o || new THREE.Vector3()).copy(f);
    };
    const aimCell = (fromX, fromZ, i, j, dy = 0) => {
      const d = R.deckY();
      aim(fromX, d + 1.7, fromZ, (i + 0.5) * 2, d + dy, (j + 0.5) * 2);
    };
    const select = (id) => {
      let k = I.firstIndexOf(id);
      ok(k >= 0, id + ' in inventory');
      if (k >= 8) { I.swap(I.slots, k, I.slots, 7); k = 7; }
      I.select(k, true);
      return I.getSelected();
    };
    const pump = (hd, sec, dt = 0.05) => { for (let t = 0; t < sec - 1e-9; t += dt) hd.update(dt, I.getSelected()); };
    const oldDebris = G.debris, oldUi = G.ui;

    try {
      step('initial raft', () => {
        mod.reset();
        eq(R.count(), 4, 'start tiles');
        for (const k of ['-1,-1', '0,-1', '-1,0', '0,0']) ok(R.tiles.has(k), 'tile ' + k);
        const t = R.tileAt(0.5, 0.5);
        ok(t && t.i === 0 && t.j === 0, 'tileAt(0.5,0.5)');
        const t2 = R.tileAt(-0.5, -1.5);
        ok(t2 && t2.i === -1 && t2.j === -1, 'tileAt(-0.5,-1.5)');
        eq(R.tileAt(5, 5), null, 'tileAt far');
        eq(t.hp, 100, 'hp'); eq(t.maxHp, 100, 'maxHp'); eq(t.reinforced, false, 'reinforced');
        ok(t.mesh && t.mesh.isMesh && t.mesh.parent === R.group, 'tile mesh in group'); eq(t.structure, null, 'no structure');
        ok(t.mesh.castShadow && t.mesh.receiveShadow, 'tile shadows');
        const b = R.bounds();
        eq(b.minX, -2, 'minX'); eq(b.maxX, 2, 'maxX'); eq(b.minZ, -2, 'minZ'); eq(b.maxZ, 2, 'maxZ');
        near(R.radius(), Math.hypot(2, 2), 1e-6, 'radius');
        eq(R.edgeTiles().length, 4, 'edge tiles');
        ok(R.randomEdgeTile() && R.randomTile(), 'random tiles');
        near(R.deckY(), R.group.position.y + G.C.DECK_Y, 1e-9, 'deckY');
        const c = R.tileCenter(t, new THREE.Vector3());
        near(c.x, 1, 1e-9, 'center x'); near(c.z, 1, 1e-9, 'center z'); near(c.y, R.deckY(), 1e-9, 'center y');
        const g = G.ground.sample(0.5, 0.5);
        ok(g && g.provider.kind === 'raft' && Math.abs(g.height - R.deckY()) < 1e-6, 'ground provider');
        const off = G.ground.sample(9, 9);
        ok(!off || off.provider.kind !== 'raft', 'no raft ground off the raft');
        eq(R.structures.length, 0, 'no structures');
        ok(R.velocity.isVector3 && Math.abs(R.velocity.length() - 0.35) < 0.01, 'drift velocity');
        eq(R.sailUp, false, 'sailUp'); eq(R.anchored, false, 'anchored');
      });

      step('paid build', () => {
        I.add('prkno', 45, 'debug'); I.add('plast', 45, 'debug'); I.add('kov', 10, 'debug');
        clearEv();
        const p0 = I.count('prkno'), q0 = I.count('plast'), s0 = G.stats.tilesBuilt || 0;
        eq(R.build(1, 0), true, 'build (1,0)');
        eq(R.count(), 5, 'count after build');
        eq(I.count('prkno'), p0 - 2, 'prkno cost'); eq(I.count('plast'), q0 - 2, 'plast cost');
        const e = last('build:tile'); ok(e && e.i === 1 && e.j === 0, 'build:tile payload');
        eq(G.stats.tilesBuilt, s0 + 1, 'tilesBuilt');
        eq(R.canBuildAt(5, 5), 'detached', 'detached'); eq(R.build(5, 5), false, 'no detached build');
        eq(R.canBuildAt(0, 0), 'occupied', 'occupied'); eq(R.build(0, 0), false, 'no double build');
        eq(I.count('prkno'), p0 - 2, 'failed builds are free');
      });

      step('hammer tool: build', () => {
        I.add('kladivo', 1, 'debug');
        const slot = select('kladivo');
        const hd = G.tools.get('hammer');
        ok(hd && hd.viewModel && hd.viewModel.isObject3D, 'hammer viewModel');
        hd.onEquip(slot);
        clearEv();
        aimCell(3.2, 1.0, 2, 0);
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'build', 'aim kind'); eq(hd.aim.i, 2, 'aim i'); eq(hd.aim.j, 0, 'aim j');
        ok(/Postavit základ \(2× Prkno, 2× Plast\)/.test(G.hud.toolHint), 'build hint: ' + G.hud.toolHint);
        hd.primaryDown(slot); hd.primaryUp(slot);
        pump(hd, 0.6);
        ok(R.getTile(2, 0), 'hammer built (2,0)');
        eq(slot.dur, 199, 'hammer durability');
        ok(evs('build:tile').some((e) => e.i === 2 && e.j === 0), 'build:tile from hammer');
        // not affordable
        const plast = I.count('plast');
        I.remove('plast', plast);
        aimCell(3.2, 1.0, 2, -1);
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'build', 'aim (2,-1)'); eq(hd.afford, false, 'cannot afford');
        ok(/Chybí: 2× Plast/.test(G.hud.toolHint), 'missing hint: ' + G.hud.toolHint);
        const n = R.count();
        hd.primaryDown(slot); hd.primaryUp(slot); pump(hd, 0.6);
        eq(R.count(), n, 'no build without materials'); eq(slot.dur, 199, 'no wear on failed swing');
        I.add('plast', plast, 'debug');
        // looking far out to sea: nothing to do
        aim(3.2, R.deckY() + 1.7, 1, 30, R.deckY(), 1);
        hd.update(0.016, slot);
        ok(hd.aim.kind === null || hd.aim.kind === 'far', 'far aim: ' + hd.aim.kind);
      });

      step('hammer tool: reinforce & repair', () => {
        const hd = G.tools.get('hammer'), slot = I.getSelected();
        const t = R.getTile(2, 0);
        aimCell(3.2, 1.0, 2, 0);
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'reinforce', 'reinforce aim');
        ok(/Zpevnit základ/.test(G.hud.toolHint), 'reinforce hint');
        const k0 = I.count('kov'), p0 = I.count('prkno');
        clearEv();
        hd.primaryDown(slot); hd.primaryUp(slot); pump(hd, 0.6);
        eq(t.reinforced, true, 'reinforced'); eq(t.maxHp, 150, 'reinforced maxHp'); eq(t.hp, 150, 'reinforced hp');
        eq(I.count('kov'), k0 - 1, 'kov cost'); eq(I.count('prkno'), p0 - 2, 'prkno cost');
        ok(last('build:reinforce') && last('build:reinforce').i === 2, 'build:reinforce');
        R.damageTile(t, 40, 'cannon');                                    // half damage: 20
        eq(t.hp, 130, 'cannon half damage on reinforced');
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'repair', 'repair aim');
        ok(/Opravit základ \(1× Prkno\) · stav 87 %/.test(G.hud.toolHint), 'repair hint: ' + G.hud.toolHint);
        hd.primaryDown(slot); hd.primaryUp(slot); pump(hd, 0.6);
        eq(t.hp, 150, 'repaired'); ok(last('build:repair'), 'build:repair');
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'metal', 'metal aim on a reinforced tile');
        ok(/Okovat základ/.test(G.hud.toolHint), 'metal hint: ' + G.hud.toolHint);
        I.add('kov', 4, 'debug');
        hd.primaryDown(slot); hd.primaryUp(slot); pump(hd, 0.6);
        eq(t.level, 2, 'plated with metal'); eq(t.maxHp, 250, 'metal maxHp');
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'full', 'full aim');
        hd.onUnequip();
        eq(G.hud.toolHint, '', 'hint cleared on unequip');
      });

      step('hammer: hold LMB keeps building', () => {
        const hd = G.tools.get('hammer'), slot = select('kladivo');
        hd.onEquip(slot);
        aimCell(-1.2, 1.0, -2, 0);
        hd.update(0.016, slot);
        eq(hd.aim.kind, 'build', 'west cell buildable');
        hd.primaryDown(slot);
        pump(hd, 0.6);
        ok(R.getTile(-2, 0), 'first build');
        aimCell(-1.2, -1.0, -2, -1);
        pump(hd, 0.7);
        ok(R.getTile(-2, -1), 'second build while LMB held');
        pump(hd, 1.2);
        eq(R.getTile(-2, -1).reinforced, false, 'holding never auto-reinforces');
        hd.primaryUp(slot);
        hd.onUnequip();
      });

      step('damage rules', () => {
        const t = R.getTile(1, 0), r = R.getTile(2, 0);
        const g0 = t.mesh.geometry;
        clearEv();
        eq(R.damageTile(t, 30, 'shark'), 30, 'shark dealt');
        eq(t.hp, 70, 'hp after bite');
        ok(t.mesh.geometry !== g0, 'damaged visual state');
        const d = last('tile:damaged'); ok(d && d.tile === t && d.amount === 30 && d.source === 'shark', 'tile:damaged payload');
        eq(R.damageTile(r, 50, 'shark'), 0, 'reinforced ignores shark');
        eq(r.hp, r.maxHp, 'reinforced hp intact');
        R.damageTile(t, 50, 'storm');
        eq(t.hp, 20, 'hp 20');
        const n = R.count();
        R.damageTile(r, 1000, 'cannon');
        eq(R.count(), n - 1, 'destroyed'); eq(R.getTile(2, 0), null, 'tile gone');
        const x = last('tile:destroyed'); ok(x && x.i === 2 && x.j === 0 && x.source === 'cannon', 'tile:destroyed payload');
        eq(R.damageTile(r, 10, 'shark'), 0, 'dead tile ignores damage');
        mod.reset();
        const all = Array.from(R.tiles.values());
        for (let k = 0; k < 3; k++) R.damageTile(all[k], 1000, 'shark');
        eq(R.count(), 1, 'one tile left');
        R.damageTile(all[3], 1000, 'shark');
        eq(R.count(), 1, 'last tile never sinks'); eq(all[3].hp, 1, 'last tile hp 1');
        mod.reset();
      });

      const S = {};
      step('structures', () => {
        eq(G.debug.buildRing(), 8, 'ring of 8');
        eq(R.count(), 12, 'count 12');
        clearEv();
        const want = ['purifier', 'grill', 'chest', 'net', 'sail', 'anchor'];
        const edges = R.edgeTiles();
        let k = 0;
        for (const type of want) {
          const t = edges[k++];
          const s = R.placeStructure(type, t, 0);
          ok(s, 'placed ' + type);
          eq(s.type, type, 'type'); eq(s.tile, t, 'tile'); eq(t.structure, s, 'tile.structure'); eq(s.rotation, 0, 'rotation');
          ok(s.object && s.object.parent === R.group, 'object in group');
          ok(Math.abs(s.object.position.x - (t.i + 0.5) * 2) < 1e-6 && Math.abs(s.object.position.y - G.C.DECK_Y) < 1e-6, 'object on tile centre');
          ok(s.data && typeof s.data === 'object', 'data');
          let it = null;
          for (const x of G.interaction.items) if (x.structure === s) it = x;
          ok(it && typeof it.label() === 'string' && it.label().length > 3, 'interactable ' + type);
          S[type] = s;
        }
        eq(R.structures.length, 6, 'six structures');
        eq(evs('build:structure').length, 6, 'build:structure events');
        ok(evs('build:structure').every((e) => e.type && e.tile), 'build:structure payload');
        eq(R.findStructures('grill').length, 1, 'findStructures');
        eq(R.placeStructure('chest', S.grill.tile, 0), null, 'one structure per tile');
        eq(R.placeStructure('nope', R.getTile(0, 0), 0), null, 'unknown type');
        const s2 = R.placeStructure('chest', { i: 0, j: 0 }, Math.PI / 2);
        ok(s2 && s2.rotation === 1 && Math.abs(s2.object.rotation.y - Math.PI / 2) < 1e-6, 'radians tolerated');
        clearEv();
        eq(R.removeStructure(s2, false), true, 'remove');
        eq(R.getTile(0, 0).structure, null, 'tile freed');
        ok(last('structure:removed') && last('structure:removed').type === 'chest', 'structure:removed');
      });

      const label = (s) => { for (const x of G.interaction.items) if (x.structure === s) return x.label(); return null; };
      const use = (s) => { for (const x of G.interaction.items) if (x.structure === s) return x.onInteract(); fail('no interactable'); };

      step('purifier', () => {
        const s = S.purifier;
        I.remove('kelimek_slany', I.count('kelimek_slany'));
        ok(/Potřebuješ slanou vodu/.test(label(s)), 'needs label: ' + label(s));
        const itP = Array.from(G.interaction.items).find((x) => x.structure === s);
        eq(itP.passive(), true, 'informational label is passive');
        clearEv();
        use(s);
        eq(s.data.state, 'idle', 'still idle'); ok(evs('notify').length === 1, 'hint notify');
        I.add('kelimek_slany', 1, 'debug');
        eq(label(s), 'Čistit vodu', 'ready label');
        eq(itP.passive(), false, 'actionable label');
        use(s);
        eq(s.data.state, 'work', 'working'); eq(I.count('kelimek_slany'), 0, 'salt water taken');
        ok(/^Čistí se… 20 s$/.test(label(s)), 'working label: ' + label(s));
        run(10);
        eq(s.data.state, 'work', 'still working at 10 s');
        run(10.5);
        eq(s.data.state, 'done', 'done after 20 s'); eq(label(s), 'Vzít pitnou vodu', 'done label');
        const w0 = I.count('kelimek_sladky');
        clearEv();
        use(s);
        eq(I.count('kelimek_sladky'), w0 + 1, 'fresh water'); eq(s.data.state, 'idle', 'idle again');
        ok(evs('purify:done').length === 1, 'purify:done');
      });

      step('grill', () => {
        const s = S.grill;
        for (const id of ['sardinka', 'makrela', 'tunak', 'zralok_maso']) I.remove(id, I.count(id));
        ok(/Potřebuješ syrovou rybu/.test(label(s)), 'needs label');
        I.add('makrela', 1, 'debug');
        eq(label(s), 'Upéct: Syrová makrela', 'cook label');
        use(s);
        eq(s.data.state, 'work', 'cooking'); eq(s.data.input, 'makrela', 'input'); eq(s.data.out, 'makrela_pecena', 'out');
        eq(I.count('makrela'), 0, 'fish taken');
        ok(/^Peče se… 15 s$/.test(label(s)), 'cooking label: ' + label(s));
        run(15.2);
        eq(s.data.state, 'done', 'cooked'); eq(label(s), 'Vzít: Pečená makrela', 'done label');
        clearEv();
        use(s);
        eq(I.count('makrela_pecena'), 1, 'cooked fish');
        ok(last('cook:done') && last('cook:done').id === 'makrela_pecena', 'cook:done');
      });

      step('chest', () => {
        const s = S.chest, st = s.data.storage;
        eq(st.slots.length, 20, 'chest slots');
        eq(label(s), 'Otevřít truhlu (prázdná)', 'empty label');
        I.addTo(st, 'prkno', 5);
        eq(label(s), 'Otevřít truhlu (5 věcí)', 'label with items');
        let opened = null;
        G.ui = Object.assign({}, oldUi || {}, { openStorage: (a, b) => { opened = [a, b]; } });
        use(s);
        ok(opened && opened[0] === st && opened[1] === 'Truhla', 'openStorage(storage, "Truhla")');
        G.ui = oldUi;
      });

      step('net', () => {
        const s = S.net, st = s.data.storage;
        eq(st.slots.length, 10, 'net slots');
        ok(/prázdná/.test(label(s)), 'empty net label');
        const c = R.tileCenter(s.tile, new THREE.Vector3());
        const list = [];
        const nearD = { position: new THREE.Vector3(c.x + 1.2, 0, c.z + 1.0), id: 'prkno' };
        const farD = { position: new THREE.Vector3(c.x + 6, 0, c.z), id: 'plast' };
        list.push(nearD, farD);
        G.debris = { list, collect(d, storage) { I.addTo(storage, d.id, 1); list.splice(list.indexOf(d), 1); return true; }, spawnItem() {} };
        mod.update(0.016);
        eq(I.countIn(st, 'prkno'), 1, 'net caught near debris'); eq(I.countIn(st, 'plast'), 0, 'far debris ignored');
        eq(list.length, 1, 'collected removed');
        eq(label(s), 'Vybrat síť (1 věc)', 'net label');
        const p0 = I.count('prkno');
        use(s);
        eq(I.count('prkno'), p0 + 1, 'took net contents'); eq(I.countIn(st, 'prkno'), 0, 'net emptied');
        for (let k = 0; k < 10; k++) st.slots[k] = { id: 'kamen', count: 1 };
        ok(/plná/.test(label(s)), 'full label: ' + label(s));
        farD.position.set(c.x + 0.5, 0, c.z);
        mod.update(0.016);
        eq(list.length, 1, 'full net catches nothing');
        for (let k = 0; k < 10; k++) st.slots[k] = null;
        G.debris = oldDebris;
      });

      step('sail & anchor', () => {
        const sail = S.sail, anch = S.anchor;
        const w = G.world ? G.world.windDir.clone().setY(0).normalize() : new THREE.Vector3(1, 0, 0);
        clearEv();
        eq(label(sail), 'Vytáhnout plachtu', 'sail label');
        use(sail);
        eq(sail.data.up, true, 'sail up'); eq(R.sailUp, true, 'sailUp');
        ok(last('sail:toggled') && last('sail:toggled').up === true, 'sail:toggled');
        eq(label(sail), 'Stáhnout plachtu', 'sail label up');
        run(14);
        near(R.velocity.length(), 2.2, 0.03, 'sail speed');
        ok(R.velocity.clone().normalize().dot(w) > 0.99, 'velocity along windDir');
        eq(R.velocity.y, 0, 'velocity y');
        eq(label(anch), 'Spustit kotvu', 'anchor label');
        use(anch);
        eq(R.anchored, true, 'anchored'); ok(last('anchor:toggled') && last('anchor:toggled').down === true, 'anchor:toggled');
        run(14);
        ok(R.velocity.length() < 0.02, 'anchored speed ' + R.velocity.length());
        ok(anch._v && anch._v.drop > 0.99, 'anchor fully dropped');
        use(anch); use(sail);
        eq(R.anchored, false, 'anchor raised'); eq(R.sailUp, false, 'sail lowered');
        run(14);
        near(R.velocity.length(), 0.35, 0.02, 'drift speed');
      });

      step('save / load', () => {
        I.addTo(S.chest.data.storage, 'kov', 3);
        use(S.sail); use(S.anchor);
        const dmg = R.getTile(0, 0);
        R.damageTile(dmg, 45, 'shark');
        dmg.reinforced = false;
        const rt = R.getTile(-1, -1);
        R.reinforce(rt);
        const data = JSON.parse(JSON.stringify(mod.save()));
        ok(Array.isArray(data.tiles) && data.tiles.length === 12, 'saved tiles');
        ok(data.tiles.every((t) => 'i' in t && 'j' in t && 'hp' in t && 'reinforced' in t), 'tile fields');
        ok(Array.isArray(data.structures) && data.structures.length === 6, 'saved structures');
        ok(data.structures.every((s) => s.type && 'i' in s && 'j' in s && 'rotation' in s && 'data' in s), 'structure fields');
        mod.reset();
        eq(R.count(), 4, 'reset tiles'); eq(R.structures.length, 0, 'reset structures'); eq(R.sailUp, false, 'reset sail');
        clearEv();
        mod.load(data);
        eq(ev.filter((e) => e.n.startsWith('build:')).length, 0, 'load is quiet');
        eq(R.count(), 12, 'loaded tiles'); eq(R.structures.length, 6, 'loaded structures');
        eq(R.getTile(0, 0).hp, 55, 'loaded hp'); eq(R.getTile(-1, -1).reinforced, true, 'loaded reinforced');
        eq(R.getTile(-1, -1).maxHp, 150, 'loaded maxHp');
        eq(R.sailUp, true, 'loaded sail up'); eq(R.anchored, true, 'loaded anchor down');
        const chest = R.findStructures('chest')[0];
        eq(I.countIn(chest.data.storage, 'prkno'), 5, 'chest prkno'); eq(I.countIn(chest.data.storage, 'kov'), 3, 'chest kov');
        eq(chest.data.storage.slots.length, 20, 'chest slots after load');
        for (const k in S) S[k] = R.findStructures(k)[0];
        mod.reset();
        mod.load({ tiles: 'x', structures: [null, { type: 'nope', i: 0, j: 0 }, { type: 'chest', i: 99, j: 99 }], speed: 'fast' });
        eq(R.count(), 4, 'garbage load keeps defaults'); eq(R.structures.length, 0, 'garbage structures skipped');
        mod.load(data);
        for (const k in S) S[k] = R.findStructures(k)[0];
        use(S.anchor); use(S.sail);
      });

      step('hammer: dismantle with RMB hold', () => {
        const hd = G.tools.get('hammer'), slot = select('kladivo');
        hd.onEquip(slot);
        const s = S.chest, t = s.tile;
        const d0 = slot.dur, tr0 = I.count('truhla'), p0 = I.count('prkno');
        const c = R.tileCenter(t, new THREE.Vector3());
        // stand 2 m away (inward) and look at the chest body
        const dir = new THREE.Vector3(-c.x, 0, -c.z).normalize();
        aim(c.x + dir.x * 2, R.deckY() + 1.7, c.z + dir.z * 2, c.x, R.deckY() + 0.3, c.z);
        hd.update(0.016, slot);
        eq(hd.aim.s, s, 'aimed structure');
        ok(/Rozebrat – Truhla/.test(G.hud.toolHint), 'dismantle hint: ' + G.hud.toolHint);
        clearEv();
        hd.secondaryDown(slot);
        pump(hd, 0.3);
        ok(G.hud.progress > 0.3 && G.hud.progress < 0.8, 'progress ring ' + G.hud.progress);
        ok(R.structures.includes(s), 'not yet removed');
        pump(hd, 0.4);
        hd.secondaryUp(slot);
        ok(!R.structures.includes(s), 'dismantled'); eq(t.structure, null, 'tile free');
        eq(I.count('truhla'), tr0 + 1, 'chest refunded'); eq(I.count('prkno'), p0 + 5, 'chest contents returned');
        eq(slot.dur, d0 - 1, 'hammer wear'); eq(G.hud.progress, null, 'progress cleared');
        ok(last('structure:removed') && last('structure:removed').type === 'chest', 'structure:removed');
        // releasing early cancels
        aim(c.x + dir.x * 2, R.deckY() + 1.7, c.z + dir.z * 2, (S.grill.tile.i + 0.5) * 2, R.deckY() + 0.4, (S.grill.tile.j + 0.5) * 2);
        hd.update(0.016, slot);
        if (hd.aim.s === S.grill) {
          hd.secondaryDown(slot); pump(hd, 0.3); hd.secondaryUp(slot); pump(hd, 0.5);
          ok(R.structures.includes(S.grill), 'early release keeps structure');
        }
        hd.onUnequip();
      });

      step('place tool', () => {
        I.add('truhla', 1, 'debug');
        const slot = select('truhla');
        const pl = G.tools.get('place');
        ok(pl, 'place handler');
        pl.onEquip(slot);
        const free = Array.from(R.tiles.values()).find((t) => !t.structure);
        ok(free, 'free tile');
        aimCell((free.i + 0.5) * 2 - 1.5, (free.j + 0.5) * 2 - 1.5, free.i, free.j);
        pl.update(0.016, slot);
        eq(pl.tile, free, 'aimed tile'); eq(pl.ok, true, 'can place');
        ok(/Postavit – Truhla/.test(G.hud.toolHint), 'place hint: ' + G.hud.toolHint);
        for (let k = 0; k < 6; k++) { pl.secondaryDown(slot); pl.secondaryUp(slot); }   // 6 × 15° (touch path; R does the same)
        ok(Math.abs(pl.angle - Math.PI / 2) < 1e-9, 'rotated a quarter turn in 15° steps: ' + pl.angle);
        const n0 = I.count('truhla');
        clearEv();
        pl.primaryDown(slot);
        const s = free.structure;
        ok(s && s.type === 'chest' && s.rotation === 1, 'placed rotated chest');
        eq(I.count('truhla'), n0 - 1, 'item consumed');
        ok(last('build:structure') && last('build:structure').type === 'chest', 'build:structure');
        aimCell((free.i + 0.5) * 2 - 1.5, (free.j + 0.5) * 2 - 1.5, free.i, free.j);
        I.add('truhla', 1, 'debug');
        pl.update(0.016, I.getSelected());
        eq(pl.ok, false, 'occupied'); ok(/Tady už něco stojí/.test(G.hud.toolHint), 'occupied hint');
        pl.onUnequip();
        S.chest2 = s;
      });

      step('destroyed tile spills its structure', () => {
        const s = S.chest2, t = s.tile;
        I.addTo(s.data.storage, 'kov', 2);
        const spilled = [];
        G.debris = { list: [], collect() {}, spawnItem: (id, n, pos) => spilled.push([id, n, pos && pos.isVector3]) };
        clearEv();
        R.damageTile(t, 1000, 'cannon');
        ok(!R.structures.includes(s), 'structure lost with tile');
        ok(spilled.some((x) => x[0] === 'kov' && x[1] === 2 && x[2]), 'contents float: ' + JSON.stringify(spilled));
        ok(spilled.some((x) => x[0] === 'truhla' && x[1] === 1), 'chest itself floats');
        ok(last('structure:removed') && last('tile:destroyed'), 'events');
        G.debris = oldDebris;
      });

      step('storm', () => {
        if (!G.world) return;
        const old = G.world.storm;
        G.world.storm = 1;
        clearEv();
        run(26);
        G.world.storm = old;
        ok(evs('tile:damaged').some((e) => e.source === 'storm' && e.amount === 8), 'storm damage');
      });

      step('foreign structure type (like pirates.js cannon)', () => {
        mod.reset();
        G.debug.buildRing();
        const log = { created: 0, previews: 0, used: 0, removed: 0, upd: 0 };
        const phantom = { getPosition: (o) => o.set(0, 0, 0), label: 'phantom', onInteract() {} };
        R.registerStructure('zz_test', {
          name: 'Testovací bedna', item: 'kamen',
          create(s) {
            ok(s.tile && typeof s.tile.i === 'number', 'create gets a tile');
            if (s.ghost) { log.previews++; G.interaction.add(phantom); } else log.created++;
            const g = new THREE.Group();
            g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardMaterial()));
            return g;
          },
          interact: { label: (s) => 'Test ' + (s.data.n || 0), onInteract: (s) => { s.data.n = (s.data.n || 0) + 1; log.used++; } },
          update(s, dt) { log.upd++; },
          remove(s) { log.removed++; },
        });
        const t = R.edgeTiles()[0];
        const s = R.placeStructure('zz_test', t, 2);
        ok(s && log.created === 1, 'foreign placed');
        ok(s.object.children[0].castShadow, 'foreign meshes cast shadows');
        use(s); eq(s.data.n, 1, 'foreign interact');
        mod.update(0.016); ok(log.upd > 0, 'foreign update');
        const data = JSON.parse(JSON.stringify(mod.save()));
        const e = data.structures.find((x) => x.type === 'zz_test');
        ok(e && e.data.n === 1 && e.rotation === 2, 'default save = s.data');
        mod.reset();
        eq(log.removed, 1, 'remove() on reset');
        mod.load(data);
        const s2 = R.findStructures('zz_test')[0];
        ok(s2 && s2.data.n === 1 && s2.rotation === 2, 'default load merges data');
        // preview via the place tool: sandboxed registries
        G.items.defs.zz_item = { id: 'zz_item', name: 'Testovací bedna', icon: '?', color: '#888', stack: 5, category: 'placeable', desc: '', tool: 'place', place: 'zz_test' };
        I.add('zz_item', 1, 'debug');
        const slot = select('zz_item'), pl = G.tools.get('place');
        const nIt = G.interaction.items.size;
        pl.onEquip(slot);
        const free = Array.from(R.tiles.values()).find((x) => !x.structure);
        aimCell((free.i + 0.5) * 2 - 1.5, (free.j + 0.5) * 2 - 1.5, free.i, free.j);
        pl.update(0.016, slot);
        ok(log.previews >= 1, 'preview created');
        ok(!G.interaction.items.has(phantom) && G.interaction.items.size === nIt, 'no phantom interactables from previews');
        pl.primaryDown(slot);
        ok(free.structure && free.structure.type === 'zz_test', 'placed via tool');
        pl.onUnequip();
        I.remove('zz_item', I.count('zz_item'));
        delete G.items.defs.zz_item;
        mod.reset();
        delete R.structureDefs.zz_test;
      });

      step('span limit & debug hooks', () => {
        mod.reset();
        for (let i = 1; i <= 30; i++) R.addTile(i, 0);
        eq(R.canBuildAt(31, 0), 'size', 'span limit'); eq(R.build(31, 0), false, 'no build past limit');
        G.debug.buildRing();
        for (const t of R.tiles.values()) ok(t.i >= -1 && t.i <= 30, 'ring respects span');
        mod.reset();
        eq(G.debug.buildRing(), 8, 'buildRing');
        const n = R.count();
        ok(G.debug.damageRaft() > 0, 'damageRaft');
        eq(R.count(), n, 'damageRaft never destroys');
        ok(Array.from(R.tiles.values()).some((t) => t.hp < t.maxHp), 'some tile damaged');
      });
    } finally {
      for (const [n, fn] of hs) G.events.off(n, fn);
      G.debris = oldDebris;
      G.ui = oldUi;
      if (hadPlayer) { P.eye = oldEye; P.forward = oldFwd; } else delete G.player;
    }

    // leave a showcase for the screenshot
    mod.reset();
    G.debug.raftShowcase();
    G.raft.damageTile(G.raft.getTile(-1, -1), 45, 'storm');
    return { checks: checks.length, names: checks };
  });
  note('passed ' + result.checks + ' checks: ' + result.names.join(', '));
};
