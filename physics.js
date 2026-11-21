// Neon Flux v0.2.0 — pure simulation core (no DOM, no Canvas).
// 2D neon gravity-flip action-platformer. Run with Left/Right; one
// button flips gravity, momentum preserved through the flip. There is
// no jump — the flip IS the jump. Levels are hand-crafted tile maps:
// spikes on floor and ceiling, patrolling saws, slamming crushers,
// gaps, energy orbs, checkpoints, exit portal. Death resets to the
// last checkpoint; score from orbs + time bonus; best time saved
// per level.
//
// Anti-slop: no auto-run, no assist, no "flip now" prompt, nothing
// that plays for the player. The random-flip bot (hold right, flip at
// random times) must die on every level; the decision bot flips with
// real timing decisions — a lookahead planner that forward-simulates
// candidate flip policies through the same public stepRun — and must
// clear all 12. If the random bot clears a level, the level is not done.
//
// Deterministic: fixed-step simulation (DT = 1/60), every hazard
// cycle derived from the run clock, so identical inputs give
// identical results.
export const VERSION = '0.2.0';
export const TILE = 40;
export const ROWS = 14;
export const DT = 1 / 60;
export const GRAVITY = 2400; // px/s^2 — a full flip crosses the arena in ~0.63s
export const MAX_FALL = 720;
export const RUN_ACCEL = 2600;
export const MAX_RUN = 290;
export const GROUND_FRICTION = 2400; // decel px/s^2 with no input on a surface
export const AIR_DRAG = 0.35; // exponential damping /s while airborne, no input
export const FLIP_COOLDOWN = 0.18;
export const FLIP_COYOTE = 0.1; // seconds after leaving a surface a flip still works
export const FLIP_BUFFER = 0.12; // seconds a flip pressed mid-air stays queued for the landing
export const PLAYER_W = 24;
export const PLAYER_H = 32;
export const ORB_SCORE = 100;
export const ORB_RADIUS = 12;
export const SAW_RADIUS = 13;
export const SAW_SPEED = 130;
export const SAW_RANGE = 120; // patrol half-range in px
export const CRUSHER_W = 40;
export const CRUSHER_H = 36;
export const DEATH_RESPAWN_DELAY = 0.5; // seconds of game time in the death beat
export const SAVE_KEY = 'neon-flux-save-v1';
export const SAVE_VERSION = 1;

// Crusher cycle (seconds): rest up -> telegraph -> slam -> hold down -> retract.
export const CRUSHER_PHASES = [
  { name: 'up', dur: 0.7 },
  { name: 'telegraph', dur: 0.45 },
  { name: 'slam', dur: 0.12 },
  { name: 'down', dur: 0.5 },
  { name: 'retract', dur: 0.55 },
];
export const CRUSHER_CYCLE = CRUSHER_PHASES.reduce((a, p) => a + p.dur, 0); // 2.32s

// Feedback tiers (game-feel): every event fires its full bundle.
export const FEEDBACK = {
  flip: { trauma: 0.12, hitStop: 0, layers: ['sound', 'whoosh', 'trail'] },
  orb: { trauma: 0.08, hitStop: 0, layers: ['sound', 'spark', 'pop'] },
  checkpoint: { trauma: 0.15, hitStop: 0, layers: ['sound', 'ring', 'flash'] },
  death: { trauma: 0.9, hitStop: 0.12, layers: ['sound', 'burst', 'shake', 'flash', 'slowmo'] },
  exit: { trauma: 0.3, hitStop: 0, layers: ['sound', 'fanfare', 'burst', 'flash'] },
  crusherSlam: { trauma: 0.35, hitStop: 0, layers: ['sound', 'thud', 'shake'] },
};
export const FEEDBACK_TIERS = {
  small: { trauma: [0.1, 0.2], hitStop: 0 },
  medium: { trauma: [0.3, 0.5], hitStop: [0.04, 0.06] },
  large: { trauma: [0.7, 1.0], hitStop: [0.1, 0.15] },
};
export const FEEDBACK_LAYERS = {
  flip: 3, orb: 3, checkpoint: 3, death: 5, exit: 4, crusherSlam: 3,
};

