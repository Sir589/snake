// Menu flow with real clicks and keys: main menu (Ovládání, Nastavení), Nová hra, the HUD and
// first goal, pause with Esc / resume with the button, pause with P / resume with P, "Uložit a do
// menu", Pokračovat, and Nová hra over an existing save (asks for confirmation first).
//   node vor/tools/smoke.mjs --menu --seconds 1 --scenario vor/tools/scenarios/flow.mjs
import { lib } from '../scenario-lib.mjs';

export const smokeArgs = ['--menu'];

export default async (page, h) => {
  const L = lib(page, h, 'flow');
  const { ok, until, shot, note } = L;
  const shown = (id) => h.eval((i) => { const e = document.getElementById(i); return !!e && !e.classList.contains('is-hidden') && e.offsetParent !== null; }, id);

  await until(() => G.state === 'menu' && !document.getElementById('scr-menu').classList.contains('is-hidden'), null, 10000, 'main menu');
  ok(!(await shown('btn-continue')), 'no Pokračovat without a save');
  ok(await h.eval(() => G.camera.position.length() > 5), 'menu camera orbits the raft');
  await page.click('#btn-menu-help');
  await until(() => !document.getElementById('scr-help').classList.contains('is-hidden'), null, 8000, 'help from the menu');
  await shot('menu-help');
  await h.key('Escape');
  await until(() => document.getElementById('scr-help').classList.contains('is-hidden'), null, 8000, 'Esc closes help');
  await page.click('#btn-menu-settings');
  await until(() => !document.getElementById('scr-settings').classList.contains('is-hidden'), null, 8000, 'settings from the menu');
  await page.click('#btn-settings-close');
  await until(() => document.getElementById('scr-settings').classList.contains('is-hidden'), null, 8000, 'settings closed');

  await page.click('#btn-new');
  await until(() => G.state === 'playing' && !G.paused, null, 10000, 'Nová hra starts');
  await L.freeLook();
  await until(() => document.getElementById('scr-menu').classList.contains('is-hidden') && !!document.getElementById('hotbar'), null, 8000, 'menu hidden, HUD shown');
  await until(() => G.time > 0.1, null, 15000, 'first game frames');
  ok(await h.eval(() => G.camera.position.distanceTo(G.player.eye(new THREE.Vector3())) < 0.5), 'camera handed over to the player');
  ok(await h.eval(() => /prken/.test(document.getElementById('goal-text').textContent)), 'goal 1 on the goal card');
  await L.gameWait(1);

  await h.key('Escape');
  await until(() => G.paused && !document.getElementById('scr-pause').classList.contains('is-hidden'), null, 8000, 'Esc pauses');
  const t1 = await h.eval(() => G.time);
  await h.wait(800);
  ok((await h.eval(() => G.time)) === t1, 'game time stops while paused');
  await page.click('#btn-resume');
  await until(() => !G.paused && document.getElementById('scr-pause').classList.contains('is-hidden'), null, 8000, 'Pokračovat resumes');
  await L.gameWait(0.3);
  ok((await h.eval(() => G.time)) > t1, 'game time runs again');
  await h.wait(400);
  await h.key('KeyP');
  await until(() => G.paused, null, 8000, 'P pauses');
  await h.wait(400);
  await h.key('KeyP');
  await until(() => !G.paused, null, 8000, 'P resumes');

  await h.key('Escape');
  await until(() => G.paused, null, 8000, 'paused again');
  await page.click('#btn-save-quit');
  await until(() => G.state === 'menu' && G.save.exists(), null, 8000, 'Uložit a do menu');
  await until(() => document.getElementById('btn-continue').offsetParent !== null, null, 8000, 'Pokračovat offered');
  await shot('menu-with-save');
  await page.click('#btn-continue');
  await until(() => G.state === 'playing' && G.inventory.count('hak') === 1, null, 8000, 'Pokračovat continues');
  await h.eval(() => { G.inventory.add('kov', 3, 'debug'); G.toMenu(); });
  await until(() => G.state === 'menu', null, 8000, 'menu again');

  await page.click('#btn-new');
  await until(() => G.state === 'menu' && document.getElementById('btn-new').classList.contains('confirm'), null, 3000, 'Nová hra over a save asks first');
  ok(await h.eval(() => G.state === 'menu' && G.save.exists()), 'the first click keeps the save: ' + (await h.eval(() => document.getElementById('btn-new').textContent)));
  // The confirmation stays armed for 3.5 s of real time. On a slow runner the second click can
  // land after that; it then simply re-arms the confirmation, so click again.
  let started = false;
  for (let k = 0; k < 3 && !started; k++) {
    await page.click('#btn-new');
    started = await until(() => G.state === 'playing', null, 2000, 'confirmed new game').then(() => true, () => false);
  }
  ok(started, 'the second click starts a new game');
  await until(() => G.state === 'playing' && G.inventory.count('kov') === 0, null, 8000, 'confirmed new game starts fresh');
  note('done');
};
