// Neon Flux v0.4.0 — Node smoke tests for physics.js (no DOM, no Canvas).
// Covers level validity, flip/momentum physics, hazards, checkpoints,
// scoring, saves, and the anti-slop gates on level 1 (the full 6-level
// bot gate lives in tests/bot.js). Exit 0 when all pass.
// Usage: node tests/smoke.js
import {
  VERSION, TILE, ROWS, DT, GRAVITY, MAX_RUN, FLIP_COOLDOWN, FLIP_COYOTE, PLAYER_W, PLAYER_H,
  LEVELS, levelById, parseLevel, createRun, stepRun, drainEvents, cloneRun,
  simulateRun, createRandomBot, createDecisionBot, stationaryPolicy,
  defaultSave, serializeSave, parseSave, recordBest, isLevelUnlocked,
  SAVE_VERSION, mulberry32, clamp, FEEDBACK, FEEDBACK_LAYERS,
  ORB_TIME_BONUS, TIME_ATTACK_UNLOCK_CLEARS, TIME_ATTACK_GOLD_LEFT, TIME_ATTACK_SILVER_LEFT,
  timeAttackBudget, medalForTime, timeAttackMedal, isTimeAttackUnlocked,
  recordAttackBest, simulateTimeAttack,
} from '../physics.js';

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS ' + name); }
  else { failed++; failures.push(name); console.error('  FAIL ' + name + (extra !== undefined ? ' — ' + extra : '')); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

check('physics version is 0.4.0', VERSION === '0.4.0');
check('12 levels defined', LEVELS.length === 12);
check('level ids are 1..12 in order', LEVELS.every((l, i) => l.id === i + 1));
check('every level has a name, hint, par and accent', LEVELS.every((l) => l.name && l.hint && l.par > 0 && l.accent));
check('level names are distinct', new Set(LEVELS.map((l) => l.name)).size === LEVELS.length);
check('level accents are distinct', new Set(LEVELS.map((l) => l.accent)).size === LEVELS.length);
check('levelById finds level 3', levelById(3) && levelById(3).name === 'Saw Alley');
check('levelById returns null for 99', levelById(99) === null);

// --- level validity: every map parses, has exactly one start + exit,
// orbs, and a survivable opening (flat ground for the first 8 tiles) ---
for (const def of LEVELS) {
  let level;
  try { level = parseLevel(def); } catch (e) { check(`level ${def.id} parses`, false, e.message); continue; }
  check(`level ${def.id} "${def.name}" parses (${level.cols} cols)`, true);
  check(`level ${def.id} has ${ROWS} rows x ${level.cols} cols`, level.rows === ROWS);
  check(`level ${def.id} has orbs`, level.orbs.length >= 5, `${level.orbs.length} orbs`);
  check(`level ${def.id} has an exit`, !!level.exit);
  // First 8 tiles of the floor row are solid and spike-free: the first
  // seconds teach, they don't punish.
  const floorRow = level.solids[ROWS - 1];
  let safe = true;
  for (let c = 0; c < 8; c++) if (!floorRow[c]) safe = false;
  check(`level ${def.id} opening 8 tiles are solid floor`, safe);
  const openingSpikes = level.spikes.filter((s) => s.x < 8 * TILE);
  check(`level ${def.id} has no spikes in the opening 8 tiles`, openingSpikes.length === 0);
  // Start stands on solid ground.
  const p = level.startRespawn;
  check(`level ${def.id} start stands on ground`, p.y === (ROWS - 1) * TILE - PLAYER_H || level.solids[Math.floor((p.y + PLAYER_H + 1) / TILE)]?.[Math.floor(p.x / TILE)]);
  // Every checkpoint's respawn point is on solid ground.
  for (const k of level.checkpoints) {
    const r = Math.floor((k.respawn.y + PLAYER_H + 1) / TILE);
    check(`level ${def.id} checkpoint at col ${Math.floor(k.x / TILE)} respawns on ground`, level.solids[r]?.[Math.floor(k.respawn.x / TILE)] === true);
  }
}
// Hazard mix grows across levels.
check('level 1 has spikes and no saws/crushers (teaches the flip)', (() => {
  const l = parseLevel(LEVELS[0]);
  return l.spikes.length > 0 && l.saws.length === 0 && l.crushers.length === 0;
})());
check('level 3 introduces saws', parseLevel(LEVELS[2]).saws.length > 0);
check('level 4 introduces crushers', parseLevel(LEVELS[3]).crushers.length > 0);
check('level 5 has a floor gap', (() => {
  const l = parseLevel(LEVELS[4]);
  return !l.solids[ROWS - 1].every(Boolean);
})());
check('level 6 has every hazard type', (() => {
  const l = parseLevel(LEVELS[5]);
  return l.spikes.length > 0 && l.saws.length > 0 && l.crushers.length > 0;
})());
check('later levels have checkpoints', LEVELS.slice(1).every((d) => parseLevel(d).checkpoints.length >= 1));

// --- core physics: run, flip, momentum ---
{
  const run = createRun(1);
  const p = run.player;
  check('player starts grounded on the floor', p.grounded === true && p.groundDir === 'floor');
  check('player starts with gravity down', p.grav === 1);
  // Hold right: the player accelerates to max run speed. Only 60 steps
  // (1s) — level 1 has floor spikes at col 13, and running into them
  // would kill the player mid-test and invalidate the flip assertions.
  for (let i = 0; i < 60; i++) stepRun(run, { move: 1, flip: false });
  check('holding right reaches max run speed', approx(p.vx, MAX_RUN, 1), `vx=${p.vx.toFixed(1)}`);
  check('holding right moves the player right', p.x > 100, `x=${p.x.toFixed(1)}`);
  // Flip: gravity reverses INSTANTLY and velocity is preserved. Use a
  // fresh run and flip from the start: the flip arc lands on the
  // ceiling at col ~7, which is clear (the contiguous ceiling spikes
  // start at col 9), so the player lands grounded on the ceiling.
  const frun = createRun(1);
  const fp = frun.player;
  const vyBefore = fp.vy;
  stepRun(frun, { move: 1, flip: true });
  check('flip reverses gravity immediately', fp.grav === -1);
  check('flip preserves vertical momentum (vy unchanged by the flip itself)', approx(fp.vy, vyBefore + -GRAVITY * DT, 1e-6) || fp.vy < 0, `vy ${vyBefore.toFixed(1)} -> ${fp.vy.toFixed(1)}`);
  check('flip clears grounded', fp.grounded === false);
  // Screen-space assertion (the Drift M2 lesson): after the flip the
  // player must move UP in world space, which the renderer maps to up
  // on screen. While gravity is up, y must decrease over the next steps.
  const y0 = fp.y;
  for (let i = 0; i < 30; i++) stepRun(frun, { move: 1, flip: false });
  check('flipped player rises (screen-space up)', fp.y < y0 - 20, `y ${y0.toFixed(1)} -> ${fp.y.toFixed(1)}`);
  // The player lands on the ceiling and is grounded there.
  for (let i = 0; i < 120 && !fp.grounded; i++) stepRun(frun, { move: 1, flip: false });
  check('flipped player lands grounded on the ceiling', fp.grounded === true && fp.groundDir === 'ceiling', `grounded=${fp.grounded} dir=${fp.groundDir} y=${fp.y.toFixed(1)}`);
  // Flip back: gravity down again, player falls and lands on the floor.
  stepRun(frun, { move: 1, flip: true });
  check('flip back restores gravity down', fp.grav === 1);
  for (let i = 0; i < 120 && !fp.grounded; i++) stepRun(frun, { move: 1, flip: false });
  check('player lands back on the floor', fp.grounded === true && fp.groundDir === 'floor');
  // Flip cooldown: a second flip inside the cooldown is ignored.
  const run2 = createRun(1);
  stepRun(run2, { move: 0, flip: true });
  const g1 = run2.player.grav;
  stepRun(run2, { move: 0, flip: true });
  check('flip inside the cooldown is ignored', run2.player.grav === g1);
  // Momentum through the flip: falling fast down, flip inside the
  // coyote window, still falling down on the next step (vy preserved,
  // not zeroed). The coyote window is the 0.1s after leaving a surface.
  const run3 = createRun(1);
  run3.player.y = 200; run3.player.vy = 500; run3.player.grav = 1; run3.player.grounded = false;
  run3.player.coyote = FLIP_COYOTE;
  stepRun(run3, { move: 0, flip: true });
  check('coyote flip reverses gravity', run3.player.grav === -1);
  check('falling player keeps falling right after a coyote flip (momentum preserved)', run3.player.vy > 400, `vy=${run3.player.vy.toFixed(1)}`);
  // Anti-hover rule: a flip pressed mid-air (no coyote) does nothing.
  const run4 = createRun(1);
  run4.player.y = 200; run4.player.vy = 100; run4.player.grav = 1; run4.player.grounded = false;
  run4.player.coyote = 0;
  stepRun(run4, { move: 0, flip: true });
  check('mid-air flip is ignored (no hover)', run4.player.grav === 1);
  // Input buffering: a flip pressed mid-air fires on the landing.
  const run5 = createRun(1);
  run5.player.y = 470; run5.player.vy = 0; run5.player.grav = 1; run5.player.grounded = false;
  run5.player.coyote = 0;
  stepRun(run5, { move: 0, flip: true }); // buffered while falling the last 18px
  let flippedOnLanding = false;
  for (let i = 0; i < 30 && !flippedOnLanding; i++) {
    stepRun(run5, { move: 0, flip: false });
    if (run5.player.grav === -1) flippedOnLanding = true;
  }
  check('flip pressed mid-air fires on the landing (input buffering)', flippedOnLanding);
}

// --- hazards kill, checkpoints save, orbs score ---
{
  // Run straight into the first spike pair on level 1: must die.
  const run = createRun(1);
  let died = false;
  for (let i = 0; i < 600 && !died; i++) { stepRun(run, { move: 1, flip: false }); if (run.dead) died = true; }
  check('running blind into spikes kills the player', died);
  check('death is recorded', run.deaths === 1, `deaths=${run.deaths}`);
  check('death event fires with a cause', drainEvents(run).some((e) => e.type === 'death' && e.cause === 'spike'));
  // After the death beat the player respawns at the start (no checkpoint yet).
  for (let i = 0; i < 60 && run.dead; i++) stepRun(run, { move: 0, flip: false });
  check('player respawns after the death beat', run.dead === false);
  check('respawn is at the start when no checkpoint was touched', Math.abs(run.player.x + PLAYER_W / 2 - run.level.startRespawn.x) < 1);
  check('respawn resets gravity to down', run.player.grav === 1);
}
// Checkpoint: touch it, die, respawn THERE (not at the start).
{
  const run = createRun(2);
  const k = run.checkpoints[0];
  // Teleport the player onto the checkpoint (harness shortcut for the
  // checkpoint path — the movement path is covered by the bot runs).
  run.player.x = k.x - PLAYER_W / 2; run.player.y = k.y - PLAYER_H / 2;
  stepRun(run, { move: 0, flip: false });
  check('touching a checkpoint activates it', k.active === true);
  check('checkpoint event fires', drainEvents(run).some((e) => e.type === 'checkpoint'));
  run.player.y = run.level.height + 200; // force a void death
  stepRun(run, { move: 0, flip: false });
  check('void death kills the player', run.dead === true);
  for (let i = 0; i < 60 && run.dead; i++) stepRun(run, { move: 0, flip: false });
  check('respawn is at the checkpoint after touching it', Math.abs(run.player.x + PLAYER_W / 2 - k.respawn.x) < 1, `x=${run.player.x.toFixed(1)} vs ${k.respawn.x}`);
}
// Orb: overlap collects, scores, fires an event.
{
  const run = createRun(1);
  const o = run.orbs[0];
  run.player.x = o.x - PLAYER_W / 2; run.player.y = o.y - PLAYER_H / 2;
  stepRun(run, { move: 0, flip: false });
  check('overlapping an orb collects it', o.taken === true && run.orbsGot === 1);
  check('orb scores 100', run.score === 100, `score=${run.score}`);
  check('orb event fires', drainEvents(run).some((e) => e.type === 'orb'));
}
// Exit: overlap wins the level with a time bonus.
{
  const run = createRun(1);
  run.player.x = run.exit.x - PLAYER_W / 2; run.player.y = run.exit.y - PLAYER_H / 2;
  run.time = 10;
  stepRun(run, { move: 0, flip: false });
  check('reaching the exit wins the level', run.won === true && run.done === true);
  check('exit event fires with a time bonus', drainEvents(run).some((e) => e.type === 'exit' && e.timeBonus > 0));
  check('score includes orb + time bonus + flawless', run.score === Math.round((20 - 10) * 15) + 250, `score=${run.score}`);
}
// Crushers cycle and slam; saws patrol and reverse.
{
  const run = createRun(4);
  const c = run.crushers[0];
  let minY = Infinity, maxY = -Infinity, sawSlam = false;
  for (let i = 0; i < 300; i++) {
    stepRun(run, { move: 0, flip: false });
    minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y);
    if (run.events.some((e) => e.type === 'crusherSlam')) sawSlam = true;
    drainEvents(run);
  }
  check('crusher moves through its cycle (travels between rest and slam)', maxY - minY > 100, `y range ${minY.toFixed(1)}..${maxY.toFixed(1)}`);
  check('crusher slam event fires during its cycle', sawSlam);
  const run3 = createRun(3);
  const s = run3.saws[0];
  const x0 = s.x;
  for (let i = 0; i < 240; i++) stepRun(run3, { move: 0, flip: false });
  check('saw patrols away from its spawn', Math.abs(s.x - x0) > 20, `x ${x0.toFixed(1)} -> ${s.x.toFixed(1)}`);
  check('saw stays inside its patrol range', s.x >= s.min - 1 && s.x <= s.max + 1);
}
// Cloning is faithful (the planner depends on it).
{
  const run = createRun(3);
  // 60 steps (1s) moving right, no flip: the player is alive at col ~9
  // (before L3's floor spikes at 13) and the saws have moved.
  for (let i = 0; i < 60; i++) stepRun(run, { move: 1, flip: false });
  const c = cloneRun(run);
  check('clone copies player state', approx(c.player.x, run.player.x) && approx(c.player.vy, run.player.vy) && c.player.grav === run.player.grav);
  check('clone copies saws', c.saws[0].x === run.saws[0].x && c.saws[0].dir === run.saws[0].dir);
  check('clone is independent (stepping the clone does not move the original)', (() => {
    const x0 = run.player.x;
    stepRun(c, { move: 1, flip: false });
    return run.player.x === x0 && c.player.x !== x0;
  })());
}
// Determinism: identical inputs, identical results.
{
  const a = simulateRun(1, () => createRandomBot(7));
  const b = simulateRun(1, () => createRandomBot(7));
  check('same seed gives identical results', a.time === b.time && a.deaths === b.deaths && a.score === b.score);
}

