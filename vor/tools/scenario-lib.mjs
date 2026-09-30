// Shared helpers for the scenarios in tools/scenarios/ (not a scenario itself).
//
//   import { lib } from '../scenario-lib.mjs';
//   export default async (page, h) => { const L = lib(page, h, 'build'); ... };
//
// Headless SwiftShader renders slowly and unevenly (game time runs at 0.1–0.6× real time on a
// loaded machine and single frames can stall for seconds), so everything here waits for
// conditions or for game time, never for fixed real-time delays. Timeouts are budgets of
// *simulated* time (G.clock, the sum of frame dt in every state), so a slow runner only makes a
// scenario take longer instead of failing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHOTS = process.env.SHOTS || path.join(os.tmpdir(), 'sire-more-shots');

export function lib(page, h, tag) {
  const log = [];
  const note = (t) => { log.push(t); process.stderr.write('[' + tag + '] ' + t + '\n'); };
  const fail = (m) => { throw new Error('[' + tag + '] ' + m); };
  const ok = (c, m) => { if (!c) fail(m); note('ok  ' + m); };

  const clock = () => page.evaluate(() => (window.G && G.clock) || 0);

  // Polls fn (evaluated in the page) until it returns something truthy. Gives up only once both
  // `ms` of real time and `ms` of simulated time (G.clock) have passed (hard cap 30× + 30 s).
  const until = async (fn, arg, ms = 15000, what = 'condition') => {
    const t0 = Date.now(), c0 = await clock(), hard = ms * 30 + 30000;
    let v;
    for (;;) {
      v = await page.evaluate(fn, arg);
      if (v) return v;
      const el = Date.now() - t0;
      if (el >= ms && (el >= hard || ((await clock()) - c0) * 1000 >= ms)) break;
      await page.waitForTimeout(60);
    }
    fail('timed out waiting for ' + what);
  };

  // Waits until `sec` seconds of simulated time (G.clock: advances in menus / pause too) passed.
  const settle = async (sec) => {
    const c0 = await clock(), cap = Date.now() + sec * 30000 + 30000;
    while (Date.now() < cap) {
      if ((await clock()) - c0 >= sec) return;
      await page.waitForTimeout(40);
    }
    fail('the page did not render ' + sec + ' s of frames');
  };

  // Waits until `sec` seconds of game time (G.time) have passed (real-time cap: 30× + 30 s).
  const gameWait = async (sec) => {
    const t0 = await page.evaluate(() => G.time);
    const cap = Date.now() + sec * 30000 + 30000;
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

  // After a real click on "Nová hra" / "Pokračovat" headless Chromium grants pointer lock, and
  // then every synthetic mouse event carries a bogus movement (lock point → cursor) that spins
  // the view. Drop the lock and use the free-look fallback instead (like smoke.mjs does).
  const freeLook = async () => {
    await page.evaluate(() => { G.input.lockFailed = true; });
    // let a pending lock request settle (the pointerlockchange event is async)
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) {
      if (await page.evaluate(() => G.input.pointerLocked === !!document.pointerLockElement)) break;
      await page.waitForTimeout(50);
    }
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      G._suppressLockPause = true;
      if (document.pointerLockElement) document.exitPointerLock();
    });
    await until(() => !document.pointerLockElement && !G.input.pointerLocked, null, 8000, 'pointer lock released');
    await page.waitForTimeout(200);
    for (let k = 0; k < 20; k++) {
      const ok = await page.evaluate(() => { G.input.lockFailed = true; if (G.paused) G.setPaused(false); return !G.paused && !document.pointerLockElement; });
      if (ok) break;
      await page.waitForTimeout(100);
    }
    await page.mouse.move(h.viewport ? h.viewport.width / 2 : 640, h.viewport ? h.viewport.height / 2 : 360);
    await until(() => !G.paused && G.state === 'playing', null, 8000, 'playing (not paused) in free look');
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

  return { note, fail, ok, until, settle, gameWait, frames, shot, aimAt, selectItem, sceneStats, freeLook, log };
}
