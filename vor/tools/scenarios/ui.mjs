// UI scenario: inventory open/close, crafting via buttons, moving stacks, storage, pause/resume,
// help/settings, goals, banners, game over and the main menu. Screenshots go to $UI_SHOTS
// (default: /tmp/claude-0/.../scratchpad/ui). Throws on the first broken expectation.
//
//   node vor/tools/smoke.mjs --seconds 1 --scenario vor/tools/scenarios/ui.mjs
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.UI_SHOTS || '/tmp/claude-0/-home-user-snake/81834326-c28e-50ca-bccf-274322532f52/scratchpad/ui';
fs.mkdirSync(OUT, { recursive: true });
// Headless SwiftShader can stall frame production for seconds (CSS animations freeze mid-way),
// so wait for a number of real animation frames before each screenshot.
const settle = (page, frames = 14) => page.evaluate((n) => new Promise((res) => {
  let k = 0;
  const t = setTimeout(res, 8000);
  (function f() { if (++k >= n) { clearTimeout(t); res(); } else requestAnimationFrame(f); })();
}), frames);
const shot = async (page, name) => { await settle(page); await page.screenshot({ path: path.join(OUT, name + '.png') }); };

export default async (page, h) => {
  const log = [];
  // polls (SwiftShader frames can be slow) until the condition holds or 8 s pass
  const check = async (label, fn, arg) => {
    let ok = false;
    const t0 = Date.now();
    while (!(ok = await h.eval(fn, arg)) && Date.now() - t0 < 8000) await h.wait(60);
    log.push((ok ? 'ok   ' : 'FAIL ') + label);
    if (!ok) { console.error(log.join('\n')); throw new Error('UI check failed: ' + label); }
  };
  const visible = (sel) => h.eval((s) => { const e = document.querySelector(s); return !!e && e.offsetParent !== null && getComputedStyle(e).visibility !== 'hidden'; }, sel);
  const waitVisible = async (sel, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await visible(sel)) return true; await h.wait(50); }
    throw new Error('not visible: ' + sel);
  };

  await h.eval(() => { if (G.debug.god) G.debug.god(); });
  await h.wait(1200);
  await check('HUD built', () => !!document.getElementById('hotbar') && !document.getElementById('boot-msg'));
  await check('hotbar shows the hook in slot 1', () => document.querySelector('#hot-slot-0 .slot-icon').textContent === '🪝');
  await check('goal card shows goal 1', () => /prken/.test(document.getElementById('goal-text').textContent));
  await shot(page, '01-hud');

  // --- inventory: Tab opens, panel blocks ---
  await h.key('Tab');
  await h.wait(200);
  await check('Tab opens inventory', () => G.ui.isOpen() && G.uiBlocking() && G.ui.tab === 'inv');
  await check('28 slots rendered', () => document.querySelectorAll('#inv-panel .inv-slot').length === 28);

  // move the planks stack (slot 1 → backpack slot 12) with click-click
  await h.eval(() => { G.inventory.select(0); });
  const from = await h.eval(() => G.inventory.slots.findIndex((s) => s && s.id === 'prkno'));
  await page.click('#inv-slot-' + from);
  await h.wait(80);
  await check('stack lifted onto the cursor', () => !!G.ui.heldSlot() && !document.getElementById('cursor-stack').classList.contains('is-hidden'));
  await page.mouse.move(500, 300);
  await h.wait(60);
  await shot(page, '02-inventory-held');
  await page.click('#inv-slot-12');
  await h.wait(80);
  await check('stack moved to slot 12', () => G.inventory.slots[12] && G.inventory.slots[12].id === 'prkno' && !G.ui.heldSlot());

  // shift-click moves it back to the hotbar
  await page.click('#inv-slot-12', { modifiers: ['Shift'] });
  await h.wait(80);
  await check('shift-click moves to hotbar', () => { const i = G.inventory.slots.findIndex((s) => s && s.id === 'prkno'); return i >= 0 && i < 8; });

  // right-click splits
  const pi = await h.eval(() => G.inventory.slots.findIndex((s) => s && s.id === 'prkno'));
  await page.click('#inv-slot-' + pi, { button: 'right' });
  await h.wait(80);
  await check('right-click splits the planks', () => G.inventory.slots.filter((s) => s && s.id === 'prkno').length === 2 && G.inventory.count('prkno') === 4);

  // food: pick up a coconut and eat it via the detail button
  await h.eval(() => { G.inventory.add('kokos', 2, 'debug'); G.player.hunger = 50; });
  await h.wait(120);
  const ki = await h.eval(() => G.inventory.slots.findIndex((s) => s && s.id === 'kokos'));
  await page.click('#inv-slot-' + ki);
  await waitVisible('#btn-eat');
  await shot(page, '03-inventory-detail');
  await page.click('#btn-eat');
  await h.wait(120);
  await check('eat button eats one coconut', () => G.inventory.count('kokos') === 1 && G.player.hunger > 55);
  await page.click('#inv-slot-' + ki);          // put the rest back
  const kj = await h.eval(() => G.inventory.slots.findIndex((s) => s && s.id === 'kokos'));
  await page.dblclick('#inv-slot-' + kj);
  await check('double-click eats the last coconut', () => G.inventory.count('kokos') === 0 && !G.ui.heldSlot());

  // --- crafting tab: craft a hammer with the button ---
  await h.eval(() => { G.inventory.add('prkno', 10, 'debug'); G.inventory.add('plast', 10, 'debug'); G.inventory.add('list', 6, 'debug'); });
  await page.click('#tab-craft');
  await h.wait(150);
  await check('craft tab visible', () => G.ui.tab === 'craft' && !document.getElementById('craft-view').classList.contains('is-hidden'));
  await check('hammer recipe tagged as goal recipe or visible', () => !!document.getElementById('craft-btn-kladivo'));
  await h.eval(() => G.debug.completeGoal('prkna'));
  await h.wait(200);
  // pick the Nástroje category
  await page.click('#cat-0');
  await h.wait(100);
  await check('hammer craft button enabled', () => !document.getElementById('craft-btn-kladivo').disabled);
  await check('hammer recipe carries the goal tag', () => !document.querySelector('#craft-kladivo .r-goal').classList.contains('is-hidden'));
  await shot(page, '04-crafting');
  await page.click('#craft-btn-kladivo');
  await h.wait(150);
  await check('hammer crafted via UI', () => G.inventory.count('kladivo') === 1);
  // disabled when missing
  await check('cannon disabled without metal', () => document.getElementById('craft-btn-kanon').disabled === true);
  // materials: rope via keyboard (select category with arrows, Enter)
  await page.click('#cat-4');
  await h.wait(80);
  await h.eval(() => document.activeElement && document.activeElement.blur());
  const rope0 = await h.eval(() => G.inventory.count('provaz'));
  await h.key('Enter');
  await h.wait(120);
  await check('Enter crafts the selected recipe (rope)', (r0) => G.inventory.count('provaz') === r0 + 1, rope0);

  // C toggles: in craft tab C closes
  await h.key('KeyC');
  await h.wait(150);
  await check('C closes from craft tab', () => !G.ui.isOpen() && !G.uiBlocking());
  await h.key('KeyC');
  await h.wait(150);
  await check('C opens craft tab', () => G.ui.isOpen() && G.ui.tab === 'craft');
  await h.key('Escape');
  await h.wait(150);
  await check('Esc closes the panel (no pause)', () => !G.ui.isOpen() && !G.paused);

  // --- storage ---
  await h.eval(() => {
    window.__st = G.inventory.createStorage(20);
    G.inventory.addTo(window.__st, 'kov', 5);
    G.inventory.addTo(window.__st, 'provaz', 3);
    G.ui.openStorage(window.__st, 'Truhla');
  });
  await h.wait(200);
  await check('storage open', () => G.ui.storageOpen && document.querySelectorAll('#grid-sto .inv-slot').length === 20);
  await shot(page, '05-storage');
  await page.click('#sto-slot-0', { modifiers: ['Shift'] });
  await h.wait(80);
  await check('shift-click storage → inventory', () => G.inventory.count('kov') === 5 && !window.__st.slots[0]);
  await page.click('#btn-take-all');
  await h.wait(80);
  await check('Vzít vše empties storage', () => window.__st.slots.every((s) => !s));
  await h.key('Tab');
  await h.wait(120);
  await check('Tab closes storage', () => !G.ui.isOpen());

  // --- pause / resume by keyboard ---
  await h.key('Escape');
  await h.wait(200);
  await check('Esc pauses', () => G.paused && !document.getElementById('scr-pause').classList.contains('is-hidden'));
  await shot(page, '06-pause');
  await page.click('#btn-pause-settings');
  await h.wait(200);
  await check('settings open', () => !document.getElementById('scr-settings').classList.contains('is-hidden'));
  await page.click('#set-invert');
  await page.click('#set-quality-low');
  await h.wait(80);
  await check('settings saved', () => G.settings.invertY === true && G.settings.quality === 'low');
  await shot(page, '07-settings');
  await page.click('#set-invert');
  await page.click('#set-quality-high');
  await page.click('#btn-settings-close');
  await h.wait(150);
  await page.click('#btn-pause-help');
  await h.wait(200);
  await shot(page, '08-help');
  await h.key('Escape');
  await h.wait(150);
  await check('Esc closes help back to pause', () => G.paused && !document.getElementById('scr-pause').classList.contains('is-hidden'));
  await h.wait(300);
  await h.key('KeyP');
  await h.wait(200);
  await check('P resumes', () => !G.paused && document.getElementById('scr-pause').classList.contains('is-hidden'));

  // --- help toggle with H during play ---
  await h.key('KeyH');
  await h.wait(150);
  await check('H opens help (blocking)', () => G.ui.isOpen() && G.uiBlocking());
  await h.key('KeyH');
  await h.wait(150);
  await check('H closes help', () => !G.ui.isOpen() && !G.uiBlocking());

  // --- HUD extras: notifications, banners, progress ring, damage ---
  await h.eval(() => {
    G.inventory.add('prkno', 1, 'hook'); G.inventory.add('prkno', 2, 'hook'); G.inventory.add('plast', 1, 'debris');
    G.notify('Na obzoru je ostrov!', 'info');
    G.notify('Kolem voru krouží žralok!', 'warn');
    G.ui.banner('Piráti na obzoru!', 'danger', 3);
    G.hud.setProgress(0.6, 'Síla hodu');
    G.hud.setToolHint('Podrž a pusť: hodit hák');
    G.events.emit('player:damaged', { amount: 20, source: 'test' });
  });
  await h.wait(400);
  await check('gains merged into one toast', () => [...document.querySelectorAll('.note-gain')].some((n) => /\+3/.test(n.textContent) && /Prkno/.test(n.textContent)));
  await shot(page, '09-hud-busy');
  await h.eval(() => { G.hud.setProgress(null); G.hud.setToolHint(''); });

  // --- goal completion flourish ---
  await check('goal 2 done (hammer crafted)', () => G.goals.get('kladivo').done);
  await h.wait(2600);
  await check('card moved on to goal 3', () => /základy/.test(document.getElementById('goal-text').textContent));

  // --- victory card ---
  await h.eval(() => G.debug.completeGoalsUpTo(13));
  await h.wait(2200);
  await check('victory card shows', () => !document.getElementById('scr-victory').classList.contains('is-hidden'));
  await shot(page, '10-victory');
  await page.click('#btn-victory-continue');
  await h.wait(150);
  await check('victory closes', () => !G.ui.isOpen() && !G.uiBlocking());

  // --- game over ---
  await h.eval(() => { G.gameOver('Sežral tě žralok.'); });
  await h.wait(2000);
  await check('game over screen', () => !document.getElementById('scr-over').classList.contains('is-hidden') && /žralok/.test(document.getElementById('over-reason').textContent));
  await shot(page, '11-gameover');
  await page.click('#btn-over-menu');
  await h.wait(400);
  await check('back in menu', () => G.state === 'menu' && !document.getElementById('scr-menu').classList.contains('is-hidden'));
  await check('menu buttons present', () => ['btn-new', 'btn-menu-help', 'btn-menu-settings'].every((id) => !!document.getElementById(id)));
  await shot(page, '12-menu');
  await page.click('#btn-new');
  await h.wait(400);
  await check('new game from menu', () => G.state === 'playing' && G.inventory.count('hak') === 1);

  // --- narrow (phone) layout ---
  await page.setViewportSize({ width: 390, height: 844 });
  await h.eval(() => {
    if (!G.input.touchMode) { G.input.touchMode = true; G.events.emit('input:touchmode', true); }
    G.inventory.add('prkno', 3, 'hook'); G.notify('Úkol splněn: Test', 'good');
  });
  await check('touch class on root', () => document.getElementById('ui-root').classList.contains('is-touch'));
  await h.wait(500);
  await shot(page, '13-phone-hud');
  await h.key('Tab');
  await h.wait(250);
  await shot(page, '14-phone-inventory');
  await page.click('#tab-craft');
  await h.wait(200);
  await shot(page, '15-phone-crafting');
  await h.key('Tab');
  await page.setViewportSize({ width: 1280, height: 720 });
  await h.eval(() => G.toMenu());
  await h.wait(600);
  await shot(page, '16-menu-continue');
  await h.eval(() => G.newGame());
  await h.wait(300);

  console.error(log.join('\n'));
};
