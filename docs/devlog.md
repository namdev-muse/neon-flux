# Neon Flux — devlog

## v0.3.4 — M3 playtest fix-forward #4 (2026-11-22)

- **Live playtest NO-GO triage (v0.3.3):** death frame FIXED (burst
  only, no rectangle, 7 deaths observed), flip ring FIXED (bright and
  clear in 3/3 ceiling-to-floor freezes, faint in 1/4 floor-to-ceiling),
  zoom pulse reported STILL BROKEN (frozen frames "identical within
  0–5px"). Instrumental triage says the zoom DOES render: in-page,
  camScale reads 1.2687 vs 1.1857 base (exactly +7.0%) frozen in the
  paused frame, and pixel template-matching of my own flip-vs-settled
  screenshots shows the ceiling spikes shifted ~44px right in the
  zoomed frame, with the floor content pushed out of the clip. The
  playtester's still comparison was measuring near the top-left pivot
  (where the shift is inherently tiny) and against frames that may
  both have been effectively settled.
- **Fix anyway — make it unmissable:** zoom pulse 7% → 10% amplitude,
  decay 1.2/s → 0.8/s (~1.25s life); flip ring life 0.7s → 0.9s (the
  playtester's explicit recommendation — the 0.7s life was caught
  reliably only on downward flips). The render check now asserts the
  zoom reaches the SCREEN (camScale > settled × 1.05 right after a
  flip), not just the feel state — v0.3.3 only ever asserted zoomT, a
  state number.
- **Respawn camera snap:** after a far death the camera glided back
  and the player could sit off-screen for ~0.3s. The camera now snaps
  to the respawn view on the respawn event.
- Smoke 180/180, bot gates unchanged, render check PASS.

## v0.3.3 — M3 playtest fix-forward #3 (2026-11-22)

- **Live playtest NO-GO triage (v0.3.2):** the third tap-only playtest
  still reported all three defects — death-frame rectangle, no ring, no
  zoom. Instrumental triage (headless Chromium, in-page timing +
  clipped screenshots read by eye) split the verdict:
- **Death rectangle: REAL BUG, root-caused.** The v0.3.2 fix cleared
  the trail once in the death handler, but `pushTrail` runs every tick
  ungated — the sim keeps stepping through the death beat with the
  player frozen at the death point, so the trail refilled within 0.28s
  and 17+ player-sized rects stacked into a solid body. My own
  screenshots prove it: +0.25s a translucent block at the death point,
  +0.9s a solid body-sized rectangle over the first spike. Fix: the
  push is now gated on `!run.dead && !run.done`. The render check now
  asserts the trail reads 0 during the death beat.
- **Ring/zoom: MEASUREMENT ARTIFACT, plus one real pause bug.** In-page
  sampling right after a real flip shows the bundle is there (shockwave
  1, zoomT 1.0 decaying to 0.78 over 180ms, grav flips) — the live
  playtester's screenshots arrive >0.7s after the flip (ring life) and
  >0.83s after (zoom pulse), and the player had already landed by the
  capture. BUT the Space-then-Pause trick the playtester used to freeze
  a frame could never work: `frame()` ran the feel/particle/shockwave
  updates on wall time even while paused, so the ring decayed behind
  the pause menu. Fix: pause now freezes everything — feel, particles,
  pops, shockwaves, trail, camera (shake offsets zeroed so the backdrop
  sits still). The render check now asserts the bundle is bit-identical
  after 1.5s paused. The ring/zoom lifetimes were NOT lengthened: they
  read in motion for a human player; stretching them for a slow
  screenshot tool would be designing for the tool, not the player.
- Smoke 180/180, bot gates unchanged, render check PASS.

## v0.3.2 — M3 playtest fix-forward #2 (2026-11-22)

- **Live playtest NO-GO triage (v0.3.1):** the second tap-only playtest
  confirmed the death beat is mostly fixed (no frozen upside-down body;
  every observed death respawned quickly, upright, on the floor) but
  flagged three things: a solid cyan body-sized rectangle in the first
  frame of every death, no visible shockwave ring on any flip, and no
  visible zoom pulse.
- **The rectangle was the trail, not the body.** The trail is drawn
  before the `activeRun.dead` guard, and under slow tap-only movement
  26 trail rects pile up at one spot and composite to near-solid cyan.
  Fix: the trail is cleared on death. The death burst is also thicker
  now (48 cyan / 24 pink particles, was 34/16) so the burst reads
  instead of a rectangle.
- **Ring and zoom were present but decayed before the stills.** The ring
  used linear alpha falloff (0.24 at 0.44s into a 0.6s life) and the zoom
  pulse lasted 0.4s, so a capture 0.44s after a flip showed neither —
  expected, not absent (the render check had asserted zoomT 0.77–0.88
  in-frame). Fix: ring alpha now uses sqrt falloff (0.52 at t=0.73),
  thicker line + glow, life 0.6s → 0.7s; zoom decay 2.5/s → 1.2/s
  (~0.83s pulse). A flip-stills probe (pre-flip vs ~0.25s post-flip)
  now shows the ring unmistakably in the still — large cyan outer +
  inner echo rings at the flip origin, player stretched above it.
- Smoke 180/180, bot gates unchanged, render check PASS, flip-stills
  probe PASS by eye.

## v0.3.1 — M3 playtest fix-forward (2026-11-22)

- **Live playtest NO-GO triage (v0.3.0):** the tap-only playtest could not
  see the flip ring or the zoom pulse in stills, and read the death beat
  as an "instant cut to respawn" with the player "respawned upside-down".
  Instrumental probes showed the respawn itself is correct (died
  grav=-1 at y=62 on the ceiling, respawned grav=1 at y=488 on the floor)
  and the orb combo works (max ×9 on the L1 autopilot) — the playtester
  saw the frozen death-beat body, not the respawn, and never collected
  two orbs within 1.5s.
- **Fixes:** the player body is no longer drawn during the death beat
  (it burst into particles; a frozen upside-down body read as a broken
  respawn). The flip shockwave ring is bigger, thicker and longer
  (130px / 0.6s / 5px, was 90px / 0.45s / 4px) and the zoom pulse is
  stronger and slower (7%, decay 2.5/s, was 5% / 3.5/s) so both register
  in a still frame as well as in motion.
- **Not changed:** L1's first spike gate. The six tap-only deaths there
  are the known tooling limit (no run speed → near-vertical flips);
  the decision bot clears L1 in 7.5s/0 deaths and the autopilot in
  7.62s/0 deaths with real timing. No mid-air double-flip either: flips
  only work while standing (plus coyote/buffer) by design.
- Smoke 180/180, bot gates unchanged, render check PASS.

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
