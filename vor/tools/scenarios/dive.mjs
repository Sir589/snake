// ROADMAP 6: diving — Q dives, you swim where you look, breath runs out, the sea bed has corals,
// fish and treasure chests; the raft is a ceiling from below.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/dive.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'dive');
  const { ok, until, gameWait, shot } = L;
  await h.eval(() => { G.debug.god(true); G.debug.teleport(9, 0.5); G.player.pitch = -0.6; });
  await until(() => G.player.inWater, null, 8000, 'swimming next to the raft');

  // --- dive down --------------------------------------------------------------------------------------------
  await h.hold('KeyQ');
  await until(() => G.player.diving && G.player.depth > 2, null, 15000, 'diving under');
  let r = await h.eval(() => ({ under: G.world.underwater, bed: G.seabed.group.visible }));
  ok(r.under && r.bed, 'under water: underwater look and the sea bed is drawn');
  await until(() => G.player.position.y - G.seabed.heightAt(G.player.position.x, G.player.position.z) < 0.2, null, 30000, 'reached the sea bed');
  await h.release('KeyQ');
  r = await h.eval(() => ({ y: G.player.position.y, bed: G.seabed.heightAt(G.player.position.x, G.player.position.z), depth: G.player.depth }));
  ok(r.depth > 8 && r.y >= r.bed, 'standing on the sea bed ' + r.depth.toFixed(1) + ' m down');
  r = await h.eval(() => ({ corals: G.scene.getObjectByName('seabed-branch').count + G.scene.getObjectByName('seabed-brain').count, fish: G.scene.getObjectByName('seabed-fish').visible }));
  ok(r.corals > 50 && r.fish, 'corals (' + r.corals + ') and reef fish around');
  // breath (god mode keeps it full) — switch god off to see it drain
  await h.eval(() => { G.debug.god(false); G.player.health = 100; G.player.breath = 100; });
  await gameWait(2);
  r = await h.eval(() => ({ breath: G.player.breath, bar: !document.getElementById('stat-breath').classList.contains('is-hidden') }));
  ok(r.breath < 97 && r.bar, 'breath runs down under water (' + r.breath.toFixed(1) + '), HUD shows it');
  await h.eval(() => { G.player.pitch = 0.25; G.player.yaw = 0.4; });
  await gameWait(0.3);
  await shot('reef');

  // --- treasure ---------------------------------------------------------------------------------------------
  let chest = await h.eval(() => G.debug.seabedChest());
  if (!chest) {
    // sail on until a chest is in the area
    await h.eval(() => { G.debug.god(true); });
    for (let k = 0; k < 20 && !chest; k++) {
      await h.eval(() => { G.world.groundOffset.x += 16; });
      await gameWait(0.2);
      chest = await h.eval(() => G.debug.seabedChest());
    }
  }
  ok(!!chest, 'a treasure chest lies on the sea bed');
  await h.eval((c) => { G.debug.god(true); const P = G.player; P.position.set(c.x + 1.2, c.y + 0.1, c.z); P.velocity.set(0, 0, 0); P.diving = true; }, chest);
  await gameWait(0.3);
  const gold0 = await h.eval(() => G.inventory.count('zlato'));
  r = await h.eval((c) => {
    const it = Array.from(G.interaction.items).find((x) => x.label && x.label() === 'Otevřít truhlu s pokladem' && (!x.enabled || x.enabled()) &&
      (() => { const v = new THREE.Vector3(); x.getPosition(v); return Math.hypot(v.x - c.x, v.z - c.z) < 0.5; })());
    if (!it) return null;
    it.onInteract();
    return { opened: G.seabed.opened.has(c.key), enabledAfter: it.enabled() };
  }, chest);
  ok(r && r.opened && !r.enabledAfter, 'opened the chest (cannot loot it twice)');
  ok((await h.eval(() => G.inventory.count('zlato'))) > gold0, 'gold from the treasure');
  r = await h.eval(() => { const d = G.mod('seabed').save(); return d.opened.length; });
  ok(r >= 1, 'opened chests are saved');

  // --- out of air: drowning ------------------------------------------------------------------------------
  await h.eval(() => { G.debug.god(false); G.player.health = 100; G.player.breath = 0.5; });
  await until(() => G.player.health < 95, null, 15000, 'drowning hurts');
  ok(true, 'no air → losing health');
  // --- swim up: breath comes back --------------------------------------------------------------------------
  await h.eval(() => { G.player.pitch = 0.9; });
  await h.hold('Space');
  await until(() => !G.player.diving && G.player.inWater, null, 30000, 'back at the surface');
  await h.release('Space');
  await until(() => G.player.breath > 90, null, 15000, 'breath refills');
  ok(true, 'surfaced and caught breath');

  // --- the raft is a ceiling from below ----------------------------------------------------------------------
  await h.eval(() => { G.debug.god(true); const P = G.player; P.position.set(1, G.raft.deckY() - 5.5, 1); P.velocity.set(0, 0, 0); P.diving = true; P.pitch = 1.2; });
  await h.hold('Space');
  await gameWait(2.5);
  await h.release('Space');
  r = await h.eval(() => ({ head: G.player.position.y + 1.8 - G.raft.deckY(), diving: G.player.diving, water: G.player.inWater }));
  ok(r.diving && r.water && r.head <= -0.55, 'cannot come up through the raft (head ' + r.head.toFixed(2) + ' m under the deck)');
};
