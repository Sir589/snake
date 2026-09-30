// Death → game over screen → "Hrát znovu" gives a clean new game, twice in a row.
// Each round first makes a mess (bigger raft with structures, an island, a pirate raid with the
// ship close, the shark biting, a storm, the hook and the rod out, lots of debris, particles), then
// the player dies. After "Hrát znovu" the game state must be fresh, and the scene graph / renderer
// memory / registries must be back to the fresh-game numbers (no leftover objects, no growth
// from round to round).
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/death.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'death');
  const { ok, until, shot, note, sceneStats } = L;

  // Floating debris comes and goes on its own timer (the opening "easy first catch" bundle adds a
  // badge sprite a moment into a new game), so it is cleared before every measurement.
  const settle = async () => {
    await L.frames(20);
    await L.gameWait(0.6);
    await h.eval(() => G.debris.clear());
    await L.frames(2);
  };
  await settle();
  const names = () => h.eval(() => { const m = {}; G.scene.traverse((o) => { const p = o.parent; const k = (p ? (p.name || p.type) + '/' : '') + (o.name || o.type); m[k] = (m[k] || 0) + 1; }); return m; });
  const diffNames = (a, b) => { const d = []; for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if ((a[k] || 0) !== (b[k] || 0)) d.push(k + ' ' + (a[k] || 0) + '→' + (b[k] || 0)); return d.join(', '); };
  const fresh = await sceneStats();
  const freshNames = await names();
  note('fresh game: ' + JSON.stringify(fresh));

  const mess = async () => {
    await h.eval(() => {
      G.debug.god(true);
      for (let i = -2; i <= 1; i++) for (let j = -2; j <= 1; j++) if (!G.raft.getTile(i, j)) G.raft.addTile(i, j);
      G.debug.giveAll();
      const T = (i, j) => G.raft.getTile(i, j);
      G.raft.placeStructure('purifier', T(-1, -1), 0);
      G.raft.placeStructure('grill', T(0, -1), 0);
      G.raft.placeStructure('chest', T(-1, 0), 0);
      G.raft.placeStructure('net', T(1, 0), 0);
      G.raft.placeStructure('sail', T(-2, -2), 0);
      G.raft.placeStructure('anchor', T(-2, 0), 0);
      G.raft.placeStructure('cannon', T(1, 1), 0);
      G.debug.raftShowcase && G.debug.raftShowcase();
      G.debug.island();
      G.debug.pirates('near');
      G.debug.sharkAttack();
      G.debug.storm(true);
      G.debug.debrisRain();
      G.fx.explosion(new THREE.Vector3(6, 1, 6), 1);
      G.fx.splash(new THREE.Vector3(3, 0, 3), 2);
    });
    await L.gameWait(1.5);
    await h.eval(() => { if (G.pirates.launchBoat) G.pirates.launchBoat(); });
    await L.gameWait(2);
  };
  const die = async () => {
    await h.eval(() => { G.debug.god(false); G.player.damage(1000, 'shark'); });
    await until(() => G.state === 'dead', null, 10000, 'player dead');
    await until(() => !document.getElementById('scr-over').classList.contains('is-hidden'), null, 20000, 'game over screen');
    const reason = await h.eval(() => document.getElementById('over-reason').textContent);
    ok(reason === 'Sežral tě žralok.', 'game over reason: ' + reason);
  };
  const again = async () => {
    await page.click('#btn-again');
    await until(() => G.state === 'playing' && !G.paused && document.getElementById('scr-over').classList.contains('is-hidden'), null, 10000, 'new game after Hrát znovu');
    await settle();
  };
  const checkFresh = async (round) => {
    const s = await h.eval(() => ({
      inv: G.inventory.slots.filter(Boolean).map((x) => x.id + 'x' + x.count).join(','),
      tiles: G.raft.count(), structures: G.raft.structures.length, sail: G.raft.sailUp, anchored: G.raft.anchored,
      pirates: G.pirates.active, ship: !!G.pirates.ship, boarders: G.pirates.boarders.filter((b) => !b.defeated).length,
      islands: G.islands.list.length, shark: G.shark.state, storm: G.world.storm, day: G.world.day,
      hp: G.player.health, hunger: G.player.hunger, alive: G.player.alive, water: G.player.inWater,
      goals: G.goals.doneCount(), time: G.time, stats: Object.values(G.stats).reduce((a, b) => a + b, 0),
      hook: G.debris.hookState().state, fishing: G.fishing.state, override: !!G.player.controlOverride,
      blocked: G.interaction.blocked, ui: G.ui.isOpen(), crosshair: G.hud.crosshair,
    }));
    ok(s.inv === 'hakx1,prknox4,plastx4', 'round ' + round + ': starting inventory (' + s.inv + ')');
    ok(s.tiles === 4 && s.structures === 0 && !s.sail && !s.anchored, 'round ' + round + ': 2×2 raft without structures');
    ok(!s.pirates && !s.ship && s.boarders === 0, 'round ' + round + ': no pirates');
    ok(s.islands === 0 && s.shark === 'away' && s.storm === 0 && s.day === 1, 'round ' + round + ': no island / shark / storm, day 1');
    ok(s.hp === 100 && s.alive && !s.water && s.goals === 0 && s.time < 5 && s.stats === 1, 'round ' + round + ': fresh player, goals and stats');
    ok(s.hook === 'idle' && s.fishing === 'idle' && !s.override && !s.blocked && !s.ui && s.crosshair !== 'hidden', 'round ' + round + ': tools and controls reset');
    const now = await sceneStats();
    note('round ' + round + ' scene: ' + JSON.stringify(now));
    return now;
  };

  // --- round 1 ---
  await mess();
  const dirty = await sceneStats();
  note('messy game: ' + JSON.stringify(dirty));
  ok(dirty.objects > fresh.objects + 50, 'the mess added objects (' + fresh.objects + ' → ' + dirty.objects + ')');
  await shot('mess');
  await die();
  await shot('gameover');
  await again();
  const r1 = await checkFresh(1);
  const r1Names = await names();

  // --- round 2 ---
  await h.eval(() => G.debris.hookState && G.inventory.select(0));
  await mess();
  await die();
  await again();
  const r2 = await checkFresh(2);

  for (const k of ['objects', 'meshes', 'lights', 'interactables', 'combat', 'ground', 'listeners']) {
    ok(r1[k] === fresh[k] && r2[k] === fresh[k], k + ' back to the fresh value (' + fresh[k] + ' / ' + r1[k] + ' / ' + r2[k] + ')' +
      (k === 'objects' && r1[k] !== fresh[k] ? ' — ' + diffNames(freshNames, r1Names) : ''));
  }
  // Renderer memory: pooled objects (cannonballs, rings, boat, boarders…) are uploaded lazily the
  // first time they are drawn, and speech-bubble textures are cached per line, so the numbers
  // step up a little over the first raids and then plateau (checked over 7 raid cycles). A real
  // per-round leak would add a whole set of island / raft / raid geometries each round.
  ok(r2.geometries - r1.geometries <= 8 && r2.textures - r1.textures <= 3, 'renderer memory stays bounded per round (geometries ' +
    fresh.geometries + ' / ' + r1.geometries + ' / ' + r2.geometries + ', textures ' + fresh.textures + ' / ' + r1.textures + ' / ' + r2.textures + ')');
  note('done');
};
