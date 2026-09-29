// Scenario for debris.js: start burst, hand pickup with E (plank, barrel, loot bundle), the hook
// tool driven by the real mouse (charge → throw → float → hold to reel → auto-collect), RMB cancel,
// throws that would land on the raft, collecting into a storage (net), overflow bundles, drift &
// despawn, debrisRain and reset. Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/debris.mjs --shot /tmp/debris.png
export default async (page, h) => {
  const note = (t) => process.stderr.write('[debris scenario] ' + t + '\n');
  const fail = (m) => { throw new Error('[debris] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); };
  // Headless SwiftShader runs slowly (dt is capped), so wait for conditions instead of fixed times.
  const until = async (fn, arg, ms = 12000, what = 'condition') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await h.eval(fn, arg)) return true;
      await h.wait(60);
    }
    fail('timed out waiting for ' + what);
  };
  const hookState = () => h.eval(() => G.debris.hookState());

  // Without ui.js the boot message would cover the screenshot.
  await h.eval(() => { if (!G.ui) { const b = document.getElementById('boot-msg'); if (b) b.remove(); } });
  await page.mouse.move(640, 360);      // park the mouse: h.mouse() moves here before each click
  await h.wait(200);

  // --- API, tool, start burst ---------------------------------------------------------------
  const s0 = await h.eval(() => {
    window.__dbg = { collected: [], gained: [] };
    G.events.on('debris:collected', (e) => window.__dbg.collected.push(e));
    G.events.on('item:gained', (e) => window.__dbg.gained.push(e));
    const D = G.debris;
    return {
      api: !!D && Array.isArray(D.list) && ['spawn', 'spawnItem', 'collect'].every((k) => typeof D[k] === 'function'),
      tool: !!G.tools.get('hook') && !!G.tools.get('hook').viewModel,
      rain: typeof G.debug.debrisRain === 'function',
      n: D.list.length,
      types: [...new Set(D.list.map((d) => d.type))],
      player: !!(G.player && G.player.teleport && G.player.hand),
    };
  });
  ok(s0.api, 'G.debris API (list/spawn/spawnItem/collect)');
  ok(s0.tool, 'hook tool with a viewModel registered');
  ok(s0.rain, 'G.debug.debrisRain');
  ok(s0.n >= 6, 'start burst spawned (got ' + s0.n + ')');
  ok(s0.player, 'player.js present (teleport + hand)');
  note('start burst: ' + s0.n + ' items, types ' + s0.types.join(','));

  // --- hand pickup ---------------------------------------------------------------------------
  // Stand at the -Z edge, look down at the water ~1 m past the edge and float things right there.
  const aimSpot = await h.eval(() => {
    G.debris.clear();
    G.inventory.select(G.inventory.firstIndexOf ? Math.max(0, G.inventory.firstIndexOf('hak')) : 0);
    G.player.teleport(0, -1.6);
    G.player.yaw = 0;
    G.player.pitch = -Math.atan2(G.raft.deckY() + G.C.PLAYER_HEIGHT, 1.4);
    return { x: 0, z: -3.0 };
  });
  await h.wait(300);

  const pickByE = async (kind, arg, expectLabel) => {
    await h.eval(([k, a, s]) => {
      const p = new THREE.Vector3(s.x, 0, s.z);
      const d = k === 'item' ? G.debris.spawnItem(a[0], a[1], p) : G.debris.spawn(k, p);
      d.age = 5; d.driftK = 0;          // fully afloat, stays put
      window.__target = d;
      window.__dbg.collected.length = 0;
      window.__dbg.gained.length = 0;
    }, [kind, arg, aimSpot]);
    await until(() => G.interaction.current && window.__target && G.interaction.current === window.__target.it, null, 6000,
      'crosshair on ' + kind);
    const label = await h.eval(() => G.interaction.labelOf(G.interaction.current));
    ok(expectLabel.test(label), 'label for ' + kind + ': "' + label + '"');
    await h.key('KeyE', 90);
    await until(() => !window.__target.alive, null, 4000, kind + ' picked up with E');
    const r = await h.eval(() => ({ col: window.__dbg.collected.slice(), gained: window.__dbg.gained.slice(), stat: G.stats.debrisCollected }));
    ok(r.col.length === 1 && r.col[0].source === 'debris', kind + ': one debris:collected with source debris');
    return { label, ...r };
  };

  const before = await h.eval(() => G.inventory.count('prkno'));
  const e1 = await pickByE('prkno', null, /^Sebrat: Prkno( ×2)?$/);
  const after = await h.eval(() => G.inventory.count('prkno'));
  ok(after > before, 'plank added to the inventory (' + before + ' → ' + after + ')');
  ok(e1.gained.some((g) => g.id === 'prkno' && g.source === 'debris'), 'item:gained prkno source debris');
  ok(e1.stat >= 1, 'G.stats.debrisCollected counted');
  note('E pickup: "' + e1.label + '" → prkno ' + before + ' → ' + after);

  const invSum = () => h.eval(() => G.inventory.slots.reduce((n, s) => n + (s ? s.count : 0), 0));
  const b0 = await invSum();
  const e2 = await pickByE('sud', null, /^Otevřít sud$/);
  const b1 = await invSum();
  ok(e2.col[0].type === 'sud', 'barrel: debris:collected type sud');
  ok(b1 - b0 >= 5, 'barrel loot is at least 5 items (got ' + (b1 - b0) + ')');
  const ids = [...new Set(e2.gained.map((g) => g.id))];
  ok(['prkno', 'plast', 'list'].every((id) => ids.includes(id)), 'barrel always gives prkno, plast, list (' + ids.join(',') + ')');
  note('barrel: +' + (b1 - b0) + ' items (' + e2.gained.map((g) => g.id + '×' + g.count).join(', ') + ')');

  const z0 = await h.eval(() => G.inventory.count('zlato'));
  const e3 = await pickByE('item', ['zlato', 7], /^Sebrat: Zlaté mince ×7$/);
  const z1 = await h.eval(() => G.inventory.count('zlato'));
  ok(z1 - z0 === 7 && e3.col[0].type === 'bundle', 'loot bundle gives its 7 coins');

  // --- hook: charge, throw, float, reel, auto-collect -----------------------------------------
  const throwHook = async (ms) => {
    await h.mouse('left', ms);
    await until(() => G.debris.hookState().state === 'water', null, 12000, 'hook landing in the water');
    return hookState();
  };
  const durOf = () => h.eval(() => { const s = G.inventory.getSelected(); return s && s.id === 'hak' ? s.dur : null; });
  await h.eval(() => { G.player.pitch = -0.12; G.player.yaw = 0; G.debris.clear(); });
  await h.wait(200);
  const dur0 = await durOf();
  ok(dur0 > 0, 'hook selected with durability');
  // charge progress shows on the HUD while LMB is held
  await page.mouse.down();
  await until(() => G.debris.hookState().state === 'charging' && G.hud.progress > 0.2 && G.hud.progressLabel === 'Síla hodu', null, 6000, 'charge progress');
  const hint = await h.eval(() => G.hud.toolHint);
  await until(() => G.hud.progress >= 0.6, null, 8000, 'charge ≥ 0.6');
  await page.mouse.up();
  await until(() => G.debris.hookState().state === 'flying', null, 4000, 'hook flying');
  await until(() => G.debris.hookState().state === 'water', null, 12000, 'hook landing');
  await until(() => /navíjet/.test(G.hud.toolHint), null, 3000, 'reel hint while floating');
  const hs1 = await hookState();
  const d1 = await h.eval((s) => {
    const p = G.player.position;
    return { dist: Math.hypot(s.x - p.x, s.z - p.z), onRaft: !!G.raft.tileAt(s.x, s.z), prog: G.hud.progress, hint: G.hud.toolHint };
  }, hs1);
  ok(d1.dist > 7 && d1.dist < 26, 'throw distance plausible (' + d1.dist.toFixed(1) + ' m)');
  ok(!d1.onRaft, 'hook floats off the raft');
  ok(d1.prog === null, 'charge progress cleared after the throw');
  ok(/navíjet/.test(d1.hint), 'reel hint while floating ("' + d1.hint + '")');
  note('throw: landed ' + d1.dist.toFixed(1) + ' m away; charge hint "' + hint + '"');

  // float a plank and a barrel next to the hook; they must hook on
  await h.eval((s) => {
    const a = G.debris.spawn('prkno', new THREE.Vector3(s.x + 0.6, 0, s.z + 0.2)); a.age = 5;
    const b = G.debris.spawn('sud', new THREE.Vector3(s.x - 0.4, 0, s.z - 0.5)); b.age = 5;
    window.__hooked = [a, b];
    window.__dbg.collected.length = 0;
    window.__dbg.gained.length = 0;
    window.__p0 = G.inventory.count('prkno');
  }, hs1);
  await until(() => window.__hooked.every((d) => d.attached), null, 5000, 'debris attaching to the hook');
  await page.mouse.down();              // hold to reel
  await until(() => G.debris.hookState().reeling, null, 4000, 'reeling');
  await until(() => G.debris.hookState().state === 'idle', null, 45000, 'hook reeled back in');
  await page.mouse.up();
  const r1 = await h.eval(() => ({
    col: window.__dbg.collected.slice(), p1: G.inventory.count('prkno'), p0: window.__p0,
    alive: window.__hooked.map((d) => d.alive), gainedSrc: [...new Set(window.__dbg.gained.map((g) => g.source))],
  }));
  ok(r1.alive.every((a) => !a), 'hooked debris collected');
  ok(r1.col.length === 2 && r1.col.every((c) => c.source === 'hook'), 'two debris:collected with source hook');
  ok(r1.gainedSrc.length === 1 && r1.gainedSrc[0] === 'hook', 'item:gained source hook');
  ok(r1.p1 > r1.p0, 'planks from the hook in the inventory');
  const dur1 = await durOf();
  ok(dur1 === dur0 - 1, 'durability −1 per throw (' + dur0 + ' → ' + dur1 + ')');
  note('hook: reeled in ' + r1.col.map((c) => c.type).join(' + ') + ', prkno ' + r1.p0 + ' → ' + r1.p1);

  // --- RMB cancels: hook snaps back, attached debris stays afloat -----------------------------
  const hs2 = await throwHook(400);
  await h.eval((s) => {
    const a = G.debris.spawn('plast', new THREE.Vector3(s.x + 0.5, 0, s.z)); a.age = 5;
    window.__c = a;
  }, hs2);
  await until(() => window.__c.attached, null, 5000, 'plastic attaching');
  await h.mouse('right', 80);
  await until(() => G.debris.hookState().state === 'idle', null, 6000, 'cancel returns the hook');
  const c1 = await h.eval(() => ({ alive: window.__c.alive, att: window.__c.attached, inList: G.debris.list.includes(window.__c) }));
  ok(c1.alive && !c1.att && c1.inList, 'cancel leaves the debris floating');
  ok((await durOf()) === dur0 - 2, 'cancelled throw also costs 1 durability');

  // --- RMB while charging aborts without throwing ------------------------------------------------
  await page.mouse.down();
  await until(() => G.debris.hookState().state === 'charging', null, 4000, 'charging');
  await h.mouse('right', 80);
  await until(() => G.debris.hookState().state === 'idle', null, 3000, 'charge aborted');
  await page.mouse.up();
  await h.wait(150);
  ok((await hookState()).state === 'idle' && (await durOf()) === dur0 - 2, 'aborted charge does not throw');

  // --- a throw that would land on the deck ends up just past the raft edge ----------------------
  // extend the raft to z = 6 so a minimum-power throw (~6 m) would come down on the deck
  await h.eval(() => {
    for (const [i, j] of [[-1, 1], [0, 1], [-1, 2], [0, 2]]) if (!G.raft.getTile || !G.raft.getTile(i, j)) G.raft.addTile(i, j);
    G.player.teleport(0, -1.6); G.player.yaw = Math.PI; G.player.pitch = -0.5;      // facing +Z, over the raft
  });
  await h.wait(200);
  const hs3 = await throwHook(90);
  const e4 = await h.eval((s) => ({ onRaft: !!G.raft.tileAt(s.x, s.z), z: s.z, b: G.raft.bounds() }), hs3);
  ok(e4.b.maxZ >= 6, 'raft extended for the edge test');
  ok(!e4.onRaft && e4.z > e4.b.maxZ, 'short throw over the raft lands past the far edge (z=' + e4.z.toFixed(2) + ')');
  await h.mouse('right', 80);
  await until(() => G.debris.hookState().state === 'idle', null, 6000, 'hook back');

  // --- the hook works while swimming --------------------------------------------------------------
  await h.eval(() => { G.debris.clear(); G.player.teleport(0, -5.5); G.player.yaw = 0; G.player.pitch = -0.05; });
  await until(() => G.player.inWater, null, 6000, 'player swimming');
  const hs5 = await throwHook(450);
  await h.eval((s) => {
    const a = G.debris.spawn('list', new THREE.Vector3(s.x + 0.4, 0, s.z)); a.age = 5;
    window.__sw = a;
    window.__l0 = G.inventory.count('list');
  }, hs5);
  await until(() => window.__sw.attached, null, 5000, 'leaf attaching');
  await page.mouse.down();
  await until(() => G.debris.hookState().state === 'idle', null, 45000, 'reeled in while swimming');
  await page.mouse.up();
  ok(await h.eval(() => !window.__sw.alive && G.inventory.count('list') > window.__l0), 'hook works while swimming');
  note('swimming: throw + reel ok');
  await h.eval(() => G.player.teleport(0, -1.6));

  // --- collect into a storage (net), overflow into bundles, spawnItem on the deck -----------------
  const s1 = await h.eval(() => {
    const st = G.inventory.createStorage(6);
    const d = G.debris.spawn('sud', new THREE.Vector3(9, 0, 9));
    const n0 = G.debris.list.length;
    window.__dbg.collected.length = 0;
    const res = G.debris.collect(d, st);
    const inSt = st.slots.filter(Boolean).length;
    const tiny = G.inventory.createStorage(1);
    const e = G.debris.spawn('sud', new THREE.Vector3(9, 0, -9));
    const nb = G.debris.list.length;
    const res2 = G.debris.collect(e, tiny);
    const bundles = G.debris.list.length - (nb - 1);
    const onDeck = G.debris.spawnItem('kov', 2, new THREE.Vector3(0.5, 0, 0.5));
    return {
      res, inSt, src: window.__dbg.collected[0] && window.__dbg.collected[0].source, n0, n1: G.debris.list.length,
      res2, tinyUsed: tiny.slots.filter(Boolean).length, bundles,
      deckOk: !G.raft.tileAt(onDeck.position.x, onDeck.position.z), deckLabel: onDeck.label,
      again: G.debris.collect(d, st),
    };
  });
  ok(s1.res && s1.inSt >= 3 && s1.src === 'net', 'collect(d, storage) fills the storage, source net');
  ok(s1.res2 && s1.tinyUsed === 1 && s1.bundles >= 2, 'what does not fit floats on as bundles (' + s1.bundles + ')');
  ok(s1.deckOk, 'spawnItem on the deck is moved into the water');
  ok(s1.deckLabel === 'Sebrat: Kovový šrot ×2', 'bundle label "' + s1.deckLabel + '"');
  ok(s1.again === false, 'a collected item cannot be collected twice');

  // --- drift & despawn, nothing inside the raft ------------------------------------------------------
  const far = await h.eval(() => {
    const w = G.world.windDir;
    const d = G.debris.spawn('prkno', new THREE.Vector3(-w.x * 89.7, 0, -w.z * 89.7));
    d.age = 5;
    window.__far = d;
    const p0 = d.position.clone();
    return { x: p0.x, z: p0.z };
  });
  await until(() => !window.__far.alive, null, 30000, 'far downstream debris despawning');
  await h.eval(() => {
    // one item on a collision course with the raft: it must slide around the deck
    const w = G.world.windDir;
    const d = G.debris.spawn('prkno', new THREE.Vector3(w.x * 4, 0, w.z * 4));
    d.age = 5; d.driftK = 4;
    window.__bump = d;
    window.__bumpBad = 0;
    window.__bumpT = setInterval(() => {
      const p = window.__bump.position;
      if (G.raft.tileAt(p.x, p.z)) window.__bumpBad++;
    }, 30);
  });
  await until(() => { const p = window.__bump.position, w = G.world.windDir; return p.x * w.x + p.z * w.z < -4; }, null, 45000,
    'debris drifting past the raft');
  const bump = await h.eval(() => { clearInterval(window.__bumpT); return window.__bumpBad; });
  ok(bump === 0, 'drifting debris never enters the deck (' + bump + ' samples on a tile)');

  // --- debrisRain, reset ---------------------------------------------------------------------------
  const rain = await h.eval(() => {
    const n0 = G.debris.list.length;
    const n = G.debug.debrisRain();
    const inside = G.debris.list.filter((d) => G.raft.tileAt(d.position.x, d.position.z)).length;
    return { n, grew: G.debris.list.length - n0, inside };
  });
  ok(rain.n === 20 && rain.grew === 20, 'debrisRain spawns 20 items');
  ok(rain.inside === 0, 'no rain debris on the deck');
  const rs = await h.eval(() => {
    const itemsBefore = G.interaction.items.size;
    G.mod('debris').reset();
    return { n: G.debris.list.length, it: G.interaction.items.size, itemsBefore };
  });
  ok(rs.n === 0 && rs.it < rs.itemsBefore, 'reset clears debris and their interactables');
  await until(() => G.debris.list.length >= 6, null, 6000, 'burst after reset');
  note('rain +' + rain.n + ', reset ok, burst respawned');

  // leave a nice scene for the final screenshot: rain around the raft, hook out in the water
  await h.eval(() => {
    G.debug.debrisRain();
    for (const d of G.debris.list) d.age = Math.max(d.age, 3);
    G.player.teleport(0, -1.2);
    G.player.yaw = 0.35; G.player.pitch = -0.2;
  });
  await h.wait(200);
  await throwHook(700);
  note('all debris checks passed');
};
