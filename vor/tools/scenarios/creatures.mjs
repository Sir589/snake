// Scenario for creatures.js + fishing.js: the shark attacks a raft edge (tile hp drops), a real
// spear thrust from the deck hits it (flee), it hunts a swimming player, reinforced rafts are safe,
// killing it drops meat; then the rod: casting from the deck, too-early click, forced bite +
// click → fish in the inventory, RMB cancel, a missed bite, no casting while swimming; save & reset.
// Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/creatures.mjs --shot /tmp/creatures.png
//   (set SHOT_DIR=/some/dir to also save screenshots of the key moments)
import path from 'node:path';

export default async (page, h) => {
  const note = (t) => process.stderr.write('[creatures scenario] ' + t + '\n');
  const fail = (m) => { throw new Error('[creatures] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); };
  // Headless SwiftShader renders slowly and dt is capped, so game time runs behind real time: wait
  // for conditions with a budget in *game* milliseconds (and a generous real-time cap).
  const snapshot = () => h.eval(() => ({ shark: G.shark.state + '/' + G.shark.phase, fish: G.fishing.state,
    time: Math.round(G.time * 10) / 10, state: G.state, paused: G.paused, water: G.player.inWater, hp: G.player.health }));
  const until = async (fn, arg, ms = 15000, what = 'condition') => {
    const g0 = await h.eval(() => G.time), t0 = Date.now();
    for (;;) {
      if (await h.eval(fn, arg)) return true;
      const g = await h.eval(() => G.time);
      // game-time budget; the real-time cap allows game time to run at ~0.05× real time
      if ((g - g0) * 1000 > ms || Date.now() - t0 > ms * 30 + 30000) break;
      await h.wait(50);
    }
    fail('timed out waiting for ' + what + ' ' + JSON.stringify(await snapshot()));
  };
  const shotDir = process.env.SHOT_DIR || null;
  const shot = async (name) => { if (shotDir) await h.shot(path.join(shotDir, name)); };

  // Without ui.js the boot message would cover the screenshot.
  await h.eval(() => { if (!G.ui) { const b = document.getElementById('boot-msg'); if (b) b.remove(); } });
  await page.mouse.move(640, 360);      // park the mouse: h.mouse() moves here before each click
  await h.wait(200);

  // --- API ---------------------------------------------------------------------------------
  const s0 = await h.eval(() => {
    window.__cr = { attack: [], fled: 0, killed: 0, caught: [], gained: [] };
    G.events.on('shark:attack', (e) => window.__cr.attack.push(e && e.target));
    G.events.on('shark:fled', () => { window.__cr.fled++; });
    G.events.on('shark:killed', () => { window.__cr.killed++; });
    G.events.on('fish:caught', (e) => window.__cr.caught.push(e && e.id));
    G.events.on('item:gained', (e) => window.__cr.gained.push(e));
    const S = G.shark, F = G.fishing, rod = G.tools.get('rod');
    const tgt = [...G.combat.targets].find((t) => t.kind === 'shark');
    return {
      shark: !!S && typeof S.present === 'function' && S.position && S.position.isVector3,
      state: S && S.state,
      fishing: !!F && typeof F.forceBite === 'function' && F.bobber && F.bobber.isVector3,
      rod: !!rod && !!rod.viewModel && rod.viewModel.isObject3D,
      debug: typeof G.debug.sharkAttack === 'function' && typeof G.debug.fishBite === 'function',
      target: !!tgt && tgt.radius > 0.5 && typeof tgt.onHit === 'function' && tgt.alive() === false,
      schools: F && F.schools.length,
      gulls: !!G.scene.getObjectByName('gulls'),
      time: G.time,
    };
  });
  ok(s0.shark, 'G.shark API');
  ok(s0.state === 'away', 'no shark at the start of a game (state ' + s0.state + ')');
  ok(s0.fishing, 'G.fishing API');
  ok(s0.rod, "'rod' tool with a viewModel registered");
  ok(s0.debug, 'G.debug.sharkAttack + G.debug.fishBite');
  ok(s0.target, 'shark combat target registered (and not alive yet)');
  ok(s0.schools >= 2, 'ambient fish schools');
  ok(s0.gulls, 'seagulls');
  note('API ok, ' + s0.schools + ' fish schools');

  await h.eval(() => { if (G.debug.god) G.debug.god(true); G.player.teleport(0, 0); });

  // --- the shark attacks the raft ---------------------------------------------------------------
  ok(await h.eval(() => G.debug.sharkAttack()), 'G.debug.sharkAttack() starts an attack');
  ok(await h.eval(() => G.shark.state === 'attackRaft' && !!G.shark.targetTile), 'state attackRaft with a target tile');
  await until(() => G.shark.phase === 'bite', null, 40000, 'the shark to reach the raft edge and bite');
  const bite = await h.eval(() => {
    const t = G.shark.targetTile, p = G.shark.position;
    return { i: t.i, j: t.j, hp: t.hp, max: t.maxHp, onRaft: !!G.raft.tileAt(p.x, p.z), events: window.__cr.attack.slice() };
  });
  ok(!bite.onRaft, 'the shark body stays in the water (outside the raft footprint)');
  ok(bite.events.includes('raft'), "shark:attack {target:'raft'} emitted");
  await until((k) => { const t = G.raft.tiles.get(k); return !t || t.hp < t.maxHp; }, bite.i + ',' + bite.j, 8000, 'tile hp to drop');
  const hpAfter = await h.eval((k) => { const t = G.raft.tiles.get(k); return t ? t.hp : 0; }, bite.i + ',' + bite.j);
  note('bite on tile ' + bite.i + ',' + bite.j + ': hp ' + bite.hp + ' → ' + hpAfter);
  await shot('shark_bite.png');

  // --- a real spear thrust from the deck hits it --------------------------------------------------
  const hasSpear = await h.eval(() => !!G.tools.get('spear') && !!G.items.def('ostep'));
  const aimAtHead = () => h.eval(() => {
    const hp = G.shark.headPosition(), e = G.player.eye();
    G.player.yaw = Math.atan2(-(hp.x - e.x), -(hp.z - e.z));
    G.player.pitch = Math.atan2(hp.y - e.y, Math.hypot(hp.x - e.x, hp.z - e.z));
  });
  if (hasSpear) {
    await h.eval(() => {
      G.inventory.add('ostep', 1, 'debug');
      G.inventory.select(G.inventory.firstIndexOf('ostep'));
      const t = G.shark.targetTile, cx = (t.i + 0.5) * 2, cz = (t.j + 0.5) * 2;
      const hp = G.shark.headPosition();
      const dx = hp.x - cx, dz = hp.z - cz, l = Math.hypot(dx, dz) || 1;
      G.player.teleport(cx + (dx / l) * 0.35, cz + (dz / l) * 0.35);
    });
    await h.wait(350);
    let hit = false;
    for (let k = 0; k < 4 && !hit; k++) {
      await aimAtHead();
      await h.wait(40);
      await aimAtHead();
      await h.mouse('left', 70);
      hit = await until(() => G.shark.state === 'flee' || G.shark.hp < G.shark.maxHp, null, 2000, 'spear hit').catch(() => false);
      if (!hit) await h.wait(700);
    }
    ok(hit, 'a spear thrust from the deck reaches the biting shark');
    note('spear hit the shark from the deck');
  } else {
    note('spear tool missing — hitting the combat target directly');
    await h.eval(() => { const t = [...G.combat.targets].find((x) => x.kind === 'shark'); t.onHit(25, new THREE.Vector3(0, 0, 1), 'spear'); });
  }
  const fl = await h.eval(() => ({ st: G.shark.state, hp: G.shark.hp, fled: window.__cr.fled, d: G.shark.position.length() }));
  ok(fl.st === 'flee', 'the hit shark flees (state ' + fl.st + ')');
  ok(fl.hp === 75, 'spear took 25 hp (hp ' + fl.hp + ')');
  ok(fl.fled === 1, 'shark:fled emitted once');
  await until((d0) => G.shark.position.length() > d0 + 4, fl.d, 8000, 'the shark to swim away');
  note('flee ok (hp ' + fl.hp + ')');

  // --- a swimming player gets hunted ---------------------------------------------------------------
  await h.eval(() => {
    G.inventory.select(0);
    G.debug.sharkSpawn(9);
    if (G.debug.god) G.debug.god(false);
    G.player.health = 100;
    G.player.teleport(0, -6);
  });
  ok(await h.eval(() => G.player.inWater), 'player is swimming');
  await until(() => G.shark.state === 'attackPlayer', null, 3000, 'attackPlayer state');
  await until(() => G.player.health <= 80, null, 20000, 'the shark to bite the swimmer');
  const sw = await h.eval(() => ({ hp: G.player.health, src: G.player.lastDamageSource, ev: window.__cr.attack.slice() }));
  ok(sw.src === 'shark', "damage source 'shark'");
  ok(sw.ev.includes('player'), "shark:attack {target:'player'} emitted");
  note('swimmer bitten: health ' + sw.hp);
  await h.eval(() => { G.player.teleport(0, 0); G.player.health = 100; if (G.debug.god) G.debug.god(true); });
  await until(() => !G.player.inWater, null, 3000, 'back on the raft');
  await until(() => G.shark.state === 'circle', null, 8000, 'the shark to go back to circling');

  // --- reinforced raft: nothing to bite -----------------------------------------------------------
  const reinf = await h.eval(() => {
    const saved = [];
    G.raft.tiles.forEach((t) => { saved.push(t.reinforced); t.reinforced = true; });
    const started = G.shark.startAttack();
    const st = G.shark.state;
    let i = 0;
    G.raft.tiles.forEach((t) => { t.reinforced = saved[i++]; });
    return { started, st };
  });
  ok(!reinf.started && reinf.st === 'circle', 'with every edge tile reinforced the shark only circles');

  // --- killing it drops meat ------------------------------------------------------------------------
  const kill = await h.eval(() => {
    const t = [...G.combat.targets].find((x) => x.kind === 'shark');
    const before = G.debris.list.filter((d) => d.id === 'zralok_maso' && d.alive !== false).length;
    t.onHit(500, new THREE.Vector3(0, 0, 1), 'spear');
    const meat = G.debris.list.filter((d) => d.id === 'zralok_maso' && d.alive !== false);
    return { st: G.shark.state, alive: t.alive(), killed: window.__cr.killed, stat: G.stats.sharksKilled,
      meat: meat.length - before, count: meat.length ? meat[meat.length - 1].count : 0 };
  });
  ok(kill.st === 'dead' && !kill.alive, 'shark dead, target not alive');
  ok(kill.killed === 1 && kill.stat === 1, 'shark:killed + G.stats.sharksKilled');
  ok(kill.meat === 1 && kill.count === 3, 'a floating bundle of 3× zralok_maso');
  note('kill ok, meat bundle spawned');
  await h.wait(600);
  await shot('shark_dead.png');

  // --- fishing ----------------------------------------------------------------------------------
  const rodReady = await h.eval(() => {
    G.inventory.add('udice', 1, 'debug');
    const i = G.inventory.firstIndexOf('udice');
    G.inventory.select(i);
    G.player.teleport(0, -1.4);
    G.player.yaw = 0;            // forward = −Z: out over the raft edge
    G.player.pitch = 0.05;
    return i;
  });
  ok(rodReady >= 0 && rodReady < 8, 'rod in the hotbar');
  await until(() => G.scene.getObjectByName('rod-view') && G.scene.getObjectByName('rod-view').parent === G.player.hand,
    null, 3000, 'rod view model in the hand');
  // hold LMB for `ms` of *game* time (the charge is measured in game time)
  const cast = async (ms) => {
    await page.mouse.down({ button: 'left' });
    await until(() => G.fishing.state === 'charging' && G.hud.progress > 0, null, 3000, 'rod charging');
    const g0 = await h.eval(() => G.time), t0 = Date.now();
    while ((await h.eval(() => G.time)) - g0 < ms / 1000 && Date.now() - t0 < ms * 30 + 30000) await h.wait(30);
    const charging = await h.eval(() => ({ st: G.fishing.state, label: G.hud.progressLabel, p: G.hud.progress }));
    await page.mouse.up({ button: 'left' });
    await until(() => G.fishing.state === 'waiting', null, 8000, 'the bobber to land');
    return charging;
  };
  const ch = await cast(450);
  ok(ch.st === 'charging' && ch.label === 'Síla nahození' && ch.p > 0, 'charging shows HUD progress "Síla nahození"');
  const landed = await h.eval(() => {
    const b = G.fishing.bobber, p = G.player.position;
    return { d: Math.hypot(b.x - p.x, b.z - p.z), onRaft: !!G.raft.tileAt(b.x, b.z), dy: b.y - G.world.waveHeight(b.x, b.z),
      line: G.scene.getObjectByName('fishing-line').visible };
  });
  ok(landed.d >= 3.5 && landed.d <= 16.5, 'bobber lands 4–16 m away (' + landed.d.toFixed(1) + ' m)');
  ok(!landed.onRaft, 'bobber is in the water, not on the deck');
  ok(landed.line, 'fishing line visible');
  note('cast landed ' + landed.d.toFixed(1) + ' m out');
  await shot('fishing_wait.png');

  // too early
  await h.mouse('left', 60);
  await until(() => G.fishing.state === 'reeling' || G.fishing.state === 'idle', null, 3000, 'reel in');
  await until(() => G.hud.toolHint === 'Nic nezabralo.', null, 600, 'too early → "Nic nezabralo."');
  await until(() => G.fishing.state === 'idle', null, 4000, 'rod idle again');
  ok(await h.eval(() => window.__cr.caught.length === 0), 'nothing caught when clicking too early');

  // forced bite + click
  await cast(700);
  const inv0 = await h.eval(() => ({ s: G.inventory.count('sardinka'), m: G.inventory.count('makrela'), t: G.inventory.count('tunak'),
    dur: G.inventory.getSelected().dur }));
  ok(await h.eval(() => G.debug.fishBite()), 'G.debug.fishBite() on a cast');
  await until(() => G.fishing.state === 'bite', null, 3000, 'the bite');
  await until(() => G.hud.progressLabel === 'Záběr! Klikni!' && G.hud.toolHint === 'Záběr! Klikni!', null, 600, 'HUD "Záběr! Klikni!"');
  await h.mouse('left', 40);
  await until(() => window.__cr.caught.length === 1, null, 6000, 'fish:caught');
  await h.wait(200);
  await shot('fishing_catch.png');
  await until(() => G.fishing.state === 'idle', null, 6000, 'catch animation to finish');
  const got = await h.eval((i0) => {
    const id = window.__cr.caught[0];
    const g = window.__cr.gained.find((e) => e.id === id && e.source === 'fish');
    return { id, gained: !!g, delta: G.inventory.count('sardinka') - i0.s + G.inventory.count('makrela') - i0.m + G.inventory.count('tunak') - i0.t,
      stat: G.stats.fishCaught, dur: G.inventory.getSelected() && G.inventory.getSelected().dur };
  }, inv0);
  ok(['sardinka', 'makrela', 'tunak'].includes(got.id), 'caught a known species (' + got.id + ')');
  ok(got.gained && got.delta === 1, "fish added to the inventory with source 'fish'");
  ok(got.stat === 1, 'G.stats.fishCaught = 1');
  ok(got.dur === inv0.dur - 1, 'rod durability −1 (' + inv0.dur + ' → ' + got.dur + ')');
  note('caught ' + got.id + ', rod durability ' + got.dur);

  // RMB cancels
  await cast(300);
  await h.mouse('right', 60);
  await until(() => G.fishing.state === 'idle', null, 4000, 'RMB cancel');
  ok(await h.eval(() => window.__cr.caught.length === 1), 'RMB cancel catches nothing');

  // a missed bite: the fish escapes, the bobber stays out
  await cast(300);
  await h.eval(() => G.debug.fishBite());
  await until(() => G.fishing.state === 'bite', null, 3000, 'second bite');
  await until(() => G.fishing.state === 'waiting', null, 6000, 'the bite window to pass');
  await until(() => G.hud.toolHint === 'Ryba utekla!' && G.hud.progress === null, null, 600, 'missed bite → "Ryba utekla!"');
  await h.mouse('right', 60);
  await until(() => G.fishing.state === 'idle', null, 4000, 'reel in after the miss');

  // no casting while swimming
  await h.eval(() => { G.player.teleport(0, -5); });
  ok(await h.eval(() => G.player.inWater), 'swimming for the no-cast check');
  await h.mouse('left', 400);
  await until(() => /vod/.test(G.hud.toolHint), null, 1500, 'swimming hint shown');
  ok(await h.eval(() => G.fishing.state === 'idle'), 'cannot cast while swimming');
  await h.eval(() => { G.player.teleport(0, 0); });
  note('fishing ok');

  // --- save / load / reset -------------------------------------------------------------------------
  const sv = await h.eval(() => { G.save.write(); const d = G.save.read(); return d && d.modules && d.modules.creatures; });
  ok(sv && sv.st === 'dead' && sv.respawn > 100, 'creatures save: dead shark with a respawn timer');
  const re = await h.eval(() => {
    G.continueGame();
    const a = { st: G.shark.state, alive: G.shark.alive() };
    G.newGame();
    return { a, st: G.shark.state, fish: G.fishing.state, bob: G.scene.getObjectByName('fishing-bobber').visible,
      sharkVis: G.scene.getObjectByName('shark').visible };
  });
  ok(re.a.st === 'dead' && !re.a.alive, 'load restores the dead shark (respawning later)');
  ok(re.st === 'away' && !re.sharkVis, 'new game: no shark until 90 s');
  ok(re.fish === 'idle' && !re.bob, 'new game: no cast / bobber');
  note('save/load/reset ok — all checks passed');
};
