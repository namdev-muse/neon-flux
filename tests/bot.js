// Neon Flux v0.2.0 — bot harness: the anti-slop gate.
//   - Random bot: holds right and flips at random times. It MUST die
//     on every level — if it clears one, the level is not done.
//   - Decision bot: the lookahead planner flips with real timing
//     decisions through the public stepRun + input hooks. It MUST
//     clear all 12 levels — if it cannot, the level is unfair or the
//     planner is blind.
//   - Stationary bot: sitting still must never win.
// Usage: node tests/bot.js
import { LEVELS, simulateRun, createRandomBot, createRandomBotAtRate, createDecisionBot, stationaryPolicy } from '../physics.js';

let failures = 0;
for (const level of LEVELS) {
  const t0 = Date.now();
  const smart = simulateRun(level.id, createDecisionBot, { maxSeconds: 150 });
  const random = simulateRun(level.id, () => createRandomBot(1000 + level.id), { maxSeconds: 90 });
  const still = simulateRun(level.id, () => ({ input: () => stationaryPolicy() }), { maxSeconds: 30 });
  const ms = Date.now() - t0;
  console.log(`Level ${level.id} "${level.name}": decision bot ${smart.won ? 'CLEAR' : 'FAILED'}`
    + ` in ${smart.time.toFixed(1)}s, ${smart.deaths} deaths, ${smart.orbs}/${smart.orbsTotal} orbs, score ${smart.score}`
    + ` | random: ${random.won ? 'CLEARED (SLOP!)' : `died x${random.deaths} in ${random.time.toFixed(1)}s`}`
    + ` | stationary: ${still.won ? 'CLEARED (SLOP!)' : 'failed'}`
    + ` (${ms}ms)`);
  if (!smart.won) { failures++; console.error(`  BOT FAIL: level ${level.id} not cleared by the decision bot`); }
  if (smart.deaths > 6) { failures++; console.error(`  BOT FAIL: level ${level.id} cost the decision bot ${smart.deaths} deaths (want <= 6 — the level may be unfair)`); }
  if (random.won) { failures++; console.error(`  BOT FAIL: level ${level.id} is clearable by holding right and flipping at random — tighten the level`); }
  if (random.deaths === 0) { failures++; console.error(`  BOT FAIL: random bot survived level ${level.id} without dying — the level has no teeth`); }
  if (still.won) { failures++; console.error(`  BOT FAIL: level ${level.id} is clearable by sitting still — tighten the level`); }
}

// A second random seed, to catch levels that are only deadly by luck.
for (const level of LEVELS) {
  const random = simulateRun(level.id, () => createRandomBot(555 + level.id), { maxSeconds: 90 });
  if (random.won) { failures++; console.error(`  BOT FAIL: level ${level.id} cleared by random bot seed 555 (SLOP)`); }
}
console.log('bot: second random seed checked on all 12 levels');

// Multi-rate random check (folded in from hidden_files/multirate-probe.mjs,
// M2): the canonical bot flips every 0.2-1.2s, but a faster (0.1-0.6s) or
// slower (0.8-2.5s) masher must not clear a level either. 6 seeds per rate
// per level, 90s cap — the same seeds the probe used.
for (const rate of [
  { name: 'fast 0.1-0.6s', min: 0.1, max: 0.6 },
  { name: 'canon 0.2-1.2s', min: 0.2, max: 1.2 },
  { name: 'slow 0.8-2.5s', min: 0.8, max: 2.5 },
]) {
  for (const level of LEVELS) {
    let wins = 0;
    for (let s = 0; s < 6; s++) {
      const r = simulateRun(level.id, () => createRandomBotAtRate(rate.min, rate.max, 1000 + level.id * 97 + s * 13), { maxSeconds: 90 });
      if (r.won) wins++;
    }
    if (wins > 0) { failures++; console.error(`  BOT FAIL: level ${level.id} cleared by ${rate.name} random bot ${wins}/6 (SLOP)`); }
  }
}
console.log('bot: multi-rate random check done on all levels');

if (failures > 0) { console.error(`bot: ${failures} failure(s)`); process.exit(1); }
console.log('bot: all gates pass — random dies everywhere, decision clears everything');
