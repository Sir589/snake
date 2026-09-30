// ROADMAP 3 (part 1): the big sail across the raft, the mast with a crow's nest, the bed and the
// telescope.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/lookout.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'lookout');
  const { ok, until, gameWait, aimAt, selectItem, shot } = L;
  await h.eval(() => {
    G.debug.god && G.debug.god(true);
    for (let i = -3; i <= 2; i++) for (let j = -3; j <= 2; j++) if (!G.raft.getTile(i, j)) G.raft.addTile(i, j);
  });
  const items = (s, label) => h.eval(([id, lb]) => {
    const st = G.raft.structures.find((x) => x._id === id);
    const it = Array.from(G.interaction.items).find((x) => x.structure === st && (!lb || x.label().includes(lb)));
    return it ? { label: it.label(), enabled: it.enabled ? it.enabled() : true, passive: it.passive ? it.passive() : false } : null;
  }, [s, label]);
  const use = (s, label) => h.eval(([id, lb]) => {
    const st = G.raft.structures.find((x) => x._id === id);
    const it = Array.from(G.interaction.items).find((x) => x.structure === st && (!lb || x.label().includes(lb)));
    it.onInteract();
  }, [s, label]);

  // --- big sail ---------------------------------------------------------------------------------------
  let r = await h.eval(() => {
    const s = G.raft.placeStructure('bigsail', null, 0, undefined, { x: 1, y: 0, z: 1, angle: 0 });
    s._id = 'sail';
    return { placed: !!s, kx: s._v.rig.scale.x, mastY: s.object.children[0].scale.y };
  });
  ok(r.placed && r.kx >= 2 && r.mastY > 1.5, 'big sail placed, rig ' + r.kx.toFixed(2) + '× wide, mast ' + r.mastY + '× tall');
  ok(/Vytáhnout velkou plachtu/.test((await items('sail')).label), 'label: vytáhnout velkou plachtu');
  await use('sail');
  r = await h.eval(() => ({ up: G.raft.sailUp, power: G.raft.sailPower }));
  ok(r.up && r.power > 1.5, 'raised: sail power ' + r.power);
  await until(() => G.raft.speed() > 3.3, null, 40000, 'raft speeds up past 3.3 m/s');
  ok(true, 'the big sail makes the raft faster than the small one (2.2 m/s)');
  await h.eval(() => G.debug.teleport(-3, -3));
  await gameWait(1.5);
  await aimAt(1, (await h.eval(() => G.raft.deckY())) + 4, 1);
  await shot('bigsail');

  // --- mast & crow's nest --------------------------------------------------------------------------------
  await h.eval(() => {
    const s = G.raft.placeStructure('mast', null, 0, undefined, { x: -3, y: 0, z: 1, angle: 0 });
    s._id = 'mast';
  });
  r = await items('mast', 'Vylézt');
  ok(r && r.enabled, 'mast: "Vylézt na stožár" at its foot');
  await use('mast', 'Vylézt');
  await until(() => G.player.onGround && G.player.groundKind === 'nest' && G.player.position.y - G.raft.deckY() > 4.8, null, 10000, 'player in the crow\'s nest');
  r = await h.eval(() => ({ kind: G.player.groundKind, y: G.player.position.y - G.raft.deckY() }));
  ok(r.kind === 'nest' && Math.abs(r.y - 5) < 0.1, 'standing in the nest 5 m up (' + r.kind + ')');
  await gameWait(0.6);
  r = await h.eval(() => G.player.position.y - G.raft.deckY());
  ok(r > 4.8, 'stays up there');
  ok((await items('mast', 'Slézt')).enabled, '"Slézt dolů" offered up top');
  await h.eval(() => { G.debug.island && G.debug.island(); });
  await aimAt(20, 0, 20);
  await shot('nest');
  await use('mast', 'Slézt');
  await until(() => G.player.onGround && Math.abs(G.player.position.y - G.raft.deckY()) < 0.1, null, 10000, 'back on the deck');
  ok(true, 'climbed down');

  // --- telescope -------------------------------------------------------------------------------------------
  await h.eval(() => G.inventory.add('dalekohled', 1, 'debug'));
  await page.mouse.move(640, 360);
  await selectItem('dalekohled');
  await until(() => /přiblížit/.test(G.hud.toolHint), null, 8000, 'telescope hint');
  const isl = await h.eval(() => { const i = G.islands.nearest(); const p = i.position || i.group.position; return { name: i.name, x: p.x, z: p.z }; });
  await aimAt(isl.x, 2, isl.z);
  await page.mouse.down({ button: 'left' });
  await until(() => G.player.zoom === 4 && G.camera.fov < 25, null, 10000, 'zoomed in 4×');
  const hint = await until((n) => G.hud.toolHint.includes(n) && G.hud.toolHint, isl.name, 10000, 'island named in the hint');
  ok(/\d+ m|km/.test(hint), 'telescope names the island with its distance: ' + hint);
  await shot('scope');
  await page.mouse.down({ button: 'right' }); await page.mouse.up({ button: 'right' });
  await until(() => G.player.zoom === 8, null, 8000, '8× zoom');
  await page.mouse.up({ button: 'left' });
  await until(() => G.player.zoom === 1 && G.camera.fov > 60, null, 10000, 'zoom released');
  ok(true, 'zoom 4× → 8× → back to normal');

  // --- bed ---------------------------------------------------------------------------------------------------
  await h.eval(() => {
    const s = G.raft.placeStructure('bed', null, 0, undefined, { x: -3, y: 0, z: -3, angle: Math.PI / 2 });
    s._id = 'bed';
    G.debug.setTime(0.5);
  });
  r = await items('bed');
  ok(r.passive && /jen v noci/.test(r.label), 'by day the bed only says: ' + r.label);
  r = await h.eval(() => {
    G.debug.setTime(0.9);
    G.player.hunger = 80; G.player.thirst = 80; G.player.health = 50;
    return { day: G.world.day };
  });
  const day0 = r.day;
  await gameWait(0.2);
  r = await items('bed');
  ok(!r.passive && r.label === 'Spát do rána', 'at night: ' + r.label);
  await use('bed');
  await until((d) => G.world.day === d + 1 && G.world.dayFraction < 0.35 && !G.uiBlocking(), day0, 15000, 'morning of the next day');
  r = await h.eval(() => ({ f: G.world.dayFraction, hunger: G.player.hunger, thirst: G.player.thirst, hp: G.player.health, night: G.world.isNight() }));
  ok(!r.night && r.hunger < 70 && r.thirst < 70 && r.hp >= 80, 'slept until morning: ' + JSON.stringify(r));
  await shot('morning');
};