export function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- levels
// Legend: '#' solid | '^' floor spike | 'v' ceiling spike | 's' horizontal
// saw | 'S' vertical saw | 'C' ceiling crusher | 'c' floor crusher |
// '*' orb | 'K' checkpoint | 'P' player start | 'E' exit portal |
// '.' or ' ' empty. Row 0 is the ceiling, row 13 the floor. All rows
// must be the same length; the parser throws otherwise.
//
// Flip-arc note (drives every layout): at full run speed a flip takes
// ~0.63s to cross the 480px arena and carries the player ~4.6 tiles
// right. So a spike pair on the floor is answered by flipping ~1 tile
// before it and landing on the ceiling ~4.6 tiles later — the ceiling
// there must be clear, and the flip-back landing must be clear too.
// Flips only work while standing on a surface (plus a 0.1s coyote
// window and input buffering): mid-air flipping would let a player
// hover in the middle of the arena forever, safe from every surface
// spike — the flip must be a committed decision, not a hover button.
export const LEVELS = [
  {
    id: 1, name: 'First Steps', par: 20, accent: '#22d3ee',
    hint: 'Run right. SPACE flips gravity — but only while standing on a surface. Flip where the ceiling is clear.',
    rows: [
      '###########################################################',
      '.........vvvvvv.*..vvvvvvvvvvv*..vvvvvvvvvvv*..vvvvvvv.....',
      '...........................................................',
      '...........................................................',
      '...........................................................',
      '...........................................................',
      '...............*.............*.............*...........*...',
      '...........................................................',
      '...........................................................',
      '...........................................................',
      '...........................................................',
      '...........................................................',
      '..P...*.*....^^.......*....^^.....K.*....^^.......*......E.',
      '#####################################################...###',
    ],
  },
  {
    id: 2, name: 'Ceiling Run', par: 24, accent: '#a78bfa',
    hint: 'Spikes on the floor? Ride the ceiling. Spikes above? Drop back down.',
    rows: [
      '#########################################################',
      '.............*..*....vvvvvvvv...*..*...vvvv....*..*..vv..',
      '.........................................................',
      '.........................................................',
      '.........................................................',
      '.........................................................',
      '...........*..................*.................*........',
      '.........................................................',
      '.........................................................',
      '.........................................................',
      '.........................................................',
      '.........................................................',
      '..P.....^^^^^^^^^^^^^^^^.K.^^^^^^^^^^^^^^^.K.^^^^^^^^^.E.',
      '#########################################################',
    ],
  },
  {
    id: 3, name: 'Saw Alley', par: 28, accent: '#f472b6',
    hint: 'Saws sweep their lanes. Time the crossing — or flip around them.',
    rows: [
      '############################################################',
      '.........vvvvvv.*.vvvvvvvvvvv.*.vvvvvvvv.*.v.*.vvvvvvvvvv...',
      '............................................................',
      '............................................................',
      '............................................................',
      '............................................................',
      '................*............s*.............*...............',
      '............................................................',
      '............................................................',
      '............................................................',
      '..................................................S.........',
      '............................................................',
      '..P...*.*....^^.....*.K....^^.....K..s*..^^...........*..E..',
      '############################################################',
    ],
  },
  {
    id: 4, name: 'Crusher Row', par: 32, accent: '#fbbf24',
    hint: 'The ceiling is spiked almost everywhere — flip only where it is clear, and mind the crushers.',
    rows: [
      '################################################################',
      '........vvvv.*.vCvvvv....vvvCvvvvvv.*..vCvvvvv....vvCvv.......vv',
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '............*.................*.................*...............',
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '..P...*...^^..*.......c...*...K...c...*.......c...*.......c..E..',
      '################################################################',
    ],
  },
  {
    id: 5, name: 'The Gauntlet', par: 38, accent: '#34d399',
    hint: 'Everything at once. Gaps want a hop; spikes want a flip.',
    rows: [
      '####################################################################',
      '.........vvvvvv..*.vvvvvvvv..*.vvvvvvvvvvvvv..C.vvvvvv..*.vvvvv..*..',
      '....................................................................',
      '....................................................................',
      '....................................................................',
      '....................................................................',
      '................*...........*..........................*........*...',
      '....................................................................',
      '....................................................................',
      '....................................................................',
      '....................................................................',
      '....................................................................',
      '..P...*.*....^^.....*...........K.*....s............^^....*.....cE..',
      '########################...#################################...#####',
    ],
  },
  {
    id: 6, name: 'Flux Core', par: 44, accent: '#fb7185',
    hint: 'The full test. Every flip is a decision — make them count.',
    rows: [
      '########################################################################',
      '.........vvvvvv..*.vvvvvvvv..*.vvvvvv..*..vvvv..C.vvvvvvv..*.vvvvvvvvvv.',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '................*...........*.............................*.............',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '..................................................................S.....',
      '........................................................................',
      '..P...*.*....^^.....*.............K....s....K.....*....^^......*.....E..',
      '########################...###############################...###########',
    ],
  },
  {
    id: 7, name: 'Crosswind', par: 38, accent: '#a3e635',
    hint: 'Saws sweep the flip arcs. Cross when the saw is away.',
    rows: [
      '################################################################',
      '.............*......vvvvvvvv..*......vvvvvvvv..*......vv........',
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '..........*.........s.....*s...............*s.........s*........',
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '................................................................',
      '..P.*...^^^^^^^^^^^^^^.*..^^^^^^^^^^^^^.K..^^^^^^^^^^^^^.*...E..',
      '################################################################',
    ],
  },
  {
    id: 8, name: 'Crusher Alley', par: 42, accent: '#38bdf8',
    hint: 'Crushers slam the columns. Cross on the up-beat — or flip over them.',
    rows: [
      '##################################################################',
      '.............*......vvvvvvvv..*......vvvvCvvv..*......vv..C.......',
      '..................................................................',
      '..................................................................',
      '..................................................................',
      '..................................................................',
      '..........*................*................*..........*..........',
      '..................................................................',
      '..................................................................',
      '..................................................................',
      '..................................................................',
      '..................................................................',
      '..P.*...^^^^^^^c^^^^^^.*..^^^^^^^^^^^^^.K...^^^^^^^^^^^^.K*....E..',
      '##################################################################',
    ],
  },
  {
    id: 9, name: 'The Weave', par: 46, accent: '#fb923c',
    hint: 'Short runs, quick flips. Find the rhythm and ride it.',
    rows: [
      '########################################################################',
      '.............*......vvvvvvvv..*......vvvvvvvv..*......vvvvvvvv..*..vv...',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '..........*................*................*................*..........',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '..P.*...^^^^^^^^^^^^^^..*.^^^^^^^^^^^^^.K..^^^^^^^^^^^^^..*.^^^^^^^^^.E.',
      '########################################################################',
    ],
  },
  {
    id: 10, name: 'Sawmill', par: 46, accent: '#2dd4bf',
    hint: 'Vertical saws guard the floor. Flip over them — and mind the cross-saws.',
    rows: [
      '######################################################################',
      '.............*......vvvvvvvv..*......vvvvvvvv..*......vv..............',
      '......................................................................',
      '......................................................................',
      '......................................................................',
      '......................................................................',
      '..........*.........s.....*s...............*s.........s*..............',
      '......................................................................',
      '......................................................................',
      '......................................................................',
      '........................S................S................S...........',
      '......................................................................',
      '..P.*...^^^^^^^^^^^^^^.*..^^^^^^^^^^^^^.K..^^^^^^^^^^^^^.*.........E..',
      '######################################################################',
    ],
  },
  {
    id: 11, name: 'Thunder Row', par: 48, accent: '#ef4444',
    hint: 'Crushers, spikes, two checkpoints. No mercy — time everything.',
    rows: [
      '########################################################################',
      '.............*......vvvvvvvv..*......vvvvCvvv..*......vv.......C........',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '..........*................*................*..........*................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '........................................................................',
      '..P.*...^^^^^^^c^^^^^^.*..^^^^^^c^^^^^^.K..^^^^^^^^^^^^^.K...........E..',
      '########################################################################',
    ],
  },
  {
    id: 12, name: 'Event Horizon', par: 55, accent: '#e879f9',
    hint: 'Everything you have learned, all at once. Make every flip count.',
    rows: [
      '############################################################################',
      '.............*......vvvvvvvv..*......vvvvCvvv..*......vvvvvvvv..*......vv...',
      '............................................................................',
      '............................................................................',
      '............................................................................',
      '............................................................................',
      '..........*.........s.....*s...............*s...............s*..............',
      '............................................................................',
      '............................................................................',
      '............................................................................',
      '........................S...................................................',
      '............................................................................',
      '..P.*...^^^^^^^c^^^^^^.*..^^^^^^c^^^^^^.K..^^^^^^^^^^^^^.K..^^^^^^c^^^^^^.E.',
      '############################################################################',
    ],
  },
];

