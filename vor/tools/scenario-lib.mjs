// Shared helpers for the scenarios in tools/scenarios/ (not a scenario itself).
//
//   import { lib } from '../scenario-lib.mjs';
//   export default async (page, h) => { const L = lib(page, h, 'build'); ... };
//
// Headless SwiftShader renders slowly and unevenly (game time often runs at 0.3–0.6× real time
// and single frames can stall for seconds), so everything here waits for conditions or for game
// time, never for fixed real-time delays.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'sire-more-shots');

export function lib(page, h, tag) {
  const log = [];
  const note = (t) => { log.push(t); process.stderr.write('[' + tag + '] ' + t + '\n'); };
  const fail = (m) => { throw new Error('[' + tag + '] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); note('ok  ' + m); };

  // Polls fn (evaluated in the page) until it returns something truthy.
  const until = async (fn, arg, ms = 15000, what = 'condition') => {
    const t0 = Date.now();
    let v;
    while (Date.now() - t0 < ms) {
      v = await page.evaluate(fn, arg);
      if (v) return v;
      await page.waitForTimeout(60);
    }
    fail('timed out waiting for ' + what);
  };

  // Waits until `sec` seconds of game time (G.time) have passed (real-time cap: 8× + 20 s).
  const gameWait = async (sec) => {
    const t0 = await page.evaluate(() => G.time);
    const cap = Date.now() + sec * 8000 + 20000;
    while (Date.now() < cap) {
      if ((await page.evaluate(() => G.time)) - t0 >= sec) return;
      await page.waitForTimeout(50);
    }
    fail('game time did not advance ' + sec + ' s');
  };

  // Waits for n real animation frames (so the DOM/HUD has caught up before a screenshot).
  const frames = (n = 6) => page.evaluate((k) => new Promise((res) => {
    let i = 0;
    const t = setTimeout(res, 10000);
    (function f() { if (++i >= k) { clearTimeout(t); res(); } else requestAnimationFrame(f); })();
  }), n);

  const shot = async (name) => {
    fs.mkdirSync(SHOTS, { recursive: true });
    await frames(8);
    const p = path.join(SHOTS, tag + '-' + name + '.png');
    await page.screenshot({ path: p });
    note('shot ' + p);
    return p;
  };

  // Turns the view with real look input (h.look → G.input.addLook → player.js) until the eye
  // looks at the world point (x, y, z). Closed loop, so frame stalls do not matter.
  const aimAt = async (x, y, z, tol = 0.004) => {
    for (let k = 0; k < 8; k++) {
      const d = await page.evaluate(([tx, ty, tz]) => {
        const P = G.player, e = P.eye(new THREE.Vector3());
        const dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
        const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
        let dyaw = yaw - P.yaw;
        while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
        while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
        const kk = 0.0022 * (Number(G.settings.sensitivity) || 1);
        return { dyaw, dpitch: pitch - P.pitch, k: kk, inv: G.settings.invertY ? -1 : 1, yaw: P.yaw, pitch: P.pitch };
      }, [x, y, z]);
      if (Math.abs(d.dyaw) < tol && Math.abs(d.dpitch) < tol) return true;
      await h.look(-d.dyaw / d.k, -d.dpitch / d.k * d.inv);
      // wait until player.js consumed the look delta
      await until(([y0, p0]) => G.player.yaw !== y0 || G.player.pitch !== p0 || !G.input.looking(), [d.yaw, d.pitch], 8000, 'look applied');
    }
    return false;
  };

  // Presses the hotbar key that selects the first hotbar slot holding `id`.
  const selectItem = async (id) => {
    const i = await page.evaluate((iid) => G.inventory.slots.slice(0, 8).findIndex((s) => s && s.id === iid), id);
    if (i < 0) fail('item not in hotbar: ' + id);
    await h.key('Digit' + (i + 1));
    await until((ii) => G.inventory.selected === ii, i, 8000, 'hotbar select ' + id);
    return i;
  };

  // Sums the scene graph: object count and renderer memory, for leak checks.
  const sceneStats = () => page.evaluate(() => {
    let objects = 0, meshes = 0, lights = 0;
    G.scene.traverse((o) => { objects++; if (o.isMesh || o.isPoints || o.isLine) meshes++; if (o.isLight) lights++; });
    const m = G.renderer.info.memory;
    return { objects, meshes, lights, geometries: m.geometries, textures: m.textures,
      programs: G.renderer.info.programs ? G.renderer.info.programs.length : 0,
      interactables: G.interaction.items.size, combat: G.combat.targets.size, ground: G.ground.providers.length,
      listeners: Object.values(G.events._h).reduce((a, l) => a + l.length, 0) };
  });

  return { note, fail, ok, until, gameWait, frames, shot, aimAt, selectItem, sceneStats, log };
}
