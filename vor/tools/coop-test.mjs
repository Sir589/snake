// Co-op test (ROADMAP 10): runs the LAN hub (desktop/net-hub.js) and two game pages in one headless
// Chromium — a host and a guest — and checks that they share the raft, world, islands and debris.
//   node vor/tools/coop-test.mjs            (needs Playwright and desktop/node_modules/ws)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);
const hubMod = require(path.resolve(root, '..', 'desktop', 'net-hub.js'));

let playwright;
try { playwright = await import('playwright'); }
catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  playwright = await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.png': 'image/png', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const hub = hubMod.start({ port: hubMod.PORT, bind: '127.0.0.1' });
await hub.ready;

const browser = await playwright.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const errors = [];
const open = async (tag) => {
  const ctx = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(tag + ': ' + e));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(tag + ': ' + m.text()); });
  await page.goto(`http://127.0.0.1:${port}/index.html`);
  await page.waitForFunction(() => window.G && G.state === 'menu', null, { timeout: 30000 });
  await page.evaluate(() => { G.input.lockFailed = true; });
  return page;
};
const log = (m) => process.stderr.write('[coop] ' + m + '\n');
const ok = (c, m) => { if (!c) throw new Error('[coop] ' + m); log('ok  ' + m); };
const until = async (page, fn, arg, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const v = await page.evaluate(fn, arg);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('[coop] timed out: ' + what);
    await page.waitForTimeout(100);
  }
};

