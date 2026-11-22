// Neon Flux v0.3.2 — size sweep screenshots.
// Serves the game dir over local HTTP and captures the menu + gameplay at
// 1280x720, 2560x1080 and 1080x2340 (portrait). Inspect every shot by eye:
// no clipped or overlapping elements, no cut-off text, HUD fits.
//
// Run: node tests/screenshots.js
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-flux-size-sweep');
const SIZES = [
  { name: '1280x720', width: 1280, height: 720 },
  { name: '2560x1080', width: 2560, height: 1080 },
  { name: '1080x2340', width: 1080, height: 2340 },
];

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};
function findHeadlessShell() {
  const base = path.join(os.homedir(), '.cache', 'ms-playwright');
  try {
    for (const entry of fs.readdirSync(base)) {
      const candidate = path.join(base, entry, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* cache dir missing */ }
  return null;
}
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.join(GAME_DIR, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium } = require(playwrightPath);
const executablePath = findHeadlessShell();
const errors = [];
let browser;
try {
  browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  for (const size of SIZES) {
    const context = await browser.newContext({
      viewport: { width: size.width, height: size.height },
      timezoneId: 'Asia/Bangkok',
    });
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${size.name} console: ${msg.text()}`); });
    page.on('pageerror', (err) => errors.push(`${size.name} pageerror: ${String(err)}`));
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window.__flux, null, { timeout: 30000 });
    await page.waitForTimeout(1500); // menu pop-in + demo running
    await page.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, `menu-${size.name}.png`) });
    await page.click('#btn-play');
    await page.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
    await page.waitForTimeout(800);
    await page.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, `gameplay-${size.name}.png`) });
    // Level select at this size too (the grid is the layout risk).
    await page.keyboard.press('p');
    await page.waitForFunction(() => window.__flux.state.phase === 'pause', null, { timeout: 5000 });
    await page.click('#btn-quit');
    await page.waitForFunction(() => window.__flux.state.phase === 'menu', null, { timeout: 5000 });
    await page.click('#btn-levels');
    await page.waitForFunction(() => !document.getElementById('levels').classList.contains('hidden'), null, { timeout: 5000 });
    // 2500ms, not 600ms: the cards pop in with a stagger, and under
    // SwiftShader the compositor presents frames ~0.5s stale, so a
    // 600ms wait captured the panel mid-pop-in (empty) at all 3 sizes
    // on 2026-11-22 — the cards were fine in the DOM, the shot was early.
    await page.waitForTimeout(2500);
    await page.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, `levels-${size.name}.png`) });
    console.log(`size-sweep: ${size.name} captured (menu, gameplay, levels)`);
    await context.close();
  }
  if (errors.length > 0) {
    console.error('size-sweep: console/page errors:');
    for (const e of errors) console.error('  ' + e);
    throw new Error(`${errors.length} console/page error(s)`);
  }
  console.log(`size-sweep: PASS — shots in ${SHOTS_DIR} — INSPECT BY EYE at all 3 sizes (no clipped/overlapping elements)`);
} catch (err) {
  console.error('size-sweep: FAIL —', err.message);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}
