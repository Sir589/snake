// The first minutes as a new player, with real input only (menu click, look, mouse, keys):
// start from the main menu, read the first goal, hook floating debris until goal 1 (6 planks) is
// done, craft the hammer in the crafting panel, and build a foundation. Also measures how soon
// debris comes within reach and how well the hook works (items per throw).
// The "player" picks targets it can see (floating debris 7–21 m away) and aims with the landing
// ring like a person would. PLAY_SECONDS (game seconds, default 240) caps the hooking phase.
//   node vor/tools/smoke.mjs --menu --seconds 1 --scenario vor/tools/scenarios/newplayer.mjs
import { lib } from '../scenario-lib.mjs';

export const smokeArgs = ['--menu'];

export default async (page, h) => {
  const L = lib(page, h, 'newplayer');
  const { ok, until, shot, note, aimAt } = L;
  const budget = Number(process.env.PLAY_SECONDS || 240);

  // --- menu → new game ---
  await until(() => !document.getElementById('scr-menu').classList.contains('is-hidden'), null, 10000, 'main menu');
  await page.click('#btn-new');
  await until(() => G.state === 'playing', null, 10000, 'Nová hra starts the game');
  await L.freeLook();                                   // headless: free look instead of pointer lock
  await until(() => document.getElementById('goal-text').textContent.trim() !== '' && G.time > 0.1, null, 15000, 'goal card filled');
  const goal = await h.eval(() => ({ text: document.getElementById('goal-text').textContent, hint: G.goals.hintOf(G.goals.current()), tool: G.hud.toolHint }));
  note('goal card: ' + JSON.stringify(goal));
  ok(/prken/.test(goal.text) && /hák/.test(goal.hint), 'first goal tells what to do');
  await L.frames(10);
  await shot('start');

  await h.eval(() => {
    window.__np = { gained: [], first: null, t0: G.time };
    G.events.on('item:gained', (e) => window.__np.gained.push(e.id + 'x' + e.count + ':' + e.source));
  });

  // --- hooking phase ---
  const stats = { throws: 0, items: 0, empty: 0, hits: 0 };
  const pickTarget = () => h.eval(() => {
    const p = G.player.position;
    let best = null, bs = Infinity;
    for (const d of G.debris.list) {
      if (!d.alive || d.attached || d.hooked || d.collected || d.flying) continue;
      const dx = d.position.x - p.x, dz = d.position.z - p.z, dist = Math.hypot(dx, dz);
      if (dist < 7 || dist > 20.5) continue;
      if (G.raft.tileAt(d.position.x, d.position.z)) continue;
      const score = dist - (d.type === 'prkno' || d.type === 'sud' ? 6 : 0);
      if (score < bs) { bs = score; best = { x: d.position.x, z: d.position.z, dist, type: d.type }; }
    }
    if (best && window.__np.first === null) window.__np.first = G.time - window.__np.t0;
    return best;
  });
  const t0 = await h.eval(() => G.time);
  while ((await h.eval(() => G.time)) - t0 < budget) {
    if (await h.eval(() => G.goals.get('prkna').done)) break;
    const tg = await pickTarget();
    if (!tg) { await L.gameWait(1); continue; }
    // aim a little past the item so the hook drags through it on the way back
    const over = await h.eval(([x, z]) => { const p = G.player.position, dx = x - p.x, dz = z - p.z, l = Math.hypot(dx, dz); return [x + dx / l * 1.6, z + dz / l * 1.6, l + 1.6]; }, [tg.x, tg.z]);
    await aimAt(over[0], 0, over[1]);
    const need = await h.eval((D) => { const f = Math.min(1.15, Math.max(0.7, 1 + G.player.pitch * 0.35)); return Math.min(1, Math.max(0, (D / f - 6) / 16)); }, over[2]);
    await page.mouse.down();
    await until((n) => { const s = G.debris.hookState(); return s.state === 'charging' && s.charge >= n - 0.02; }, need, 20000, 'charge');
    await page.mouse.up();
    stats.throws++;
    await until(() => G.debris.hookState().state === 'water', null, 20000, 'hook in the water');
    const got0 = await h.eval(() => window.__np.gained.length);
    await page.mouse.down();                                   // hold to reel in
    await until(() => G.debris.hookState().state === 'idle', null, 90000, 'hook back');
    await page.mouse.up();
    const got = await h.eval((g) => window.__np.gained.slice(g), got0);
    if (got.length) { stats.items += got.length; stats.hits++; } else stats.empty++;
    note('throw ' + stats.throws + ' at ' + tg.type + ' ' + tg.dist.toFixed(1) + ' m → ' + (got.join(' ') || 'nothing') + ' · planks ' + (await h.eval(() => G.goals.get('prkna').progress)) + '/6');
    if (stats.throws === 2) await shot('hooking');
  }
  const res = await h.eval(() => ({ first: window.__np.first, played: G.time - window.__np.t0, goal: G.goals.get('prkna').done, inv: G.inventory.slots.filter(Boolean).map((s) => s.id + 'x' + s.count).join(',') }));
  note('first debris in reach after ' + (res.first === null ? 'never' : res.first.toFixed(1) + ' s') + '; played ' + res.played.toFixed(0) + ' s; ' + JSON.stringify(stats) + '; inventory ' + res.inv);
  ok(res.first !== null && res.first < 20, 'debris comes within hook reach quickly');
  ok(stats.throws > 0 && stats.hits / stats.throws >= 0.4, 'the hook catches something on most throws (' + stats.hits + ' of ' + stats.throws + ' throws, ' + stats.items + ' item stacks)');
  ok(res.goal, 'goal 1 (6 planks) done within ' + budget + ' s of game time');

  // --- craft the hammer in the crafting panel ---
  await until(() => /kladivo/.test(document.getElementById('goal-text').textContent), null, 15000, 'goal card moves to the hammer');
  await h.key('KeyC');
  await until(() => G.ui.isOpen() && G.ui.tab === 'craft', null, 8000, 'C opens crafting');
  await page.click('#cat-0');
  await until(() => { const b = document.getElementById('craft-btn-kladivo'); return b && !b.disabled; }, null, 8000, 'hammer can be crafted');
  await shot('crafting');
  await page.click('#craft-btn-kladivo');
  await until(() => G.inventory.count('kladivo') === 1, null, 8000, 'hammer crafted');
  await page.mouse.move(640, 360);   // back to the centre while the panel is open (free look would turn)
  await h.key('KeyC');
  await until(() => !G.ui.isOpen(), null, 8000, 'panel closed');
  ok(true, 'hammer crafted through the crafting panel');

  // --- build a foundation with it ---
  if ((await h.eval(() => G.inventory.count('prkno') >= 2 && G.inventory.count('plast') >= 2))) {
    await L.selectItem('kladivo');
    const cell = await h.eval(() => {
      const p = G.player.position, f = G.player.forward(new THREE.Vector3());
      let best = null, bd = Infinity;
      for (let i = -3; i <= 2; i++) for (let j = -3; j <= 2; j++) {
        if (G.raft.getTile(i, j) || G.raft.canBuildAt(i, j) !== '') continue;
        const x = (i + 0.5) * 2, z = (j + 0.5) * 2, d = Math.hypot(x - p.x, z - p.z);
        if (d < bd) { bd = d; best = [i, j, x, z]; }
      }
      return best;
    });
    const dy = await h.eval(() => G.raft.deckY());
    await aimAt(cell[2], dy, cell[3]);
    await until(([i, j]) => { const a = G.tools.get('hammer').aim; return a.kind === 'build' && a.i === i && a.j === j; }, cell, 8000, 'ghost foundation');
    await shot('build-ghost');
    const n0 = await h.eval(() => G.raft.count());
    await h.mouse('left', 90);
    await until((n) => G.raft.count() === n + 1, n0, 10000, 'foundation built');
    ok(true, 'first foundation built');
  } else note('not enough materials left for a foundation');
  await shot('end');
  note('done');
};