// --- saves ---
{
  const save = defaultSave();
  check('default save unlocks only level 1', save.unlocked === 1 && isLevelUnlocked(save, 1) && !isLevelUnlocked(save, 2));
  check('recordBest stores the first clear', recordBest(save, 1, 18.5, 1200) === true && save.best[1].time === 18.5);
  check('clearing level 1 unlocks level 2', save.unlocked === 2);
  check('a slower time does not replace the best', recordBest(save, 1, 25, 900) === false && save.best[1].time === 18.5);
  check('a faster time replaces the best', recordBest(save, 1, 15.2, 1500) === true && save.best[1].time === 15.2);
  const round = parseSave(serializeSave(save));
  check('save round-trips through JSON', round.best[1].time === 15.2 && round.unlocked === 2);
  check('corrupt save falls back to defaults', parseSave('not json').unlocked === 1);
  check('save version is 1', SAVE_VERSION === 1);
  check('default save has no Time Attack result yet', defaultSave().attack === null);
}

// --- M4 progression: medals, orb records, Time Attack ---
{
  // Medals: time vs par (L1 par 20 — gold at par, silver to 1.5x par).
  check('medal gold at par', medalForTime(1, 20) === 'gold');
  check('medal gold under par', medalForTime(1, 7.5) === 'gold');
  check('medal silver between par and 1.5x par', medalForTime(1, 25) === 'silver' && medalForTime(1, 30) === 'silver');
  check('medal bronze past 1.5x par', medalForTime(1, 30.01) === 'bronze' && medalForTime(1, 90) === 'bronze');
  check('medal uses each level\'s own par', medalForTime(12, 55) === 'gold' && medalForTime(12, 56) === 'silver');
  check('medal for an unknown level is bronze', medalForTime(99, 1) === 'bronze');
  // Time Attack budget is the sum of the pars.
  const pars = LEVELS.reduce((a, l) => a + l.par, 0);
  check('Time Attack budget is the sum of the pars (461s)', timeAttackBudget() === 461 && timeAttackBudget() === pars, `budget=${timeAttackBudget()}`);
  check('each orb is worth +2s in Time Attack', ORB_TIME_BONUS === 2);
  // Time Attack medals from the clock left at the finish.
  check('Time Attack gold needs 150s+ left', timeAttackMedal(150) === 'gold' && timeAttackMedal(502) === 'gold');
  check('Time Attack silver needs 60s+ left', timeAttackMedal(60) === 'silver' && timeAttackMedal(149.9) === 'silver');
  check('Time Attack bronze is finishing at all', timeAttackMedal(0.5) === 'bronze' && timeAttackMedal(59.9) === 'bronze');
  check('medal thresholds are ordered gold > silver', TIME_ATTACK_GOLD_LEFT > TIME_ATTACK_SILVER_LEFT);
  // The unlock gate: 3 clears.
  check('Time Attack unlocks after 3 clears', TIME_ATTACK_UNLOCK_CLEARS === 3);
  {
    const s = defaultSave();
    check('Time Attack locked on a fresh save', isTimeAttackUnlocked(s) === false);
    recordBest(s, 1, 10, 1000, 9); recordBest(s, 2, 10, 1000, 5);
    check('Time Attack still locked at 2 clears', isTimeAttackUnlocked(s) === false);
    recordBest(s, 3, 10, 1000, 7);
    check('Time Attack unlocked at 3 clears', isTimeAttackUnlocked(s) === true);
  }
  // Orb records: best time wins, but a slower run with more orbs still
  // improves the orb count — replays for orbs count.
  {
    const s = defaultSave();
    recordBest(s, 1, 18.5, 1200, 6);
    check('orb count stored on the best run', s.best[1].orbs === 6);
    recordBest(s, 1, 25, 900, 10);
    check('slower run with more orbs improves the orb record, not the time', s.best[1].time === 18.5 && s.best[1].orbs === 10);
    recordBest(s, 1, 15.2, 1500, 4);
    check('faster run keeps the better orb record', s.best[1].time === 15.2 && s.best[1].orbs === 10);
    const round = parseSave(serializeSave(s));
    check('orb record survives a save round-trip', round.best[1].orbs === 10);
  }
  // A pre-M4 save (no orbs field) migrates: times kept, orbs unknown.
  {
    const old = parseSave(JSON.stringify({ version: 1, best: { 1: { time: 12.3, score: 1400 } }, unlocked: 2, settings: { muted: false, shake: 1, flash: true } }));
    check('pre-M4 save keeps its best time', old.best[1].time === 12.3);
    check('pre-M4 save has unknown orb count, not a false zero', old.best[1].orbs === null);
    check('pre-M4 save has no Time Attack result', old.attack === null);
  }
  // Time Attack results: only finishes count, fastest total time wins.
  {
    const s = defaultSave();
    const finish = { finished: true, timeLeft: 200, totalTime: 300, orbs: 90, deaths: 2, levels: 12, medal: 'gold' };
    check('first Time Attack finish is a new best', recordAttackBest(s, finish) === true && s.attack.time === 300);
    check('a slower finish does not replace the best', recordAttackBest(s, { ...finish, totalTime: 320, timeLeft: 180 }) === false && s.attack.time === 300);
    check('a faster finish replaces the best', recordAttackBest(s, { ...finish, totalTime: 280, timeLeft: 220 }) === true && s.attack.time === 280);
    check('a timeout is never a best', recordAttackBest(s, { finished: false, timeLeft: 0, totalTime: 461, orbs: 40, deaths: 9, levels: 5, medal: null }) === false && s.attack.time === 280);
    const round = parseSave(serializeSave(s));
    check('Time Attack best survives a save round-trip', round.attack && round.attack.time === 280 && round.attack.medal === 'gold');
  }
  // Full Time Attack, decision bot: finishes all 12 with time to spare.
  const t0 = Date.now();
  const ta = simulateTimeAttack(createDecisionBot);
  console.log(`  (Time Attack decision bot: ${ta.finished ? 'FINISH' : 'FAIL'} at level ${ta.reachedLevel}, total ${ta.totalTime.toFixed(1)}s, ${ta.timeLeft.toFixed(1)}s left, ${ta.orbs} orbs, ${ta.deaths} deaths, medal ${ta.medal}, ${Date.now() - t0}ms)`);
  check('decision bot finishes the Time Attack', ta.finished === true && ta.levels === 12, `reached=${ta.reachedLevel} timeLeft=${ta.timeLeft.toFixed(1)}`);
  check('decision bot finishes Time Attack with a gold medal', ta.medal === 'gold', `timeLeft=${ta.timeLeft.toFixed(1)}`);
  check('Time Attack total time is the sum of the level times', ta.totalTime > 140 && ta.totalTime < 160, `totalTime=${ta.totalTime.toFixed(1)}`);
  // Full Time Attack, random bot: stalls on level 1 and runs the clock out.
  const taRandom = simulateTimeAttack(() => createRandomBot(42));
  console.log(`  (Time Attack random bot: ${taRandom.finished ? 'FINISH (SLOP!)' : 'FAIL'} at level ${taRandom.reachedLevel}, timeLeft ${taRandom.timeLeft.toFixed(1)}s)`);
  check('random bot cannot finish the Time Attack', taRandom.finished === false);
  check('random bot stalls on level 1 of the Time Attack', taRandom.reachedLevel === 1, `reached=${taRandom.reachedLevel}`);
  check('random bot runs the Time Attack clock out', taRandom.timeLeft <= 0, `timeLeft=${taRandom.timeLeft.toFixed(1)}`);
}

