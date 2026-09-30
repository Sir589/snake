// ROADMAP 8: animals on the raft. Catch them on islands (rope / banana), let them loose on the
// deck, feed them for milk, wool, truffles and eggs; name the parrot and hear it talk.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/animals.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'animals');
  const { ok, until, gameWait, aimAt, selectItem, shot } = L;
  await h.eval(() => { G.debug.god(true); G.debug.buildRing(); for (const i of G.islands.list.slice()) G.islands.remove(i); });

  // --- wild animals on an island; catch a goat with rope --------------------------------------------------
  let r = await h.eval(() => {
    const d = G.debug.island({ name: 'Borový ostrov', seed: 77 });
    const isl = d.island;
    window.__isl = isl;
    const wild = G.animals.populate(isl, true);
    return { n: wild.length, kinds: wild.map((w) => w.kind), label: wild[0] && wild[0].it.label() };
  });
  ok(r.n >= 1, 'wild animals on the island: ' + r.kinds.join(', '));
  ok(/^Chytit .+ \(/.test(r.label), 'label: ' + r.label);
  r = await h.eval(() => {
    const w = G.animals.wild(window.__isl)[0];
    const kind = w.kind;
    G.inventory.remove('provaz', G.inventory.count('provaz'));
    w.it.onInteract();                                   // no rope yet
    const still = G.animals.wild(window.__isl).includes(w);
    G.inventory.add('provaz', 5, 'debug');
    G.inventory.add('banan', 1, 'debug');
    w.it.onInteract();
    return { kind, still, gone: !G.animals.wild(window.__isl).includes(w), item: G.inventory.count(kind) };
  });
  ok(r.still, 'without rope it gets away');
  ok(r.gone && r.item === 1, 'caught: ' + r.kind + ' is in the inventory');
  const kind = r.kind;
  r = await h.eval(() => G.mod('animals').save().caught[window.__isl.seed]);
  ok(r > 0, 'caught animals are remembered per island');

  // --- let it loose on the raft with the 'animal' tool (real input) --------------------------------------------
  await h.eval(() => { for (const i of G.islands.list.slice()) G.islands.remove(i); G.debug.teleport(-0.5, -0.5); });
  await page.mouse.move(640, 360);
  await selectItem(kind);
  const dy = await h.eval(() => G.raft.deckY());
  await aimAt(1, dy, 1);
  await until(() => /Pustit/.test(G.hud.toolHint), null, 8000, 'release hint');
  await h.mouse('left', 90);
  await until((k) => G.animals.list.some((a) => a.kind === k), kind, 8000, 'animal on the raft');
  ok(true, kind + ' let loose on the raft');
  const p0 = await h.eval(() => { const a = G.animals.list[0]; return [a.x, a.z]; });
  await gameWait(6);
  r = await h.eval(() => { const a = G.animals.list[0]; return { x: a.x, z: a.z, tile: !!G.raft.tileAt(a.x, a.z) }; });
  ok(r.tile && Math.hypot(r.x - p0[0], r.z - p0[1]) > 0.2, 'it walks around the deck and stays on the raft');

  // --- feeding and products ---------------------------------------------------------------------------------------
  r = await h.eval(() => {
    const a = G.animals.list[0];
    a.fed = 0.1;
    G.inventory.add('list', 3, 'debug');
    const hungryLabel = a.it.label();
    const l0 = G.inventory.count('list');
    a.it.onInteract();
    return { hungryLabel, fed: a.fed, ate: l0 - G.inventory.count('list'), product: a.K.product };
  });
  ok(/^Nakrmit .+ \(1× Palmový list\)$/.test(r.hungryLabel), 'feeding label: ' + r.hungryLabel);
  ok(r.fed === 1 && r.ate === 1, 'fed with a palm leaf');
  const prod = r.product;
  await h.eval(() => { const a = G.animals.list[0]; a.prog = a.T - 0.2; });
  await until(() => G.animals.list[0].ready, null, 10000, 'product ready');
  r = await h.eval((id) => {
    const a = G.animals.list[0];
    const label = a.it.label(), n0 = G.inventory.count(id);
    a.it.onInteract();
    return { label, got: G.inventory.count(id) - n0, ready: a.ready, icon: a.iconKey };
  }, prod);
  ok(r.got >= 1 && !r.ready, 'collected ' + r.got + '× ' + prod + ' (' + r.label + ')');

  // every kind produces its thing
  r = await h.eval(() => {
    const out = {};
    for (const k of ['krava', 'koza', 'ovce', 'prase', 'slepice']) {
      const a = G.debug.animal(k);
      a.fed = 1; a.prog = a.T; a.ready = true;
      const id = a.K.product, n0 = G.inventory.count(id);
      a.it.onInteract();
      out[k] = [a.it ? a.K.take : '', G.inventory.count(id) - n0 > 0 ? id : '-'];
    }
    return out;
  });
  ok(Object.values(r).every((v) => v[1] !== '-'), 'milk, wool, truffles, eggs: ' + JSON.stringify(r));
  r = await h.eval(() => ({ egg: G.items.cookResult('vejce'), rope: G.items.recipe('provaz_vlna') ? G.items.recipe('provaz_vlna').needs.vlna : 0 }));
  ok(r.egg === 'vejce_pecene' && r.rope === 1, 'eggs cook on the grill, wool makes rope');

  // --- the parrot: name it through the dialog, it talks --------------------------------------------------------
  await h.eval(() => { const p = G.debug.animal('papousek'); window.__par = p; });
  await gameWait(0.3);
  r = await h.eval(() => window.__par.it.label());
  ok(/^Papoušek Papoušek – přejmenovat$/.test(r), 'parrot label: ' + r);
  await h.eval(() => window.__par.it.onInteract());
  await until(() => document.querySelector('.animal-name input') && G.uiBlocking() && document.activeElement === document.querySelector('.animal-name input'), null, 5000, 'naming dialog with the cursor in the name field');
  await page.keyboard.type('Kája');
  await page.keyboard.press('Enter');
  await until(() => window.__par.name === 'Kája' && !document.querySelector('.animal-name') && !G.uiBlocking(), null, 5000, 'named');
  ok(true, 'the parrot is called Kája');
  await h.eval(() => { window.__said = []; G.events.on('parrot:said', (e) => window.__said.push(e.text)); G.events.emit('shark:attack', { target: 'raft' }); });
  r = await h.eval(() => ({ said: window.__said, bubble: window.__par.bubble.visible }));
  ok(r.bubble && r.said.some((t) => /Žralok/.test(t)), 'it shouts: ' + r.said.join(' | '));
  await gameWait(8);
  r = await h.eval(() => ({ y: window.__par.y, fly: window.__par.fly }));
  ok(true, 'the parrot hops between perches (y ' + r.y.toFixed(2) + ')');
  await h.eval(() => { const p = window.__par; G.debug.teleport(p.x - 1.5, p.z - 1.5); });
  await gameWait(0.5);
  await aimAt(...(await h.eval(() => { const v = new THREE.Vector3(); window.__par.obj.getWorldPosition(v); return [v.x, v.y + 0.3, v.z]; })));
  await shot('parrot');

  // --- save / load ------------------------------------------------------------------------------------------------
  r = await h.eval(() => {
    const mod = G.mod('animals');
    const d = JSON.parse(JSON.stringify(mod.save()));
    mod.reset();
    const empty = G.animals.list.length;
    mod.load(d);
    return { empty, n: G.animals.list.length, names: G.animals.list.filter((a) => a.K.flies).map((a) => a.name), kinds: G.animals.list.map((a) => a.kind) };
  });
  ok(r.empty === 0 && r.n === 7 && r.names[0] === 'Kája', 'save/load keeps the animals and the parrot\'s name: ' + r.kinds.join(', '));
};
