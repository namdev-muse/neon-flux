// Neon Flux v0.4.1 — headless browser render check.
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
//   - M4: Time Attack is locked on a fresh save (0/3) and unlocked with
//     3 clears; the countdown HUD ticks, orbs add +2s (clock rises past
//     the budget), the run advances 1 -> 2, medals show on the cards,
//     and the timeout path ends the run with a Time Up screen
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
  if (version !== '0.4.1') throw new Error(`expected version 0.4.1, got ${version}`);
  console.log('render-check: game module initialised, version 0.4.1');

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

  // M4: Time Attack is a locked gate on a fresh save, not a dead button —
  // disabled, with the unlock condition and progress in its label.
  const attackLocked = await page.evaluate(() => {
    const b = document.getElementById('btn-attack');
    return { disabled: b.disabled, label: b.textContent };
  });
  if (!attackLocked.disabled) throw new Error('Time Attack must be locked on a fresh save');
  if (!attackLocked.label.includes('0/3') || !attackLocked.label.includes('clear 3 levels')) {
    throw new Error(`Time Attack lock label must name the gate and progress, got: ${attackLocked.label}`);
  }
  console.log(`render-check: Time Attack locked on a fresh save ("${attackLocked.label.trim()}")`);

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
  // v0.3.4: the zoom must reach the SCREEN, not just the feel state —
  // read the settled camScale first, then require the flip to push it
  // up by >5%. (v0.3.3 measured camScale 1.27 vs 1.19 base in a probe,
  // but the render check only ever asserted zoomT, a state number.)
  // v0.4.0: sample the bundle IN-PAGE. The flip's trauma is small
  // (0.12) and decays in ~75ms of game time, and under SwiftShader a
  // single frame can take longer than that — the first v0.4.0 run
  // failed here with shockwave 1, zoomT 0.84, trauma 0: the bundle
  // HAD fired, but a feel() read after a waitForFunction + evaluate
  // round-trip landed after the trauma was already gone. The sampler
  // polls every 16ms in-page and keeps the maxima, so it measures
  // what the flip actually did.
  // v0.4.1: the window is 5s, not 1.2s, and it resolves 300ms after
  // the flip is seen. The v0.4.1 first run failed with "Space did not
  // flip gravity" — but a focused probe proves the game is fine
  // (Space keydown delivered, flip fires in ~32ms, trauma 0.12):
  // under SwiftShader the main thread can be blocked for the whole
  // 1.2s window, so NO sampler tick fires and the window expires with
  // all zeros. A 5s window needs a 5s block to false-negative.
  const settleFeel = await page.evaluate(() => window.__flux.feel());
  const bundlePromise = page.evaluate(() => new Promise((resolve) => {
    const start = performance.now();
    let maxTrauma = 0, maxCamScale = 0, maxRings = 0, seenFlip = false, flipAt = 0;
    const iv = setInterval(() => {
      const f = window.__flux.feel();
      const i = window.__flux.info();
      if (i.playerWorld.grav === -1 && !seenFlip) { seenFlip = true; flipAt = performance.now(); }
      maxTrauma = Math.max(maxTrauma, f.trauma);
      maxCamScale = Math.max(maxCamScale, f.camScale);
      maxRings = Math.max(maxRings, f.shockwaves);
      const elapsed = performance.now() - start;
      if ((seenFlip && performance.now() - flipAt > 300) || elapsed > 5000) {
        clearInterval(iv);
        resolve({ maxTrauma, maxCamScale, maxRings, seenFlip });
      }
    }, 16);
  }));
  await page.keyboard.press('Space');
  const bundle = await bundlePromise;
  if (!bundle.seenFlip) throw new Error('Space did not flip gravity');
  // M3: the flip fires its full bundle in the same frame — shockwave
  // ring + camera zoom pulse + trauma, not just the gravity change.
  if (bundle.maxRings < 1) throw new Error(`flip fired no shockwave ring (bundle: ${JSON.stringify(bundle)})`);
  if (!(bundle.maxCamScale > settleFeel.camScale * 1.05)) throw new Error(`zoom pulse never reached the screen (camScale ${settleFeel.camScale.toFixed(3)} -> ${bundle.maxCamScale.toFixed(3)}, need >5%)`);
  if (!(bundle.maxTrauma > 0)) throw new Error(`flip fired no trauma (bundle: ${JSON.stringify(bundle)})`);
  console.log(`render-check: flip fires its bundle — shockwave ${bundle.maxRings}, zoom pulse (camScale ${settleFeel.camScale.toFixed(3)} -> ${bundle.maxCamScale.toFixed(3)}), trauma ${bundle.maxTrauma.toFixed(2)}`);

  // v0.3.3: pause freezes the juice. Flip, pause as soon as the flip
  // lands, then check the bundle is BIT-IDENTICAL after 1.5s of wall
  // time paused (and non-zero at pause — a dead flip would pass
  // vacuously). Before the fix, updateShockwaves/updateFeel ran on
  // wall time while paused, so a ring fired just before pausing
  // decayed away behind the pause menu and Space-then-Pause could
  // never freeze a flip for a still frame.
  await page.keyboard.press('r');
  await page.waitForFunction(() => {
    const i = window.__flux.info();
    return window.__flux.state.phase === 'playing' && i.playerWorld.grounded && i.playerWorld.grav === 1;
  }, null, { timeout: 10000 });
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__flux.info().playerWorld.grav === -1, null, { timeout: 5000 });
  await page.evaluate(() => window.__flux.pause());
  await page.waitForFunction(() => window.__flux.state.phase === 'pause', null, { timeout: 5000 });
  const pausedFeel0 = await page.evaluate(() => window.__flux.feel());
  await page.waitForTimeout(1500);
  const pausedFeel1 = await page.evaluate(() => window.__flux.feel());
  if (pausedFeel0.shockwaves < 1 || !(pausedFeel0.zoomT > 0)) throw new Error(`flip bundle already gone at pause time (feel: ${JSON.stringify(pausedFeel0)}) — the check raced the 0.7s ring life`);
  if (pausedFeel1.shockwaves !== pausedFeel0.shockwaves || pausedFeel1.zoomT !== pausedFeel0.zoomT) throw new Error(`pause let the flip bundle decay (shockwaves ${pausedFeel0.shockwaves} -> ${pausedFeel1.shockwaves}, zoomT ${pausedFeel0.zoomT.toFixed(2)} -> ${pausedFeel1.zoomT.toFixed(2)})`);
  console.log(`render-check: pause freezes the flip bundle (shockwave ${pausedFeel1.shockwaves}, zoom ${pausedFeel1.zoomT.toFixed(2)} after 1.5s paused)`);
  await page.evaluate(() => window.__flux.resume());
  await page.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
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
  // v0.3.3: no trail while dead. Poll during the ~0.9s death beat: the
  // trail must read 0 at the death point. Before the fix the per-tick
  // push refilled it within 0.28s, stacking into a solid body-sized
  // rectangle through the whole beat (the v0.3.2 live-playtest finding).
  const deadTrail = await page.evaluate(() => new Promise((resolve) => {
    const iv = setInterval(() => {
      const f = window.__flux.feel();
      const i = window.__flux.info();
      if (f.trail === 0 && i.deaths >= 1 && i.playerWorld.x > 400) { clearInterval(iv); resolve('empty'); }
      else if (i.playerWorld.x < 200) { clearInterval(iv); resolve('respawned-first'); }
    }, 50);
    setTimeout(() => { clearInterval(iv); resolve('timeout'); }, 1500);
  }));
  if (deadTrail === 'timeout') throw new Error('trail never read 0 during the death beat — the death-point rectangle is back');
  if (deadTrail === 'respawned-first') console.log('render-check: WARNING — death-beat trail check inconclusive (respawn beat the first sample)');
  else console.log('render-check: trail empty during the death beat (fix holds)');
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

  // --- M4: Time Attack, on a seeded save (3 clears = unlocked) ------
  // A fresh profile cannot unlock the mode without clearing 3 levels,
  // so this runs in a second context whose localStorage is seeded
  // before the module loads: best times on levels 1-3 (all gold by
  // par), level 4 unlocked.
  // The first context is closed first: two SwiftShader pages compete
  // for 1.5 CPUs, and the second page's click starved on RAF — the
  // v0.4.0 first re-run failed here with #btn-levels "waiting for
  // element to be visible, enabled and stable" for 30s, while the
  // same button is stable and clickable in a lone-page probe.
  await context.close();
  const seedSave = {
    version: 1,
    best: {
      1: { time: 7.5, score: 1337, orbs: 9 },
      2: { time: 7.2, score: 1001, orbs: 5 },
      3: { time: 7.9, score: 1251, orbs: 7 },
    },
    unlocked: 4, attack: null,
    settings: { muted: false, shake: 1, flash: true },
  };
  const ctx2 = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: 'Asia/Bangkok',
    hasTouch: true,
  });
  const page2 = await ctx2.newPage();
  page2.on('console', noteConsole);
  page2.on('pageerror', (err) => errors.push(stamp() + ' pageerror: ' + String(err)));
  await page2.addInitScript((seed) => {
    localStorage.setItem('neon-flux-save-v1', JSON.stringify(seed));
  }, seedSave);
  await page2.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page2.waitForFunction(() => window.__flux, null, { timeout: 30000 });
  if (!await page2.evaluate(() => window.__flux.isTimeAttackUnlocked())) {
    throw new Error('Time Attack should be unlocked with 3 clears in the seeded save');
  }
  const attackBtn = await page2.evaluate(() => {
    const b = document.getElementById('btn-attack');
    return { disabled: b.disabled, label: b.textContent };
  });
  if (attackBtn.disabled) throw new Error('Time Attack button disabled on an unlocked save');
  const menuBest = await page2.textContent('#menu-best');
  if (!menuBest.includes('3 gold')) throw new Error(`menu medal line wrong: ${menuBest}`);
  console.log(`render-check: Time Attack unlocked on the seeded save ("${attackBtn.label.trim()}"), menu shows "${menuBest.trim()}"`);

  // Medals + orb records on the level cards. Settle first: this click
  // lands right after page load, mid pop-in (0.45s + stagger), and a
  // click's stability check needs a couple of frames to see it done.
  await page2.waitForTimeout(1500);
  await page2.click('#btn-levels');
  await page2.waitForFunction(() => !document.getElementById('levels').classList.contains('hidden'), null, { timeout: 5000 });
  const card1 = await page2.locator('#level-grid .level-card').first().textContent();
  if (!card1.includes('Gold') || !card1.includes('◆ 9/12') || !card1.includes('7.50s')) {
    throw new Error(`level 1 card must show its gold medal + orb record, got: ${card1}`);
  }
  console.log('render-check: level card shows medal + orb record ("Best 7.50s · ◆ 9/12 Gold")');
  await page2.click('#btn-levels-back');
  await page2.waitForFunction(() => !document.getElementById('menu').classList.contains('hidden'), null, { timeout: 5000 });

  // Start Time Attack: HUD shows the countdown (mm:ss) and TA 1/12.
  await page2.click('#btn-attack');
  await page2.waitForFunction(() => window.__flux.state.phase === 'playing', null, { timeout: 5000 });
  const attack0 = await page2.evaluate(() => window.__flux.attack());
  if (!attack0 || attack0.level !== 1) throw new Error(`Time Attack did not start at level 1: ${JSON.stringify(attack0)}`);
  if (Math.abs(attack0.timeLeft - 461) > 2) throw new Error(`Time Attack clock should start at the 461s budget, got ${attack0.timeLeft}`);
  const hudTime = await page2.textContent('#hud-time');
  if (!/⏱ \d+:\d\d/.test(hudTime)) throw new Error(`HUD must show the countdown clock in Time Attack, got: ${hudTime}`);
  const hudLevelTA = await page2.textContent('#hud-level');
  if (!hudLevelTA.includes('TA 1/12')) throw new Error(`HUD must read TA 1/12 in Time Attack, got: ${hudLevelTA}`);
  console.log(`render-check: Time Attack starts — clock ${hudTime.trim()}, ${hudLevelTA.trim()}`);

  // Autopilot clears level 1: orbs add +2s each, so the clock ends UP
  // past the 461s budget — the orb economy, visible in one number.
  await page2.evaluate(() => window.__flux.autopilot(true));
  await page2.waitForFunction(() => window.__flux.info().won === true, null, { timeout: 180000 });
  await page2.evaluate(() => window.__flux.autopilot(false));
  const attackAfterL1 = await page2.evaluate(() => window.__flux.attack());
  if (!attackAfterL1 || attackAfterL1.orbs < 5) throw new Error(`Time Attack should have banked orbs on level 1, got ${JSON.stringify(attackAfterL1)}`);
  if (!(attackAfterL1.timeLeft > 461)) throw new Error(`orb +2s must lift the clock past the 461s budget (orbs ${attackAfterL1.orbs}, timeLeft ${attackAfterL1.timeLeft.toFixed(1)})`);
  console.log(`render-check: orbs fuel the clock — ${attackAfterL1.orbs} orbs, ${attackAfterL1.timeLeft.toFixed(1)}s left (past the 461s budget)`);
  await page2.waitForFunction(() => window.__flux.state.phase === 'complete', null, { timeout: 5000 });
  const completeTA = await page2.textContent('#complete');
  if (!completeTA.includes('Gold medal') || !completeTA.includes('Level 1/12')) {
    throw new Error(`complete screen in Time Attack must name the medal + level, got: ${completeTA.slice(0, 240)}`);
  }
  const savedTA = await page2.evaluate(() => window.__flux.save);
  if (!savedTA.best[1] || savedTA.best[1].time <= 0) throw new Error('best time should be saved for level 1 after the Time Attack clear');
  if (savedTA.attack !== null) throw new Error('an unfinished Time Attack must not record a best');
  console.log('render-check: complete screen shows Gold medal + Level 1/12, best time saved, no attack best yet');

  // Next Level continues the attack at level 2 on the same clock.
  await page2.click('#btn-next');
  await page2.waitForFunction(() => window.__flux.state.phase === 'playing' && window.__flux.state.levelId === 2, null, { timeout: 5000 });
  const attackL2 = await page2.evaluate(() => window.__flux.attack());
  if (!attackL2 || attackL2.level !== 2) throw new Error(`Time Attack did not advance to level 2: ${JSON.stringify(attackL2)}`);
  const hudLevelL2 = await page2.textContent('#hud-level');
  if (!hudLevelL2.includes('TA 2/12')) throw new Error(`HUD must read TA 2/12, got: ${hudLevelL2}`);
  console.log(`render-check: Next Level continues the attack at level 2 (${hudLevelL2.trim()}, ${attackL2.timeLeft.toFixed(1)}s left)`);

  // Timeout path (test hook forces the clock to 2s): the run ends with
  // the Time Up screen, and a timeout never records a best.
  await page2.evaluate(() => window.__flux.attackSetTimeLeft(2));
  await page2.waitForFunction(() => window.__flux.state.phase === 'attack', null, { timeout: 10000 });
  const attackTitle = await page2.textContent('#attack-title');
  const attackSub = await page2.textContent('#attack-sub');
  if (!attackTitle.includes('Time Up')) throw new Error(`timeout must show Time Up, got: ${attackTitle}`);
  if (!attackSub.includes('level 2')) throw new Error(`timeout must name where the run ended, got: ${attackSub}`);
  const savedAfterTimeout = await page2.evaluate(() => window.__flux.save);
  if (savedAfterTimeout.attack !== null) throw new Error('a timed-out Time Attack must not record a best');
  console.log(`render-check: timeout ends the run ("${attackTitle.trim()}" — ${attackSub.trim()}); no best recorded`);
  await page2.screenshot({ timeout: 300000, path: path.join(SHOTS_DIR, 'attack-timeup-1280x720.png') });

  // Retry restarts the attack from level 1 on a full clock.
  await page2.click('#btn-attack-retry');
  await page2.waitForFunction(() => window.__flux.state.phase === 'playing' && window.__flux.state.levelId === 1, null, { timeout: 5000 });
  const attackRetry = await page2.evaluate(() => window.__flux.attack());
  if (!attackRetry || attackRetry.level !== 1 || Math.abs(attackRetry.timeLeft - 461) > 2) {
    throw new Error(`retry must restart the attack on a full clock, got ${JSON.stringify(attackRetry)}`);
  }
  console.log('render-check: Retry restarts the attack at level 1 on a full 461s clock');
  await page2.evaluate(() => window.__flux.quitToMenu());
  await page2.waitForFunction(() => window.__flux.state.phase === 'menu', null, { timeout: 5000 });
  await ctx2.close();

  // --- verdict ---
  if (errors.length > 0) {
    console.error('render-check: CONSOLE/PAGE ERRORS:');
    for (const e of errors) console.error('  ' + e);
    throw new Error(`render-check failed with ${errors.length} console/page error(s)`);
  }
  if (navAwayArtifacts > 0) console.log(`render-check: ignored ${navAwayArtifacts} Firefox "Navigated away" driver artifacts`);
  console.log('render-check: PASS — menu + live demo, flash toggle, flip bundle + rest state, camera lookahead, screen-space movement + flip, death/respawn, autopilot clear + save, pause/resume/restart, Time Attack (lock gate, countdown HUD, orb +2s, level advance, timeout + retry), zero console errors');
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