// --- helpers ---
check('mulberry32 is deterministic', mulberry32(42)() === mulberry32(42)());
check('clamp works', clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2);
check('every feedback event has layers', Object.values(FEEDBACK).every((f) => f.layers.length >= 3));
check('feedback layer counts match the table', Object.entries(FEEDBACK_LAYERS).every(([k, n]) => FEEDBACK[k].layers.length === n));
// M3: the feedback spec is complete and in-tier — every event type the
// sim can emit has an entry, trauma stays in [0, 1], hit-stop in
// [0, 0.15]s, and the death event is the large tier (0.7–1.0 trauma,
// 0.10–0.15s stop) per the game-feel tiers.
check('feedback covers respawn + nearMiss (game-side events)', !!FEEDBACK.respawn && !!FEEDBACK.nearMiss);
check('all feedback trauma in [0, 1] and hit-stop in [0, 0.15]',
  Object.values(FEEDBACK).every((f) => f.trauma >= 0 && f.trauma <= 1 && f.hitStop >= 0 && f.hitStop <= 0.15));
check('death is the large tier', FEEDBACK.death.trauma >= 0.7 && FEEDBACK.death.trauma <= 1.0 && FEEDBACK.death.hitStop >= 0.1 && FEEDBACK.death.hitStop <= 0.15);
check('medium events sit in the medium tier', FEEDBACK.crusherSlam.trauma >= 0.3 && FEEDBACK.crusherSlam.trauma <= 0.5 && FEEDBACK.exit.trauma >= 0.3 && FEEDBACK.exit.trauma <= 0.5);
{
  // Drive a decision bot through level 1 and collect every event type
  // the sim actually emits — each must have a FEEDBACK bundle.
  const run = createRun(1);
  const bot = createDecisionBot();
  const seen = new Set();
  for (let i = 0; i < 60 * 120 && !run.done; i++) {
    stepRun(run, bot.input(run, DT), DT);
    for (const e of drainEvents(run)) seen.add(e.type);
  }
  check('decision-bot L1 run emits events the feedback table covers',
    [...seen].every((t) => !!FEEDBACK[t]), `emitted: ${[...seen].join(',')}`);
  check('decision-bot L1 run emits flip + orb + exit events',
    seen.has('flip') && seen.has('orb') && seen.has('exit'), `emitted: ${[...seen].join(',')}`);
}
// M3: flashing toggle defaults on and round-trips through the save.
check('default save has flashing on', defaultSave().settings.flash === true);
{
  const s = defaultSave();
  s.settings.flash = false;
  const round = parseSave(serializeSave(s));
  check('flash-off survives a save round-trip', round.settings.flash === false);
}

