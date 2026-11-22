// Neon Flux v0.3.1 — headless browser render check.
// Serves the game dir over local HTTP, loads it in a headless browser, and
// asserts the M1 core, by hook and by eye:
//   - the menu renders over a LIVE demo (the attract-mode bot actually
//     plays level 1 behind the menu — the demo player moves), with no
//     version/engine text anywhere the player can see, one clear primary
//     Play action, and 12 level cards
//   - Play starts level 1 with the HUD; movement is asserted in SCREEN
//     space (right moves right on screen, left moves left — the Drift M2
//     lesson), and the flip is asserted in screen space too (Space flips
//     gravity and the player rises on screen)
//   - holding right with no flips dies on the floor spikes and respawns
//     at the start (death + checkpoint respawn)
//   - the autopilot (decision bot) collects orbs and clears level 1,
//     the complete screen shows, and the best time is saved
//   - pause focuses Resume; Enter resumes; R restarts
//   - zero console errors and zero page errors
//
// Run: node tests/render-check.js (Chromium headless shell) or
//      PW_BROWSER=firefox node tests/render-check.js
//      (Firefox — headless Firefox on this VM has no audio device and
//      no WebGL, but Flux is Canvas 2D so it runs headless fine.)
// NOTE: screenshot timeouts are 300s, not 120s — under SwiftShader on
// this 1.5-CPU VM a single 1280x720 screenshot readback takes 60–180s
// (measured 2026-11-22 by the shot probe: menu/gameplay shots all
// succeeded, just slowly). The timeout is environmental; the
// assertions themselves are unchanged. On real GPU hardware the
// same shots take ~1s.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const GAME_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_DIR = path.join(os.tmpdir(), 'neon-flux-render-check');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
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
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const require = createRequire(import.meta.url);
const playwrightPath = fileURLToPath(new URL('../../neon-hexfall/node_modules/playwright-core', import.meta.url));
const { chromium, firefox } = require(playwrightPath);
const PW_BROWSER = (process.env.PW_BROWSER || 'chromium').toLowerCase();
const pw = PW_BROWSER === 'firefox' ? firefox : chromium;
const executablePath = PW_BROWSER === 'firefox' ? null : findHeadlessShell();
console.log(`render-check: ${PW_BROWSER} executable:`, executablePath || '(playwright default)');
const launchArgs = PW_BROWSER === 'firefox' ? []
  : ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'];