export function levelById(id) { return LEVELS.find((l) => l.id === id) || null; }

// Parse a level definition into the runtime structures. Throws on any
// malformed map so a bad level can never ship silently.
export function parseLevel(def) {
  const rows = def.rows;
  const width = rows[0].length;
  if (rows.length !== ROWS) throw new Error(`level ${def.id}: expected ${ROWS} rows, got ${rows.length}`);
  const solids = [];
  for (let r = 0; r < ROWS; r++) {
    if (rows[r].length !== width) throw new Error(`level ${def.id}: row ${r} length ${rows[r].length} != ${width}`);
    solids.push(new Array(width).fill(false));
  }
  const spikes = [], saws = [], crushers = [], orbs = [], checkpoints = [];
  let start = null, exit = null;
  let sawIndex = 0, crusherIndex = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < width; c++) {
      const ch = rows[r][c];
      const x = c * TILE, y = r * TILE;
      switch (ch) {
        case '#': solids[r][c] = true; break;
        case '^': spikes.push({ x, y, dir: 'up', cx: x + TILE / 2, cy: y + TILE / 2 }); break;
        case 'v': spikes.push({ x, y, dir: 'down', cx: x + TILE / 2, cy: y + TILE / 2 }); break;
        case 's': saws.push({ x: x + TILE / 2, y: y + TILE / 2, axis: 'x', dir: 1, speed: SAW_SPEED, min: x + TILE / 2 - SAW_RANGE, max: x + TILE / 2 + SAW_RANGE, cx: x + TILE / 2, cy: y + TILE / 2 }); sawIndex++; break;
        case 'S': saws.push({ x: x + TILE / 2, y: y + TILE / 2, axis: 'y', dir: 1, speed: SAW_SPEED, min: y + TILE / 2 - SAW_RANGE, max: y + TILE / 2 + SAW_RANGE, cx: x + TILE / 2, cy: y + TILE / 2 }); sawIndex++; break;
        case 'C': crushers.push({ x, anchor: 'ceiling', t: crusherIndex * 0.55, index: crusherIndex }); crusherIndex++; break;
        case 'c': crushers.push({ x, anchor: 'floor', t: crusherIndex * 0.55, index: crusherIndex }); crusherIndex++; break;
        case '*': orbs.push({ x: x + TILE / 2, y: y + TILE / 2, taken: false }); break;
        case 'K': checkpoints.push({ x: x + TILE / 2, y: y + TILE / 2, active: false }); break;
        case 'P': if (start) throw new Error(`level ${def.id}: two starts`); start = { x: x + TILE / 2, y: y + TILE / 2 }; break;
        case 'E': if (exit) throw new Error(`level ${def.id}: two exits`); exit = { x: x + TILE / 2, y: y + TILE / 2 }; break;
        case '.': case ' ': break;
        default: throw new Error(`level ${def.id}: unknown tile '${ch}' at row ${r} col ${c}`);
      }
    }
  }
  if (!start) throw new Error(`level ${def.id}: no player start (P)`);
  if (!exit) throw new Error(`level ${def.id}: no exit (E)`);
  // Clamp saw patrols inside the level.
  for (const s of saws) {
    if (s.axis === 'x') { s.min = Math.max(TILE, s.min); s.max = Math.min(width * TILE - TILE, s.max); }
    else { s.min = Math.max(TILE, s.min); s.max = Math.min(ROWS * TILE - TILE, s.max); }
  }
  // Respawn point for a checkpoint / the start: stand on the first
  // solid tile below (or above, for a ceiling checkpoint) the marker.
  function respawnFor(px, py) {
    const col = Math.floor(px / TILE);
    for (let r = Math.floor(py / TILE) + 1; r < ROWS; r++) {
      if (solids[r][col]) return { x: px, y: r * TILE - PLAYER_H };
    }
    for (let r = Math.floor(py / TILE) - 1; r >= 0; r--) {
      if (solids[r][col]) return { x: px, y: (r + 1) * TILE };
    }
    return { x: px, y: py };
  }
  const startRespawn = respawnFor(start.x, start.y);
  for (const k of checkpoints) k.respawn = respawnFor(k.x, k.y);
  return {
    def, id: def.id, name: def.name, par: def.par, accent: def.accent, hint: def.hint,
    width: width * TILE, height: ROWS * TILE, cols: width, rows: ROWS, solids,
    spikes, saws, crushers, orbs, checkpoints, start, exit, startRespawn,
  };
}

