# Neon Flux

A 2D neon gravity-flip action-platformer. Run, flip gravity, dodge spikes and
saws, ride crushers, collect energy orbs, and reach the exit portal.

**Play it live:** https://namdev-muse.github.io/neon-flux/

## The flip is the skill

There is no jump — the flip IS the jump. Hold **← / →** (or **A / D**) to run,
press **Space / W / ↑** to flip gravity. Momentum carries through the flip, so
timing is everything: flip too early and you land in the ceiling spikes, too
late and the floor spikes get you. Flips only work while standing on a surface
(a short grace window after leaving one).

- **Spikes** on floor and ceiling, **saws** patrolling lanes, **crushers** that
  telegraph before they slam, **gaps** in the floor.
- **Energy orbs** for points, **checkpoints** to respawn at, an **exit portal**
  at the end of every level.
- Death sends you back to your last checkpoint (orbs you collected stay
  collected). Score = orbs + time bonus + a flawless bonus for a deathless run.
  Best time is saved per level.
- 12 dense hand-crafted levels in this release, each with its own identity:
  First Steps, Ceiling Run, Saw Alley, Crusher Row, The Gauntlet, Flux Core,
  Crosswind, Crusher Alley, The Weave, Sawmill, Thunder Row, Event Horizon.

## Progression

- **Medals:** beat a level's par time for Gold, within 1.5× par for Silver.
  Your best medal and orb record show on the level card — the reason to replay
  a level you already cleared.
- **Time Attack** (unlocks after clearing 3 levels): one countdown clock
  across all 12 levels, starting from the sum of the pars (7:41). Every orb
  adds +2s, so orbs are the fuel — grabbing one under pressure is worth the
  risk, skipping one is a real choice. Finish with 2:30+ left for Gold,
  1:00+ for Silver. Your best finish is saved; a timeout never counts.

## Controls

| Input | Action |
| --- | --- |
| ← → / A D | Run left / right |
| Space / W / ↑ | Flip gravity |
| P | Pause |
| M | Mute |
| R | Restart level |
| Touch | Hold ◀ ▶ zones to run, tap FLIP |

## Game feel

Pooled particles, trauma screen shake, hit-stop and slow-mo on death,
near-miss slow-mo when a saw sweeps past, a camera that leans into the run
with lookahead and a zoom pulse on every flip, squash & stretch on flip and
landing, shockwave rings on flip/checkpoint/exit, an orb combo pitch ladder,
crusher-slam dust, Web Audio synth SFX and a looping bass + arp + pad +
hats soundtrack, floating score pops, a live attract-mode demo playing
behind the menu, and a screen-stack menu with staggered pops and hover
ticks. Screen shake (0–100%) and flashing effects can both be turned down
or off in Settings; every effect decays back to its exact rest state.

## Anti-slop

No auto-run, no assist, no "flip now" prompt — nothing plays for you. The
level set is gated by bots: a bot that holds right and flips at random must
die on every level, and a bot that flips with real timing decisions must be
able to clear all twelve.

## Run locally

```sh
# tests (pure logic, no browser needed)
npm run smoke   # physics + level validity
npm run bot     # anti-slop gates: random bot dies, decision bot clears

# play in a browser (any static server)
python3 -m http.server 8931
# open http://localhost:8931/

# headless render check (needs the Playwright headless shell)
npm run render-check
```

## Tech

Vanilla Canvas 2D + HTML/CSS/JS, Web Audio synth SFX, no build step, no
dependencies at runtime. Static files, deployed to GitHub Pages.
`physics.js` is the pure simulation (imported by the game and the tests);
`game.js` owns rendering, input, screens, audio and game feel.

## License

MIT — see [LICENSE](LICENSE).
