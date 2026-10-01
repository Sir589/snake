// Draft Steam store art: game screenshots (1920×1080, no HUD) and capsule images in the sizes
// Steamworks asks for. Output goes to desktop/store/out/.
//   node desktop/store/make-store-art.mjs        (needs Playwright)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const game = path.resolve(here, '..', '..', 'vor');
const out = path.join(here, 'out');
fs.mkdirSync(out, { recursive: true });

let playwright;
try { playwright = await import('playwright'); }
catch { playwright = await import(pathToFileURL(path.join(execSync('npm root -g').toString().trim(), 'playwright', 'index.mjs')).href); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const base = u.startsWith('/out/') ? here : game;
  const f = path.join(base, u === '/' ? 'index.html' : u);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${port}/index.html`);
await page.waitForFunction(() => window.G && G.state === 'menu', null, { timeout: 60000 });
const ev = (fn, a) => page.evaluate(fn, a);
const wait = async (sec) => { const t0 = await ev(() => G.clock); await page.waitForFunction((t) => G.clock >= t, t0 + sec, { timeout: 600000 }); };
const shot = async (name) => {
  await ev(() => { for (const e of document.querySelectorAll('#ui > *, #touch > *, #scope')) { e.dataset.hid = e.style.display; e.style.display = 'none'; } G.hud.crosshair = 'hidden'; });
  await wait(0.3);
  await page.screenshot({ path: path.join(out, name + '.png') });
  await ev(() => { for (const e of document.querySelectorAll('#ui > *, #touch > *, #scope')) e.style.display = e.dataset.hid || ''; });
  console.log('shot', name);
};
const look = (x, y, z) => ev(([x, y, z]) => {
  const P = G.player, e = P.eye(new THREE.Vector3());
  P.yaw = Math.atan2(-(x - e.x), -(z - e.z)); P.pitch = Math.atan2(y - e.y, Math.hypot(x - e.x, z - e.z));
}, [x, y, z]);

await ev(() => { G.input.lockFailed = true; G.settings.quality = 'high'; G.applyQuality && G.applyQuality(); G.newGame(); G.debug.god(true); });
await wait(1);
// 1) a grown raft with a big sail and a house at golden hour
await ev(() => {
  for (let i = -3; i <= 2; i++) for (let j = -3; j <= 2; j++) if (!G.raft.getTile(i, j)) G.raft.addTile(i, j);
  G.debug.house && G.debug.house();
  G.raft.placeStructure('bigsail', null, 0, undefined, { x: 3, y: 0, z: -3, angle: 0 });
  const s = G.raft.findStructures('bigsail')[0]; if (s) { s.data.up = true; s._v.raise = 1; }
  G.raft.placeStructure('grill', null, 0, undefined, { x: 3, y: 0, z: -2.5, angle: 0.4 });
  G.raft.placeStructure('chest', null, 0, undefined, { x: 3.4, y: 0, z: 3.2, angle: -0.3 });
  G.raft.placeStructure('flag', null, 0, undefined, { x: -5.2, y: 0, z: 4.6, angle: 0 });
  G.debug.setTime(0.71);
  for (const k of ['koza', 'slepice', 'papousek']) G.debug.animal(k);
  G.debug.teleport(5.5, 5.5);
});
await wait(2.5);
await look(-2.5, 2.4, -2);
await shot('screenshot-1-raft');
// 2) island with palms / jungle seen from the raft, midday
await ev(() => { G.debug.setTime(0.47); G.debug.island({ name: 'Džunglový ostrov', seed: 99 }); });
await wait(2);
const isl = await ev(() => { const i = G.islands.nearest(); return [i.position.x, 3, i.position.z]; });
await ev(() => G.debug.teleport(0, 0));
await look(...isl);
await shot('screenshot-2-island');
// 3) under water on the reef
await ev(() => { for (const i of G.islands.list.slice()) G.islands.remove(i); const P = G.player; G.debug.teleport(14, 14); P.diving = true; });
await wait(0.5);
await ev(() => { const P = G.player; const h = G.seabed.heightAt(P.position.x, P.position.z); P.position.y = h + 1.6; P.velocity.set(0, 0, 0); P.diving = true; P.pitch = -0.15; P.yaw = 2.4; });
await wait(1.5);
await shot('screenshot-3-reef');
// 4) pirates from the cannon
await ev(() => {
  G.debug.teleport(0, 0); G.player.diving = false;
  G.inventory.add('koule', 10, 'debug');
  const s = G.raft.placeStructure('cannon', null, 0, undefined, { x: -4.4, y: 0, z: -0.5, angle: -Math.PI / 2 });
  G.debug.pirates('near');
  window.__can = s;
});
await wait(3);
await ev(() => { const sh = G.pirates.ship; sh.frozen = true; sh.position.set(-38, 0, 2); sh.heading = 1.4; G.pirates.sit(window.__can); });
await wait(1.5);
await shot('screenshot-4-pirates');
await ev(() => { G.pirates.stand && G.pirates.stand(true); });
// 5) a strong storm at dusk
await ev(() => { G.debug.setTime(0.76); G.debug.storm(true, 1.5); G.debug.teleport(-4.5, 4.5); });
await wait(4);
await look(3, 2, -3);
await shot('screenshot-5-storm');
await ev(() => G.debug.storm(false));

// --- capsules: a screenshot behind the title -----------------------------------------------------
const cap = async (name, w, h, bg, opts) => {
  opts = opts || {};
  const p2 = await browser.newPage({ viewport: { width: w, height: h } });
  const size = opts.size || Math.round(h * 0.3);
  const html = `<!doctype html><html><head><link rel="stylesheet" href="/fonts/fonts.css">
    <style>html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${opts.transparent ? 'transparent' : '#06222b'}}
    .bg{position:absolute;inset:0;background:url(/out/${bg}.png) center/cover}
    .shade{position:absolute;inset:0;background:${opts.shade || 'linear-gradient(180deg,rgba(4,20,25,0) 35%,rgba(4,20,25,.75))'}}
    .t{position:absolute;left:0;right:0;${opts.top ? 'top:' + opts.top : 'bottom:' + (opts.bottom || '8%')};text-align:center;font-family:'Pirata One';font-size:${size}px;
      color:#f3dcab;text-shadow:0 4px 0 #3a2410,0 8px 24px rgba(0,0,0,.6);letter-spacing:1px;line-height:1}
    .s{display:block;font-family:'Alegreya Sans';font-weight:800;font-size:${Math.round(size * 0.22)}px;color:#e9f1ea;letter-spacing:3px;margin-top:${Math.round(size * 0.08)}px;text-shadow:0 2px 8px rgba(0,0,0,.7)}</style></head>
    <body>${opts.noBg ? '' : '<div class="bg"></div><div class="shade"></div>'}${opts.noTitle ? '' : `<div class="t">Širé moře${opts.sub ? '<span class="s">' + opts.sub + '</span>' : ''}</div>`}</body></html>`;
  fs.writeFileSync(path.join(out, '_cap.html'), html);
  await p2.goto(`http://127.0.0.1:${port}/out/_cap.html`);
  await p2.waitForTimeout(800);
  await p2.evaluate(() => document.fonts.ready);
  await p2.screenshot({ path: path.join(out, name + '.png'), omitBackground: !!opts.transparent });
  await p2.close();
  console.log('capsule', name, w + '×' + h);
};
await cap('header_capsule_920x430', 920, 430, 'screenshot-1-raft', { sub: 'PŘEŽIJ NA VORU' });
await cap('small_capsule_462x174', 462, 174, 'screenshot-1-raft', { size: 82, bottom: '12%' });
await cap('main_capsule_1232x706', 1232, 706, 'screenshot-2-island', { sub: 'PŘEŽIJ NA VORU' });
await cap('vertical_capsule_748x896', 748, 896, 'screenshot-1-raft', { size: 150, sub: 'PŘEŽIJ NA VORU' });
await cap('library_capsule_600x900', 600, 900, 'screenshot-1-raft', { size: 130 });
await cap('library_header_920x430', 920, 430, 'screenshot-2-island', {});
await cap('library_hero_3840x1240', 3840, 1240, 'screenshot-1-raft', { noTitle: true, shade: 'none' });
await cap('library_logo_1280x720', 1280, 720, '', { transparent: true, noBg: true, size: 260, bottom: '30%', sub: 'PŘEŽIJ NA VORU' });
await cap('page_background_1438x810', 1438, 810, 'screenshot-3-reef', { noTitle: true, shade: 'linear-gradient(rgba(4,20,25,.55),rgba(4,20,25,.85))' });

await browser.close();
server.close();
try { fs.unlinkSync(path.join(out, '_cap.html')); } catch (e) { /* ignore */ }
console.log('hotovo →', out);