const errors = [];
const T0 = Date.now();
const stamp = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
let navAwayArtifacts = 0;
function noteConsole(msg) {
  if (msg.type() !== 'error') return;
  if (PW_BROWSER === 'firefox' && msg.text().includes('Navigated away from page')) {
    navAwayArtifacts++;
    return;
  }
  errors.push(stamp() + ' console: ' + msg.text());
}
let browser;
try {
  browser = await pw.launch({
    ...(executablePath ? { executablePath } : {}),
    args: launchArgs,
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on('console', noteConsole);
  page.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));

  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  try {
    await page.waitForFunction(() => window.__flux, null, { timeout: 30000 });
  } catch {
    throw new Error('game module did not initialise (window.__flux never appeared)');
  }
  const version = await page.evaluate(() => window.__flux.version);
  if (version !== '0.3.1') throw new Error(`expected version 0.3.1, got ${version}`);
  console.log('render-check: game module initialised, version 0.3.1');

  // Canvas exists and is on screen.
  const canvas = await page.evaluate(() => {
    const c = document.querySelector('#game');
    return c ? { w: c.width, h: c.height } : null;
  });
  if (!canvas) throw new Error('no #game canvas');
  console.log(`render-check: canvas live (${canvas.w}x${canvas.h})`);

  // Menu: title, one primary Play, no version/engine text anywhere the
  // player can see.
  const menuText = await page.textContent('#menu');
  if (!menuText.includes('NEON') || !menuText.includes('FLUX')) throw new Error('menu title missing');
  if (/\bv?\d+\.\d+\.\d+\b/.test(menuText) || menuText.includes('Three.js')) {
    throw new Error('menu shows version/engine text — it must live in the README only');
  }
  const playClass = await page.getAttribute('#btn-play', 'class');
  if (!playClass || !playClass.includes('primary')) throw new Error('Play is not the primary action');
  console.log('render-check: menu renders — no version text, Play primary');

  // Level select: 12 level cards, only level 1 unlocked on a fresh save.
  await page.click('#btn-levels');
  await page.waitForFunction(() => !document.getElementById('levels').classList.contains('hidden'), null, { timeout: 5000 });
  const cardCount = await page.locator('#level-grid .level-card').count();
  if (cardCount !== 12) throw new Error(`expected 12 level cards, got ${cardCount}`);
  const lockedCards = await page.locator('#level-grid .level-card.locked').count();
  if (lockedCards !== 11) throw new Error(`expected 11 locked cards on a fresh save, got ${lockedCards}`);
  const levels = await page.evaluate(() => window.__flux.levels());
  if (levels.length !== 12 || levels[0].name !== 'First Steps' || levels[11].name !== 'Event Horizon') {
    throw new Error(`level list wrong: ${JSON.stringify(levels.map((l) => l.name))}`);
  }
  console.log('render-check: level select — 12 cards, only level 1 unlocked on a fresh save');
  await page.click('#btn-levels-back');
  await page.waitForFunction(() => !document.getElementById('menu').classList.contains('hidden'), null, { timeout: 5000 });

  // M3: the flashing toggle works — off means no flash ever fires.
  await page.click('#btn-settings');
  await page.waitForFunction(() => !document.getElementById('settings').classList.contains('hidden'), null, { timeout: 5000 });
  const flashBefore = await page.evaluate(() => window.__flux.feel().flashOn);
  if (flashBefore !== true) throw new Error(`flashing should default on, got ${flashBefore}`);
  await page.click('#btn-flash-settings');
  const flashOff = await page.evaluate(() => window.__flux.feel().flashOn);
  if (flashOff !== false) throw new Error('flashing toggle did not turn flashing off');
  const flashLabel = await page.textContent('#btn-flash-settings');
  if (!flashLabel.includes('Off')) throw new Error(`flash toggle label wrong: ${flashLabel}`);
  await page.click('#btn-flash-settings');
  const flashOn = await page.evaluate(() => window.__flux.feel().flashOn);
  if (flashOn !== true) throw new Error('flashing toggle did not turn flashing back on');
  console.log('render-check: flashing toggle works (On -> Off -> On, label follows)');
  await page.click('#btn-settings-back');
  await page.waitForFunction(() => !document.getElementById('menu').classList.contains('hidden'), null, { timeout: 5000 });

  // The attract demo plays behind the menu: the demo player moves.
  const demo0 = await page.evaluate(() => window.__flux.info());
  if (!demo0) throw new Error('no demo info in the menu phase');
  await page.waitForFunction((p0) => {
    const i = window.__flux.info();
    return Math.abs(i.player.x - p0.x) > 20 || Math.abs(i.player.y - p0.y) > 20;
  }, { x: demo0.player.x, y: demo0.player.y }, { timeout: 30000 });
  const demo1 = await page.evaluate(() => window.__flux.info());
  console.log(`render-check: attract demo alive — demo player moved (${demo0.player.x.toFixed(0)}, ${demo0.player.y.toFixed(0)}) -> (${demo1.player.x.toFixed(0)}, ${demo1.player.y.toFixed(0)})`);

  // Menu screenshot for the by-eye check.
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForTimeout(1200);
  await page.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, 'menu-1280x720.png') });
  console.log(`render-check: menu screenshot saved to ${SHOTS_DIR}/menu-1280x720.png — INSPECT BY EYE (live demo behind the menu, no clipped elements)`);

  // PLAY starts level 1 with the HUD.
  await page.click('#btn-play');
  await page.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
  if (!await page.isVisible('#hud')) throw new Error('HUD not visible after PLAY');
  const hudLevel = await page.textContent('#hud-level');
  if (!hudLevel.includes('First Steps')) throw new Error(`expected level 1 First Steps, got: ${hudLevel}`);
  console.log('render-check: PLAY starts level 1 (First Steps), HUD visible');

  // The canvas must actually update during a run (a frozen render loop
  // leaves the sim state looking alive while the pixels never change).
  const shotA = await page.screenshot({ timeout: 300000 });
  await page.waitForTimeout(1000);
  const shotB = await page.screenshot({ timeout: 300000 });
  if (shotA.equals(shotB)) throw new Error('canvas did not change between two screenshots during a run — the render loop may be frozen');
  console.log('render-check: canvas updates during a run (two screenshots differ)');

  // Movement in SCREEN space: ArrowRight moves the player right on
  // screen, ArrowLeft moves it left. Under swiftshader the game runs
  // slower than real time, so these are polls, not fixed windows.
  async function moveScreen(key, dir) {
    const x0 = (await page.evaluate(() => window.__flux.info().player)).x;
    await page.keyboard.down(key);
    let ok = false;
    try {
      await page.waitForFunction(([x, d]) => {
        const i = window.__flux.info();
        return d > 0 ? i.player.x > x + 20 : i.player.x < x - 20;
      }, [x0, dir], { timeout: 20000 });
      ok = true;
    } catch { /* fall through to the explicit check */ }
    await page.keyboard.up(key);
    const x1 = (await page.evaluate(() => window.__flux.info().player)).x;
    if (!ok || (dir > 0 && x1 <= x0 + 20) || (dir < 0 && x1 >= x0 - 20)) {
      throw new Error(`${key} did not move the player on screen (${x0.toFixed(0)} -> ${x1.toFixed(0)})`);
    }
    return { x0, x1 };
  }
  const right = await moveScreen('ArrowRight', 1);
  console.log(`render-check: ArrowRight moves the player right on screen (${right.x0.toFixed(0)} -> ${right.x1.toFixed(0)})`);
  const left = await moveScreen('ArrowLeft', -1);
  console.log(`render-check: ArrowLeft moves the player left on screen (${left.x0.toFixed(0)} -> ${left.x1.toFixed(0)})`);

  // Flip in SCREEN space: Space flips gravity and the player rises on
  // screen (screen y decreases). Restart fresh first so the player is
  // standing on solid ground at the start.
  await page.keyboard.press('r');
  await page.waitForFunction(() => {
    const i = window.__flux.info();
    return window.__flux.state.phase === 'playing' && i.playerWorld.grounded && i.playerWorld.grav === 1;
  }, null, { timeout: 10000 });
  const flip0 = await page.evaluate(() => window.__flux.info());
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__flux.info().playerWorld.grav === -1, null, { timeout: 5000 });
  // M3: the flip fires its full bundle in the same frame — shockwave
  // ring + camera zoom pulse + trauma, not just the gravity change.
  const flipFeel = await page.evaluate(() => window.__flux.feel());
  if (flipFeel.shockwaves < 1) throw new Error(`flip fired no shockwave ring (feel: ${JSON.stringify(flipFeel)})`);
  if (!(flipFeel.zoomT > 0)) throw new Error(`flip fired no camera zoom pulse (feel: ${JSON.stringify(flipFeel)})`);
  if (!(flipFeel.trauma > 0)) throw new Error(`flip fired no trauma (feel: ${JSON.stringify(flipFeel)})`);
  console.log(`render-check: flip fires its bundle — shockwave ${flipFeel.shockwaves}, zoom pulse ${flipFeel.zoomT.toFixed(2)}, trauma ${flipFeel.trauma.toFixed(2)}`);
  const flip1 = await page.evaluate(() => window.__flux.info());
  await page.waitForFunction((y0) => window.__flux.info().player.y < y0 - 10, flip0.player.y, { timeout: 10000 });
  const flip2 = await page.evaluate(() => window.__flux.info());
  console.log(`render-check: Space flips gravity (grav ${flip0.playerWorld.grav} -> ${flip1.playerWorld.grav}) and the player rises on screen (y ${flip0.player.y.toFixed(0)} -> ${flip2.player.y.toFixed(0)})`);

  // M3: rest state — poll until every effect has decayed to its exact
  // rest value (no trauma, no slow-mo, no flash, no zoom, no rings, no
  // squash/stretch). Polled, not a fixed wait: under SwiftShader the
  // frame rate is low and a fixed 3s wall wait is not 3s of decay.
  // The player stands on the ceiling near the start, clear of the
  // ceiling spikes, so no new event fires while waiting.
  await page.waitForFunction(() => {
    const f = window.__flux.feel();
    return f.trauma === 0 && f.timeScale === 1 && f.flashT === 0 && f.zoomT === 0
      && f.shockwaves === 0 && f.stretchT <= 0 && f.squashT <= 0 && f.slowMoT === 0 && f.hitStopT === 0;
  }, null, { timeout: 30000 });
  console.log('render-check: feel rest state clean after idle (trauma 0, timeScale 1, no flash/zoom/rings)');

  // M3: camera lookahead — while running right the player stays on
  // screen (camera keeps up, neither lagging behind nor racing ahead).
  // Wait until the player has actually advanced 200px in the world
  // first: under SwiftShader frames are slow and a fixed wall-clock
  // sample window can pass vacuously while the sim barely moves.
  await page.keyboard.press('r');
  await page.waitForFunction(() => {
    const i = window.__flux.info();
    return window.__flux.state.phase === 'playing' && i.playerWorld.grounded && i.playerWorld.grav === 1;
  }, null, { timeout: 10000 });
  const camStart = await page.evaluate(() => window.__flux.info().playerWorld.x);
  const deaths0 = (await page.evaluate(() => window.__flux.info())).deaths;
  await page.keyboard.down('ArrowRight');
  try {
    await page.waitForFunction(([x0, d0]) => {
      const i = window.__flux.info();
      return i.playerWorld.x > x0 + 200 && i.deaths === d0;
    }, [camStart, deaths0], { timeout: 30000 });
  } finally {
    await page.keyboard.up('ArrowRight');
  }
  const camSamples = [];
  for (let i = 0; i < 3; i++) {
    const s = await page.evaluate(() => ({ x: window.__flux.info().player.x, d: window.__flux.info().deaths }));
    if (s.d === deaths0) camSamples.push(s.x);
    await page.waitForTimeout(400);
  }
  if (camSamples.length < 2) throw new Error(`too few clean camera samples (${camSamples.length}) — deaths during the run?`);
  const outOfFrame = camSamples.filter((x) => x < 128 || x > 1152);
  if (outOfFrame.length > 0) throw new Error(`camera lost the player while running right: samples ${camSamples.map((x) => x.toFixed(0)).join(',')}`);
  console.log(`render-check: camera keeps the runner on screen (${camSamples.length} samples after +200px, x ${Math.min(...camSamples).toFixed(0)}–${Math.max(...camSamples).toFixed(0)})`);

  // Gameplay screenshot for the by-eye check.
  await page.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, 'gameplay-1280x720.png') });
  console.log(`render-check: gameplay screenshot saved to ${SHOTS_DIR}/gameplay-1280x720.png — INSPECT BY EYE (neon palette, spikes, HUD)`);

  // Holding right with no flips dies on the floor spikes and respawns
  // at the start (death + checkpoint respawn, the anti-slop gate in
  // the live game).
  await page.keyboard.press('r');
  await page.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
  await page.keyboard.down('ArrowRight');
  let died = false;
  try {
    await page.waitForFunction(() => window.__flux.info().deaths >= 1, null, { timeout: 30000 });
    died = true;
  } finally {
    await page.keyboard.up('ArrowRight');
  }
  if (!died) throw new Error('holding right with no flips did not die — the level may be too easy');
  // The run auto-respawns after the death pause; the player is alive
  // again near the start.
  // The run auto-respawns after the death pause; the player is alive
  // again near the start (x ~ 80, well under 200).
  await page.waitForFunction(() => {
    const i = window.__flux.info();
    return i && i.playerWorld.x < 200;
  }, null, { timeout: 10000 });
  const afterDeath = await page.evaluate(() => window.__flux.info());
  console.log(`render-check: holding right dies on the spikes (deaths ${afterDeath.deaths}) and respawns (x ${afterDeath.playerWorld.x.toFixed(0)})`);

  // The autopilot (decision bot) collects orbs and clears level 1.
  await page.keyboard.press('r');
  await page.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
  await page.evaluate(() => window.__flux.autopilot(true));
  await page.waitForFunction(() => window.__flux.info().orbs >= 1, null, { timeout: 60000 });
  const orbs = await page.evaluate(() => window.__flux.info());
  console.log(`render-check: autopilot collects orbs (${orbs.orbs}/${orbs.orbsTotal})`);
  await page.waitForFunction(() => window.__flux.info().won === true, null, { timeout: 180000 });
  await page.evaluate(() => window.__flux.autopilot(false));
  const won = await page.evaluate(() => window.__flux.info());
  console.log(`render-check: autopilot clears level 1 (time ${won.time.toFixed(2)}s, orbs ${won.orbs}/${won.orbsTotal}, deaths ${won.deaths})`);
  await page.waitForFunction(() => window.__flux.state.phase === 'complete', null, { timeout: 5000 });
  const completeText = await page.textContent('#complete');
  if (!completeText.includes('Clear')) throw new Error(`complete screen wrong: ${completeText.slice(0, 200)}`);
  const saved = await page.evaluate(() => window.__flux.save);
  if (!saved.best || !saved.best[1] || saved.best[1].time <= 0) {
    throw new Error(`best time should be saved for level 1: ${JSON.stringify(saved.best)}`);
  }
  console.log(`render-check: complete screen shows, best time saved for level 1 (${saved.best[1].time.toFixed(2)}s)`);
  await page.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, 'complete-1280x720.png') });

  // Next Level goes to level 2 (unlocked by the clear).
  await page.click('#btn-next');
  await page.waitForFunction(() => window.__flux.state.phase === 'playing' && window.__flux.state.levelId === 2, null, { timeout: 5000 });
  const hud2 = await page.textContent('#hud-level');
  if (!hud2.includes('Ceiling Run')) throw new Error(`expected level 2 Ceiling Run, got: ${hud2}`);
  console.log('render-check: Next Level starts level 2 (Ceiling Run)');

  // Pause focuses Resume; Enter resumes.
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__flux.state.phase === 'pause', null, { timeout: 5000 });
  const focused = await page.evaluate(() => document.activeElement && document.activeElement.id);
  if (focused !== 'btn-resume') throw new Error(`pause should focus Resume, focused: ${focused}`);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
  console.log('render-check: P pauses with Resume focused, Enter resumes');

  // R restarts the level from the start.
  await page.keyboard.press('r');
  await page.waitForFunction(() => {
    const i = window.__flux.info();
    return window.__flux.state.phase === 'playing' && i.levelId === 2 && i.deaths === 0 && i.time < 1;
  }, null, { timeout: 5000 });
  console.log('render-check: R restarts level 2 (0 deaths, time reset)');

  // Mute toggle works from the HUD.
  const muteBefore = await page.evaluate(() => window.__flux.state.muted);
  await page.click('#btn-mute-hud');
  const muteAfter = await page.evaluate(() => window.__flux.state.muted);
  if (muteAfter === muteBefore) throw new Error('mute toggle did not change state');
  await page.click('#btn-mute-hud');
  console.log(`render-check: mute toggle works (${muteBefore} -> ${muteAfter} -> back)`);

  // Quit to the menu from pause; the menu shows level 2 unlocked now.
  await page.keyboard.press('p');
  await page.waitForFunction(() => window.__flux.state.phase === 'pause', null, { timeout: 5000 });
  await page.click('#btn-quit');
  await page.waitForFunction(() => window.__flux.state.phase === 'menu', null, { timeout: 5000 });
  const levelsAfter = await page.evaluate(() => window.__flux.levels());
  if (!levelsAfter[1].unlocked) throw new Error('level 2 should be unlocked after clearing level 1');
  console.log('render-check: quit to menu; level 2 unlocked');

  // --- verdict ---
  if (errors.length > 0) {
    console.error('render-check: CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.error('  ' + e);
    throw new Error(`render-check failed with ${errors.length} console/page error(s)`);
  }
  if (navAwayArtifacts > 0) console.log(`render-check: ignored ${navAwayArtifacts} Firefox "Navigated away" driver artifacts`);
  console.log('render-check: PASS — menu + live demo, flash toggle, flip bundle + rest state, camera lookahead, screen-space movement + flip, death/respawn, autopilot clear + save, pause/resume/restart, zero console errors');
} catch (err) {
  console.error('render-check: FAIL —', err.message);
  if (errors.length > 0) {
    console.error('console/page errors:');
    for (const e of errors) console.error('  ' + e);
  }
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}
