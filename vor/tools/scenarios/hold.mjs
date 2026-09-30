// ROADMAP 3 (part 2): the below-deck hold (podpalubí). Built with the hammer under a raft tile,
// entered through a hatch; inside it is dry (no swimming, no underwater tint), walled and roofed,
// and furniture can stand on its floor. Saved with the raft.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/hold.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'hold');
  const { ok, until, gameWait, aimAt, selectItem, shot } = L;
  await h.eval(() => {
    G.debug.god && G.debug.god(true);
    G.debug.buildRing();
    G.inventory.add('kladivo', 1, 'debug');
    for (const [id, n] of [['prkno', 30], ['plast', 10], ['kov', 5]]) G.inventory.add(id, n, 'debug');
    G.debug.teleport(0.5, 0.5);
  });

  // --- build it with the hammer (real input) ---------------------------------------------------------
  await page.mouse.move(640, 360);
  await selectItem('kladivo');
  await h.eval(() => { G.build.selected = G.build.types.findIndex((t) => t.id === 'podpalubi'); });
  const dy = await h.eval(() => G.raft.deckY());
  await aimAt(-1, dy, -1);
  await until(() => /Postavit podpalubí/.test(G.hud.toolHint), null, 8000, 'hold hint');
  const k0 = await h.eval(() => G.inventory.count('kov'));
  await h.mouse('left', 90);
  await until(() => G.raft.getTile(-1, -1).hold, null, 8000, 'hold built under tile (-1,-1)');
  ok((await h.eval(() => G.inventory.count('kov'))) === k0 - 1, 'the hold cost its materials');
  await gameWait(0.2);
  ok(/už podpalubí je/.test(await h.eval(() => G.hud.toolHint)), 'hint knows the hold is there');
  let r = await h.eval(() => {
    G.raft.addHold(G.raft.getTile(0, -1), true);          // a second tile: one 4 × 2 m room
    return { hatchNoHold: G.raft.fitReason('hatch', 1, 0, 1, 0), hatchOk: G.raft.fitReason('hatch', -1, 0, -1, 0) };
  });
  ok(r.hatchNoHold === 'hold', 'a hatch needs a hold under it (' + r.hatchNoHold + ')');
  ok(r.hatchOk === '', 'hatch fits over the hold');
  await gameWait(0.2);
  r = await h.eval(() => ({ meshes: G.scene.getObjectByName('holds').children.length }));
  ok(r.meshes === 2, 'two hull pieces drawn under the raft');

  // --- down through the hatch ----------------------------------------------------------------------------
  await h.eval(() => {
    G.inventory.select(0);
    const s = G.raft.placeStructure('hatch', null, 0, undefined, { x: -1, y: 0, z: -1, angle: 0 });
    window.__hatch = s;
    const it = Array.from(G.interaction.items).find((x) => x.structure === s && x.label() === 'Slézt do podpalubí');
    it.onInteract();
  });
  await until(() => G.player.onGround && G.player.groundKind === 'hold', null, 10000, 'standing on the hold floor');
  await gameWait(0.5);
  r = await h.eval(() => ({ y: Math.round((G.player.position.y - G.raft.deckY()) * 100) / 100, water: G.player.inWater, under: G.world.underwater, kind: G.player.groundKind }));
  ok(r.y === G_HOLD() && !r.water && !r.under && r.kind === 'hold', 'dry in the hold: ' + JSON.stringify(r));
  function G_HOLD() { return -2.4; }

  // walk into the hull wall (towards open water / a tile without a hold)
  await h.eval(() => { G.player.yaw = Math.PI / 2; G.player.pitch = 0; });   // face -x
  await h.hold('KeyW'); await gameWait(1.2); await h.release('KeyW');
  r = await h.eval(() => ({ x: G.player.position.x, inHold: !!G.raft.holdAt(G.player.position.x, G.player.position.z), water: G.player.inWater, y: G.player.position.y - G.raft.deckY() }));
  ok(r.inHold && !r.water && r.x > -2 + 0.25, 'the hull wall stops the player: ' + JSON.stringify(r));
  await h.eval(() => { G.player.yaw = -Math.PI / 2; });                       // face +x: into the second tile
  await h.hold('KeyW'); await gameWait(1.2); await h.release('KeyW');
  r = await h.eval(() => ({ x: G.player.position.x, water: G.player.inWater }));
  ok(r.x > 0 && r.x < 1.75 && !r.water, 'walks on into the neighbouring hold tile (x ' + r.x.toFixed(2) + ')');
  // jump: the deck is the ceiling
  await h.key('Space', 80);
  await gameWait(0.4);
  r = await h.eval(() => ({ top: G.player.position.y + 1.8 - G.raft.deckY(), water: G.player.inWater }));
  ok(r.top <= -0.3 && !r.water, 'head stays under the deck when jumping (' + r.top.toFixed(2) + ')');
  await h.eval(() => G.debug.teleport && null);
  await aimAt(-1.6, dy - 2.4, -1.6);
  await shot('inside');

  // --- furniture in the hold ---------------------------------------------------------------------------------
  r = await h.eval(() => ({
    chest: G.raft.fitReason('chest', 1, -2.4, -1.2, 0),
    wall: G.raft.fitReason('chest', 1, -2.4, -1.95, 0),
    sail: G.raft.fitReason('sail', 1, -2.4, -1, 0),
    placed: !!G.raft.placeStructure('chest', null, 0, undefined, { x: 1, y: -2.4, z: -1.2, angle: 0 }),
  }));
  ok(r.chest === '' && r.placed, 'a chest stands in the hold');
  ok(r.wall === 'wall', 'not into the hull wall (' + r.wall + ')');
  ok(r.sail === 'tall', 'a sail does not fit under the deck (' + r.sail + ')');
  await gameWait(0.6);
  r = await h.eval(() => G.raft.findStructures('chest')[0].y);
  ok(r === -2.4, 'the chest stays on the hold floor');
  r = await h.eval(() => G.raft.removeHold(G.raft.getTile(0, -1)));
  ok(/V podpalubí ještě něco stojí/.test(r), 'cannot remove a hold with things in it: ' + r);

  // --- back up ------------------------------------------------------------------------------------------------
  await h.eval(() => {
    const s = window.__hatch;
    const it = Array.from(G.interaction.items).find((x) => x.structure === s && x.label() === 'Vylézt na palubu');
    it.onInteract();
  });
  await until(() => G.player.onGround && Math.abs(G.player.position.y - G.raft.deckY()) < 0.05, null, 10000, 'back on the deck');
  ok(true, 'climbed back up through the hatch');

  // --- save / load ---------------------------------------------------------------------------------------------
  r = await h.eval(() => {
    const mod = G.mod('raft');
    const d = JSON.parse(JSON.stringify(mod.save()));
    mod.reset();
    mod.load(d);
    return { holds: Array.from(G.raft.tiles.values()).filter((t) => t.hold).length, chest: G.raft.findStructures('chest').map((s) => s.y) };
  });
  ok(r.holds === 2 && r.chest[0] === -2.4, 'save/load keeps the holds and the chest down there');

  // --- the tile sinks: its hold and what stands in it go too ---------------------------------------------------
  r = await h.eval(() => {
    const t = G.raft.getTile(0, -1);
    G.raft.destroyTile(t, 'shark');
    return { chest: G.raft.findStructures('chest').length, holds: Array.from(G.raft.tiles.values()).filter((x) => x.hold).length };
  });
  ok(r.chest === 0 && r.holds === 1, 'sunk tile takes its hold and chest: ' + JSON.stringify(r));
};
