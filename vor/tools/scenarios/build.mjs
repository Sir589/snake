// Building with the hammer through real input: hotbar key, look (h.look) and the left mouse
// button. Builds two foundations (goal 3), reinforces a tile, repairs a damaged one, shows the
// green / red ghost, and dismantles a structure by holding the right mouse button.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/build.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'build');
  const { ok, until, aimAt, selectItem, shot, note } = L;
  const deck = () => h.eval(() => G.raft.deckY());
  // clicks during a swing are ignored (like in the real game): wait until the hammer is ready
  const ready = () => until(() => { const hm = G.tools.get('hammer'); return hm.cooldown <= 0 && hm.swingT < 0; }, null, 10000, 'hammer ready');
  const click = async () => { await ready(); await h.mouse('left', 90); };

  await h.eval(() => {
    G.debug.god(true);
    G.debug.give('kladivo', 1);
    G.inventory.add('prkno', 16, 'debug');
    G.inventory.add('plast', 10, 'debug');
    G.inventory.add('kov', 2, 'debug');
    window.__b = { ev: [] };
    for (const n of ['build:tile', 'build:reinforce', 'build:repair', 'goal:done', 'structure:removed'])
      G.events.on(n, (d) => window.__b.ev.push(n));
  });
  await page.mouse.move(640, 360);
  await selectItem('kladivo');
  await until(() => G.player.hand.children.length > 0 && /Namiř|Postavit|Zpevnit|Opravit/.test(G.hud.toolHint), null, 8000, 'hammer in hand with a hint');

  // --- build two foundations east of the raft (cells (1,0) and (1,-1)) ---
  const tiles0 = await h.eval(() => G.raft.count());
  const inv0 = await h.eval(() => ({ p: G.inventory.count('prkno'), q: G.inventory.count('plast') }));
  let dy = await deck();
  await aimAt(3, dy, 1);
  await until(() => { const a = G.tools.get('hammer').aim; return a.kind === 'build' && a.i === 1 && a.j === 0; }, null, 8000, 'aim at empty cell (1,0)');
  await shot('ghost-green');
  await click();
  await until(() => !!G.raft.getTile(1, 0), null, 10000, 'tile (1,0) built');
  const inv1 = await h.eval(() => ({ p: G.inventory.count('prkno'), q: G.inventory.count('plast') }));
  ok(inv0.p - inv1.p === 2 && inv0.q - inv1.q === 2, 'foundation cost 2 planks + 2 plastic');

  dy = await deck();
  await aimAt(3, dy, -1);
  await until(() => { const a = G.tools.get('hammer').aim; return a.kind === 'build' && a.i === 1 && a.j === -1; }, null, 8000, 'aim at empty cell (1,-1)');
  await click();
  await until(() => !!G.raft.getTile(1, -1), null, 10000, 'tile (1,-1) built');
  ok((await h.eval(() => G.raft.count())) === tiles0 + 2, 'raft grew by two tiles');
  await until(() => G.goals.get('zaklady').done, null, 8000, 'goal "2 nové základy" done');
  ok(true, 'goal 3 completed by real building');

  // --- reinforce an existing tile ---
  dy = await deck();
  await aimAt(1, dy, 1);
  await until(() => G.tools.get('hammer').aim.kind === 'reinforce', null, 8000, 'aim at tile to reinforce');
  const kov0 = await h.eval(() => G.inventory.count('kov'));
  await click();
  await until(() => G.raft.getTile(0, 0).reinforced, null, 10000, 'tile reinforced');
  ok((await h.eval(() => G.inventory.count('kov'))) === kov0 - 1, 'reinforce used 1 metal');

  // --- repair a damaged tile ---
  await h.eval(() => G.raft.damageTile(G.raft.getTile(-1, 0), 40, 'shark'));
  dy = await deck();
  await aimAt(-1, dy, 1);
  await until(() => G.tools.get('hammer').aim.kind === 'repair', null, 8000, 'aim at damaged tile');
  await click();
  await until(() => { const t = G.raft.getTile(-1, 0); return t.hp === t.maxHp; }, null, 10000, 'tile repaired');
  ok(true, 'damaged tile repaired to full');

  // --- red ghost when materials are missing ---
  await h.eval(() => G.inventory.remove('plast', G.inventory.count('plast')));
  dy = await deck();
  await aimAt(-3, dy, 1);
  await until(() => G.tools.get('hammer').aim.kind === 'build' && /Chybí: 2× Plast/.test(G.hud.toolHint), null, 8000, 'missing-materials hint');
  await shot('ghost-red');
  const n0 = await h.eval(() => G.raft.count());
  await click();
  await h.wait(400);
  ok((await h.eval(() => G.raft.count())) === n0, 'no build without materials');

  // --- dismantle a structure by holding RMB ---
  await h.eval(() => { G.raft.placeStructure('chest', G.raft.getTile(1, 0), 0); });
  dy = await deck();
  await aimAt(3, dy + 0.4, 1);
  await until(() => { const a = G.tools.get('hammer').aim; return a.s && a.s.type === 'chest'; }, null, 8000, 'aim at the chest');
  await page.mouse.down({ button: 'right' });
  await until(() => !G.raft.findStructures('chest').length, null, 15000, 'chest dismantled');
  await page.mouse.up({ button: 'right' });
  ok((await h.eval(() => G.inventory.count('truhla'))) === 1, 'dismantle refunds the chest');

  const ev = await h.eval(() => window.__b.ev);
  ok(ev.includes('build:tile') && ev.includes('build:reinforce') && ev.includes('build:repair') && ev.includes('structure:removed'), 'build events: ' + [...new Set(ev)].join(', '));
  await h.eval(() => G.debug.god(false));
  note('done');
};
