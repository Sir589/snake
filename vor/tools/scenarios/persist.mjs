// Save → reload the page → "Pokračovat" restores the game: raft tiles (hp, reinforced), structures
// with their contents and state, inventory (counts, durability, selection), stats, goals, player
// stats and position, world day/time, played time. Saving goes through the real pause menu
// (Esc → "Uložit a do menu").
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/persist.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'persist');
  const { ok, until, shot, note } = L;

  const snapshot = () => h.eval(() => ({
    tiles: [...G.raft.tiles.values()].map((t) => t.i + ',' + t.j + ':' + Math.round(t.hp) + (t.reinforced ? 'R' : '')).sort().join(' '),
    structures: G.raft.structures.map((s) => s.type + '@' + s.tile.i + ',' + s.tile.j + 'r' + s.rotation).sort().join(' '),
    chest: (() => { const c = G.raft.findStructures('chest')[0]; return c ? c.data.storage.slots.filter(Boolean).map((x) => x.id + 'x' + x.count).join(',') : null; })(),
    sail: G.raft.sailUp,
    inv: G.inventory.slots.map((x) => (x ? x.id + 'x' + x.count + (x.dur != null ? 'd' + x.dur : '') : '-')).join(','),
    selected: G.inventory.selected,
    stats: JSON.stringify(G.stats),
    goals: G.goals.list.filter((g) => g.done).map((g) => g.id).join(','),
    hunger: Math.round(G.player.hunger), thirst: Math.round(G.player.thirst), health: Math.round(G.player.health),
    pos: G.player.position.toArray().map((v) => Math.round(v * 2) / 2).join(','),
    day: G.world.day, dayFrac: Math.round(G.world.dayFraction * 100) / 100,
    time: Math.round(G.time),
  }));

  await h.eval(() => {
    G.debug.god(true);
    G.raft.addTile(1, 0); G.raft.addTile(1, -1); G.raft.addTile(-2, 0);
    G.raft.getTile(1, 0).reinforced = true;
    G.raft.damageTile(G.raft.getTile(-2, 0), 35, 'shark');
    const c = G.raft.placeStructure('chest', G.raft.getTile(-1, 0), 1);
    G.inventory.addTo(c.data.storage, 'kov', 7);
    G.inventory.addTo(c.data.storage, 'kokos', 2);
    const s = G.raft.placeStructure('sail', G.raft.getTile(1, -1), 2);
    G.raft.structureDefs.sail.interact.onInteract(s);                       // raise it
    G.debug.give('kladivo', 1);
    G.inventory.add('provaz', 5, 'debug');
    G.inventory.add('sardinka_pecena', 3, 'debug');
    G.inventory.slots[0].dur = 57;                                           // worn hook
    G.inventory.select(2, true);
    G.stats.fishCaught = 3; G.stats.sharksKilled = 1; G.stats.debrisCollected = 12;
    G.goals.complete('prkna'); G.goals.complete('kladivo');
    G.player.hunger = 61; G.player.thirst = 44; G.player.health = 83;
    G.debug.setTime(0.62);
    G.time = 321;
    G.debug.god(false);
    G.player.god = false;
  });
  await until(() => G.raft.sailUp, null, 8000, 'sail raised');
  await L.gameWait(0.5);

  // --- save through the pause menu ---
  await h.key('Escape');
  await until(() => G.paused && !document.getElementById('scr-pause').classList.contains('is-hidden'), null, 10000, 'pause screen');
  const before = await snapshot();
  note('before: ' + JSON.stringify(before));
  await page.click('#btn-save-quit');
  await until(() => G.state === 'menu' && !document.getElementById('scr-menu').classList.contains('is-hidden'), null, 10000, 'back in the menu');
  ok(await h.eval(() => G.save.exists()), 'save written');

  // --- reload the page ---
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.G && G.state === 'menu', null, { timeout: 30000 });
  await h.eval(() => { G.input.lockFailed = true; });
  await until(() => { const b = document.getElementById('btn-continue'); return b && b.offsetParent !== null; }, null, 10000, 'Pokračovat button after reload');
  const btn = await h.eval(() => document.getElementById('btn-continue').closest('.screen, section, div').textContent.replace(/\s+/g, ' ').trim());
  note('menu: ' + btn.slice(0, 160));
  ok(/Pokračovat/.test(btn), 'menu offers Pokračovat');
  await shot('menu-continue');
  await page.click('#btn-continue');
  await until(() => G.state === 'playing', null, 10000, 'game continued');
  await L.frames(10);
  const after = await snapshot();
  note('after:  ' + JSON.stringify(after));

  for (const k of Object.keys(before)) {
    if (k === 'time') ok(Math.abs(after.time - before.time) <= 2, 'played time restored (' + before.time + ' → ' + after.time + ')');
    else if (k === 'pos') {
      const a = before.pos.split(',').map(Number), b = after.pos.split(',').map(Number);
      ok(Math.hypot(a[0] - b[0], a[2] - b[2]) < 1.1, 'player position restored (' + before.pos + ' → ' + after.pos + ')');
    } else if (k === 'dayFrac') ok(Math.abs(after.dayFrac - before.dayFrac) < 0.03, 'time of day restored');
    else if (k === 'hunger' || k === 'thirst' || k === 'health') ok(Math.abs(after[k] - before[k]) <= 1, k + ' restored (' + before[k] + ' → ' + after[k] + ')');
    else ok(JSON.stringify(after[k]) === JSON.stringify(before[k]), k + ' restored' + (after[k] !== before[k] ? ' (' + before[k] + ' → ' + after[k] + ')' : ''));
  }
  await shot('continued');
  note('done');
};
