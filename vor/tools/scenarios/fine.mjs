// Fine building (ROADMAP 2): planks, beams, posts and half blocks on a 25 cm / 50 cm grid, with the
// hammer. Collision for the player and for raft equipment, save/load, tile loss, real input.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/fine.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'fine');
  const { ok, until, gameWait, aimAt, selectItem, shot } = L;
  await h.eval(() => { G.debug.god && G.debug.god(true); G.debug.buildRing(); });

  // --- API ------------------------------------------------------------------------------------------
  let r = await h.eval(() => {
    const B = G.build, base = G.raft.deckY();
    const types = B.types.filter((t) => t.fine).map((t) => t.id);
    const plank = B.addPiece('prkenko', 0.25, 0, 0.5, 0);
    const dup = B.addPiece('prkenko', 0.5, 0, 0.5, 0);
    const beamZ = B.addPiece('tram', -1, 0, -1, 1);
    const post = B.addPiece('sloup', 1.5, 0, 1.5, 0);
    return {
      types,
      plank: plank && [plank.x0, plank.x1, plank.y1, plank.z0, plank.z1],
      dup: !!dup,
      beamZ: beamZ && [beamZ.x1 - beamZ.x0, beamZ.z1 - beamZ.z0],
      post: !!post,
      standPlank: Math.round((B.heightAt(0.7, 0.6, base + 5) - base) * 1000) / 1000,
      wallPost: B.blocked(1.6, 1.6, base + 0.3, base + 1.6, 0),
      chestInPost: G.raft.fitReason('chest', 1.6, 0, 1.6, 0),
      chestOnPlankEdge: G.raft.fitReason('chest', 0.75, 0.125, 0.62, 0),
    };
  });
  ok(r.types.join(',') === 'prkenko,tram,sloup,pulblok', 'fine types: ' + r.types.join(', '));
  ok(JSON.stringify(r.plank) === JSON.stringify([0.25, 1.25, 0.125, 0.5, 0.75]), 'plank 1 × 0.125 × 0.25 m on a 25 cm grid: ' + JSON.stringify(r.plank));
  ok(!r.dup, 'pieces cannot overlap');
  ok(JSON.stringify(r.beamZ) === JSON.stringify([0.25, 1]), 'turned beam runs along z');
  ok(r.post, 'post placed');
  ok(r.standPlank === 0.125, 'the plank top is a floor (' + r.standPlank + ')');
  ok(r.wallPost === true, 'the post blocks walking');
  ok(r.chestInPost === 'wall', 'furniture cannot go into a post');
  ok(r.chestOnPlankEdge === 'floor', 'a chest does not stand level on a single thin plank');

  r = await h.eval(() => {
    const B = G.build;
    // 2 × 2 half blocks = a 1 m platform, 0.5 m high
    for (const [x, z] of [[-2, 1], [-1.5, 1], [-2, 1.5], [-1.5, 1.5]]) B.addPiece('pulblok', x, 0, z, 0);
    return {
      chestOnTop: G.raft.fitReason('chest', -1.5, 0.5, 1.5, 0),
      blockOverPiece: !!B.pieceInBox(-2, -1, 0, 1, 1, 2),
    };
  });
  ok(r.chestOnTop === '', 'a chest stands on a platform of half blocks');
  ok(r.blockOverPiece, 'build.js sees pieces where a 1 m block would go');

  // the player walks up onto a beam (25 cm is a normal step)
  await h.eval(() => { G.build.addPiece('tram', -1.5, 0, -1.5, 1); G.build.addPiece('tram', -1.5, 0, -0.5, 1); G.debug.teleport(-1.375, -2.1); G.player.yaw = Math.PI; G.player.pitch = 0; });
  await h.hold('KeyW'); await gameWait(0.35); await h.release('KeyW'); await gameWait(0.2);
  r = await h.eval(() => ({ y: Math.round((G.player.position.y - G.raft.deckY()) * 100) / 100, z: G.player.position.z }));
  ok(Math.abs(r.y - 0.25) < 0.04, 'player stepped up onto the beam: ' + JSON.stringify(r));
  await h.eval(() => G.debug.teleport(0, 0));

  // --- save / load ----------------------------------------------------------------------------------
  r = await h.eval(() => {
    const mod = G.mod('build'), B = G.build;
    const key = () => Array.from(B.pieces).map((p) => [p.t.id, p.x0, p.y0, p.z0, p.rot].join(':')).sort().join(' ');
    const before = key();
    B.fineStep = 0.5;
    const d = JSON.parse(JSON.stringify(mod.save()));
    mod.reset();
    const empty = B.pieces.size;
    mod.load(d);
    return { same: key() === before, empty, n: B.pieces.size, step: B.fineStep, mesh: G.scene.getObjectByName('build-tram') ? G.scene.getObjectByName('build-tram').count : -1 };
  });
  ok(r.empty === 0 && r.same && r.n === 9, 'save/load keeps all ' + r.n + ' pieces');
  ok(r.step === 0.5, 'grid step saved');
  await gameWait(0.1);
  r = await h.eval(() => [G.scene.getObjectByName('build-tram').count, Array.from(G.build.pieces).filter((p) => p.t.id === 'tram').length]);
  ok(r[0] === r[1] && r[0] === 3, 'beams drawn as instances (' + r[0] + ')');

  // --- a sinking tile takes the pieces on its deck -----------------------------------------------------
  r = await h.eval(() => {
    const B = G.build;
    const p = B.addPiece('tram', 2.25, 0, 0.5, 0);      // tile (1, 0)
    const n0 = B.pieces.size;
    G.raft.destroyTile(G.raft.getTile(1, 0), 'shark');
    return { placed: !!p, gone: !B.pieces.has(p), n: n0 - B.pieces.size };
  });
  ok(r.placed && r.gone, 'beam on a sunk tile is gone');

  // --- real input: hammer, pick "Trám", G = 50 cm grid, R = turn, click, then knock it out -------------
  await h.eval(() => {
    G.mod('build').reset();
    G.inventory.add('kladivo', 1, 'debug');
    G.inventory.add('prkno', 10, 'debug');
    G.debug.teleport(-0.2, -0.2);
  });
  await page.mouse.move(640, 360);
  await selectItem('kladivo');
  await h.eval(() => { G.build.selected = G.build.types.findIndex((t) => t.id === 'tram'); });
  const dy = await h.eval(() => G.raft.deckY());
  await aimAt(-1.1, dy, -2.2);
  await until(() => /Trám|trám/.test(G.hud.toolHint), null, 8000, 'fine hint');
  await h.key('KeyG', 60);
  await until(() => G.build.fineStep === 0.5, null, 5000, 'grid 50 cm');
  await h.key('KeyR', 60);
  await until(() => G.build.fineRot === 1, null, 5000, 'beam turned');
  const hint = await h.eval(() => G.hud.toolHint);
  ok(/G: mřížka 50 cm/.test(hint) && /R: otočit/.test(hint), 'hint: ' + hint);
  await shot('ghost');
  const p0 = await h.eval(() => G.inventory.count('prkno'));
  await h.mouse('left', 90);
  r = await until(() => { const p = Array.from(G.build.pieces)[0]; return p && [p.t.id, p.x0, p.y0, p.z0, p.x1 - p.x0, p.z1 - p.z0]; }, null, 8000, 'beam built');
  ok(r[0] === 'tram' && r[2] === 0 && r[4] === 0.25 && r[5] === 1, 'turned beam on the deck: ' + JSON.stringify(r));
  ok(Math.abs(r[3] / 0.5 - Math.round(r[3] / 0.5)) < 1e-9, 'snapped to the 50 cm grid along the beam (z0 ' + r[3] + ')');
  ok((await h.eval(() => G.inventory.count('prkno'))) === p0 - 1, 'cost one plank');
  await gameWait(0.3);
  await shot('built');
  await until(() => G.hud.toolHint.includes('Rozbít'), null, 8000, 'aiming at the beam');
  await h.mouse('right', 90);
  await until(() => G.build.pieces.size === 0, null, 8000, 'beam knocked out');
  ok((await h.eval(() => G.inventory.count('prkno'))) === p0, 'plank refunded');
};
