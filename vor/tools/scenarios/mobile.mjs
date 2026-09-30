// Phone run (390×844, touch): tap "Nová hra" in the menu, then check that the touch controls
// render, the HUD fits the screen without overlaps, and that the joystick, look drag, the use,
// jump, E, inventory and pause buttons work with real touch events (CDP multi-touch).
//   node vor/tools/smoke.mjs --mobile --menu --seconds 1 --scenario vor/tools/scenarios/mobile.mjs
import { lib } from '../scenario-lib.mjs';

export const smokeArgs = ['--mobile', '--menu'];

export default async (page, h) => {
  const L = lib(page, h, 'mobile');
  const { ok, until, shot, note } = L;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map(([x, y, id]) => ({ x, y, id })) });
  const center = (sel) => h.eval((s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
  const tapSel = async (sel) => { const c = await center(sel); if (!c) L.fail('missing ' + sel); await touch('touchStart', [[c[0], c[1], 1]]); await h.wait(120); await touch('touchEnd', []); };

  ok(await h.eval(() => G.state === 'menu'), 'starts in the menu');
  await shot('menu');
  await page.tap('#btn-new');
  await until(() => G.state === 'playing', null, 15000, 'tap on Nová hra starts the game');
  await until(() => G.input.touchMode && G.touch && G.touch.enabled, null, 10000, 'touch mode on');
  await until(() => G.touch.visible && document.body.classList.contains('touch-active'), null, 10000, 'touch controls visible');
  await L.frames(10);

  // --- everything on screen, no overlaps between the HUD blocks and the buttons ---
  const layout = await h.eval(() => {
    const W = innerWidth, H = innerHeight;
    const rect = (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height }; };
    const vis = (e) => e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).opacity !== '0' && e.getBoundingClientRect().width > 0;
    const named = {};
    for (const id of ['hotbar', 'stats', 'goal-card', 'status']) { const e = document.getElementById(id); if (vis(e)) named[id] = rect(e); }
    for (const b of document.querySelectorAll('.tc-btn')) if (vis(b) && !b.classList.contains('tc-gone')) named['btn-' + b.className.split(' ')[1].slice(3)] = rect(b);
    const outside = Object.entries(named).filter(([, r]) => r.x < -1 || r.y < -1 || r.r > W + 1 || r.b > H + 1).map(([k]) => k);
    const keys = Object.keys(named), overlaps = [];
    for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
      const a = named[keys[i]], b = named[keys[j]];
      const ox = Math.min(a.r, b.r) - Math.max(a.x, b.x), oy = Math.min(a.b, b.b) - Math.max(a.y, b.y);
      if (ox > 2 && oy > 2) overlaps.push(keys[i] + '×' + keys[j]);
    }
    const tiny = [...document.querySelectorAll('#ui-root *')].filter((e) => vis(e) && e.children.length === 0 && e.textContent.trim() && parseFloat(getComputedStyle(e).fontSize) < 10).map((e) => e.id || e.className);
    return { W, H, named: Object.keys(named), outside, overlaps, tiny, scrollW: document.documentElement.scrollWidth };
  });
  note('layout: ' + JSON.stringify(layout));
  ok(layout.named.includes('hotbar') && layout.named.includes('stats') && layout.named.filter((k) => k.startsWith('btn-')).length >= 6, 'HUD and touch buttons rendered');
  ok(layout.outside.length === 0, 'everything inside the 390×844 screen (' + layout.outside.join(', ') + ')');
  ok(layout.overlaps.length === 0, 'no overlapping HUD blocks / buttons (' + layout.overlaps.join(', ') + ')');
  ok(layout.scrollW <= layout.W, 'no horizontal page scroll');
  ok(layout.tiny.length === 0, 'no text smaller than 10 px (' + layout.tiny.join(', ') + ')');
  await shot('hud');

  // --- joystick: drag up in the left part → walk forward ---
  const p0 = await h.eval(() => G.player.position.toArray());
  await touch('touchStart', [[90, 640, 1]]);
  await touch('touchMove', [[90, 600, 1]]);
  await touch('touchMove', [[90, 575, 1]]);
  await until(() => G.input.move.y > 0.5, null, 5000, 'joystick pushes forward');
  await L.gameWait(0.4);
  await shot('joystick');
  await touch('touchEnd', []);
  await until(() => G.input.move.y === 0 && G.input.move.x === 0, null, 5000, 'joystick released');
  const p1 = await h.eval(() => G.player.position.toArray());
  ok(Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) > 0.3, 'player walked with the joystick (' + Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(2) + ' m)');
  await h.eval(() => G.debug.teleport(0, 0));        // the start raft is small: back to its middle
  await until(() => G.player.onGround && !G.player.inWater, null, 8000, 'back on the deck');

  // --- look: drag on the right side turns the view ---
  const y0 = await h.eval(() => G.player.yaw);
  await touch('touchStart', [[300, 380, 2]]);
  for (let k = 1; k <= 5; k++) await touch('touchMove', [[300 - k * 16, 380, 2]]);
  await touch('touchEnd', []);
  await until((y) => Math.abs(G.player.yaw - y) > 0.05, y0, 8000, 'look drag turns the view');
  ok(true, 'look drag turned the view');

  // --- use (●) while holding the hook: charge and throw ---
  await h.eval(() => G.inventory.select(0, true));
  const use = await center('.tc-use');
  await touch('touchStart', [[use[0], use[1], 3]]);
  await until(() => G.debris.hookState().state === 'charging', null, 8000, '● charges the hook');
  await L.gameWait(0.5);
  await touch('touchEnd', []);
  await until(() => ['flying', 'water'].includes(G.debris.hookState().state), null, 8000, 'hook thrown on release');
  ok(true, 'the use button throws the hook');
  await tapSel('.tc-alt');
  await until(() => G.debris.hookState().state === 'idle', null, 20000, '◐ cancels the hook');

  // --- jump ---
  const j = await center('.tc-jump');
  await touch('touchStart', [[j[0], j[1], 4]]);
  await until(() => !G.player.onGround, null, 8000, 'jump button jumps');
  await touch('touchEnd', []);
  ok(true, 'jump button works');

  // --- inventory button opens the panel, which fits the screen ---
  await until(() => G.player.onGround, null, 8000, 'landed');
  await tapSel('.tc-inv');
  await until(() => G.ui.isOpen() && !G.touch.visible, null, 8000, 'inventory opens, touch controls hide');
  const inv = await h.eval(() => { const r = document.getElementById('inv-panel').getBoundingClientRect(); return { x: r.left, r: r.right, y: r.top, b: r.bottom, sw: document.documentElement.scrollWidth, W: innerWidth }; });
  ok(inv.x >= -1 && inv.r <= inv.W + 1 && inv.sw <= inv.W, 'inventory panel fits the width (' + JSON.stringify(inv) + ')');
  await shot('inventory');
  // tap to move: tap a stack to pick it up, tap an empty slot to put it down
  await h.eval(() => G.inventory.add('makrela', 2, 'debug'));
  const mi = await h.eval(() => G.inventory.slots.findIndex((s) => s && s.id === 'makrela'));
  await tapSel('#inv-slot-' + mi);
  await until(() => { const hs = G.ui.heldSlot(); return hs && hs.id === 'makrela'; }, null, 5000, 'tap picks up the stack');
  const free = await h.eval(() => { for (let i = 27; i >= 8; i--) if (!G.inventory.slots[i]) return i; return -1; });
  ok(free >= 8, 'a free backpack slot for the tap test');
  await tapSel('#inv-slot-' + free);
  await until((f) => !G.ui.heldSlot() && G.inventory.slots[f] && G.inventory.slots[f].id === 'makrela', free, 5000, 'tap puts the stack down');
  ok(true, 'tap to pick up / put down in the inventory');
  await page.tap('#btn-inv-close');
  await until(() => !G.ui.isOpen() && G.touch.visible, null, 8000, 'inventory closed, touch controls back');

  // --- pause button ---
  await tapSel('.tc-pause');
  await until(() => G.paused && !G.touch.visible, null, 8000, 'pause button pauses');
  await shot('pause');
  await page.tap('#btn-resume');
  await until(() => !G.paused && G.touch.visible, null, 8000, 'resume');
  ok(true, 'pause / resume by touch');
  note('done');
};
