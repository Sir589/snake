// ROADMAP 4: raft tile levels (wood → reinforced → metal) and rafts bigger than 24 × 24.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/tiers.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'tiers');
  const { ok, until, gameWait, aimAt, selectItem, shot } = L;
  await h.eval(() => {
    G.debug.god && G.debug.god(true);
    G.debug.buildRing();
    G.inventory.add('kladivo', 1, 'debug');
    for (const [id, n] of [['prkno', 40], ['plast', 20], ['kov', 20]]) G.inventory.add(id, n, 'debug');
  });

  // --- levels through the API --------------------------------------------------------------------------
  let r = await h.eval(() => {
    const R = G.raft, t = R.getTile(1, 0);
    const out = { start: [t.level, t.maxHp] };
    out.metalFirst = R.plate(t);                       // needs reinforcing first
    R.reinforce(t);
    out.reinforced = [t.level, t.maxHp, t.hp];
    out.metal = R.plate(t);
    out.lvl2 = [t.level, t.maxHp, t.hp, t.reinforced];
    out.shark = R.damageTile(t, 50, 'shark');
    out.cannon = Math.round(R.damageTile(t, 100, 'cannon'));
    out.storm = Math.round(R.damageTile(t, 20, 'storm'));
    return out;
  });
  ok(JSON.stringify(r.start) === '[0,100]', 'new tile: wood, 100 hp');
  ok(r.metalFirst === false, 'metal plating needs a reinforced tile first');
  ok(JSON.stringify(r.reinforced) === '[1,150,150]', 'reinforced: 150 hp');
  ok(r.metal && JSON.stringify(r.lvl2) === '[2,250,250,true]', 'metal: 250 hp ' + JSON.stringify(r.lvl2));
  ok(r.shark === 0 && r.cannon === 35 && r.storm === 6, 'metal takes no shark bites, 35 % cannon, 30 % storm (' + [r.shark, r.cannon, r.storm] + ')');

  // --- with the hammer (real input) ----------------------------------------------------------------------
  await h.eval(() => {
    const t = G.raft.getTile(0, 0);
    G.raft.reinforce(t);
    G.debug.teleport(-0.6, -0.6);
  });
  await page.mouse.move(640, 360);
  await selectItem('kladivo');
  await h.eval(() => { G.build.selected = G.build.types.findIndex((t) => t.id === 'zaklad'); });
  const dy = await h.eval(() => G.raft.deckY());
  await aimAt(1, dy, 1);
  const hint = await until(() => /Okovat základ/.test(G.hud.toolHint) && G.hud.toolHint, null, 8000, 'plating hint');
  ok(/4× Kovový šrot/.test(hint), 'hint: ' + hint);
  const k0 = await h.eval(() => G.inventory.count('kov'));
  await h.mouse('left', 90);
  await until(() => G.raft.getTile(0, 0).level === 2, null, 8000, 'tile (0,0) plated with metal');
  ok((await h.eval(() => G.inventory.count('kov'))) === k0 - 4, 'cost 4 metal');
  await gameWait(0.3);
  ok(/okovaný/.test(await h.eval(() => G.hud.toolHint)), 'plated tile says it is done');
  await aimAt(1.5, dy, 3);
  await shot('metal');

  // --- save / load ----------------------------------------------------------------------------------------
  r = await h.eval(() => {
    const mod = G.mod('raft');
    const d = JSON.parse(JSON.stringify(mod.save()));
    mod.reset(); mod.load(d);
    const lv = G.raft.getTile(0, 0).level;
    mod.reset();
    mod.load({ tiles: [{ i: 0, j: 0, hp: 150, reinforced: 1 }, { i: 1, j: 0, hp: 90 }] });
    return { lv, old: [G.raft.getTile(0, 0).level, G.raft.getTile(0, 0).maxHp, G.raft.getTile(1, 0).level] };
  });
  ok(r.lv === 2, 'save/load keeps the metal level');
  ok(JSON.stringify(r.old) === '[1,150,0]', 'older saves: reinforced → level 1');

  // --- a raft bigger than 24 × 24 ---------------------------------------------------------------------------
  r = await h.eval(() => {
    const R = G.raft;
    G.mod('raft').reset();
    let n = 0;
    for (let k = 0; k < 20; k++) n += G.debug.buildRing();
    const b = R.bounds();
    const spanX = (b.maxX - b.minX) / 2, spanZ = (b.maxZ - b.minZ) / 2;
    // push one more column in every direction: must stop at 32 tiles
    let far = 0;
    const ts = Array.from(R.tiles.values());
    const minI = Math.min(...ts.map((t) => t.i)), maxI = Math.max(...ts.map((t) => t.i));
    const minJ = Math.min(...ts.map((t) => t.j)), maxJ = Math.max(...ts.map((t) => t.j));
    for (const t of ts) {
      if (t.i === maxI && !R.canBuildAt(t.i + 1, t.j)) far++;
      if (t.i === minI && !R.canBuildAt(t.i - 1, t.j)) far++;
      if (t.j === maxJ && !R.canBuildAt(t.i, t.j + 1)) far++;
      if (t.j === minJ && !R.canBuildAt(t.i, t.j - 1)) far++;
    }
    return { n: R.count(), spanX, spanZ, far, radius: R.radius(), mapFar: G.debug.raftMap(-15, 0), mapCorner: G.debug.raftMap(-16, -16) };
  });
  ok(r.spanX === 32 && r.spanZ === 32, 'the raft grows to 32 × 32 tiles (' + r.spanX + ' × ' + r.spanZ + ', ' + r.n + ' tiles)');
  ok(r.far === 0, 'and not a tile further');
  await gameWait(0.8);
  r = await h.eval(() => ({ a: G.debug.raftMap(-16, 0), b: G.debug.raftMap(15, 0), c: G.debug.raftMap(0, 15) }));
  ok(r.a === 255 && r.b === 255 && r.c === 255, 'the water map covers the whole big raft (no sea poking through the deck)');
  r = await h.eval(() => {
    G.debug.teleport(20, 20);
    return true;
  });
  await gameWait(0.4);
  r = await h.eval(() => { const t = G.world.sun.target.position; return { x: t.x, z: t.z }; });
  ok(Math.abs(r.x - 20) <= 1 && Math.abs(r.z - 20) <= 1, 'sun shadows follow the player on a big raft (' + r.x + ', ' + r.z + ')');
  await h.eval(() => { G.player.yaw = -Math.PI * 0.75; G.player.pitch = -0.35; });
  await gameWait(0.3);
  await shot('big');
};
