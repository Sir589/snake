// Renders tools/icon.svg into build/icon-512.png, build/icon-256.png, build/icon.png (512)
// and build/icon.ico (16–256 px, PNG-compressed entries). Needs Playwright (npm i -g playwright).
//   node tools/make-icons.mjs
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(here, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

let playwright;
try { playwright = await import('playwright'); }
catch {
  const globalRoot = execSync('npm root -g').toString().trim();
  playwright = await import(pathToFileURL(path.join(globalRoot, 'playwright', 'index.mjs')).href);
}

const svg = fs.readFileSync(path.join(here, 'icon.svg'), 'utf8');
const browser = await playwright.chromium.launch();
const page = await browser.newPage();

async function render(size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</body></html>`);
  return page.locator('svg').screenshot({ omitBackground: true });
}

const pngs = {};
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) pngs[s] = await render(s);
await browser.close();

fs.writeFileSync(path.join(buildDir, 'icon-512.png'), pngs[512]);
fs.writeFileSync(path.join(buildDir, 'icon-256.png'), pngs[256]);
fs.writeFileSync(path.join(buildDir, 'icon.png'), pngs[512]);

// ICO container: 6-byte header, 16-byte directory entries, then the PNG blobs.
const sizes = [16, 24, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
const dir = Buffer.alloc(16 * sizes.length);
let offset = 6 + dir.length;
sizes.forEach((s, i) => {
  const b = pngs[s], o = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, o); dir.writeUInt8(s >= 256 ? 0 : s, o + 1);
  dir.writeUInt8(0, o + 2); dir.writeUInt8(0, o + 3);
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(b.length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += b.length;
});
fs.writeFileSync(path.join(buildDir, 'icon.ico'), Buffer.concat([header, dir, ...sizes.map((s) => pngs[s])]));
console.log('Ikony hotové v', buildDir);
