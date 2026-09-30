// Runs every scenario in vor/tools/scenarios/ through smoke.mjs and prints a pass/fail table.
//
//   node vor/tools/run-all.mjs [--only name,name] [--jobs N] [--logs dir] [--seconds N] [--probe]
//
// --probe passes smoke.mjs --probe to every scenario and lists missing API members / unknown
// sfx names that any scenario touched (see smoke.mjs).
//
// A scenario can ask for extra smoke.mjs flags (e.g. --mobile, --menu) by exporting
//   export const smokeArgs = ['--mobile'];
// Scenarios run one after another by default (--jobs 1): headless SwiftShader is CPU bound and
// several scenarios measure game time, so running them side by side only makes each one slower.
// Exit code 1 if any scenario fails (a thrown assertion, a page error or a console error).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const scenDir = path.join(here, 'scenarios');
const smoke = path.join(here, 'smoke.mjs');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf('--' + name);
  if (i < 0) return def;
  const v = args[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};
const only = opt('only', null);
const jobs = Math.max(1, Number(opt('jobs', 1)) || 1);
const seconds = String(opt('seconds', 1));
const probe = !!opt('probe', false);
const logDir = opt('logs', path.join(os.tmpdir(), 'sire-more-run-all'));
fs.mkdirSync(logDir, { recursive: true });

let files = fs.readdirSync(scenDir).filter((f) => f.endsWith('.mjs')).sort();
if (only) {
  const want = String(only).split(',').map((s) => s.trim().replace(/\.mjs$/, ''));
  files = files.filter((f) => want.includes(f.replace(/\.mjs$/, '')));
}
if (!files.length) { console.error('No scenarios matched.'); process.exit(1); }

async function flagsOf(file) {
  try {
    const mod = await import(pathToFileURL(path.join(scenDir, file)).href);
    return Array.isArray(mod.smokeArgs) ? mod.smokeArgs.map(String) : [];
  } catch (e) { return []; }
}

function runOne(file, flags) {
  return new Promise((resolve) => {
    const name = file.replace(/\.mjs$/, '');
    const t0 = Date.now();
    const argv = [smoke, '--seconds', seconds, '--scenario', path.join(scenDir, file), ...flags, ...(probe ? ['--probe'] : [])];
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      const secs = (Date.now() - t0) / 1000;
      fs.writeFileSync(path.join(logDir, name + '.log'), out + '\n--- stderr ---\n' + err);
      let report = null;
      try { report = JSON.parse(out.slice(out.indexOf('{'))); } catch (e) { /* not JSON */ }
      let why = '';
      if (code !== 0) {
        if (report && report.harnessError) why = report.harnessError.split('\n')[0];
        else if (report && report.pageErrors && report.pageErrors.length) why = 'page error: ' + report.pageErrors[0].split('\n')[0];
        else if (report && report.consoleErrors && report.consoleErrors.length) why = 'console error: ' + report.consoleErrors[0].split('\n')[0];
        else why = 'exit ' + code + (err ? ': ' + err.trim().split('\n').pop() : '');
      }
      resolve({ name, pass: code === 0, secs, why, fps: report && report.fps, probe: report && report.probe });
    });
  });
}

const results = [];
const queue = files.slice();
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const flags = await flagsOf(f);
    process.stderr.write(`▶ ${f}${flags.length ? ' ' + flags.join(' ') : ''}\n`);
    const r = await runOne(f, flags);
    process.stderr.write(`${r.pass ? '✔' : '✘'} ${r.name} (${r.secs.toFixed(0)} s)${r.why ? ' — ' + r.why : ''}\n`);
    results.push(r);
  }
}
await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, worker));

results.sort((a, b) => files.indexOf(a.name + '.mjs') - files.indexOf(b.name + '.mjs'));
const w = Math.max(8, ...results.map((r) => r.name.length));
console.log('\n' + 'scenario'.padEnd(w) + '  result  time    note');
console.log('-'.repeat(w) + '  ------  ------  ' + '-'.repeat(40));
for (const r of results) {
  console.log(r.name.padEnd(w) + '  ' + (r.pass ? 'PASS  ' : 'FAIL  ') + '  ' +
    (r.secs.toFixed(0) + ' s').padEnd(6) + '  ' + (r.why || ''));
}
if (probe) {
  const missing = {}, sfx = new Set();
  for (const r of results) {
    if (!r.probe) continue;
    for (const k in r.probe.missing) if (!missing[k]) missing[k] = r.name + ': ' + r.probe.missing[k];
    for (const n of r.probe.unknownSfx) sfx.add(n);
  }
  console.log('\nProbe: missing API members read during the runs:');
  for (const k of Object.keys(missing).sort()) console.log('  ' + k.padEnd(34) + ' ' + missing[k]);
  if (!Object.keys(missing).length) console.log('  (none)');
  console.log('Probe: unknown sfx names: ' + (sfx.size ? [...sfx].join(', ') : '(none)'));
}
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed. Logs: ${logDir}`);
process.exit(failed ? 1 : 0);
