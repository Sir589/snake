// Placing and using every raft structure through real input: the hotbar key selects the
// placeable, h.look aims the ghost, the left mouse button places it, E uses it.
// purifier (salt water → drinking water), grill (raw → cooked fish), chest (storage panel,
// shift-click into it), net (catches floating debris, E empties it), sail (raft speeds up),
// anchor (raft stops). Timers of the purifier / grill are shortened to keep the test quick.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/structures.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'structures');
  const { ok, until, aimAt, selectItem, shot, note } = L;

  await h.eval(() => {
    G.debug.god(true);
    for (let i = -2; i <= 1; i++) for (let j = -2; j <= 1; j++) if (!G.raft.getTile(i, j)) G.raft.addTile(i, j);   // 4×4 raft
    G.inventory.remove('prkno', G.inventory.count('prkno'));
    G.inventory.remove('plast', G.inventory.count('plast'));
    for (const id of ['cisticka', 'gril', 'truhla', 'sit', 'plachta', 'kotva']) G.inventory.add(id, 1, 'debug');
    G.inventory.add('kelimek_slany', 1, 'debug');
    G.inventory.add('sardinka', 1, 'debug');
    window.__s = { ev: [] };
    for (const n of ['build:structure', 'purify:done', 'cook:done', 'sail:toggled', 'anchor:toggled'])
      G.events.on(n, (d) => window.__s.ev.push(n));
  });
  ok((await h.eval(() => G.raft.count())) === 16, 'debug ring gives a 4×4 raft');
  await page.mouse.move(640, 360);

  const place = async (id, type, i, j) => {
    await selectItem(id);
    const dy = await h.eval(() => G.raft.deckY());
    await aimAt((i + 0.5) * 2, dy, (j + 0.5) * 2);
    await until(([i, j]) => { const p = G.tools.get('place'); return p.tile && p.tile.i === i && p.tile.j === j && p.ok; }, [i, j], 10000, 'ghost of ' + type + ' on (' + i + ',' + j + ')');
    const hint = await h.eval(() => G.hud.toolHint);
    await h.mouse('left', 90);
    await until(([t, i, j]) => { const tl = G.raft.getTile(i, j); return tl && tl.structure && tl.structure.type === t; }, [type, i, j], 10000, type + ' placed');
    ok((await h.eval((iid) => G.inventory.count(iid), id)) === 0, type + ' placed with the place tool (hint: "' + hint + '")');
  };
  // Aim at a structure's interaction point and wait until it is under the crosshair.
  const aimUse = async (type) => {
    const p = await h.eval((t) => {
      const s = G.raft.findStructures(t)[0];
      for (const it of G.interaction.items) if (it.structure === s) { const v = new THREE.Vector3(); it.getPosition ? it.getPosition(v) : it.object.getWorldPosition(v); return v.toArray(); }
      return null;
    }, type);
    if (!p) L.fail('no interactable for ' + type);
    // step next to it (E reaches 3.2 m), standing on the deck on the raft-centre side
    await h.eval((q) => {
      const P = G.player.position, d = Math.hypot(q[0] - P.x, q[2] - P.z);
      if (d < 2.2) return;
      const k = 1.6 / Math.max(0.01, Math.hypot(q[0], q[2]));
      let x = q[0] - q[0] * k, z = q[2] - q[2] * k;
      if (!G.raft.tileAt(x, z)) { x *= 0.7; z *= 0.7; }
      G.debug.teleport(x, z);
    }, p);
    await until(() => G.player.onGround && !G.player.inWater, null, 8000, 'standing on the deck');
    await aimAt(p[0], p[1], p[2]);
    const label = await until((t) => { const c = G.interaction.current; return c && c.structure && c.structure.type === t && G.interaction.labelOf(c); }, type, 10000, type + ' under the crosshair');
    return label;
  };
  const use = async (type) => { const label = await aimUse(type); await h.key('KeyE'); return label; };

  await place('cisticka', 'purifier', -1, -1);
  await place('gril', 'grill', 0, -1);
  await place('truhla', 'chest', -1, 0);
  await place('sit', 'net', 1, 0);
  await place('plachta', 'sail', -2, -2);
  await place('kotva', 'anchor', -2, 0);
  await shot('all-placed');

  // --- purifier ---
  let label = await use('purifier');
  ok(label === 'Čistit vodu', 'purifier label: ' + label);
  await until(() => G.raft.findStructures('purifier')[0].data.state === 'work', null, 8000, 'purifier working');
  ok((await h.eval(() => G.inventory.count('kelimek_slany'))) === 0, 'salt water went into the purifier');
  await h.eval(() => { G.raft.findStructures('purifier')[0].data.t = 0.4; });
  await until(() => G.raft.findStructures('purifier')[0].data.state === 'done', null, 20000, 'purifier done');
  label = await use('purifier');
  await until(() => G.inventory.count('kelimek_sladky') === 1, null, 8000, 'drinking water collected');
  ok(true, 'purifier gives drinking water ("' + label + '")');

  // --- grill ---
  label = await use('grill');
  await until(() => G.raft.findStructures('grill')[0].data.state === 'work', null, 8000, 'grill cooking');
  ok(/Gril|Upéct|upéct|Péct/i.test(label), 'grill label: ' + label);
  await h.eval(() => { G.raft.findStructures('grill')[0].data.t = 0.4; });
  await until(() => G.raft.findStructures('grill')[0].data.state === 'done', null, 20000, 'grill done');
  await use('grill');
  await until(() => G.inventory.count('sardinka_pecena') === 1, null, 8000, 'cooked sardine collected');
  ok(true, 'grill cooks the sardine');

  // --- chest: E opens the storage panel, shift-click moves an item in ---
  await use('chest');
  await until(() => G.ui.storageOpen, null, 8000, 'chest panel open');
  const wi = await h.eval(() => G.inventory.slots.findIndex((s) => s && s.id === 'kelimek_sladky'));
  await page.click('#inv-slot-' + wi, { modifiers: ['Shift'] });
  await until(() => G.raft.findStructures('chest')[0].data.storage.slots.some((s) => s && s.id === 'kelimek_sladky'), null, 8000, 'item moved into the chest');
  await shot('chest');
  await h.key('Escape');
  await until(() => !G.ui.isOpen() && !G.uiBlocking() && !G.paused, null, 8000, 'chest closed with Esc');
  ok(true, 'chest stores items');

  // --- net: debris drifting into it is caught; E empties it ---
  await h.eval(() => {
    G.debris.clear();
    const W = G.world, s = G.raft.findStructures('net')[0], c = G.raft.tileCenter(s.tile, new THREE.Vector3());
    for (let k = 0; k < 3; k++) {
      const p = new THREE.Vector3(c.x + 2.2, 0, c.z).addScaledVector(W.windDir, 1.5 + k * 0.8);
      const d = G.debris.spawn('prkno', p); if (d) d.age = 5;
    }
  });
  await until(() => G.raft.findStructures('net')[0].data.storage.slots.some(Boolean), null, 60000, 'the net catching a plank');
  // leftover planks floating right at the net would take the crosshair ("Sebrat: Prkno")
  await h.eval(() => G.debris.clear());
  const p0 = await h.eval(() => G.inventory.count('prkno'));
  label = await use('net');
  await until((p) => G.inventory.count('prkno') > p, p0, 8000, 'net emptied into the inventory');
  ok(/Vybrat síť/.test(label), 'net catches debris and E empties it ("' + label + '")');

  // --- sail: speeds the raft up ---
  label = await use('sail');
  await until(() => G.raft.sailUp, null, 8000, 'sail up');
  await until(() => G.raft.velocity.length() > 1.2, null, 60000, 'raft speeding up');
  ok(label === 'Vytáhnout plachtu', 'sail raised, raft speed ' + (await h.eval(() => G.raft.velocity.length().toFixed(2))) + ' m/s');
  await shot('sail-up');

  // --- anchor: stops the raft ---
  label = await use('anchor');
  await until(() => G.raft.anchored, null, 8000, 'anchor down');
  await until(() => G.raft.velocity.length() < 0.05, null, 90000, 'raft stopped');
  ok(label === 'Spustit kotvu', 'anchor stops the raft');
  await use('anchor');
  await until(() => !G.raft.anchored, null, 8000, 'anchor up');
  await use('sail');
  await until(() => !G.raft.sailUp, null, 8000, 'sail down');

  const ev = await h.eval(() => window.__s.ev);
  ok(['build:structure', 'purify:done', 'cook:done', 'sail:toggled', 'anchor:toggled'].every((n) => ev.includes(n)), 'structure events fired');
  ok(await h.eval(() => G.goals.get('cisticka').done && G.goals.get('gril').done && G.goals.get('plachta').done), 'purifier / grill / sail goals done');
  await h.eval(() => G.debug.god(false));
  note('done');
};
