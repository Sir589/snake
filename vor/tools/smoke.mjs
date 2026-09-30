// Headless smoke test: serves vor/ over http, opens it in Chromium, starts a new game,
// runs an optional scenario and prints a JSON report.
//
//   node vor/tools/smoke.mjs [--seconds 5] [--scenario path.mjs] [--shot out.png] [--menu] [--mobile]
//
// --menu    stay in the main menu (do not start a new game before the scenario)
// --mobile  390x844 phone viewport with isMobile + hasTouch (touch controls turn on)
// --probe   contract probe: wraps the module API objects (G.raft, G.player, …) in Proxies and
//           reports reads of members that do not exist (report.probe.missing, with the caller)
//           and sfx names audio.js does not synthesize (report.probe.unknownSfx)
//
// A scenario is an ES module: export default async (page, h) => { ... }
// Helpers: h.key(code, ms), h.hold(code), h.release(code), h.mouse(button, ms),
//          h.eval(fn, arg), h.wait(ms), h.shot(path), h.look(dx, dy), h.tap(x, y), h.mobile,
//          h.viewport ({width, height})
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
const mobile = !!opt('mobile', false);
const probe = !!opt('probe', false);
const viewport = mobile ? { width: 390, height: 844 } : { width: 1280, height: 720 };

let playwright;
try { playwright = await import('playwright'); }
catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  playwright = await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}
const { chromium } = playwright;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.md': 'text/plain' };
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
const page = await browser.newPage(mobile
  ? { viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 1 }
  : { viewport });

// The game must run fully offline: every request that leaves the local test server fails
// the run (three.js and the fonts are bundled in lib/ and fonts/).
const offlineViolations = [];
await page.route((url) => !url.href.startsWith('http://127.0.0.1:'), (route) => {
  offlineViolations.push(route.request().url());
  route.abort();
});
const pageErrors = [], consoleErrors = [], consoleWarnings = [];
page.on('pageerror', (e) => pageErrors.push(String(e && e.stack || e)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !(t.includes('Failed to load resource') && !t.includes('404'))) consoleErrors.push(t);
  else if (m.type() === 'warning' && !t.includes('build/three.min.js')) consoleWarnings.push(t);
});
page.on('requestfailed', (r) => {
  if (r.url().startsWith('http://127.0.0.1:')) consoleErrors.push('request failed: ' + r.url());
});

const h = {
  wait: (ms) => page.waitForTimeout(ms),
  key: async (code, ms = 80) => { await page.keyboard.down(code); await page.waitForTimeout(ms); await page.keyboard.up(code); },
  hold: (code) => page.keyboard.down(code),
  release: (code) => page.keyboard.up(code),
  mouse: async (button = 'left', ms = 80) => {
    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.down({ button }); await page.waitForTimeout(ms); await page.mouse.up({ button });
  },
  look: (dx, dy) => page.evaluate(([x, y]) => G.input.addLook(x, y), [dx, dy]),
  eval: (fn, arg) => page.evaluate(fn, arg),
  shot: (p) => page.screenshot({ path: p }),
  tap: (x, y) => page.touchscreen.tap(x, y),
  mobile,
  viewport,
};

// Runs in the page (see --probe).
function installProbe() {
  const P = (G._probe = { missing: {}, unknownSfx: {} });
  const skip = new Set(['then', 'toJSON', 'constructor', 'nodeType', 'isObject3D', 'length', 'valueOf', 'toString', 'inspect', 'asymmetricMatch', '$$typeof']);
  const names = ['items', 'inventory', 'world', 'fx', 'raft', 'player', 'debris', 'fishing', 'shark', 'pirates',
    'islands', 'audio', 'goals', 'ui', 'touch', 'hud', 'interaction', 'combat', 'tools', 'ground', 'save'];
  for (const n of names) {
    const target = G[n];
    if (!target || typeof target !== 'object') { P.missing['G.' + n] = 'module object missing'; continue; }
    G[n] = new Proxy(target, {
      get(t, k, r) {
        if (typeof k === 'string' && !skip.has(k) && !(k in t)) {
          const key = 'G.' + n + '.' + k;
          if (!P.missing[key]) {
            const st = (new Error().stack || '').split('\n').slice(2, 4).map((l) => l.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+\//, '')).join(' < ');
            P.missing[key] = st;
          }
        }
        return Reflect.get(t, k, r);
      },
    });
  }
  G.events.on('sfx', (e) => {
    const a = G.audio;
    if (e && e.name && a && a.has && !a.has(e.name)) P.unknownSfx[e.name] = true;
  });
}

let report = {};
try {
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.G && G.state === 'menu', null, { timeout: 20000 });
  if (probe) await page.evaluate(installProbe);
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
    frameMs: Math.round(G.frameMs || 0),
    modules: G.modules.map((m) => m.name + (m._errored ? '(ERRORED)' : '')),
    player: G.player && G.player.position ? {
      pos: G.player.position.toArray().map((v) => Math.round(v * 100) / 100),
      health: G.player.health, hunger: G.player.hunger, thirst: G.player.thirst, inWater: G.player.inWater,
    } : null,
    raftTiles: G.raft && G.raft.count ? G.raft.count() : null,
    inventory: G.inventory && G.inventory.slots ? G.inventory.slots.filter(Boolean).map((s) => s.id + 'x' + s.count) : null,
    probe: G._probe ? { missing: G._probe.missing, unknownSfx: Object.keys(G._probe.unknownSfx) } : undefined,
    drawCalls: G.renderer.info.render.calls,
    triangles: G.renderer.info.render.triangles,
  }));
} catch (err) {
  report.harnessError = String(err && err.stack || err);
}
report.pageErrors = pageErrors;
if (offlineViolations.length) consoleErrors.push('external requests (game must run offline): ' + offlineViolations.join(', '));
report.consoleErrors = consoleErrors;
report.consoleWarnings = consoleWarnings.slice(0, 20);
console.log(JSON.stringify(report, null, 2));
await browser.close();
server.close();
process.exit(pageErrors.length || consoleErrors.length || report.harnessError ? 1 : 0);