// ---------------------------------------------------------------- run state
export function createRun(levelId) {
  const def = levelById(levelId);
  if (!def) throw new Error(`no level ${levelId}`);
  const level = parseLevel(def);
  const run = {
    level, levelId,
    player: {
      x: level.startRespawn.x - PLAYER_W / 2, y: level.startRespawn.y,
      vx: 0, vy: 0, grav: 1, grounded: true, groundDir: 'floor', flipCd: 0, coyote: 0,
    },
    flipBuffer: 0,
    orbs: level.orbs.map((o) => ({ ...o })),
    checkpoints: level.checkpoints.map((k) => ({ ...k })),
    saws: level.saws.map((s) => ({ ...s })),
    crushers: level.crushers.map((c) => ({ ...c, phase: 'up', phaseT: 0, y: crusherRestY(level, c) })),
    exit: { ...level.exit },
    lastCheckpoint: null,
    deaths: 0, time: 0, score: 0, orbsGot: 0,
    dead: false, deadTimer: 0, done: false, won: false,
    events: [],
  };
  return run;
}

function crusherRestY(level, c) {
  return c.anchor === 'ceiling' ? TILE : level.height - TILE - CRUSHER_H;
}
function crusherSlamY(level, c) {
  return c.anchor === 'ceiling' ? level.height - TILE - CRUSHER_H : TILE;
}

function solidAt(level, col, row) {
  if (col < 0 || col >= level.cols || row < 0 || row >= level.rows) return true; // outside the map is solid
  return level.solids[row][col];
}