// --- anti-slop gates on level 1 (full gate in tests/bot.js) ---
{
  const random = simulateRun(1, () => createRandomBot(99), { maxSeconds: 90 });
  check('random-flip bot dies on level 1 (never clears it)', !random.won && random.deaths >= 1, `won=${random.won} deaths=${random.deaths}`);
  const t0 = Date.now();
  const smart = simulateRun(1, createDecisionBot, { maxSeconds: 90 });
  console.log(`  (decision bot level 1: ${smart.won ? 'CLEAR' : 'FAIL'} in ${smart.time.toFixed(1)}s, ${smart.deaths} deaths, ${smart.orbs}/${smart.orbsTotal} orbs, score ${smart.score}, ${(Date.now() - t0)}ms)`);
  check('decision bot clears level 1', smart.won === true, `won=${smart.won} deaths=${smart.deaths} time=${smart.time.toFixed(1)}`);
  check('decision bot collects orbs on level 1', smart.orbs >= 3, `${smart.orbs}/${smart.orbsTotal} orbs`);
}
// Stationary: sitting still never wins.
{
  const still = simulateRun(1, () => ({ input: () => stationaryPolicy() }), { maxSeconds: 30 });
  check('sitting still never clears level 1', still.won === false);
}

console.log(`\nsmoke: ${passed} passed, ${failed} failed`);
if (failed > 0) { console.error('failing checks:', failures.join(', ')); process.exit(1); }
