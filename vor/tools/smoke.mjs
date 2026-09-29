// Headless smoke test: serves vor/ over http, opens it in Chromium, starts a new game,
// runs an optional scenario and prints a JSON report.
//
//   node vor/tools/smoke.mjs [--seconds 5] [--scenario path.mjs] [--shot out.png] [--menu]
//
// A scenario is an ES module: export default async (page, h) => { ... }
// Helpers: h.key(code, ms), h.hold(code), h.release(code), h.mouse(button, ms),
//          h.eval(fn, arg), h.wait(ms), h.shot(path), h.look(dx, dy)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const seconds = Number(opt('seconds', 4));
const scenarioPath = opt('scenario', null);
const shotPath = opt('shot', null);
const stayInMenu = !!opt('menu', false);

let playwright;
try { playwright = await import('playwright'); }
catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  playwright = await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const { chromium } = playwright;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.md': 'text/plain' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, url === '/' ? 'index.html' : url);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

// Serve the three.js CDN build from a local cache (the sandbox proxy's CA is not trusted by
// Chromium) and skip web fonts, which are optional.
const THREE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/0.160.0/three.min.js';
const cacheDir = path.join(here, '.cache');
const threeCache = path.join(cacheDir, 'three-0.160.0.min.js');
if (!fs.existsSync(threeCache)) {
  fs.mkdirSync(cacheDir, { recursive: true });
  execSync(`curl -sSf -o "${threeCache}" "${THREE_URL}"`);
}
await page.route(THREE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(threeCache) }));
await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
const pageErrors = [], consoleErrors = [], consoleWarnings = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !(t.includes('Failed to load resource') && !t.includes('404'))) consoleErrors.push(t);
  else if (m.type() === 'warning' && !t.includes('build/three.min.js')) consoleWarnings.push(t);
});
page.on('requestfailed', (r) => {
  if (!/fonts\.g/.test(r.url())) consoleErrors.push('request failed: ' + r.url());
});

const h = {
  wait: (ms) => page.waitForTimeout(ms),
  key: async (code, ms = 80) => { await page.keyboard.down(code); await page.waitForTimeout(ms); await page.keyboard.up(code); },
  hold: (code) => page.keyboard.down(code),
  release: (code) => page.keyboard.up(code),
  mouse: async (button = 'left', ms = 80) => {
    await page.mouse.move(640, 360);
    await page.mouse.down({ button }); await page.waitForTimeout(ms); await page.mouse.up({ button });
  },
  look: (dx, dy) => page.evaluate(([x, y]) => G.input.addLook(x, y), [dx, dy]),
  eval: (fn, arg) => page.evaluate(fn, arg),
  shot: (p) => page.screenshot({ path: p }),
};

let report = {};
try {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.G && G.state === 'menu', null, { timeout: 20000 });
  if (!stayInMenu) {
    await page.evaluate(() => { G.input.lockFailed = true; G.newGame(); });
  }
  if (scenarioPath) {
    const mod = await import(pathToFileURL(path.resolve(scenarioPath)).href);
    await mod.default(page, h);
  }
  await page.waitForTimeout(seconds * 1000);
  if (shotPath) await page.screenshot({ path: shotPath });
  report = await page.evaluate(() => ({
    state: G.state,
    paused: G.paused,
    time: Math.round(G.time * 10) / 10,
    fps: Math.round(G.fps),
    modules: G.modules.map((m) => m.name + (m._errored ? '(ERRORED)' : '')),
    player: G.player && G.player.position ? {
      pos: G.player.position.toArray().map((v) => Math.round(v * 100) / 100),
      health: G.player.health, hunger: G.player.hunger, thirst: G.player.thirst, inWater: G.player.inWater,
    } : null,
    raftTiles: G.raft && G.raft.count ? G.raft.count() : null,
    inventory: G.inventory && G.inventory.slots ? G.inventory.slots.filter(Boolean).map((s) => s.id + 'x' + s.count) : null,
    drawCalls: G.renderer.info.render.calls,
    triangles: G.renderer.info.render.triangles,
  }));
} catch (err) {
  report.harnessError = String(err && err.stack || err);
}
report.pageErrors = pageErrors;
report.consoleErrors = consoleErrors;
report.consoleWarnings = consoleWarnings.slice(0, 20);
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(pageErrors.length || consoleErrors.length || report.harnessError ? 1 : 0);