// AABB vs the tile grid. Returns the resolved position and whether the
// player is grounded (pushed back in the gravity direction).
function moveAndCollide(level, p, dx, dy) {
  let grounded = false, groundDir = p.groundDir;
  // --- horizontal ---
  p.x += dx;
  const top = Math.floor(p.y / TILE), bottom = Math.floor((p.y + PLAYER_H - 0.01) / TILE);
  if (dx > 0) {
    const col = Math.floor((p.x + PLAYER_W) / TILE);
    for (let r = top; r <= bottom; r++) {
      if (solidAt(level, col, r)) { p.x = col * TILE - PLAYER_W - 0.01; p.vx = 0; break; }
    }
  } else if (dx < 0) {
    const col = Math.floor(p.x / TILE);
    for (let r = top; r <= bottom; r++) {
      if (solidAt(level, col, r)) { p.x = (col + 1) * TILE + 0.01; p.vx = 0; break; }
    }
  }
  // --- vertical ---
  p.y += dy;
  const left = Math.floor(p.x / TILE), right = Math.floor((p.x + PLAYER_W - 0.01) / TILE);
  if (dy > 0) {
    const row = Math.floor((p.y + PLAYER_H) / TILE);
    for (let c = left; c <= right; c++) {
      if (solidAt(level, c, row)) { p.y = row * TILE - PLAYER_H - 0.01; p.vy = 0; grounded = true; groundDir = 'floor'; break; }
    }
  } else if (dy < 0) {
    const row = Math.floor(p.y / TILE);
    for (let c = left; c <= right; c++) {
      if (solidAt(level, c, row)) { p.y = (row + 1) * TILE + 0.01; p.vy = 0; grounded = true; groundDir = 'ceiling'; break; }
    }
  } else {
    // No vertical motion: re-probe the surface in the gravity direction
    // so standing still still counts as grounded.
    if (p.grav > 0) {
      const row = Math.floor((p.y + PLAYER_H + 1) / TILE);
      for (let c = left; c <= right; c++) {
        if (solidAt(level, c, row)) { grounded = true; groundDir = 'floor'; break; }
      }
    } else {
      const row = Math.floor((p.y - 1) / TILE);
      for (let c = left; c <= right; c++) {
        if (solidAt(level, c, row)) { grounded = true; groundDir = 'ceiling'; break; }
      }
    }
  }
  return { grounded, groundDir };
}

function aabbOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
function circleAabb(cx, cy, r, ax, ay, aw, ah) {
  const nx = clamp(cx, ax, ax + aw), ny = clamp(cy, ay, ay + ah);
  const dx = cx - nx, dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}

function die(run, cause) {
  if (run.dead || run.done) return;
  run.dead = true;
  run.deadTimer = DEATH_RESPAWN_DELAY;
  run.deaths++;
  run.events.push({ type: 'death', cause, x: run.player.x + PLAYER_W / 2, y: run.player.y + PLAYER_H / 2 });
}

export function respawn(run) {
  const spot = run.lastCheckpoint ? run.lastCheckpoint.respawn : run.level.startRespawn;
  const p = run.player;
  p.x = spot.x - PLAYER_W / 2; p.y = spot.y;
  p.vx = 0; p.vy = 0; p.grav = 1; p.flipCd = 0; p.coyote = 0; p.grounded = true; p.groundDir = 'floor';
  run.dead = false; run.deadTimer = 0; run.flipBuffer = 0;
  run.events.push({ type: 'respawn', x: spot.x, y: spot.y });
}