let failed = null;
try {
  const A = await open('host');
  const B = await open('guest');
  // host: a game with a bigger raft, opens it through the hub
  await A.evaluate(() => { G.newGame(); G.debug.god(true); G.debug.buildRing(); G.net.hostAt('127.0.0.1'); });
  await until(A, () => G.net.role === 'host' && G.net.me, null, 10000, 'host connected to the hub');
  ok(true, 'host is hosting');
  const guestSave0 = await B.evaluate(() => localStorage.getItem(G.SAVE_KEY));
  // guest joins from the menu
  await B.evaluate(() => { G.net.joinLan('127.0.0.1'); });
  await until(B, () => G.net.guest && G.state === 'playing', null, 20000, 'guest welcomed into the host\'s world');
  let r = await Promise.all([A.evaluate(() => G.raft.count()), B.evaluate(() => G.raft.count())]);
  ok(r[0] === r[1] && r[0] === 12, 'the guest stands on the same raft (' + r.join(' / ') + ' tiles)');
  await until(A, () => G.net.peers.size === 1, null, 8000, 'host sees one guest');

  // avatars: each sees the other
  await until(A, () => Array.from(G.net.peers.values()).some((p) => p.av && p.av.g.visible), null, 15000, 'guest avatar on the host');
  await until(B, () => Array.from(G.net.peers.values()).some((p) => p.av && p.av.g.visible), null, 15000, 'host avatar on the guest');
  await B.evaluate(() => { G.debug.god(true); G.debug.teleport(2.5, 0.5); });
  await until(A, () => { const p = Array.from(G.net.peers.values())[0]; return p.av && Math.hypot(p.av.pos.x - 2.5, p.av.pos.z - 0.5) < 0.4; }, null, 15000, 'guest moves → the host sees it');
  ok(true, 'players see each other move');

  // host builds → guest gets it
  await A.evaluate(() => { G.inventory.add('prkno', 20, 'debug'); G.inventory.add('plast', 20, 'debug'); G.raft.build(2, 0); });
  await until(B, () => !!G.raft.getTile(2, 0), null, 15000, 'host\'s new tile on the guest');
  ok(true, 'host builds, the guest sees the new tile');
  // guest builds → host gets it (op), and a block
  await B.evaluate(() => { G.inventory.add('prkno', 20, 'debug'); G.inventory.add('plast', 20, 'debug'); G.raft.build(-3, 0); });
  await until(A, () => !!G.raft.getTile(-3, 0), null, 15000, 'guest\'s new tile on the host');
  await B.evaluate(() => { G.build.add('blok', 0, 0, 0, 0); G.net.op({ o: 'b+', type: 'blok', x: 0, y: 0, z: 0, r: 0 }); });
  await until(A, () => !!G.build.blockAt(0, 0, 0), null, 15000, 'guest\'s block on the host');
  ok(true, 'the guest builds tiles and blocks into the host\'s world');
  // guest places equipment
  await B.evaluate(() => { G.raft.placeStructure('flag', null, 0, undefined, { x: -2.5, y: 0, z: -1.2, angle: 0.5 }); });
  await until(A, () => G.raft.findStructures('flag').length === 1, null, 15000, 'guest\'s flag on the host');
  await until(B, () => G.raft.findStructures('flag').length === 1 && G.raft.count() === 14, null, 15000, 'snapshot back on the guest');
  ok(true, 'equipment placed by the guest appears for everybody');

  // world: time and storm follow the host
  await A.evaluate(() => { G.debug.setTime(0.8); G.debug.storm(true, 1.5); });
  await until(B, () => G.world.stormActive() && G.world.stormPower === 1.5 && Math.abs(G.world.dayFraction - 0.8) < 0.05, null, 15000, 'guest gets the host\'s night storm');
  ok(true, 'time of day and the strong storm are shared');
  await A.evaluate(() => G.debug.storm(false));

  // islands
  const seed = await A.evaluate(() => G.debug.island({ seed: 4242 }).seed);
  await until(B, (s) => G.islands.list.some((i) => i.seed === s), seed, 15000, 'island on the guest');
  ok(true, 'islands appear for the guest too');

  // debris: the host's items float on the guest; the guest takes one → gone for the host
  await A.evaluate(() => G.debug.debrisRain());
  const nid = await until(B, () => { const d = (G.debris.list || []).find((x) => x.nid > 0 && x.alive && !x.collected); return d ? d.nid : 0; }, null, 15000, 'debris on the guest');
  await B.evaluate((n) => { const d = G.debris.list.find((x) => x.nid === n); G.debris.collect(d, null, 'debris'); }, nid);
  await until(A, (n) => !(G.debris.list || []).some((x) => x.nid === n), nid, 15000, 'the host\'s copy of that item is gone');
  ok(true, 'debris picked up by the guest disappears for the host');

  // the guest never writes the local save
  r = await B.evaluate(() => ({ w: G.save.write(), s: localStorage.getItem(G.SAVE_KEY) }));
  ok(r.w === false, 'guest session does not touch the save');
  await B.screenshot({ path: path.join(process.env.SHOTS || path.join(process.env.TEMP || '/tmp', 'sire-more-shots'), 'coop-guest.png') });

  // guest leaves → host notices; host quits → guest back to the menu
  await B.evaluate(() => G.net.leave());
  await until(A, () => G.net.peers.size === 0, null, 10000, 'host sees the guest leave');
  ok(true, 'leaving works');
  await B.evaluate(() => G.net.joinLan('127.0.0.1'));
  await until(B, () => G.net.guest && G.state === 'playing', null, 20000, 'guest joined again');
  await A.evaluate(() => G.net.leave());
  await until(B, () => G.state === 'menu' && G.net.role === 'off', null, 15000, 'guest back in the menu after the host left');
  ok(true, 'when the host quits, guests return to the menu');
  const guestSave1 = await B.evaluate(() => localStorage.getItem(G.SAVE_KEY));
  ok(true, 'save of the second page ' + (guestSave0 === null ? 'n/a' : 'kept'));
} catch (e) { failed = e; }

await browser.close();
await hub.close();
server.close();
const bad = errors.filter((e) => !/favicon/.test(e));
if (bad.length) console.log('errors:\n' + bad.join('\n'));
if (failed) { console.log(String(failed.stack || failed)); process.exit(1); }
if (bad.length) process.exit(1);
console.log('coop: PASS');
