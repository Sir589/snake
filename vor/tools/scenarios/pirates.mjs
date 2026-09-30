// Scenario for pirates.js: raid scheduling, the ship (sighting, circling, cannon fire that damages
// raft tiles), the rowboat and boarders (boarding, melee, defeat through their combat targets,
// knock-back off the edge), the player's cannon (placing, sitting with E, aiming, firing with LMB,
// reload, getting up with E / Escape), sinking the ship with loot bundles + stats, the ship
// leaving, save data and a clean reset. Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/pirates.mjs --shot /tmp/pirates.png
// Set PIRATES_SHOTS=<dir> to also save a few screenshots along the way.
export default async (page, h) => {
  const note = (t) => process.stderr.write('[pirates scenario] ' + t + '\n');
  const shots = process.env.PIRATES_SHOTS || '';
  const shot = async (name) => { if (shots) await h.shot(shots + '/' + name + '.png'); };
  const fail = (m) => { throw new Error('[pirates] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); };
  // Wait for `sec` seconds of *game* time (headless frames are slow; dt is clamped to 0.05 s).
  const gw = async (sec) => {
    const target = await h.eval((sec) => G.time + sec, sec);
    await page.waitForFunction((t) => G.state !== 'playing' || G.paused || G.time >= t, target, { timeout: 120000 });
  };
  // Wait (game time) until fn() is truthy.
  const until = async (fn, arg, maxSec, what) => {
    const t0 = await h.eval(() => G.time);
    for (;;) {
      const v = await h.eval(fn, arg);
      if (v) return v;
      const t = await h.eval(() => G.time);
      if (t - t0 > maxSec) fail('timed out waiting for ' + what);
      await gw(0.1);
    }
  };
  const events = (n) => h.eval((n) => window.__pev.filter((e) => e.n === n).map((e) => e.d), n);
  const count = (n) => h.eval((n) => window.__pev.filter((e) => e.n === n).length, n);

  // The first real mouse move produces a big movement delta: do it before anything aims.
  await page.mouse.move(640, 360);
  await h.eval(() => {
    const b = document.getElementById('boot-msg');
    if (b) b.style.display = 'none';
    window.__pev = [];
    for (const n of ['pirates:sighted', 'pirates:boarding', 'pirates:sunk', 'pirates:left', 'pirate:killed', 'tile:damaged',
      'player:damaged', 'item:gained', 'build:structure', 'game:paused']) {
      G.events.on(n, (d) => window.__pev.push({ n, d: d && typeof d === 'object' ? JSON.parse(JSON.stringify(d, (k, v) => (k === 'tile' ? (v ? v.i + ',' + v.j : v) : v))) : d }));
    }
  });
  await gw(0.3);

  // --- API & scheduling ---------------------------------------------------------------------------
  let s = await h.eval(() => ({
    api: !!G.pirates, active: G.pirates.active, ship: G.pirates.ship, next: G.pirates.nextRaidAt,
    spawn: typeof G.pirates.spawnRaid, dbg: typeof G.debug.pirates, cannonDef: !!(G.raft.structureDefs && G.raft.structureDefs.cannon),
  }));
  ok(s.api && s.active === false && s.ship === null, 'fresh state: no raid');
  ok(s.next === 480, 'first raid at 480 s, got ' + s.next);
  ok(s.spawn === 'function' && s.dbg === 'function', 'spawnRaid + debug hook exist');
  ok(s.cannonDef, 'cannon structure registered with raft.js');

  s = await h.eval(() => { G.time = 950; return { started: G.pirates.checkNow(), tiles: G.raft.count() }; });
  ok(!s.started, 'no raid with only ' + s.tiles + ' tiles');
  s = await h.eval(() => { G.time = 300; G.debug.buildRing(); return { started: G.pirates.checkNow(), tiles: G.raft.count() }; });
  ok(!s.started, 'no raid before 480 s');
  s = await h.eval(() => { G.time = 950; return { started: G.pirates.checkNow() }; });
  ok(!s.started, 'no first raid without a spear');
  await h.eval(() => G.inventory.add('ostep', 1, 'debug'));
  s = await h.eval(() => { G.time = 950; const st = G.pirates.checkNow(); const sh = G.pirates.ship;
    return { started: st, tiles: G.raft.count(), active: G.pirates.active, state: sh && sh.state, d: sh ? Math.hypot(sh.position.x, sh.position.z) : 0 }; });
  ok(s.started && s.active, 'raid starts after 600 s with ' + s.tiles + ' tiles');
  ok(s.state === 'approach' && s.d > 150 && s.d < 200, 'ship sails in from ~180 m: ' + s.state + ' ' + s.d.toFixed(1));
  ok((await count('pirates:sighted')) === 1, 'pirates:sighted emitted');
  // the ship moves towards the raft
  const d0 = s.d;
  await gw(1.5);
  s = await h.eval(() => { const sh = G.pirates.ship; return { d: Math.hypot(sh.position.x, sh.position.z), y: sh.object.position.y, vis: sh.object.visible }; });
  ok(s.d < d0 - 3, 'ship approaches: ' + d0.toFixed(1) + ' -> ' + s.d.toFixed(1));
  ok(s.vis && Math.abs(s.y) < 2, 'ship visible & floating');

  // --- fast-forward: ship circling nearby ---------------------------------------------------------
  s = await h.eval(() => { G.debug.god(true); G.player.health = 100; return G.debug.pirates('near'); });
  ok(s && s.state === 'circle', 'debug raid near: ' + JSON.stringify(s));
  await gw(1.5);
  s = await h.eval(() => {
    const sh = G.pirates.ship;
    return { d: Math.hypot(sh.position.x, sh.position.z), state: sh.state, target: [...G.combat.targets].some((t) => t.kind === 'pirate_ship' && t.alive()) };
  });
  ok(s.state === 'circle' && s.d > 30 && s.d < 50, 'ship circles at 35–45 m: ' + s.d.toFixed(1));
  ok(s.target, 'ship is a live combat target');
  await h.eval(() => { const sh = G.pirates.ship; sh.fireT = 999; });
  await shot('01-ship');

  // --- ship cannon fire damages raft tiles ----------------------------------------------------------
  const before = await h.eval(() => { let sum = 0; for (const t of G.raft.tiles.values()) sum += t.hp; return sum; });
  ok(await h.eval(() => G.pirates.shipFire(true)), 'ship fires');
  s = await h.eval(() => ({ balls: G.pirates.balls.length, owner: G.pirates.balls[0] && G.pirates.balls[0].owner }));
  ok(s.balls === 1 && s.owner === 'ship', 'a cannonball is in flight');
  await until(() => window.__pev.some((e) => e.n === 'tile:damaged' && e.d.source === 'cannon'), null, 6, 'cannon tile damage');
  const after = await h.eval(() => { let sum = 0; for (const t of G.raft.tiles.values()) sum += t.hp; return sum; });
  ok(after < before, 'tile hp dropped: ' + before + ' -> ' + after);
  const dmg = (await events('tile:damaged')).filter((e) => e.source === 'cannon');
  ok(dmg.length === 1 && (Math.abs(dmg[0].amount - 25) < 0.01 || Math.abs(dmg[0].amount - 12.5) < 0.01), 'cannon hit = 25 (12.5 reinforced): ' + JSON.stringify(dmg[0]));
  // deliberate miss: splash, no damage
  await h.eval(() => G.pirates.shipFire(false));
  await until(() => G.pirates.balls.length === 0, null, 6, 'miss to land');
  ok((await events('tile:damaged')).filter((e) => e.source === 'cannon').length === 1, 'a miss does not damage tiles');
  // a hit right next to the player hurts (25)
  await h.eval(() => { G.debug.god(false); G.player.health = 100; });
  const hpBefore = await h.eval(() => G.player.health);
  await h.eval(() => {
    G.pirates.shipFire(true);
    const b = G.pirates.balls[G.pirates.balls.length - 1];
    const P = G.player.position;
    b.target.set(P.x + 0.5, b.target.y, P.z);
    const T = b.T, m = b.pos;
    b.vel.set((b.target.x - m.x) / T, (b.target.y - m.y + 0.5 * G.pirates.BALL_G * T * T) / T, (b.target.z - m.z) / T);
  });
  await until(() => G.pirates.balls.length === 0, null, 6, 'close hit');
  s = await h.eval(() => ({ hp: G.player.health, ev: window.__pev.filter((e) => e.n === 'player:damaged' && e.d.source === 'cannon').map((e) => e.d.amount) }));
  ok(s.ev.length === 1 && s.ev[0] === 15 && hpBefore - s.hp > 14, 'cannonball next to the player: -15 hp, got ' + JSON.stringify(s.ev) + ' hp ' + s.hp.toFixed(2));
  await h.eval(() => { G.debug.god(true); G.player.health = 100; for (const t of G.raft.tiles.values()) t.hp = t.maxHp; });

  // --- rowboat & boarders -------------------------------------------------------------------------
  ok(await h.eval(() => G.pirates.launchBoat()), 'rowboat launched');
  s = await h.eval(() => ({ n: G.pirates.boarders.length, st: G.pirates.boarders.map((b) => b.state), boat: G.pirates.boat.state,
    targets: [...G.combat.targets].filter((t) => t.kind === 'pirate').length }));
  ok(s.n >= 2 && s.n <= 3 && s.st.every((x) => x === 'boat'), '2–3 boarders in the boat: ' + JSON.stringify(s));
  ok(s.boat === 'row' && s.targets === s.n, 'boat rows, boarders are combat targets');
  // fast-forward the rowing
  await h.eval(() => { const b = G.pirates.boat; b.pos.set(b.tx + b.dirx * 3, 0, b.tz + b.dirz * 3); });
  await shot('02-boat');
  await until(() => window.__pev.some((e) => e.n === 'pirates:boarding'), null, 12, 'pirates:boarding');
  await until(() => G.pirates.boarders.filter((b) => b.state === 'fight').length === G.pirates.boarders.length, null, 6, 'all boarders on deck');
  s = await h.eval(() => G.pirates.boarders.map((b) => ({ x: b.pos.x, z: b.pos.z, onRaft: !!G.raft.tileAt(b.pos.x, b.pos.z) })));
  ok(s.every((b) => b.onRaft), 'boarders stand on raft tiles');
  // they chase the player
  await h.eval(() => { G.debug.teleport(-1, -1); });
  const dStart = await h.eval(() => Math.min(...G.pirates.boarders.map((b) => Math.hypot(b.pos.x - G.player.position.x, b.pos.z - G.player.position.z))));
  await gw(1.2);
  const dNow = await h.eval(() => Math.min(...G.pirates.boarders.map((b) => Math.hypot(b.pos.x - G.player.position.x, b.pos.z - G.player.position.z))));
  ok(dNow < dStart - 0.5 || dNow < 1.4, 'boarders chase the player: ' + dStart.toFixed(2) + ' -> ' + dNow.toFixed(2));
  // melee: 10 dmg
  await h.eval(() => { G.debug.god(false); G.player.health = 100; });
  await until(() => window.__pev.some((e) => e.n === 'player:damaged' && e.d.source === 'pirate'), null, 8, 'boarder melee hit');
  s = await h.eval(() => window.__pev.filter((e) => e.n === 'player:damaged' && e.d.source === 'pirate')[0].d);
  ok(s.amount === 10, 'melee hit = 10 dmg: ' + JSON.stringify(s));
  await h.eval(() => { G.debug.god(true); G.player.health = 100; });
  await shot('03-boarders');

  // kill one through its combat target (spear hits of 25)
  const gold0 = await h.eval(() => G.inventory.count('zlato'));
  const defeated0 = await h.eval(() => G.stats.piratesDefeated);
  s = await h.eval(() => {
    const b = G.pirates.boarders.find((x) => x.state === 'fight');
    // move it to the middle of the raft so the knock-back cannot push it off
    b.pos.set(1, b.pos.y, 1);
    const t = b.target;
    const dir = new THREE.Vector3(1, 0, 0);
    let hits = 0;
    while (t.alive() && hits < 5) { t.onHit(25, dir, 'spear'); hits++; b.kbx = b.kbz = 0; }
    return { hits, hp: b.hp, state: b.state };
  });
  ok(s.hits === 3 && s.state === 'dying', '60 hp boarder falls after 3 spear hits: ' + JSON.stringify(s));
  s = await h.eval(() => ({ gold: G.inventory.count('zlato'), def: G.stats.piratesDefeated,
    killed: window.__pev.filter((e) => e.n === 'pirate:killed').length,
    src: window.__pev.filter((e) => e.n === 'item:gained' && e.d.id === 'zlato').map((e) => e.d.source) }));
  ok(s.killed === 1 && s.def === defeated0 + 1, 'pirate:killed + stats.piratesDefeated');
  ok(s.gold - gold0 >= 3 && s.gold - gold0 <= 8 && s.src.includes('pirate'), 'gold 3–8 from the pirate: ' + (s.gold - gold0));

  // knock-back off the edge: falls into the sea and is defeated
  s = await h.eval(() => {
    const b = G.pirates.boarders.find((x) => x.state === 'fight' && !x.defeated);
    const bd = G.raft.bounds();
    b.pos.set(bd.maxX - 0.3, b.pos.y, (bd.minZ + bd.maxZ) / 2 + 0.5);
    b.target.onHit(25, new THREE.Vector3(1, 0, 0), 'spear');
    return !!b;
  });
  ok(s, 'second boarder found');
  await until(() => window.__pev.filter((e) => e.n === 'pirate:killed').length === 2, null, 4, 'knock-back defeat');
  s = await h.eval(() => window.__pev.filter((e) => e.n === 'pirate:killed')[1].d.cause);
  ok(s === 'sea', 'second pirate defeated by the sea, got ' + s);

  // --- the player's cannon -----------------------------------------------------------------------
  s = await h.eval(() => {
    G.inventory.add('koule', 8, 'debug');
    // an edge tile on the ship's side, facing the water
    const sh = G.pirates.ship;
    sh.frozen = true; sh.fireT = 999;
    let best = null, bd = Infinity;
    for (const t of G.raft.edgeTiles()) {
      if (t.structure) continue;
      const c = G.raft.tileCenter(t, new THREE.Vector3());
      const d = Math.hypot(c.x - 30, c.z);
      if (d < bd) { bd = d; best = t; }
    }
    const s = G.raft.placeStructure('cannon', best, 1);
    // the ship waits broadside 32 m in front of the cannon
    const c = G.raft.tileCenter(best, new THREE.Vector3());
    sh.position.set(c.x + 32, 0, c.z + 2); sh.heading = 0.1; sh.speed = 0;
    window.__cannon = s;
    return { placed: !!s, i: best.i, j: best.j, cx: c.x, cz: c.z };
  });
  ok(s.placed, 'cannon placed via G.raft.placeStructure');
  // walk up to it and press E
  await h.eval(([cx, cz]) => { G.debug.teleport(cx - 1.4, cz); G.player.yaw = -Math.PI / 2; G.player.pitch = -0.55; }, [s.cx, s.cz]);
  await gw(0.3);
  s = await h.eval(() => ({ cur: G.interaction.current && G.interaction.labelOf(G.interaction.current) }));
  ok(s.cur && s.cur.indexOf('Sednout ke kanónu') === 0, 'aiming at the cannon shows its label: ' + s.cur);
  await h.key('KeyE', 60);
  await gw(0.5);
  s = await h.eval(() => ({ seated: G.pirates.seated, ov: !!G.player.controlOverride, blocked: G.interaction.blocked, hint: G.hud.toolHint, cross: G.hud.crosshair }));
  ok(s.seated && s.ov && s.blocked, 'seated at the cannon: ' + JSON.stringify(s));
  ok(/^Levé tlačítko: Pal! · Koule: \d+ · E: Vstát · V: pohled zezadu$/.test(s.hint), 'cannon hint: ' + s.hint);
  ok(s.cross === 'dot', 'first-person cannon view has a sight dot');
  const camDist = () => h.eval(() => { const v = new THREE.Vector3(); window.__cannon.object.getWorldPosition(v); return G.camera.position.distanceTo(v); });
  s = await camDist();
  ok(s < 1.8, 'first person: the eye is right behind the breech (' + s.toFixed(2) + ' m from the cannon)');
  await shot('03b-cannon-first-person');
  await h.key('KeyV', 60); await gw(0.6);
  s = await camDist();
  ok(s > 2.4, 'V: view from behind (' + s.toFixed(2) + ' m)');
  await h.key('KeyV', 60); await gw(0.6);
  ok((await camDist()) < 1.8, 'V again: back to first person');
  // mouse aims within the limits
  await h.look(-5000, 0);
  await gw(0.15);
  s = await h.eval(() => ({ yaw: window.__cannon.data.yaw, pitch: window.__cannon.data.pitch }));
  ok(Number.isFinite(s.yaw) && Math.abs(s.yaw) <= Math.PI + 1e-6, 'cannon turns all the way round (yaw stays in ±180°): ' + s.yaw);
  await h.look(0, 5000);
  await gw(0.15);
  s = await h.eval(() => window.__cannon.data.pitch);
  ok(Math.abs(s + 5 * Math.PI / 180) < 1e-3, 'pitch clamped to -5°: ' + s);
  // aim at the ship programmatically and fire with the real mouse button
  const aim = () => h.eval(() => { const sh = G.pirates.ship; return G.pirates.aimAt(window.__cannon, sh.position.x, sh.object.position.y + 1.6, sh.position.z); });
  ok(await aim(), 'ship within the cannon arc');
  await gw(0.15);
  s = await h.eval(() => G.pirates.predict());
  ok(s && s.hit === 'ship', 'trajectory preview predicts a hit: ' + JSON.stringify(s));
  await shot('04-seated');
  const koule0 = await h.eval(() => G.inventory.count('koule'));
  await h.mouse('left', 60);
  await gw(0.1);
  s = await h.eval(() => ({ koule: G.inventory.count('koule'), reload: window.__cannon._cv.reload, balls: G.pirates.balls.filter((b) => b.owner === 'player').length, prog: G.hud.progress }));
  ok(s.koule === koule0 - 1 && s.balls === 1, 'LMB fires one ball: ' + JSON.stringify(s));
  ok(s.reload > 2 && s.prog !== null, 'reloading with HUD progress');
  await shot('05-fire');
  await h.mouse('left', 60);
  await gw(0.1);
  ok((await h.eval(() => G.inventory.count('koule'))) === koule0 - 1, 'no second shot while reloading');
  await until(() => G.pirates.ship && G.pirates.ship.hp < G.pirates.ship.maxHp, null, 5, 'player ball to hit the ship');
  s = await h.eval(() => G.pirates.ship.hp);
  ok(s === 240, 'ship hit for 60: hp ' + s);
  // keep firing until it sinks (reload fast-forwarded)
  for (let i = 0; i < 8; i++) {
    const hp = await h.eval(() => G.pirates.ship ? G.pirates.ship.hp : 0);
    if (hp <= 0) break;
    await h.eval(() => { window.__cannon._cv.reload = 0; });
    await aim();
    await h.mouse('left', 60);
    await until((hp) => !G.pirates.ship || G.pirates.ship.hp < hp || G.pirates.balls.filter((b) => b.owner === 'player').length === 0, hp, 6, 'shot ' + i);
    await until(() => G.pirates.balls.filter((b) => b.owner === 'player').length === 0, null, 6, 'ball ' + i + ' to land');
  }
  s = await h.eval(() => ({ hp: G.pirates.ship && G.pirates.ship.hp, state: G.pirates.ship && G.pirates.ship.state, sunk: G.stats.piratesSunk,
    target: [...G.combat.targets].some((t) => t.kind === 'pirate_ship') }));
  ok(s.hp === 0 && s.state === 'sinking', 'ship sinking after 5 hits: ' + JSON.stringify(s));
  ok(s.sunk === 1 && (await count('pirates:sunk')) === 1, 'pirates:sunk + stats.piratesSunk');
  ok(!s.target, 'sinking ship is no longer a combat target');
  await gw(1.5);
  await shot('06-sinking');
  const bundles0 = await h.eval(() => G.debris.list.filter((d) => d.type === 'bundle').length);
  await until(() => !G.pirates.ship, null, 14, 'ship to sink completely');
  s = await h.eval(() => G.debris.list.filter((d) => d.type === 'bundle').map((d) => d.id));
  const loot = s;
  ok(loot.length - 0 >= 4 && ['kov', 'koule', 'zlato', 'prkno'].every((id) => loot.includes(id)), 'loot bundles float: ' + JSON.stringify(loot) + ' (before ' + bundles0 + ')');

  // stand up with E
  await h.key('KeyE', 60);
  await gw(0.2);
  s = await h.eval(() => ({ seated: G.pirates.seated, ov: !!G.player.controlOverride, blocked: G.interaction.blocked, paused: G.paused, cross: G.hud.crosshair }));
  ok(!s.seated && !s.ov && !s.blocked && !s.paused && s.cross === 'dot', 'E gets up: ' + JSON.stringify(s));
  // sit again and get up with Escape (must not pause)
  await h.eval(() => G.pirates.sit(window.__cannon));
  await gw(0.2);
  ok(await h.eval(() => G.pirates.seated), 'seated again');
  await h.key('Escape', 60);
  await gw(0.2);
  s = await h.eval(() => ({ seated: G.pirates.seated, paused: G.paused, state: G.state }));
  ok(!s.seated && !s.paused && s.state === 'playing', 'Escape gets up without pausing: ' + JSON.stringify(s));

  // the raid ends once the last boarder is gone
  await h.eval(() => { for (const b of G.pirates.boarders) if (!b.defeated && b.target) { b.pos.set(1, b.pos.y, 1); b.kbx = b.kbz = 0; for (let i = 0; i < 4 && b.target && b.target.alive(); i++) b.target.onHit(25, new THREE.Vector3(0, 0, 1), 'spear'); } });
  await until(() => !G.pirates.active, null, 6, 'raid to end');
  s = await h.eval(() => ({ next: G.pirates.nextRaidAt, t: G.time, def: G.stats.piratesDefeated }));
  ok(s.next >= s.t + 419 && s.next <= s.t + 601, 'next raid in 420–600 s: ' + (s.next - s.t).toFixed(0));

  // --- a raid where the ship gives up and leaves ---------------------------------------------------
  await h.eval(() => { G.debug.pirates('near'); const sh = G.pirates.ship; sh.fireT = 999; sh.boatLaunched = true; sh.combatTime = 149.9; });
  await until(() => G.pirates.ship && G.pirates.ship.state === 'leave', null, 3, 'ship to leave');
  await h.eval(() => { const sh = G.pirates.ship; const d = Math.hypot(sh.position.x, sh.position.z); sh.position.multiplyScalar(205 / d); });
  await until(() => !G.pirates.ship, null, 3, 'ship to despawn');
  ok((await count('pirates:left')) === 1, 'pirates:left emitted');
  ok(await h.eval(() => !G.pirates.active), 'raid over after the ship left');

  // --- save data -----------------------------------------------------------------------------------
  s = await h.eval(() => { G.save.write(); const d = G.save.read(); return d && d.modules && d.modules.pirates; });
  ok(s && Number.isFinite(s.nextRaidAt), 'save has nextRaidAt: ' + JSON.stringify(s));
  s = await h.eval(() => { const d = G.save.read(); return d.modules.raft.structures.filter((x) => x.type === 'cannon'); });
  ok(s.length === 1 && Number.isFinite(s[0].data.yaw), 'cannon saved by raft.js with its aim');

  // --- reset mid-raid: a new game starts clean --------------------------------------------------------
  await h.eval(() => { G.debug.pirates('near'); G.pirates.launchBoat(); G.pirates.shipFire(true); G.pirates.sit(window.__cannon); });
  await gw(0.3);
  await h.eval(() => G.newGame());
  await gw(0.3);
  s = await h.eval(() => {
    let visible = 0;
    G.scene.traverse((o) => { if (/^pirate-/.test(o.name) && o.visible) visible++; });
    return { active: G.pirates.active, ship: G.pirates.ship, boarders: G.pirates.boarders.length, balls: G.pirates.balls.length,
      seated: G.pirates.seated, ov: !!G.player.controlOverride, blocked: G.interaction.blocked, next: G.pirates.nextRaidAt, visible,
      targets: [...G.combat.targets].filter((t) => /pirate/.test(t.kind)).length };
  });
  ok(!s.active && s.ship === null && s.boarders === 0 && s.balls === 0 && !s.seated && !s.ov && !s.blocked && s.next === 480 && s.visible === 0 && s.targets === 0,
    'new game resets the raid: ' + JSON.stringify(s));
  note('all pirate checks passed');
};