// One fixed step. input: {move: -1|0|1, flip: boolean}.
export function stepRun(run, input, dt = DT) {
  const p = run.player;
  const level = run.level;
  if (run.done) return run;
  run.time += dt;

  // --- death beat: freeze, then respawn at the last checkpoint ---
  if (run.dead) {
    run.deadTimer -= dt;
    if (run.deadTimer <= 0) respawn(run);
    return run;
  }

  if (p.flipCd > 0) p.flipCd -= dt;
  if (run.flipBuffer > 0) run.flipBuffer -= dt;

  // --- flip: only while standing on a surface (or inside the coyote
  // window after leaving one). Gravity reverses, velocity is PRESERVED
  // (momentum carries). A flip pressed mid-air is buffered and fires
  // on the landing, so the input is never silently dropped. ---
  const wasGrounded = p.grounded;
  function doFlip() {
    p.grav *= -1;
    p.flipCd = FLIP_COOLDOWN;
    p.grounded = false;
    p.coyote = 0;
    run.flipBuffer = 0;
    run.events.push({ type: 'flip', grav: p.grav, x: p.x + PLAYER_W / 2, y: p.y + PLAYER_H / 2 });
  }
  if (input.flip) {
    if (p.flipCd <= 0 && (p.grounded || p.coyote > 0)) doFlip();
    else run.flipBuffer = FLIP_BUFFER;
  }

  // --- horizontal run ---
  if (input.move !== 0) {
    p.vx += input.move * RUN_ACCEL * dt;
    p.vx = clamp(p.vx, -MAX_RUN, MAX_RUN);
  } else if (p.grounded) {
    const s = Math.sign(p.vx);
    p.vx -= s * GROUND_FRICTION * dt;
    if (Math.sign(p.vx) !== s) p.vx = 0;
  } else {
    p.vx *= Math.exp(-AIR_DRAG * dt);
  }

  // --- gravity ---
  p.vy += p.grav * GRAVITY * dt;
  p.vy = clamp(p.vy, -MAX_FALL, MAX_FALL);

  // --- integrate + collide ---
  const res = moveAndCollide(level, p, p.vx * dt, p.vy * dt);
  const landed = res.grounded && !wasGrounded;
  p.grounded = res.grounded;
  p.groundDir = res.groundDir;
  // Coyote: a short grace window after walking off a surface.
  if (p.grounded) p.coyote = FLIP_COYOTE;
  else if (p.coyote > 0) p.coyote -= dt;
  // A flip buffered mid-air fires the instant the player lands.
  if (landed && run.flipBuffer > 0 && p.flipCd <= 0) doFlip();
  // Clamp inside the level horizontally (invisible walls at the ends).
  if (p.x < 0) { p.x = 0; p.vx = 0; }
  if (p.x > level.width - PLAYER_W) { p.x = level.width - PLAYER_W; p.vx = 0; }

  // --- hazards: saws ---
  for (const s of run.saws) {
    if (s.axis === 'x') {
      s.x += s.dir * s.speed * dt;
      if (s.x > s.max) { s.x = s.max; s.dir = -1; }
      if (s.x < s.min) { s.x = s.min; s.dir = 1; }
    } else {
      s.y += s.dir * s.speed * dt;
      if (s.y > s.max) { s.y = s.max; s.dir = -1; }
      if (s.y < s.min) { s.y = s.min; s.dir = 1; }
    }
    if (circleAabb(s.x, s.y, SAW_RADIUS, p.x + 1, p.y + 1, PLAYER_W - 2, PLAYER_H - 2)) {
      die(run, 'saw');
      return run;
    }
  }

  // --- hazards: crushers (cycle + slam) ---
  for (const c of run.crushers) {
    c.t += dt;
    const tt = c.t % CRUSHER_CYCLE;
    let acc = 0, phase = 'up', phaseT = 0;
    for (const ph of CRUSHER_PHASES) {
      if (tt < acc + ph.dur) { phase = ph.name; phaseT = tt - acc; break; }
      acc += ph.dur;
    }
    if (phase !== c.phase) {
      if (phase === 'slam') run.events.push({ type: 'crusherSlam', x: c.x + CRUSHER_W / 2, y: c.y });
      c.phase = phase;
    }
    c.phaseT = phaseT;
    const restY = crusherRestY(level, c), slamY = crusherSlamY(level, c);
    if (phase === 'up' || phase === 'telegraph') c.y = restY;
    else if (phase === 'slam') {
      const k = phaseT / 0.12;
      c.y = restY + (slamY - restY) * k * k; // ease-in: the slam accelerates
    } else if (phase === 'down') c.y = slamY;
    else { // retract, ease-out back to rest
      const k = phaseT / 0.55;
      c.y = slamY + (restY - slamY) * (1 - (1 - k) * (1 - k));
    }
    if (aabbOverlap(p.x + 2, p.y + 2, PLAYER_W - 4, PLAYER_H - 4, c.x, c.y, CRUSHER_W, CRUSHER_H)) {
      die(run, 'crusher');
      return run;
    }
  }

  // --- hazards: spikes (inset kill rect — the triangle, not the tile) ---
  for (const sp of level.spikes) {
    const kx = sp.x + 7, kw = TILE - 14, kh = 24;
    const ky = sp.dir === 'up' ? sp.y + TILE - kh : sp.y;
    if (aabbOverlap(p.x + 2, p.y + 2, PLAYER_W - 4, PLAYER_H - 4, kx, ky, kw, kh)) {
      die(run, 'spike');
      return run;
    }
  }

  // --- out of bounds (fell through a gap / flew out the top) ---
  if (p.y > level.height + 80 || p.y + PLAYER_H < -80) {
    die(run, 'void');
    return run;
  }

  // --- orbs ---
  for (const o of run.orbs) {
    if (o.taken) continue;
    const pcx = p.x + PLAYER_W / 2, pcy = p.y + PLAYER_H / 2;
    if (circleAabb(o.x, o.y, ORB_RADIUS + 8, p.x, p.y, PLAYER_W, PLAYER_H)) {
      o.taken = true;
      run.orbsGot++;
      run.score += ORB_SCORE;
      run.events.push({ type: 'orb', x: o.x, y: o.y, orbs: run.orbsGot });
    }
    void pcx; void pcy;
  }

  // --- checkpoints ---
  for (const k of run.checkpoints) {
    if (k.active) continue;
    if (aabbOverlap(p.x, p.y, PLAYER_W, PLAYER_H, k.x - 18, k.y - 18, 36, 36)) {
      k.active = true;
      run.lastCheckpoint = k;
      run.events.push({ type: 'checkpoint', x: k.x, y: k.y });
    }
  }

  // --- exit: a full-height portal column — crossing the exit column
  // at ANY height wins (a player flipping over the exit still
  // finishes; nobody can stalemate against the end wall past it). ---
  if (p.x + PLAYER_W > run.exit.x - 20 && p.x < run.exit.x + 20) {
    run.done = true;
    run.won = true;
    const timeBonus = Math.max(0, Math.round((level.par - run.time) * 15));
    const flawless = run.deaths === 0 ? 250 : 0;
    run.score += timeBonus + flawless;
    run.events.push({ type: 'exit', time: run.time, score: run.score, timeBonus, flawless });
  }
  return run;
}

