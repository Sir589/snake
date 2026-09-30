// Storm: starts with world:storm, rain and bigger waves, a UI banner and the storm icon, lightning
// with thunder, storm damage to the raft edge, the player keeps standing on the bobbing raft,
// and the storm ends cleanly. Screenshots by day and at night.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/storm.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'storm');
  const { ok, until, shot, note } = L;

  await h.eval(() => {
    G.debug.god(true);
    window.__st = { ev: [], sfx: [], dmg: [] };
    G.events.on('world:storm', (d) => window.__st.ev.push(d.active));
    G.events.on('sfx', (d) => { if (d.name === 'thunder') window.__st.sfx.push(d.name); });
    G.events.on('tile:damaged', (d) => { if (d.source === 'storm') window.__st.dmg.push(d.amount); });
    G.debug.setTime(0.45);
    G.player.pitch = -0.08;
  });
  const calm = await h.eval(() => {
    let m = 0;
    for (let k = 0; k < 64; k++) m = Math.max(m, Math.abs(G.world.waveHeight(k * 3.1 - 90, k * 1.7 - 50)));
    return m;
  });
  await h.eval(() => G.debug.storm(true));
  await until(() => window.__st.ev.includes(true), null, 10000, 'world:storm {active:true}');
  ok(await h.eval(() => G.world.stormActive() && G.world.storm > 0.9), 'storm active at full strength');
  await until(() => { const r = G.scene.getObjectByName('rain'); return r && r.visible; }, null, 10000, 'rain visible');
  const rough = await h.eval(() => {
    let m = 0;
    for (let k = 0; k < 64; k++) m = Math.max(m, Math.abs(G.world.waveHeight(k * 3.1 - 90, k * 1.7 - 50)));
    return m;
  });
  ok(rough > calm * 1.3, 'waves grow in the storm (' + calm.toFixed(2) + ' → ' + rough.toFixed(2) + ' m)');
  await until(() => /bouř/i.test(document.getElementById('banner-text').textContent) && !document.getElementById('st-storm').classList.contains('is-hidden'), null, 15000, 'storm banner + storm icon');
  ok(true, 'storm banner shown: ' + (await h.eval(() => document.getElementById('banner').textContent.trim())));
  await h.eval(() => G.debug.lightning());
  await until(() => window.__st.sfx.length > 0, null, 30000, 'thunder after lightning');
  ok(true, 'lightning is followed by thunder');
  await shot('day');

  // storm damage to the raft edge (world.js / raft.js, every ~14–24 s of game time)
  await until(() => window.__st.dmg.length > 0, null, 240000, 'storm damage to a raft tile');
  ok(true, 'storm damaged an edge tile by ' + (await h.eval(() => window.__st.dmg[0])));
  ok(await h.eval(() => !G.player.inWater && G.player.alive && Math.abs(G.player.position.y - G.raft.deckY()) < 0.3), 'player still stands on the bobbing raft');

  await h.eval(() => G.debug.setTime(0.95));
  await L.frames(10);
  await shot('night');

  await h.eval(() => G.debug.storm(false));
  await until(() => window.__st.ev.includes(false), null, 10000, 'world:storm {active:false}');
  await until(() => { const r = G.scene.getObjectByName('rain'); return !r || !r.visible; }, null, 20000, 'rain gone');
  ok(await h.eval(() => !G.world.stormActive() && G.world.storm === 0), 'storm over');
  await h.eval(() => { G.debug.god(false); G.debug.setTime(0.4); });
  note('done');
};
