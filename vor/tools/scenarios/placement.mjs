// Free placement of raft equipment (ROADMAP 1): structures sit anywhere on the deck or on block
// tops, turn in 15° steps, never overlap blocks or each other, drop when their floor goes, and
// keep their exact position through save/load. Also placed once through real input.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/placement.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'placement');
  const { ok, until, gameWait, aimAt, selectItem, shot } = L;
  await h.eval(() => { G.debug.god && G.debug.god(true); G.debug.buildRing(); });

  // --- API: exact position and fine angle -----------------------------------------------------------
  let r = await h.eval(() => {
    const s = G.raft.placeStructure('chest', null, 0, undefined, { x: -1.3, y: 0, z: -2.6, angle: Math.PI / 6 });
    return s && { x: s.object.position.x, z: s.object.position.z, y: s.object.position.y - G.C.DECK_Y, rotY: s.object.rotation.y,
      rot: s.rotation, tile: s.tile && [s.tile.i, s.tile.j], onTile: s.tile && s.tile.structure === s };
  });
  ok(r && Math.abs(r.x + 1.3) < 1e-6 && Math.abs(r.z + 2.6) < 1e-6 && Math.abs(r.y) < 1e-6, 'chest stands off the tile centre: ' + JSON.stringify(r));
  ok(Math.abs(r.rotY - Math.PI / 6) < 1e-6 && Math.abs(r.rot - 1 / 3) < 1e-6, '30° angle kept (rotation ' + r.rot + ')');
  ok(r.tile[0] === -1 && r.tile[1] === -2 && r.onTile, 'belongs to the tile under it');

  r = await h.eval(() => ({
    overlap: G.raft.fitReason('grill', -1.0, 0, -2.6, 0),
    beside: G.raft.fitReason('grill', 0.2, 0, -2.6, 0),
    second: !!G.raft.placeStructure('grill', null, 0, undefined, { x: 0.2, y: 0, z: -2.6, angle: 0 }),
    sameTile: G.raft.getTile(0, -2).structure && G.raft.getTile(0, -2).structure.type,
    edge: G.raft.fitReason('chest', 3.85, 0, 0, 0),
  }));
  ok(r.overlap === 'taken', 'cannot overlap another structure (' + r.overlap + ')');
  ok(r.beside === '' && r.second, 'grill fits right beside the chest');
  ok(r.edge === 'floor', 'cannot hang half over the water (' + r.edge + ')');

  // --- blocks: no overlap, stands on top, drops when the block goes ------------------------------------
  r = await h.eval(() => {
    G.build.add('blok', 0, 0, 0, 0);          // cell x 0..1, z 0..1
    return {
      inWall: G.raft.fitReason('chest', 0.5, 0, 0.5, 0),
      halfIn: G.raft.fitReason('chest', 1.2, 0, 0.5, 0),
      touching: G.raft.fitReason('chest', 1.5, 0, 0.5, 0),
      turnedIn: G.raft.fitReason('chest', 1.5, 0, 0.5, Math.PI / 4),
      onTop: G.raft.fitReason('purifier', 0.5, 1, 0.5, 0),
      netOnTop: G.raft.fitReason('net', 0.5, 1, 0.5, 0),
    };
  });
  ok(r.inWall === 'wall' && r.halfIn === 'wall', 'not even half into a block (' + r.inWall + ', ' + r.halfIn + ')');
  ok(r.touching === '', 'may touch the block side');
  ok(r.turnedIn === 'wall', 'turned 45° it pokes into the block');
  ok(r.onTop === '', 'purifier fits on top of the block');
  ok(r.netOnTop === 'deck', 'net only on the deck (' + r.netOnTop + ')');
  r = await h.eval(() => {
    const s = G.raft.placeStructure('purifier', null, 0, undefined, { x: 0.5, y: 1, z: 0.5, angle: 0 });
    return { placed: !!s, y: s && s.y, blockBlocked: !!G.raft.structureInBox(0, 1, 1, 2, 0, 1) };
  });
  ok(r.placed && r.y === 1, 'purifier placed on the block');
  ok(r.blockBlocked, 'build.js sees the purifier in the cell above the block');
  await h.eval(() => { for (const b of Array.from(G.build.blocks)) G.build.remove(b, false); });
  await until(() => { const s = G.raft.findStructures('purifier')[0]; return s && s.y === 0; }, null, 8000, 'purifier drops onto the deck');
  ok(true, 'knocking out the block drops the purifier onto the deck');

  // over the water on an overhanging block: falls into the sea
  r = await h.eval(() => {
    const b = G.raft.bounds();
    const x = Math.round(b.maxX), z = 0;       // first cell past the raft edge
    G.build.add('blok', x - 1, 0, z, 0);
    G.build.add('blok', x, 0, z, 0);
    const ok1 = G.raft.placeStructure('flag', null, 0, undefined, { x: x + 0.5, y: 1, z: 0.5, angle: 0 });
    return { x, placed: !!ok1, n: G.debris.list.length };
  });
  ok(r.placed, 'flag placed on a block over the water');
  const n0 = r.n;
  await h.eval((x) => { const b = G.build.blocks; for (const k of Array.from(b)) if (k.x === x) G.build.remove(k, false); }, r.x);
  await until(() => G.raft.findStructures('flag').length === 0, null, 8000, 'flag falls into the sea');
  r = await h.eval(() => G.debris.list.filter((d) => d.id === 'vlajka').length);
  ok(r >= 1, 'the flag floats in the sea (hook it back)');
  await h.eval(() => { for (const b of Array.from(G.build.blocks)) G.build.remove(b, false); });

  // --- tile sinks with an off-centre structure on it ----------------------------------------------------
  r = await h.eval(() => {
    const t = G.raft.getTile(1, 0);
    const s = G.raft.placeStructure('chest', null, 0, undefined, { x: 3.1, y: 0, z: 1.0, angle: 0.5 });
    const had = s && s.tile === t;
    G.raft.destroyTile(t, 'shark');
    return { had, gone: !G.raft.structures.includes(s) };
  });
  ok(r.had && r.gone, 'structure on a sunk tile goes into the sea with it');

  // --- save / load keeps exact spots; older saves still load ---------------------------------------------
  r = await h.eval(() => {
    const mod = G.mod('raft');
    const before = G.raft.structures.map((s) => [s.type, s.x, s.y, s.z, Math.round(s.angle * 1000) / 1000]);
    const data = JSON.parse(JSON.stringify(mod.save()));
    mod.reset(); mod.load(data);
    const after = G.raft.structures.map((s) => [s.type, s.x, s.y, s.z, Math.round(s.angle * 1000) / 1000]);
    mod.reset();
    mod.load({ tiles: [{ i: 0, j: 0, hp: 100 }, { i: -1, j: 0, hp: 100 }], structures: [{ type: 'chest', i: 0, j: 0, rotation: 1, data: {} }, { type: 'grill', i: -1, j: 0, rotation: 2, data: {} }] });
    const old = G.raft.structures.map((s) => [s.type, s.x, s.z, s.rotation]);
    return { before, after, old };
  });
  ok(JSON.stringify(r.before) === JSON.stringify(r.after), 'save/load keeps positions: ' + JSON.stringify(r.after));
  ok(JSON.stringify(r.old) === JSON.stringify([['chest', 1, 1, 1], ['grill', -1, 1, 2]]), 'old saves load on tile centres: ' + JSON.stringify(r.old));

  // --- real input: aim off-centre, rotate twice (30°), click ----------------------------------------------
  await h.eval(() => { G.mod('raft').reset(); G.debug.buildRing(); G.inventory.add('truhla', 1, 'debug'); G.debug.teleport(0, 0); });
  await page.mouse.move(640, 360);
  await selectItem('truhla');
  const dy = await h.eval(() => G.raft.deckY());
  await aimAt(-1.3, dy, -2.4);
  await until(() => { const p = G.tools.get('place'); return p.aimed && p.ok; }, null, 10000, 'green ghost');
  await h.key('KeyR', 60);
  await until(() => G.tools.get('place').angle > 0.2, null, 5000, 'first 15° turn');
  await h.key('KeyR', 60);
  await until(() => Math.abs(G.tools.get('place').angle - Math.PI / 6) < 1e-6, null, 5000, 'second 15° turn');
  const hint = await h.eval(() => G.hud.toolHint);
  ok(/Otočit/.test(hint), 'hint: ' + hint);
  await shot('placement-ghost');
  await h.mouse('left', 90);
  r = await until(() => { const s = G.raft.findStructures('chest')[0]; return s && { x: s.x, z: s.z, a: s.angle }; }, null, 10000, 'chest placed');
  ok(Math.abs(r.x + 1.3) < 0.35 && Math.abs(r.z + 2.4) < 0.35 && Math.abs(r.a - Math.PI / 6) < 1e-6, 'chest placed where aimed, turned 30°: ' + JSON.stringify(r));
  ok(Math.abs(r.x + 1) > 0.05 || Math.abs(r.z + 3) > 0.05, 'not snapped to the tile centre');
  await gameWait(0.3);
  await shot('placement-done');
};