export function drainEvents(run) {
  const evs = run.events;
  run.events = [];
  return evs;
}

// Deep-clone a run for the lookahead planner. The parsed level is
// shared (immutable); all mutable state is copied.
export function cloneRun(run) {
  return {
    level: run.level, levelId: run.levelId,
    player: { ...run.player },
    orbs: run.orbs.map((o) => ({ ...o })),
    checkpoints: run.checkpoints.map((k) => ({ ...k, respawn: k.respawn })),
    saws: run.saws.map((s) => ({ ...s })),
    crushers: run.crushers.map((c) => ({ ...c })),
    exit: { ...run.exit },
    lastCheckpoint: run.lastCheckpoint ? { ...run.lastCheckpoint, respawn: run.lastCheckpoint.respawn } : null,
    deaths: run.deaths, time: run.time, score: run.score, orbsGot: run.orbsGot,
    dead: run.dead, deadTimer: run.deadTimer, done: run.done, won: run.won,
    flipBuffer: run.flipBuffer,
    events: [],
  };
}

// ---------------------------------------------------------------- policies
// A policy is a function (run, stepIndex, dt) => {move, flip} used by
// simulateRun and by the decision bot's rollouts. All policies play
// through the same public stepRun + input hooks as a human.
export function stationaryPolicy() {
  return { move: 0, flip: false };
}

export function createRandomBot(seed = 1234) {
  const rng = mulberry32(seed);
  let nextFlipIn = 0.3 + rng() * 0.9;
  return {
    input(run, dt) {
      nextFlipIn -= dt;
      let flip = false;
      if (nextFlipIn <= 0) { flip = true; nextFlipIn = 0.2 + rng() * 1.0; }
      return { move: 1, flip };
    },
  };
}

// Same hold-right + flip-at-random bot, but with an explicit flip
// interval — used by the multi-rate anti-slop check (fast 0.1–0.6s,
// canonical 0.2–1.2s, slow 0.8–2.5s). A level that only dies to one
// flip rate is not done: the masher must lose at every rate.
export function createRandomBotAtRate(min, max, seed) {
  const rng = mulberry32(seed);
  let nextFlipIn = min + rng() * (max - min);
  return {
    input(run, dt) {
      nextFlipIn -= dt;
      let flip = false;
      if (nextFlipIn <= 0) { flip = true; nextFlipIn = min + rng() * (max - min); }
      return { move: 1, flip };
    },
  };
}

// The decision bot: a lookahead planner. Every few ticks it clones the
// run and forward-simulates a small set of flip policies over a ~1.1s
// horizon, then plays the first action of the best-scoring rollout.
// The decisions are real timing decisions — the planner only flips
// when the rollout shows that holding right dies and flipping lives.
const PLANNER_HORIZON_STEPS = 180; // 3.0s (~21 tiles) — long enough to see the consequence of an early flip (the next hazard past the landing), so the planner doesn't flip into a hazard it can't see yet; and long enough that a slow policy cannot dodge a hazard by not reaching it in time
function rolloutPolicy(kind) {
  // Delayed flips: "hold for N steps, then flip". The greedy planner
  // flips as soon as flipping-now scores even slightly better than
  // holding, so without a delayed option it flips too early and lands
  // on the hazard past the safe patch. These give it the option to
  // wait for the right flip point (the replan then flips back after
  // landing on the safe patch).
  const delay = kind.startsWith('flipIn') ? parseInt(kind.slice(6), 10) : 0;
  return (sim, step) => {
    switch (kind) {
      case 'hold': return { move: 1, flip: false };
      case 'flipNow': return { move: 1, flip: step === 0 };
      // Flip, then flip back the first moment the player is grounded
      // again (a full flip with a return — the crossing move).
      case 'flipBack': return { move: 1, flip: step === 0 || (step > 18 && sim.player.grounded) };
      case 'wait': return step < 24 ? { move: 0, flip: false } : { move: 1, flip: false };
      default:
        if (kind.startsWith('flipIn')) return { move: 1, flip: step === delay };
        return { move: 1, flip: false };
    }
  };
}
const PLANNER_POLICIES = ['hold', 'flipNow', 'flipBack', 'wait', 'flipIn12', 'flipIn24', 'flipIn36', 'flipIn48', 'flipIn60', 'flipIn72', 'flipIn84', 'flipIn96'];

// Score a rollout RELATIVE to where it started: progress made during
// the rollout is what matters, not the absolute x (an absolute score
// makes "wait forever" beat "die further along" once the run is far
// in — the planner would stall instead of pushing on). A death costs
// 2000 — enough that a safe path always beats a dying one over the
// same distance, but small enough that dying further along still
// beats stalling: dying and respawning at a checkpoint is part of
// the game, stalling forever is not.
function scoreRollout(sim, startX, startOrbs, startDeaths) {
  const deaths = sim.deaths - startDeaths; // deaths DURING the rollout only
  let s = (sim.player.x - startX) * 10 + (sim.orbsGot - startOrbs) * 300 - deaths * 2000;
  if (sim.won) s += 100000;
  if (!sim.player.grounded) s -= 5; // tiny preference for settled states
  // Anti-stall: a rollout that barely moves must never beat pushing on.
  // (Without this, "wait" wins by moving slowly enough not to reach
  // the hazard inside the horizon, and the bot stalls forever.)
  if (sim.player.x - startX < 80) s -= 5000;
  return s;
}

