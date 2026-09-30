// Free building with blocks (build.js): place/remove via the hammer, collisions, stairs, doors, save/load.
export default async (page, h) => {
  const ok = (c, m) => { if (!c) throw new Error('blocks: ' + m); };
  // headless WebGL is slow: wait for real game frames / game seconds, not wall time
  const frames = async (n) => { const f0 = await h.eval(() => G.frameNo); await page.waitForFunction((t) => G.frameNo >= t, f0 + n, { timeout: 120000 }); };
  const gameSec = async (s) => { const t0 = await h.eval(() => G.time); await page.waitForFunction((t) => G.time >= t, t0 + s, { timeout: 180000 }); };
  const click = async (btn) => { await page.mouse.move(640, 360); await page.mouse.down({ button: btn }); await frames(2); await page.mouse.up({ button: btn }); await frames(3); };
  await page.mouse.move(640, 360);   // centre first: with free-look a later move would turn the camera
  await frames(3);
  await h.eval(() => { G.debug.giveAll(); G.inventory.select(G.inventory.firstIndexOf('kladivo')); });
  await frames(3);
  // look down at the deck in front and place a wooden block
  await h.eval(() => { G.debug.teleport(-1.5, 0.5); G.player.yaw = -Math.PI / 2; G.player.pitch = -0.7; G.build.selected = 1; });
  await frames(3);
  const before = await h.eval(() => ({ n: G.build.blocks.size, p: G.inventory.count('prkno') }));
  await click('left');
  const after = await h.eval(() => ({ n: G.build.blocks.size, p: G.inventory.count('prkno') }));
  ok(after.n === before.n + 1, 'block not placed ' + JSON.stringify([before, after]));
  ok(after.p === before.p - 1, 'planks not charged');
  // stack a second one on top of it (aim at the block's top face)
  await frames(2); await click('left');
  const n2 = await h.eval(() => G.build.blocks.size);
  ok(n2 === after.n + 1, 'second block not placed: ' + n2);
  // remove with RMB → refund
  await frames(2); await click('right');
  const n3 = await h.eval(() => ({ n: G.build.blocks.size, p: G.inventory.count('prkno') }));
  ok(n3.n === n2 - 1 && n3.p === after.p, 'remove/refund failed ' + JSON.stringify(n3));
  await h.eval(() => { for (const b of Array.from(G.build.blocks)) G.build.remove(b, false); });

  // collision: a wall of blocks at x = 1 blocks walking +x
  const r = await h.eval(() => {
    const d = G.raft.deckY();
    for (let z = -2; z < 2; z++) { G.build.add('blok', 1, 0, z, 0); G.build.add('blok', 1, 1, z, 0); }
    G.debug.teleport(-0.5, 0);
    G.player.yaw = -Math.PI / 2; G.player.pitch = 0; // face +x
    return d;
  });
  await frames(2);
  await h.hold('KeyW'); await gameSec(1.5); await h.release('KeyW');
  const px = await h.eval(() => G.player.position.x);
  ok(px < 0.75, 'walked through wall, x=' + px);

  // stairs: ramp from y 0 → 1, then stand on a block top
  await h.eval(() => {
    for (const b of Array.from(G.build.blocks)) G.build.remove(b, false);
    G.build.add('schody', 0, 0, -1, 2);   // rises toward -z
    G.build.add('blok', 0, 0, -2, 0);
    G.debug.teleport(0.5, 0.6);
    G.player.yaw = 0; G.player.pitch = 0;   // face -z
  });
  await frames(2);
  await h.hold('KeyW'); await gameSec(0.7); await h.release('KeyW');
  await frames(3);
  const top = await h.eval(() => ({ y: G.player.position.y - G.raft.deckY(), z: G.player.position.z }));
  ok(top.y > 0.9, 'did not climb stairs: ' + JSON.stringify(top));

  // door: closed blocks, open lets through
  const door = await h.eval(() => {
    for (const b of Array.from(G.build.blocks)) G.build.remove(b, false);
    const b = G.build.add('dvere', 0, 0, -1, 0);
    const d = G.raft.deckY();
    const closed = G.build.blocked(0.5, -0.5, d + 0.5, d + 1.8, 0.3);
    b.open = true;
    const open = G.build.blocked(0.5, -0.5, d + 0.5, d + 1.8, 0.3);
    return { closed, open };
  });
  ok(door.closed && !door.open, 'door collision ' + JSON.stringify(door));

  // demo house + save/load round-trip
  await h.eval(() => { for (const b of Array.from(G.build.blocks)) G.build.remove(b, false); G.debug.house(); });
  const cnt = await h.eval(() => G.build.blocks.size);
  ok(cnt > 40, 'house too small ' + cnt);
  const back = await h.eval(() => { G.save.write(); G.continueGame(); return G.build.blocks.size; });
  ok(back === cnt, 'save/load lost blocks ' + back + ' vs ' + cnt);
  await h.eval(() => { G.debug.teleport(6, 6); G.player.yaw = 2.4; G.player.pitch = -0.25; G.inventory.select(G.inventory.firstIndexOf('kladivo')); });
  await frames(3);
};
