// ROADMAP 7: every island is different — size class, outline shape, tree kinds, rocks, caves.
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/isles.mjs
import { lib } from '../scenario-lib.mjs';

export default async (page, h) => {
  const L = lib(page, h, 'isles');
  const { ok, until, gameWait, aimAt, shot } = L;
  await h.eval(() => { G.debug.god(true); for (const i of G.islands.list.slice()) G.islands.remove(i); });

  // outline stats of one island: min / max beach radius around the centre
  const spawn = (opts) => h.eval((o) => {
    for (const i of G.islands.list.slice()) G.islands.remove(i);
    const d = G.debug.island(o);
    const isl = d.island;
    window.__isl = isl;
    let mn = Infinity, mx = 0;
    for (let k = 0; k < 64; k++) {
      const a = k / 64 * Math.PI * 2;
      let r = 0;
      for (; r < isl.radius + 2; r += 0.25) if (isl.provider.heightAt(isl.position.x + Math.cos(a) * r, isl.position.z + Math.sin(a) * r) === null) break;
      mn = Math.min(mn, r); mx = Math.max(mx, r);
    }
    return Object.assign(isl.summary(), { mn, mx });
  }, opts);

  let r = await spawn({ shape: 'round', size: 'medium', seed: 11 });
  ok(r.shape === 'round' && r.mx / r.mn < 1.3, 'round island: ' + r.mn.toFixed(1) + '–' + r.mx.toFixed(1) + ' m');
  const roundR = r.radius;
  r = await spawn({ shape: 'long', size: 'medium', seed: 11 });
  ok(r.shape === 'long' && r.mx / r.mn > 1.4, 'long island: ' + r.mn.toFixed(1) + '–' + r.mx.toFixed(1) + ' m');
  r = await spawn({ shape: 'bay', size: 'medium', seed: 12 });
  ok(r.shape === 'bay' && r.mx / r.mn > 1.3, 'island with a cove: ' + r.mn.toFixed(1) + '–' + r.mx.toFixed(1) + ' m');
  r = await spawn({ shape: 'twin', size: 'medium', seed: 13 });
  ok(r.shape === 'twin', 'twin-peaked island (' + r.hillHeight + ' m)');
  r = await spawn({ size: 'large', seed: 14 });
  ok(r.size === 'large' && r.hillRadius >= 22, 'large island: hill radius ' + r.hillRadius + ' m (radius ' + r.radius + ')');
  r = await spawn({ size: 'small', small: true, seed: 15 });
  ok(r.size === 'small' && r.hillRadius <= 13.5, 'small island: hill radius ' + r.hillRadius + ' m');

  // --- tree kinds by island type ------------------------------------------------------------------------
  r = await spawn({ name: 'Borový ostrov', seed: 21 });
  ok((r.trees.pine || 0) >= 3 && r.theme === 'pines', 'Borový ostrov: ' + JSON.stringify(r.trees));
  r = await spawn({ name: 'Džunglový ostrov', seed: 22 });
  ok((r.trees.broadleaf || 0) >= 3 && r.theme === 'jungle', 'Džunglový ostrov: ' + JSON.stringify(r.trees));
  r = await spawn({ name: 'Banánová zátoka', seed: 23 });
  ok((r.trees.banana || 0) >= 3 && r.shape === 'bay', 'Banánová zátoka: ' + JSON.stringify(r.trees));
  // pick bananas and branches
  r = await h.eval(() => {
    const isl = window.__isl;
    const b0 = G.inventory.count('banan');
    const t = isl.trees.find((x) => x.kind === 'banana');
    t.it.onInteract ? t.it.onInteract() : null;
    return { got: G.inventory.count('banan') - b0, picked: t.picked, label: t.it.label };
  });
  ok(r.got >= 2 && r.picked && r.label === 'Utrhnout banány', 'bananas picked (+' + r.got + ')');
  r = await h.eval(() => {
    const p = G.player;
    p.hunger = 50;
    G.inventory.add('banan', 1, 'debug');
    return G.items.def('banan').food;
  });
  ok(r.hunger > 0, 'a banana is food (hunger +' + r.hunger + ')');

  // --- a cave ------------------------------------------------------------------------------------------------
  r = await spawn({ cave: true, size: 'large', seed: 31 });
  ok(r.cave, 'island with a cave');
  r = await h.eval(() => {
    const isl = window.__isl, c = isl.cave, P = isl.provider;
    const wx = isl.position.x + c.x, wz = isl.position.z + c.z;
    const floor = P.heightAt(wx, wz);
    // a wall at the back, the opening in front (towards the sea)
    const back = P.heightAt(wx - Math.cos(c.out) * 2.5, wz - Math.sin(c.out) * 2.5);
    const door = P.heightAt(wx + Math.cos(c.out) * 2.5, wz + Math.sin(c.out) * 2.5);
    return { floor, back, door };
  });
  ok(r.back - r.floor > 2.5, 'cave walls block the way (' + (r.back - r.floor).toFixed(1) + ' m)');
  ok(r.door - r.floor < 1, 'the opening is walkable (' + (r.door - r.floor).toFixed(2) + ' m)');
  // walk in and search it
  r = await h.eval(() => {
    const isl = window.__isl, c = isl.cave;
    const wx = isl.position.x + c.x + Math.cos(c.out) * 0.4, wz = isl.position.z + c.z + Math.sin(c.out) * 0.4;
    G.debug.teleport(wx, wz);
    return { x: wx, z: wz };
  });
  await gameWait(0.4);
  const loot = await h.eval(() => {
    const isl = window.__isl, c = isl.cave;
    return { x: isl.position.x + c.lx, y: isl.position.y + c.ly + 0.4, z: isl.position.z + c.lz };
  });
  await aimAt(loot.x, loot.y, loot.z);
  await until(() => G.interaction.current && G.interaction.labelOf(G.interaction.current) === 'Prohledat jeskyni', null, 10000, 'cave chest under the crosshair');
  const z0 = await h.eval(() => G.inventory.count('zlato'));
  await shot('cave');
  await h.key('KeyE', 80);
  await until((g) => G.inventory.count('zlato') > g, z0, 10000, 'treasure from the cave');
  r = await h.eval(() => {
    const d = G.mod('islands').save();
    return d.islands[0].cave;
  });
  ok(r === 1, 'the looted cave is saved');
};
