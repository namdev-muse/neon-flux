# Neon Flux — devlog

## v0.3.0 — M3 feel & juice (2026-11-22)

- **Camera:** follow now leans into the run — velocity lookahead (up to 140px) plus smooth gliding toward the target instead of snapping, so the view reads as a glide and the player never leaves the frame mid-run. A flip fires a short zoom pulse (visual only; the rig never moves colliders).
- **Flip whoosh:** every flip now fires its full bundle in the same frame — whoosh SFX, an expanding shockwave ring, a particle burst, the zoom pulse, and stretch along the flip axis. Landings squash. The FEEDBACK table in physics.js is the spec (3–6 layers per event) and the smoke test asserts the spec: every event type the sim emits has a bundle, trauma in [0, 1], hit-stop in [0, 0.15]s, death the large tier.
- **Near-miss:** a saw sweeping within 30–70px without touching earns a whoosh + brief slow-mo + a "close!" pop (1.2s cooldown so a patrolling saw can't strobe it). Presentation-side only — the sim never sees it.
- **Orb combo:** consecutive orbs within 1.5s climb a pitch ladder and show `+100 ×N`.
- **Crusher slam** now kicks up dust at the impact point; **respawn** gets a soft chime + ring + flash of its own instead of a silent pop-in.
- **Music deepened:** Am–F–C–G pad chords (detuned triangles, slow attack) under the bass + arp, and hat ticks on the offbeats while playing a level.
- **Accessibility:** a Flashing on/off toggle joins the shake slider in Settings (flash-off clears any flash already on screen). Rest-state guarantee: after sitting idle, trauma, timeScale, flash, zoom, rings and squash/stretch all return to their exact rest values — asserted in the render check via `__flux.feel()`.
- Smoke 180/180, bot gates unchanged (decision clears all 12, random dies everywhere), render check PASS.

## v0.2.0 — M2 level craft (2026-11-22)

- **12 hand-crafted levels** (was 6): Crosswind, Crusher Alley, The Weave, Sawmill, Thunder Row, Event Horizon join the first six. Each has its own identity: saw-gated flip arcs, crusher timing, rapid flip rhythm, vertical-saw floor runs, sparse-checkpoint crusher gauntlet, and a everything-combined finale.
- **Anti-slop gaps closed (M1 carry-over):** L2 slow random bot 1/6 and L3 canonical random bot 1/6. L2's ceiling is now contiguous spikes with corridors only at the decision bot's landings (7, 30, 48) plus a forced flip-down to the exit gap; L3's ceiling gaps narrowed 5 cols → 3 cols at the decision bot's landings (16, 30, 41, 44). Multi-rate probe: 0 wins at any rate. The probe is now folded into `tests/bot.js` (`createRandomBotAtRate` in physics.js) — fast 0.1–0.6s, canonical 0.2–1.2s, slow 0.8–2.5s, 6 seeds each, every level.
- **The level grammar that works** (learned the hard way — the first M2 draft failed 12 bot gates): long ceiling rides (7–9 cols, ~1s of not-flipping) so a masher flips during the ride and dies; 4-col floor gaps so the flip-up must be timed; one checkpoint per two beat-pairs; patches span [landing, flip-down + 1 col] (a spike 1 col past a flip-down kills the flipper by 1px — the kill rect is inset, but the margin is real); saws/crushers gate arcs as a bonus filter, never as the only defense.
- **Crusher lessons:** a checkpoint must never sit on (or 1 col from) a crusher column — L8 v1 respawned the bot under 'C'@40 and looped 20+ deaths in 0.5s cycles. A crusher needs a safe waiting spot before its column and approach distance to time the crossing; the planner's `wait` is only 0.4s, so a crossing that needs a longer wait becomes a phase-alignment grind (L8 v1: 76 deaths). Fix: 'c'@32 removed (it forced suicidal early flip-downs), K@57 added near the exit crusher to shorten the retry cycle, floor gap widened 4 → 5 cols at the landing edge. Result: L8 decision bot 49.0s/12 deaths → 10.0s/2 deaths.
- **L9 "The Weave" v1 was slop:** the canonical random bot cleared it — rapid beats at the masher's own rate. Rebuilt with 1 checkpoint, 3-col patches, long rides, irregular beat spacing. Now 9.3s/0 deaths for the decision bot, random dies x37.
- Decision bot clears all 12 (L11 hardest: 35.3s/5 deaths; L4 18.0s/3 deaths). Random dies everywhere at every rate. Smoke 172/172.

## v0.1.0 — M1 core (2026-11-21/22)

The first 2D game of the next loop: a neon gravity-flip action-platformer.
Run, flip gravity, dodge spikes, reach the exit. The flip IS the jump —
there is no jump button, and momentum carries through the flip.

### What shipped

- **6 dense hand-crafted levels** (First Steps, Ceiling Run, Saw Alley,
  Crusher Row, The Gauntlet, Flux Core), each with its own identity:
  flip-zones, ceiling runs, saw lanes, crusher rows, gaps, checkpoints.
- **Pure simulation core** (`physics.js`, no DOM): ground-only flips with
  coyote time and input buffering, spike/saw/crusher hazards, orbs,
  checkpoints, full-height exit portal columns, scoring (orbs + time
  bonus + flawless bonus), localStorage best times.
- **Presentation** (`game.js` + Canvas 2D): live attract-mode demo behind
  the menu (the decision bot actually plays level 1), screen-stack menu
  with staggered overshoot pops and hover ticks, event-driven HUD, Web
  Audio synth SFX + a bass-and-arp music loop, pooled particles, trauma
  screen shake, hit-stop and slow-mo on death, floating score pops,
  touch controls (hold zones + big FLIP button).
- **Anti-slop gates** (`tests/bot.js`): a bot that holds right and flips at
  random dies on every level; a bot that flips with real timing decisions
  (lookahead planner through public input hooks) clears all six.
- **Render check** (`tests/render-check.js`): headless Chromium asserts the
  menu + live demo, screen-space movement and flip direction, death +
  respawn, autopilot clear + save, pause/resume/restart, zero console errors.

### The tuning story

The level grammar was the hard part, and it took many iterations to find:

- **"Mostly no-flip" design.** Contiguous ceiling spikes in no-flip zones,
  with clear ceiling patches only at intended flip landings. A "2 on, 1 off"
  spike pattern left 1-tile safe gaps a random flip could land in.
- **Ground-only flips.** Mid-air flips let the player hover by flipping
  repeatedly; flips now only work while standing on a surface (plus a 0.1s
  coyote window and 0.12s input buffering). Momentum is still preserved.
- **The decision bot must commit.** Replanning every tick broke delayed
  flips (the delay restarted each tick and never counted down). The bot
  commits to a plan for its full 3.0s horizon; the rollout is deterministic,
  so executing the plan reproduces it tick for tick.
- **Arc orbs sit at the landing col**, not the flip col — an orb on the
  flip arc bribed the planner into flipping early and dying.
- **Checkpoints must not sit inside a hazard's patrol range** (one sat
  inside a saw's lane and produced a 23-death respawn loop).
- **Saw zones need a clear ceiling patch above them**, so the player can
  flip over the saw instead of running through it.

### Known gaps (M2)

- Multi-rate random-bot spot checks (2026-11-22, 6 seeds × 3 flip
  rates): L2 slow bot (flips every 0.8–2.5s) wins 1/6; L3 canonical
  bot (0.2–1.2s) wins 1/6. Single-seed lucky runs, not systematic
  mash-clearing — but the anti-slop bar is zero wins, so M2 must close
  them. Probe saved at
  `~/workspace/goals/neon-flux-sprint/hidden_files/multirate-probe.mjs`;
  M2 should fold it into `tests/bot.js` once the gaps are closed.
- L4 was the systematic gap and is FIXED in v0.1.0: a fast random bot
  (0.1–0.6s) won 6/6 and the canonical bot 3/6, because the level had
  no ceiling spikes — an almost-always-airborne flipper threaded the
  crushers. Fix: contiguous ceiling-spike runs with clear patches only
  at intended flip landings (the L1 grammar), repositioned so the
  decision bot's landing columns sit inside the patches. Result: fast
  0/6, canonical 0/6, slow 0/6; decision bot still clears (18.0s,
  3 deaths, floor-timing route). The opening 8 tiles stay spike-free
  per the smoke rule.
- L3's decision-bot clear takes 14.6s with 2 deaths (saw timing is tight);
  L6 takes 13.1s with 2 deaths. Both are clearable, but the saw lanes
  deserve a fairness pass.
- L4 is the only level whose intended route changed during tuning
  (ceiling-ride → floor-timing with two ceiling hops).