export function createDecisionBot() {
  // The bot COMMITS to a chosen plan for its full horizon. Replanning
  // every tick breaks delayed flips: the delay restarts on every replan
  // and never counts down, so the bot stalls holding forever. Committing
  // is exact, not approximate — the rollout is deterministic, and the
  // policy is a closed-loop function of the sim state, so executing the
  // same policy in the real run reproduces the rollout tick for tick.
  // One exception: once the plan's flip has fired and the player lands
  // on the other surface, the plan ends and the bot replans — the next
  // move (usually the flip-back) is a fresh decision, not part of the
  // old plan. Without this the bot rides the ceiling into the next
  // hazard instead of flipping back.
  let plan = null; // { kind, step, flipped }
  let wasGrounded = true;
  return {
    input(run, dt) {
      if (run.dead || run.done) { plan = null; return { move: 0, flip: false }; }
      const landed = run.player.grounded && !wasGrounded;
      wasGrounded = run.player.grounded;
      if (plan && landed && plan.flipped) plan = null;
      if (!plan) {
        let best = null, bestScore = -Infinity;
        const startX = run.player.x, startOrbs = run.orbsGot, startDeaths = run.deaths;
        for (const kind of PLANNER_POLICIES) {
          const sim = cloneRun(run);
          const policy = rolloutPolicy(kind);
          // Stop at the first death: stepping past it would respawn the
          // sim at the checkpoint and its final x would be the respawn
          // point, not the furthest point reached — which makes later
          // deaths score better than early ones and lets "wait" win by
          // dying last instead of by surviving.
          for (let step = 0; step < PLANNER_HORIZON_STEPS && !sim.won && !sim.dead; step++) {
            stepRun(sim, policy(sim, step), DT);
          }
          const sc = scoreRollout(sim, startX, startOrbs, startDeaths);
          if (sc > bestScore) { bestScore = sc; best = kind; }
        }
        plan = { kind: best, step: 0, flipped: false };
      }
      const action = rolloutPolicy(plan.kind)(run, plan.step);
      if (action.flip) plan.flipped = true;
      plan.step++;
      if (plan.step >= PLANNER_HORIZON_STEPS) plan = null;
      return action;
    },
  };
}

// Play a whole level through a policy factory. Returns the run summary.
export function simulateRun(levelId, policyFactory, opts = {}) {
  const maxSeconds = opts.maxSeconds || 150;
  const run = createRun(levelId);
  const policy = policyFactory();
  const maxSteps = Math.floor(maxSeconds / DT);
  let steps = 0;
  while (!run.done && steps < maxSteps) {
    const input = policy.input ? policy.input(run, DT) : policy(run, DT);
    stepRun(run, input, DT);
    steps++;
  }
  return {
    levelId, won: run.won, done: run.done, time: run.time,
    deaths: run.deaths, orbs: run.orbsGot, orbsTotal: run.orbs.length,
    score: run.score, steps, reason: run.won ? 'exit' : (steps >= maxSteps ? 'timeout' : 'running'),
  };
}

// ---------------------------------------------------------------- save
export function defaultSave() {
  return { version: SAVE_VERSION, best: {}, unlocked: 1, settings: { muted: false, shake: 1 } };
}
export function serializeSave(save) { return JSON.stringify(save); }
export function parseSave(text) {
  try {
    const s = JSON.parse(text);
    if (!s || typeof s !== 'object' || s.version !== SAVE_VERSION) return defaultSave();
    const out = defaultSave();
    if (s.best && typeof s.best === 'object') {
      for (const [k, v] of Object.entries(s.best)) {
        if (v && typeof v.time === 'number' && typeof v.score === 'number') out.best[k] = { time: v.time, score: v.score };
      }
    }
    if (typeof s.unlocked === 'number') out.unlocked = clamp(Math.floor(s.unlocked), 1, LEVELS.length);
    if (s.settings && typeof s.settings === 'object') {
      if (typeof s.settings.muted === 'boolean') out.settings.muted = s.settings.muted;
      if (typeof s.settings.shake === 'number') out.settings.shake = clamp(s.settings.shake, 0, 1);
    }
    return out;
  } catch { return defaultSave(); }
}
export function recordBest(save, levelId, time, score) {
  const prev = save.best[levelId];
  const isBest = !prev || time < prev.time;
  if (isBest) save.best[levelId] = { time, score };
  if (levelId < LEVELS.length) save.unlocked = Math.max(save.unlocked, levelId + 1);
  return isBest;
}
export function isLevelUnlocked(save, levelId) { return levelId <= save.unlocked; }
