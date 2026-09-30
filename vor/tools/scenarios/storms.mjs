// ROADMAP 5: storms of different strength. A strong storm rocks the whole raft, cracks tiles that
// are not reinforced and sends big waves that can throw the player off the raft (fences help).
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/storms.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'storms');
  const { ok, until, gameWait, shot } = L;
  await h.eval(() => { G.debug.god && G.debug.god(true); G.debug.buildRing(); G.debug.buildRing(); });

  // --- strengths: light vs strong -------------------------------------------------------------------------
  const waves = () => h.eval(() => {
    let m = 0;
    for (let k = 0; k < 80; k++) m = Math.max(m, Math.abs(G.world.waveHeight(k * 3.1 - 120, k * 1.7 - 60)));
    return m;
  });
  let r = await h.eval(() => { G.debug.storm(true, 0.6); return { p: G.world.stormPower, n: G.world.stormName }; });
  ok(r.p === 0.6 && r.n === 'Přeháňka', 'light storm: ' + r.n);
  const light = await waves();
  await h.eval(() => { G.debug.storm(false); G.events.on('world:storm', (e) => { if (e.active) window.__stormText = e.text; }); G.debug.storm(true, 1.5); });
  r = await h.eval(() => ({ p: G.world.stormPower, n: G.world.stormName }));
  ok(r.p === 1.5 && r.n === 'Silná bouře', 'strong storm: ' + r.n);
  const strong = await waves();
  ok(strong > light * 1.25, 'strong storm waves are bigger (' + light.toFixed(2) + ' → ' + strong.toFixed(2) + ' m)');
  r = await h.eval(() => window.__stormText);
  ok(/silná bouře/i.test(r), 'strong storm announcement: ' + r);

  // --- the raft rocks, the player keeps standing on the tilted deck ------------------------------------------
  let maxTilt = 0;
  for (let k = 0; k < 12; k++) {
    await gameWait(0.25);
    const t = await h.eval(() => Math.hypot(G.raft.tiltX, G.raft.tiltZ));
    maxTilt = Math.max(maxTilt, t);
  }
  ok(maxTilt > 0.01, 'the whole raft tilts with the waves (max slope ' + maxTilt.toFixed(3) + ')');
  r = await h.eval(() => {
    G.debug.teleport(3, 1);
    return true;
  });
  await gameWait(0.5);
  r = await h.eval(() => ({ y: G.player.position.y, deck: G.raft.deckYAt(G.player.position.x, G.player.position.z), on: G.player.onGround, water: G.player.inWater, rot: [G.raft.group.rotation.x, G.raft.group.rotation.z] }));
  ok(r.on && !r.water && Math.abs(r.y - r.deck) < 0.06, 'player stands on the tilted deck (' + (r.y - r.deck).toFixed(3) + ' m off)');
  await h.eval(() => { G.player.yaw = 2.2; G.player.pitch = -0.25; });
  await gameWait(0.3);
  await shot('rocking');

  // --- wooden tiles crack, reinforced / metal hold up -----------------------------------------------------
  r = await h.eval(() => {
    const R = G.raft;
    for (const t of R.tiles.values()) { t.hp = t.maxHp; }
    // half of the raft plated with metal
    let n = 0;
    for (const t of R.tiles.values()) if ((t.i + t.j) % 2 === 0) { R.reinforce(t); R.plate(t); n++; }
    G.inventory.add('prkno', 99, 'debug'); G.inventory.add('kov', 99, 'debug');
    for (const t of R.tiles.values()) if ((t.i + t.j) % 2 === 0 && t.level < 2) { R.reinforce(t); R.plate(t); }
    window.__dmg = { wood: 0, metal: 0 };
    G.events.on('tile:damaged', (e) => { if (e && e.source === 'storm' && e.tile) window.__dmg[e.tile.level >= 2 ? 'metal' : 'wood'] += e.amount; });
    return n;
  });
  await until(() => window.__dmg.wood > 30, null, 60000, 'storm cracks wooden tiles');
  r = await h.eval(() => window.__dmg);
  ok(r.wood > r.metal * 2, 'wooden tiles take the beating, metal ones hold (' + Math.round(r.wood) + ' vs ' + Math.round(r.metal) + ')');

  // --- a big wave throws the player off near the edge ----------------------------------------------------------
  const edgeSpot = () => h.eval(() => {
    // stand on the downwind edge: the wave pushes along the wind
    const w = G.world.windDir, R = G.raft, b = R.bounds();
    let best = null, bs = -Infinity;
    for (const t of R.tiles.values()) {
      const cx = (t.i + 0.5) * 2, cz = (t.j + 0.5) * 2, sc = cx * w.x + cz * w.z;
      if (sc > bs && !R.getTile(t.i + Math.round(w.x), t.j + Math.round(w.z))) { bs = sc; best = t; }
    }
    return { x: (best.i + 0.5) * 2 + w.x * 0.6, z: (best.j + 0.5) * 2 + w.z * 0.6, i: best.i, j: best.j };
  });
  let spot = await edgeSpot();
  await h.eval((p) => { G.debug.god(false); G.player.health = 100; G.debug.teleport(p.x, p.z); }, spot);
  await gameWait(0.3);
  await h.eval(() => G.debug.bigWave());
  await until(() => /Velká vlna/.test(document.getElementById('banner-text').textContent), null, 10000, 'big wave warning');
  ok(true, 'warning banner before the big wave');
  await until(() => G.player.inWater, null, 15000, 'player washed into the sea');
  ok(true, 'the big wave threw the player off the raft edge');
  await h.eval(() => { G.debug.god(true); });

  // with a fence along the edge the player stays on board
  spot = await edgeSpot();
  await h.eval((p) => {
    // a little pen of blocks around the player's 1 m cell, right at the downwind edge
    const cx = Math.floor(p.x - G.world.windDir.x * 0.8), cz = Math.floor(p.z - G.world.windDir.z * 0.8);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) G.build.add('blok', cx + dx, 0, cz + dz, 0);
    G.debug.teleport(cx + 0.5, cz + 0.5);
  }, spot);
  await gameWait(0.4);
  const before = await h.eval(() => G.player.inWater);
  ok(!before, 'standing behind the wall');
  await h.eval(() => G.debug.bigWave());
  await gameWait(3.5);
  r = await h.eval(() => ({ water: G.player.inWater, on: G.player.onGround }));
  ok(!r.water, 'a wall along the edge keeps the player on the raft');

  // --- calm again: the raft levels out ------------------------------------------------------------------------------
  await h.eval(() => G.debug.storm(false));
  await until(() => Math.abs(G.raft.tiltX) + Math.abs(G.raft.tiltZ) < 0.001, null, 20000, 'raft level again');
  ok(true, 'after the storm the raft is level');
};
