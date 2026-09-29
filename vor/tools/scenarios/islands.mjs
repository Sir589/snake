// Scenario for islands.js: G.debug.island() next to the raft, the ground provider, island:near,
// teleport onto the island → island:visited, gathering from a palm (real E press with the
// crosshair, then onInteract), a stone pile (2 uses) and the wreck, save/load round trip,
// collision-course avoidance, downstream removal, the spawn schedule and reset.
// Throws on the first failed assertion.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/islands.mjs --shot /tmp/islands.png
//   (set ISLAND_SHOTS=/some/dir to also save screenshots from the raft and on the island)
export default async (page, h) => {
  const note = (t) => process.stderr.write('[islands scenario] ' + t + '\n');
  const fail = (m) => { throw new Error('[islands] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); };
  const shots = process.env.ISLAND_SHOTS ? process.env.ISLAND_SHOTS.replace(/\/?$/, '/') : null;
  // Headless SwiftShader runs slowly (dt is capped), so wait for conditions instead of fixed times.
  const until = async (fn, arg, ms = 10000, what = 'condition') => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await h.eval(fn, arg)) return true;
      await h.wait(60);
    }
    fail('timed out waiting for ' + what);
  };

  // Without ui.js the boot message would cover the screenshot.
  await h.eval(() => { if (!G.ui) { const b = document.getElementById('boot-msg'); if (b) b.remove(); } });
  await h.wait(200);

  // --- API ----------------------------------------------------------------------------------------
  const s0 = await h.eval(() => {
    window.__ev = { near: [], visited: [], gained: [], gathered: [] };
    G.events.on('island:near', (e) => window.__ev.near.push(e && e.name));
    G.events.on('island:visited', (e) => window.__ev.visited.push(e && e.name));
    G.events.on('item:gained', (e) => window.__ev.gained.push(e));
    G.events.on('island:gathered', (e) => window.__ev.gathered.push(e && e.kind));
    if (G.debug.god) G.debug.god(true);
    const I = G.islands;
    return {
      api: !!I && Array.isArray(I.list) && typeof I.spawnIsland === 'function' && typeof I.nearest === 'function',
      dbg: typeof G.debug.island === 'function',
      mod: !!G.mod('islands'),
      n: I ? I.list.length : -1,
      next: I && I.timeToNext ? I.timeToNext() : null,
      islandProviders: G.ground.providers.filter((p) => p.kind === 'island').length,
    };
  });
  ok(s0.api, 'G.islands API (list / spawnIsland / nearest)');
  ok(s0.dbg && s0.mod, 'G.debug.island + module registered');
  ok(s0.n === 0 && s0.islandProviders === 0, 'a new game starts with no islands (menu scenery removed)');
  ok(s0.next > 170 && s0.next <= 180, 'first island scheduled at ~180 s (got ' + s0.next + ')');

  // --- debug island next to the raft ---------------------------------------------------------------
  const s1 = await h.eval(() => {
    const dbg = G.debug.island();
    const isl = dbg.island;
    window.__isl = isl;
    const P = isl.provider, c = isl.position;
    // beach edge height: walk outwards along one direction until heightAt returns null
    let edge = null;
    for (let r = isl.hillRadius; r < isl.radius + 1; r += 0.05) {
      const hh = P.heightAt(c.x + r, c.z);
      if (hh === null) break;
      edge = hh;
    }
    return Object.assign(isl.summary(), {
      plain: JSON.stringify(dbg).length < 1000 && dbg.name === isl.name && G.islands.list.includes(isl),
      kind: P.kind, sameVel: P.velocity === G.islands.velocity,
      inGround: G.ground.providers.includes(P), inScene: !!isl.group.parent,
      hc: P.heightAt(c.x, c.z), out: P.heightAt(c.x + isl.radius + 1, c.z), edge,
      raftDist: Math.hypot(c.x, c.z), raftR: G.raft.radius(),
      nearest: G.islands.nearest() === isl,
      labels: [isl.palms[0] && G.interaction.labelOf(isl.palms[0].it), isl.rocks[0] && G.interaction.labelOf(isl.rocks[0].it),
        isl.wreck && G.interaction.labelOf(isl.wreck.it)],
    });
  });
  note('spawned: ' + JSON.stringify(s1));
  ok(s1.plain, 'G.debug.island() returns a plain summary (+ non-enumerable .island)');
  ok(s1.kind === 'island' && s1.sameVel && s1.inGround && s1.inScene, 'ground provider (kind island, shared velocity) + scene');
  ok(s1.hc > 2 && s1.hc < 12, 'hill height at the centre: ' + s1.hc);
  ok(s1.out === null, 'heightAt outside the island is null');
  ok(s1.edge !== null && s1.edge < -0.4 && s1.edge > -0.75, 'beach reaches ~-0.6 at the outer edge: ' + s1.edge);
  ok(s1.palms >= 3 && s1.palms <= 7, 'palms 3–7 (got ' + s1.palms + ')');
  ok(s1.rocks >= 2, 'stone piles');
  ok(s1.wreck, 'debug island has a wreck');
  ok(s1.nearest, 'nearest() returns it');
  ok(s1.raftDist - s1.radius >= s1.raftR + 8 - 0.01, 'clear of the raft: shore ' + (s1.raftDist - s1.radius).toFixed(1) + ' m');
  ok(s1.raftDist < 60, 'debug island is close (' + s1.raftDist.toFixed(1) + ' m)');
  ok(s1.labels[0] === 'Otrhat palmu' && s1.labels[1] === 'Sebrat kameny' && s1.labels[2] === 'Prohledat vrak',
    'Czech labels: ' + s1.labels.join(' | '));

  await until(() => window.__ev.near.length === 1, null, 5000, 'island:near');
  ok((await h.eval(() => window.__ev.near[0])) === s1.name, 'island:near carries the name');

  // --- moves with the ground ---------------------------------------------------------------------------
  const m0 = await h.eval(() => ({ x: __isl.position.x, z: __isl.position.z, t: G.time }));
  await h.wait(900);
  const m1 = await h.eval(() => {
    const v = G.islands.velocity, r = G.raft.velocity;
    return { x: __isl.position.x, z: __isl.position.z, t: G.time, vx: v.x, vz: v.z, rx: r.x, rz: r.z, sp: Math.hypot(r.x, r.z) };
  });
  ok(Math.abs(m1.vx + m1.rx) < 1e-6 && Math.abs(m1.vz + m1.rz) < 1e-6, 'provider velocity = -raft.velocity');
  const moved = Math.hypot(m1.x - m0.x, m1.z - m0.z), expect = m1.sp * (m1.t - m0.t);
  ok(Math.abs(moved - expect) < 0.05 + expect * 0.2, 'island drifts with the ground: moved ' + moved.toFixed(3) + ' expected ' + expect.toFixed(3));
  ok((m1.x - m0.x) * m1.rx + (m1.z - m0.z) * m1.rz <= 1e-6, 'moves against the raft velocity');

  if (shots) {
    await h.eval(() => {
      const e = G.player.eye(new THREE.Vector3());
      G.player.yaw = Math.atan2(-(__isl.position.x - e.x), -(__isl.position.z - e.z));
      G.player.pitch = -0.03;
    });
    await h.wait(600);
    await h.shot(shots + 'islands_from_raft.png');
  }

  // --- step onto the island → island:visited -------------------------------------------------------------
  const v = await h.eval(() => {
    const isl = __isl;
    // a dry beach point on the side facing the raft
    const a = Math.atan2(-isl.position.z, -isl.position.x);
    let x = 0, z = 0;
    for (let r = isl.radius; r > 0; r -= 0.25) {
      x = isl.position.x + Math.cos(a) * r; z = isl.position.z + Math.sin(a) * r;
      const hh = isl.provider.heightAt(x, z);
      if (hh !== null && hh > 0.5) break;
    }
    if (G.debug.teleport) G.debug.teleport(x, z);
    else G.player.position.set(x, isl.provider.heightAt(x, z), z);
    return { x, z };
  });
  await until(() => window.__ev.visited.length === 1, null, 6000, 'island:visited');
  const s2 = await h.eval(() => ({ stat: G.stats.islandsVisited, g: G.player.groundKind, w: G.player.inWater, name: window.__ev.visited[0], vis: __isl.visited }));
  ok(s2.stat === 1 && s2.vis, 'G.stats.islandsVisited = 1');
  ok(s2.g === 'island' && !s2.w, 'standing on the island (' + s2.g + ')');
  ok(s2.name === s1.name, 'island:visited carries the name');
  await h.wait(500);
  ok((await h.eval(() => window.__ev.visited.length)) === 1, 'island:visited only once');
  note('visited ' + s1.name + ' at ' + v.x.toFixed(1) + ',' + v.z.toFixed(1));

  // --- palm: aim with the crosshair and press E ------------------------------------------------------------
  const cnt = () => h.eval(() => ({ list: G.inventory.count('list'), kokos: G.inventory.count('kokos'),
    kamen: G.inventory.count('kamen'), kov: G.inventory.count('kov'), prkno: G.inventory.count('prkno') }));
  let c0 = await cnt();
  const aimed = await h.eval(() => {
    const isl = __isl;
    // the palm with the most open ground around it: stand 1.3 m from the trunk, towards the centre
    let best = null;
    for (const p of isl.palms) {
      const dx = -p.x, dz = -p.z, l = Math.hypot(dx, dz) || 1;
      const sx = isl.position.x + p.x + (dx / l) * 1.3, sz = isl.position.z + p.z + (dz / l) * 1.3;
      const hh = isl.provider.heightAt(sx, sz);
      if (hh !== null && hh < p.y + 0.6) { best = { p, sx, sz }; break; }
    }
    if (!best) return false;
    window.__palm = best.p;
    G.debug.teleport(best.sx, best.sz);
    return true;
  });
  ok(aimed, 'found a spot next to a palm');
  const aimAt = () => h.eval(() => {
    const t = new THREE.Vector3();
    __palm.it.getPosition(t);
    const e = G.player.eye(new THREE.Vector3());
    G.player.yaw = Math.atan2(-(t.x - e.x), -(t.z - e.z));
    G.player.pitch = Math.atan2(t.y - e.y, Math.hypot(t.x - e.x, t.z - e.z));
  });
  let onPalm = false;
  for (let i = 0; i < 40 && !onPalm; i++) {
    await aimAt();
    await h.wait(80);
    onPalm = await h.eval(() => G.interaction.current === __palm.it);
  }
  if (onPalm) {
    ok((await h.eval(() => G.interaction.labelOf(G.interaction.current))) === 'Otrhat palmu', 'prompt label');
    await h.key('KeyE', 90);
    await until(() => __palm.picked, null, 3000, 'palm picked with E');
    note('palm picked with a real E press');
  } else {
    note('WARNING: crosshair never landed on the palm; using onInteract');
    await h.eval(() => __palm.it.onInteract());
  }
  let c1 = await cnt();
  const hadCoco = await h.eval(() => __palm.coco);
  ok(c1.list - c0.list >= 2 && c1.list - c0.list <= 3, 'palm gives 2–3 palm leaves (got ' + (c1.list - c0.list) + ')');
  ok(c1.kokos - c0.kokos === (hadCoco ? 1 : 0), 'coconut only from a palm with coconuts');
  ok(await h.eval(() => !__palm.it.enabled()), 'picked palm is no longer interactable');
  ok(await h.eval(() => window.__ev.gained.some((e) => e.id === 'list' && e.source === 'island')), 'item:gained source island');
  await h.wait(700);
  const fr = await h.eval(() => __isl.fr.filter((f) => f.palm === __palm).map((f) => f.state));
  ok(fr.some((s) => s > 0) && fr.some((s) => s === 0), 'the picked palm drops some fronds and keeps others: ' + fr.join(''));

  // every other palm via onInteract (coconuts only where they hang)
  c0 = await cnt();
  const palms = await h.eval(() => {
    let coco = 0, n = 0;
    for (const p of __isl.palms) { if (p.picked) continue; if (p.coco) coco++; n++; p.it.onInteract(); }
    return { n, coco, all: __isl.palms.every((p) => p.picked) };
  });
  c1 = await cnt();
  ok(palms.all, 'all palms picked');
  ok(c1.list - c0.list >= 2 * palms.n && c1.list - c0.list <= 3 * palms.n, 'palm leaves from the other palms');
  ok(c1.kokos - c0.kokos === palms.coco, 'coconuts: ' + (c1.kokos - c0.kokos) + ' / ' + palms.coco);

  // --- stone pile: 2 uses, shrinks, then gone ---------------------------------------------------------------
  c0 = await cnt();
  const rock = await h.eval(() => {
    const r = __isl.rocks[0];
    r.it.onInteract();
    const after1 = { uses: r.uses, target: r.target, en: r.it.enabled() };
    r.it.onInteract();
    const after2 = { uses: r.uses, target: r.target, en: r.it.enabled() };
    return { after1, after2 };
  });
  c1 = await cnt();
  ok(rock.after1.uses === 1 && rock.after1.target > 0 && rock.after1.target < 1 && rock.after1.en, 'stone pile after 1 use shrinks');
  ok(rock.after2.uses === 0 && rock.after2.target === 0 && !rock.after2.en, 'stone pile used up after 2 uses');
  ok(c1.kamen - c0.kamen >= 2 && c1.kamen - c0.kamen <= 4, 'stones 1–2 per use (got ' + (c1.kamen - c0.kamen) + ')');
  await h.eval(() => __isl.rocks[0].it.onInteract());
  ok((await cnt()).kamen === c1.kamen, 'a used-up pile gives nothing');

  // --- wreck: once ---------------------------------------------------------------------------------------------
  c0 = await cnt();
  await h.eval(() => __isl.wreck.it.onInteract());
  c1 = await cnt();
  ok(c1.kov - c0.kov >= 2 && c1.kov - c0.kov <= 4, 'wreck gives 2–4 kov (got ' + (c1.kov - c0.kov) + ')');
  ok(c1.prkno - c0.prkno >= 1 && c1.prkno - c0.prkno <= 3, 'wreck gives 1–3 prkno (got ' + (c1.prkno - c0.prkno) + ')');
  await h.eval(() => __isl.wreck.it.onInteract());
  const c2 = await cnt();
  ok(c2.kov === c1.kov && c2.prkno === c1.prkno, 'wreck can be searched only once');
  ok(await h.eval(() => !__isl.wreck.it.enabled()), 'searched wreck is no longer interactable');
  ok((await h.eval(() => window.__ev.gathered.slice())).includes('wreck'), 'island:gathered events');
  await until(() => !__isl.lootMesh.visible, null, 8000, 'the wreck chest to pop away');

  if (shots) {
    await h.eval(() => {
      const e = G.player.eye(new THREE.Vector3());
      G.player.yaw = Math.atan2(-(__isl.position.x - e.x), -(__isl.position.z - e.z)) + 0.9;
      G.player.pitch = 0.05;
    });
    await h.wait(700);
    await h.shot(shots + 'islands_on_island.png');
  }

  // --- save / load round trip ------------------------------------------------------------------------------
  const sl = await h.eval(() => {
    const M = G.mod('islands');
    const data = JSON.parse(JSON.stringify(M.save()));
    const before = __isl.summary();
    const pickedBefore = __isl.palms.map((p) => p.picked);
    M.reset();
    const cleared = G.islands.list.length === 0 && !G.ground.providers.some((p) => p.kind === 'island');
    M.load(data);
    const isl = G.islands.list[0];
    return {
      size: JSON.stringify(data).length, cleared, n: G.islands.list.length,
      same: !!isl && isl.name === before.name && isl.palms.length === before.palms && isl.rocks.length === before.rocks &&
        Math.abs(isl.position.x - before.x) < 0.2 && Math.abs(isl.position.z - before.z) < 0.2 &&
        isl.summary().radius === before.radius && isl.summary().hillHeight === before.hillHeight &&
        isl.summary().wreck === before.wreck && isl.summary().hut === before.hut,
      picked: !!isl && isl.palms.every((p, i) => p.picked === pickedBefore[i]),
      rock0: isl && isl.rocks[0].uses, wreck: isl && isl.wreck && isl.wreck.looted, visited: isl && isl.visited, near: isl && isl.near,
      next: G.islands.timeToNext(),
    };
  });
  note('save/load: ' + JSON.stringify(sl));
  ok(sl.cleared, 'reset removes islands and ground providers');
  ok(sl.n === 1 && sl.same, 'load restores the same island (seeded)');
  ok(sl.picked && sl.rock0 === 0 && sl.wreck && sl.visited && sl.near, 'load restores gathered state');
  ok(sl.size < 2000, 'save data is small (' + sl.size + ' bytes)');
  await h.eval(() => { window.__isl = G.islands.list[0]; G.debug.teleport(0, 0); });

  // --- never on a collision course (simulated time) -----------------------------------------------------------
  const cc = await h.eval(() => {
    const M = G.mod('islands');
    const w = G.world.windDir, rr = G.raft.radius();
    const isl = G.islands.spawnIsland({ position: { x: w.x * 140, z: w.z * 140 }, name: 'Testovací ostrov' });
    const need = isl.radius + rr + 8;
    const oldVel = G.raft.velocity.clone();
    G.raft.velocity.set(w.x, 0, w.z).multiplyScalar(2.2);     // sail speed
    const p0 = isl.position.clone();
    M.update(0);                                               // refresh the ground velocity only
    const startMiss = G.islands.closestApproach(isl);
    isl.position.copy(p0);
    let minGap = Infinity, steps = 0;
    for (; steps < 2400; steps++) {
      G.raft.velocity.set(w.x, 0, w.z).multiplyScalar(2.2);
      M.update(0.1);
      if (!isl.alive) break;
      minGap = Math.min(minGap, Math.hypot(isl.position.x, isl.position.z) - need);
      if (steps > 50 && isl.position.x * w.x + isl.position.z * w.z < -60) break;
    }
    G.raft.velocity.copy(oldVel);
    const res = { startMiss, need, minGap, steps, alive: isl.alive };
    G.islands.remove(isl);
    return res;
  });
  note('collision course: ' + JSON.stringify(cc));
  ok(cc.startMiss < 1, 'test island started dead ahead');
  ok(cc.minGap > -0.5, 'island was nudged aside and never came closer than radius + raft + 8 m (min gap ' + cc.minGap.toFixed(2) + ')');

  // --- removal far downstream --------------------------------------------------------------------------------
  const rm = await h.eval(() => {
    const M = G.mod('islands');
    const w = G.world.windDir;
    const isl = G.islands.spawnIsland({ position: { x: -w.x * 270 + -w.z * 40, z: -w.z * 270 + w.x * 40 } });
    const provider = isl.provider, its = isl.its.slice();
    const oldVel = G.raft.velocity.clone();
    let steps = 0;
    for (; steps < 200 && isl.alive; steps++) { G.raft.velocity.set(w.x, 0, w.z).multiplyScalar(0.35); M.update(0.1); }
    G.raft.velocity.copy(oldVel);
    return { alive: isl.alive, steps, inList: G.islands.list.includes(isl), prov: G.ground.providers.includes(provider),
      its: its.some((it) => G.interaction.items.has(it)), parent: !!isl.group.parent };
  });
  ok(!rm.alive && !rm.inList && !rm.prov && !rm.its && !rm.parent, 'island removed 260 m downstream (sinks away): ' + JSON.stringify(rm));

  // --- the schedule spawns one upstream --------------------------------------------------------------------------
  const sch = await h.eval(() => {
    const n0 = G.islands.list.length;
    G.time = G.time + G.islands.timeToNext() + 0.01;
    G.mod('islands').update(0.016);
    const isl = G.islands.list[G.islands.list.length - 1];
    const w = G.world.windDir;
    return { n0, n1: G.islands.list.length, along: isl.position.x * w.x + isl.position.z * w.z,
      lateral: Math.abs(isl.position.x * -w.z + isl.position.z * w.x), radius: isl.radius, rise: isl.rise,
      next: G.islands.timeToNext(), miss: G.islands.closestApproach(isl), need: isl.radius + G.raft.radius() + 8 };
  });
  note('scheduled: ' + JSON.stringify(sch));
  ok(sch.n1 === sch.n0 + 1, 'scheduled island spawned');
  ok(sch.along > 200 && sch.along < 400, 'spawned upstream ~220 m (' + sch.along.toFixed(0) + ')');
  ok(sch.lateral >= 28 && sch.miss >= sch.need, 'lateral offset keeps it off the collision course');
  ok(sch.rise < 1, 'far island rises out of the haze');
  ok(sch.next >= 239 && sch.next <= 401, 'next island in 240–400 s (' + sch.next.toFixed(0) + ')');

  // --- reset (new game) removes everything ----------------------------------------------------------------------
  const rs = await h.eval(() => {
    const its = [];
    for (const isl of G.islands.list) its.push(...isl.its);
    const groups = G.islands.list.map((i) => i.group);
    G.newGame();
    if (G.debug.god) G.debug.god(true);
    return { n: G.islands.list.length, prov: G.ground.providers.some((p) => p.kind === 'island'),
      its: its.some((it) => G.interaction.items.has(it)), groups: groups.some((g) => !!g.parent),
      stat: G.stats.islandsVisited, next: G.islands.timeToNext() };
  });
  ok(rs.n === 0 && !rs.prov && !rs.its && !rs.groups, 'new game: no islands, providers, interactables or meshes left');
  ok(rs.stat === 0 && rs.next > 170, 'new game: counters and schedule reset');
  await h.eval(() => { const isl = G.debug.island(); G.debug.teleport(0, 0); return !!isl; });
  note('all island checks passed');
};
