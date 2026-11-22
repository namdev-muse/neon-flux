// Neon Flux v0.4.0 — 2D neon gravity-flip platformer (vanilla Canvas 2D).
// Presentation layer: rendering, input, screens, audio, game feel.
// The simulation lives in physics.js (pure, no DOM); this file owns
// everything the player sees and hears. No build step, no Three.js.
//
// M4: Time Attack mode (one countdown clock across all 12 levels,
// orbs worth +2s) + per-level medals + orb records on the level cards.
import {
  VERSION, TILE, ROWS, DT, LEVELS, levelById, parseLevel, createRun,
  stepRun, drainEvents, createDecisionBot, defaultSave, serializeSave,
  parseSave, recordBest, isLevelUnlocked, FEEDBACK, SAVE_VERSION,
  SAW_RADIUS, PLAYER_W, PLAYER_H,
  ORB_TIME_BONUS, TIME_ATTACK_UNLOCK_CLEARS, medalForTime, timeAttackBudget, timeAttackMedal,
  isTimeAttackUnlocked, recordAttackBest,
} from './physics.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
// mm:ss clock for the Time Attack countdown.
const fmtClock = (s) => {
  const t = Math.max(0, Math.ceil(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const medalLabel = (m) => (m === 'gold' ? 'Gold' : m === 'silver' ? 'Silver' : 'Bronze');

// ---------------------------------------------------------------- palette
const COL = {
  bg: '#0b0b26', bg2: '#12123a', grid: 'rgba(139,92,246,0.13)',
  player: '#22d3ee', playerCore: '#a5f3fc', trail: 'rgba(34,211,238,0.35)',
  hazard: '#f472b6', hazardCore: '#fbcfe8', saw: '#fb7185',
  orb: '#fbbf24', orbCore: '#fef3c7', checkpoint: '#a78bfa',
  exit: '#34d399', exitCore: '#a7f3d0', crusher: '#fbbf24',
  text: '#e2e8f0', dim: '#94a3b8',
};

// ---------------------------------------------------------------- save
const SAVE_KEY = 'neon-flux-save-v1';
let save = defaultSave();
try {
  const raw = localStorage.getItem(SAVE_KEY);
  if (raw) save = parseSave(raw);
} catch { save = defaultSave(); }
function persistSave() {
  try { localStorage.setItem(SAVE_KEY, serializeSave(save)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- audio
let audioCtx = null, masterGain = null, musicGain = null, musicTimer = null;
let muted = !!save.settings.muted;
function ensureAudio() {
  if (audioCtx) { if (audioCtx.state === 'suspended') audioCtx.resume(); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : 0.5;
    masterGain.connect(audioCtx.destination);
    musicGain = audioCtx.createGain();
    musicGain.gain.value = 0.16;
    musicGain.connect(masterGain);
  } catch { audioCtx = null; }
}
function tone({ freq = 440, freqEnd = null, dur = 0.1, type = 'square', vol = 0.2, when = 0 }) {
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime + when;
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (freqEnd !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(masterGain);
  o.start(t0); o.stop(t0 + dur + 0.02);
}
function noise({ dur = 0.15, vol = 0.25, freq = 1200, when = 0 }) {
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime + when;
  const len = Math.max(1, Math.floor(audioCtx.sampleRate * dur));
  const buf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = audioCtx.createBufferSource(); src.buffer = buf;
  const f = audioCtx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = 0.8;
  const g = audioCtx.createGain(); g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  src.connect(f); f.connect(g); g.connect(masterGain);
  src.start(t0);
}
const SFX = {
  flip() { tone({ freq: 320, freqEnd: 880, dur: 0.14, type: 'sine', vol: 0.22 }); noise({ dur: 0.08, vol: 0.08, freq: 2400 }); },
  orb(combo = 1) {
    // Pitch ladder: consecutive orbs within the combo window climb.
    const m = 1 + Math.min(combo - 1, 7) * 0.06;
    tone({ freq: 880 * m, dur: 0.07, type: 'sine', vol: 0.18 });
    tone({ freq: 1318 * m, dur: 0.1, type: 'sine', vol: 0.14, when: 0.05 });
  },
  death() { noise({ dur: 0.25, vol: 0.3, freq: 900 }); tone({ freq: 220, freqEnd: 55, dur: 0.3, type: 'sawtooth', vol: 0.2 }); },
  respawn() { tone({ freq: 392, dur: 0.09, type: 'sine', vol: 0.14 }); tone({ freq: 587, dur: 0.12, type: 'sine', vol: 0.12, when: 0.07 }); },
  nearMiss() { noise({ dur: 0.18, vol: 0.12, freq: 3200 }); tone({ freq: 1200, freqEnd: 1800, dur: 0.12, type: 'sine', vol: 0.06 }); },
  checkpoint() { tone({ freq: 523, dur: 0.09, type: 'triangle', vol: 0.18 }); tone({ freq: 784, dur: 0.12, type: 'triangle', vol: 0.18, when: 0.08 }); },
  exit() { [523, 659, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.14, type: 'triangle', vol: 0.18, when: i * 0.09 })); },
  slam() { tone({ freq: 140, freqEnd: 60, dur: 0.12, type: 'sine', vol: 0.25 }); noise({ dur: 0.08, vol: 0.12, freq: 500 }); },
  click() { tone({ freq: 660, dur: 0.05, type: 'square', vol: 0.1 }); },
  hover() { tone({ freq: 990, dur: 0.03, type: 'sine', vol: 0.05 }); },
  land() { noise({ dur: 0.05, vol: 0.06, freq: 700 }); },
  timeUp() { [392, 311, 233, 175].forEach((f, i) => tone({ freq: f, dur: 0.22, type: 'triangle', vol: 0.2, when: i * 0.16 })); },
  attackWin() { [523, 659, 784, 1047, 1319].forEach((f, i) => tone({ freq: f, dur: 0.16, type: 'triangle', vol: 0.2, when: i * 0.1 })); },
};
// Simple music loop: a slow minor-key bass pulse + sparse arp + soft pad
// chords + hat ticks, scheduled a bar ahead so it never stutters. Starts
// on first user gesture. Am – F – C – G, one chord per bar.
const MUSIC_BASS = [55, 55, 65.41, 49]; // A1 A1 C2 G1
const MUSIC_ARP = [220, 261.63, 329.63, 440, 329.63, 261.63];
const MUSIC_PADS = [
  [110, 130.81, 164.81], // Am: A2 C3 E3
  [87.31, 130.81, 174.61], // F: F2 C3 F3
  [130.81, 164.81, 196], // C: C3 E3 G3
  [98, 146.83, 196], // G: G2 D3 G3
];
let musicStep = 0;
function padNote(freq, dur) {
  if (!audioCtx || muted) return;
  const t0 = audioCtx.currentTime;
  for (const det of [-4, 4]) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'triangle'; o.frequency.value = freq; o.detune.value = det;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.4);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g); g.connect(musicGain); o.start(t0); o.stop(t0 + dur);
  }
}
function musicTick() {
  if (!audioCtx || muted) return;
  const bar = 0.46; // ~130bpm eighth notes
  const bass = MUSIC_BASS[Math.floor(musicStep / 2) % MUSIC_BASS.length];
  if (musicStep % 2 === 0) {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'triangle'; o.frequency.value = bass;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, audioCtx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + bar * 1.8);
    o.connect(g); g.connect(musicGain); o.start(); o.stop(audioCtx.currentTime + bar * 2);
  }
  if (musicStep % 4 === 2) {
    const f = MUSIC_ARP[(musicStep / 2 | 0) % MUSIC_ARP.length];
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.18, audioCtx.currentTime + 0.03);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + bar);
    o.connect(g); g.connect(musicGain); o.start(); o.stop(audioCtx.currentTime + bar);
  }
  // Pad chord on each bar start (every 8 eighth-notes).
  if (musicStep % 8 === 0) {
    const chord = MUSIC_PADS[(musicStep / 8 | 0) % MUSIC_PADS.length];
    for (const f of chord) padNote(f, bar * 8);
  }
  // Hat tick on the offbeats, only while actually playing a level.
  if (musicStep % 2 === 1 && phase === 'playing') {
    noise({ dur: 0.03, vol: 0.05, freq: 6000 });
  }
  musicStep++;
}
function startMusic() {
  ensureAudio();
  if (!audioCtx || musicTimer) return;
  musicTimer = setInterval(musicTick, 460);
}
function setMuted(m) {
  muted = !!m;
  save.settings.muted = muted;
  persistSave();
  if (masterGain) masterGain.gain.value = muted ? 0 : 0.5;
  updateMuteLabels();
}
function setFlash(on) {
  save.settings.flash = !!on;
  persistSave();
  if (!on) flashT = 0; // toggling off clears any flash already on screen
  updateFlashLabel();
}
function updateFlashLabel() {
  const el = $('btn-flash-settings');
  if (el) el.textContent = save.settings.flash === false ? 'Flashing: Off' : 'Flashing: On';
}

// ---------------------------------------------------------------- canvas
const canvas = $('game');
const ctx = canvas.getContext('2d');
let viewW = 0, viewH = 0, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  viewW = window.innerWidth; viewH = window.innerHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  canvas.style.width = viewW + 'px';
  canvas.style.height = viewH + 'px';
}
window.addEventListener('resize', resize);
resize();
// Camera: the playfield fills the screen below a reserved HUD strip
// (so the HUD never covers the ceiling row). Width follows aspect ratio.
// World -> screen: sx = (wx - camX) * scale + shakeX,
// sy = HUD_H + wy * scale + shakeY.
// The camera follows with velocity lookahead (it leans into the run
// direction) and smooths toward its target instead of snapping, so the
// view glides; a flip fires a short zoom pulse (visual only — the rig
// never moves colliders).
const HUD_H = 56;
let camX = 0, camScale = 1, camScaleBase = 1, zoomT = 0, camSnap = true;
function computeCamera(dt) {
  camScaleBase = (viewH - HUD_H) / (ROWS * TILE);
  // 10% zoom pulse, slow decay: the 7% / 0.83s pulse DID render
  // (camScale measured 1.27 vs 1.19 base, ceiling spikes shifted ~44px
  // in pixels) but a still-frame comparison kept missing it — near the
  // top-left pivot the shift is tiny, and 0.2–0.4s of capture latency
  // ate half the pulse. Bigger + longer so the whoosh reads in motion
  // AND in a frozen frame.
  camScale = camScaleBase * (1 + 0.10 * zoomT);
  const viewWorldW = viewW / camScaleBase;
  // Follow the active run — the game run, or the attract demo in the menu.
  const active = run || demoRun;
  const levelW = active ? active.level.width : 960;
  const look = active ? clamp(active.player.vx * 0.35, -140, 140) : 0;
  const target = active ? active.player.x + 12 + look - viewWorldW * 0.42 : 0;
  const clamped = clamp(target, 0, Math.max(0, levelW - viewWorldW));
  if (levelW <= viewWorldW) { camX = (levelW - viewWorldW) / 2; camSnap = false; return; }
  if (camSnap) { camX = clamped; camSnap = false; return; }
  // Critically-damped-ish smoothing: fast enough to keep the player on
  // screen, slow enough to read as a glide (~90ms time constant).
  const k = 1 - Math.exp(-11 * Math.max(dt, 0.001));
  camX += (clamped - camX) * k;
}
function wx2sx(wx) { return (wx - camX) * camScale + shakeX; }
function wy2sy(wy) { return HUD_H + wy * camScale + shakeY; }
function worldToScreen(wx, wy) {
  return { x: wx2sx(wx), y: wy2sy(wy) };
}
function playerScreenPos() {
  if (!run) return null;
  const p = run.player;
  const s = worldToScreen(p.x + 12, p.y + 16);
  return { x: s.x, y: s.y, w: 24 * camScale, h: 32 * camScale };
}

// ---------------------------------------------------------------- feel
let trauma = 0, shakeX = 0, shakeY = 0, hitStopT = 0, slowMoT = 0, timeScale = 1;
let flashT = 0, flashColor = '255,255,255';
let stretchT = 0, squashT = 0; // squash & stretch timers (flip / landing)
let orbCombo = 0, lastOrbAt = 0, nearMisses = 0, lastNearMissAt = -10;
function addTrauma(a) { trauma = Math.min(1, trauma + a * (save.settings.shake ?? 1)); }
function doHitStop(s) { hitStopT = Math.max(hitStopT, s); }
function doSlowMo(s) { slowMoT = Math.max(slowMoT, s); }
// Flashes honour the reduce-flashing toggle (default on); with it off,
// flash() is a no-op and no event leaves a flash on screen.
function flash(color, t = 0.18) {
  if (save.settings.flash === false) return;
  flashColor = color; flashT = Math.max(flashT, t);
}
function updateFeel(dt) {
  if (hitStopT > 0) hitStopT -= dt;
  if (slowMoT > 0) { slowMoT -= dt; timeScale = 0.3; } else timeScale = 1;
  // Trauma decays in REAL time so the shake keeps settling during
  // hit-stop instead of freezing the camera off-centre.
  trauma = Math.max(0, trauma - dt * 1.6);
  const sh = trauma * trauma * 14;
  shakeX = (Math.random() * 2 - 1) * sh;
  shakeY = (Math.random() * 2 - 1) * sh;
  if (flashT > 0) flashT -= dt;
  if (zoomT > 0) zoomT = Math.max(0, zoomT - dt * 0.8); // ~1.25s pulse: the 0.83s pulse was half-gone by capture time
  if (stretchT > 0) stretchT = Math.max(0, stretchT - dt);
  if (squashT > 0) squashT = Math.max(0, squashT - dt);
}
// Pooled particles (no allocation in the hot loop).
const MAX_PARTICLES = 320;
const particles = [];
for (let i = 0; i < MAX_PARTICLES; i++) particles.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, color: '#fff', grav: 0 });
let pCursor = 0;
function spawnParticle(x, y, vx, vy, life, size, color, grav = 0) {
  const p = particles[pCursor]; pCursor = (pCursor + 1) % MAX_PARTICLES;
  p.alive = true; p.x = x; p.y = y; p.vx = vx; p.vy = vy;
  p.life = life; p.maxLife = life; p.size = size; p.color = color; p.grav = grav;
}
function burst(x, y, n, color, speed = 220, life = 0.6, size = 3) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, s = speed * (0.3 + Math.random() * 0.7);
    spawnParticle(x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.6), size * (0.6 + Math.random() * 0.8), color, 300);
  }
}
function updateParticles(dt) {
  for (const p of particles) {
    if (!p.alive) continue;
    p.life -= dt;
    if (p.life <= 0) { p.alive = false; continue; }
    p.vy += p.grav * dt;
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= Math.exp(-2.2 * dt); p.vy *= Math.exp(-2.2 * dt);
  }
}
// Floating score pops (canvas, world space).
const pops = [];
function addPop(wx, wy, text, color = '#fbbf24') {
  pops.push({ x: wx, y: wy, text, color, life: 0.9, maxLife: 0.9 });
  if (pops.length > 24) pops.shift();
}
function updatePops(dt) {
  for (let i = pops.length - 1; i >= 0; i--) {
    const p = pops[i]; p.life -= dt; p.y -= 34 * dt;
    if (p.life <= 0) pops.splice(i, 1);
  }
}
// Shockwave rings: expanding stroked circles (flip whoosh, checkpoint,
// exit). Short-lived, always decay to nothing — no rest-state leak.
const shockwaves = [];
function spawnShockwave(x, y, color, maxR = 90, life = 0.45, width = 4) {
  shockwaves.push({ x, y, color, maxR, life, maxLife: life, width });
  if (shockwaves.length > 12) shockwaves.shift();
}
function updateShockwaves(dt) {
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    shockwaves[i].life -= dt;
    if (shockwaves[i].life <= 0) shockwaves.splice(i, 1);
  }
}
function drawShockwaves() {
  const s = camScale;
  ctx.save();
  for (const w of shockwaves) {
    const t = 1 - w.life / w.maxLife; // 0 -> 1
    const r = (8 + (w.maxR - 8) * (1 - Math.pow(1 - t, 3))) * s;
    const sx = wx2sx(w.x), sy = wy2sy(w.y);
    // Alpha holds up through the ring's life (sqrt falloff): the linear
    // fade was down to 0.24 by 0.44s, too dim to see in a still frame.
    const a = Math.pow(1 - t, 0.5);
    ctx.globalAlpha = a * 0.9;
    ctx.strokeStyle = w.color;
    ctx.shadowColor = w.color; ctx.shadowBlur = 14;
    ctx.lineWidth = Math.max(1, w.width * s * (1 - t * 0.5));
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2); ctx.stroke();
    // Inner echo ring, half the radius.
    ctx.globalAlpha = a * 0.4;
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.55, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
}
// Player trail (recent positions, for the motion streak).
const trail = [];
function pushTrail(x, y, grav) {
  trail.push({ x, y, grav, life: 0.28 });
  if (trail.length > 26) trail.shift();
}
function updateTrail(dt) {
  for (let i = trail.length - 1; i >= 0; i--) {
    trail[i].life -= dt;
    if (trail[i].life <= 0) trail.splice(i, 1);
  }
}

// ---------------------------------------------------------------- input
const keys = { left: false, right: false };
let flipQueued = false; // edge-triggered: one flip per press
function queueFlip() { flipQueued = true; }
const KEYMAP = {
  ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
};
window.addEventListener('keydown', (e) => {
  if (e.repeat) { if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') e.preventDefault(); return; }
  const dir = KEYMAP[e.code];
  if (dir) { keys[dir] = true; e.preventDefault(); return; }
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    if (phase === 'playing') { ensureAudio(); queueFlip(); }
    else if (phase === 'menu') startLevel(selectedLevel);
    else if (phase === 'complete') nextLevel();
    else if (phase === 'attack') startTimeAttack();
    else if (phase === 'pause') resumeGame();
    return;
  }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (phase === 'playing') pauseGame();
    else if (phase === 'pause') resumeGame();
    return;
  }
  if (e.code === 'KeyM') { setMuted(!muted); return; }
  if (e.code === 'KeyR') {
    if (phase === 'playing' || phase === 'pause') restartLevel();
    return;
  }
  if (e.code === 'Enter') {
    if (phase === 'menu') startLevel(selectedLevel);
    else if (phase === 'complete') nextLevel();
    else if (phase === 'attack') startTimeAttack();
    else if (phase === 'pause') resumeGame();
    else if (phase === 'levels') startLevel(selectedLevel);
    return;
  }
});
window.addEventListener('keyup', (e) => {
  const dir = KEYMAP[e.code];
  if (dir) keys[dir] = false;
});
window.addEventListener('blur', () => { keys.left = false; keys.right = false; });
// Touch: left/right hold zones + big FLIP button (bound in index.html).
function bindHold(el, on, off) {
  const start = (e) => { e.preventDefault(); ensureAudio(); on(); };
  const end = (e) => { e.preventDefault(); off(); };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('pointerleave', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- screens
// Screen stack (push/pop, not boolean soup). The canvas keeps rendering
// underneath; overlays are DOM panels with staggered pop-in.
let phase = 'menu'; // menu | levels | howto | settings | playing | pause | complete | attack
const screenStack = [];
const screenEls = {
  menu: $('menu'), levels: $('levels'), howto: $('howto'), settings: $('settings'),
  pause: $('pause'), complete: $('complete'), attack: $('attack'), hud: $('hud'), touch: $('touch'),
};
function showScreen(id) {
  const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  for (const [key, el] of Object.entries(screenEls)) {
    if (!el) continue;
    const show = key === id || (id === 'playing' && (key === 'hud' || (key === 'touch' && isTouch)));
    el.classList.toggle('hidden', !show);
    if (show && el.classList.contains('overlay')) {
      // Staggered overshoot pop on the panel's children.
      const kids = el.querySelectorAll('.panel > *');
      kids.forEach((k, i) => {
        k.style.animation = 'none'; void k.offsetWidth;
        k.style.animation = `pop-in 0.45s cubic-bezier(0.2, 1.4, 0.4, 1) ${i * 0.05}s both`;
      });
    }
  }
  // Focus the primary control of the new screen (one focused control).
  const focusMap = { menu: 'btn-play', levels: 'btn-levels-back', howto: 'btn-howto-back', settings: 'btn-settings-back', pause: 'btn-resume', complete: 'btn-next', attack: 'btn-attack-retry' };
  const f = focusMap[id] && $(focusMap[id]);
  if (f) f.focus({ preventScroll: true });
}
function pushScreen(id) { screenStack.push(phase); phase = id; showScreen(id); }
function popScreen() {
  const prev = screenStack.pop() || 'menu';
  phase = prev; showScreen(prev);
  if (phase === 'menu') startAttract();
  if (phase === 'playing') resumeGame();
}
function goMenu() {
  screenStack.length = 0;
  phase = 'menu'; run = null; autopilot = null; attack = null;
  showScreen('menu'); refreshMenuBest(); refreshAttackButton(); startAttract();
}
function updateMuteLabels() {
  const label = muted ? 'Sound: Off' : 'Sound: On';
  for (const id of ['btn-mute-menu', 'btn-mute-hud', 'btn-mute-settings']) {
    const el = $(id); if (el) el.textContent = label;
  }
}
// Button juice: hover tick + scale pop + press feedback on every button.
document.querySelectorAll('button').forEach((b) => {
  b.addEventListener('mouseenter', () => { if (!muted) SFX.hover(); });
  b.addEventListener('click', () => { ensureAudio(); SFX.click(); startMusic(); });
});

// ---------------------------------------------------------------- game state
let run = null;           // active physics run (or the attract demo run)
let levelId = 1, selectedLevel = 1;
let autopilot = null;     // decision-bot driver (attract mode + __flux.autopilot)
let demoRun = null;       // attract-mode run (decision bot on level 1)
let demoBot = null;
// Time Attack (M4): one countdown clock across all 12 levels, orbs
// worth +2s. null outside the mode. idx is the 0-based level index
// currently being played; totalTime/deaths accumulate finished levels.
let attack = null;
let lastTime = 0, fpsEma = 60, accumulator = 0;
function currentLevel() { return run ? run.level : null; }
function levelDef(id) { return levelById(id); }

function startLevel(id, opts = {}) {
  ensureAudio(); startMusic();
  levelId = id; selectedLevel = id;
  run = createRun(id);
  autopilot = null; demoRun = null;
  if (!opts.keepAttack) attack = null;
  trail.length = 0; pops.length = 0; shockwaves.length = 0;
  for (const p of particles) p.alive = false;
  trauma = 0; hitStopT = 0; slowMoT = 0; timeScale = 1;
  zoomT = 0; stretchT = 0; squashT = 0;
  orbCombo = 0; lastOrbAt = 0; nearMisses = 0; lastNearMissAt = -10;
  camSnap = true;
  screenStack.length = 0;
  phase = 'playing';
  showScreen('playing');
  updateHUD(true);
  const def = levelDef(id);
  toast(def ? `${def.name} — ${def.hint}` : '', 3600);
}
function restartLevel() { if (run) startLevel(run.levelId, { keepAttack: !!attack }); }
function nextLevel() {
  if (!run) return;
  // Time Attack continues through its own sequence, not the unlock chain.
  if (attack) {
    attack.idx++;
    if (attack.idx >= LEVELS.length) { endTimeAttack(true); return; }
    startLevel(LEVELS[attack.idx].id, { keepAttack: true });
    return;
  }
  const next = run.levelId + 1;
  if (next <= LEVELS.length && isLevelUnlocked(save, next)) startLevel(next);
  else goMenu();
}
// --- Time Attack (M4) -------------------------------------------------
// Why this mode: the flip is a speed skill — every flip-timing
// decision is already a time decision. Racing one clock across all 12
// levels turns the whole game into that decision, and orbs become the
// fuel (+2s each), so the orb economy finally matters: grabbing an orb
// under pressure is worth the risk, skipping one is a real choice.
// The gate is clearing 3 levels first ("prove you can flip").
function startTimeAttack() {
  if (!isTimeAttackUnlocked(save)) return;
  ensureAudio(); startMusic();
  attack = { idx: 0, timeLeft: timeAttackBudget(), totalTime: 0, orbs: 0, deaths: 0 };
  startLevel(LEVELS[0].id, { keepAttack: true });
  toast(`Time Attack — ${fmtClock(attack.timeLeft)} on the clock. Orbs add +${ORB_TIME_BONUS}s.`, 4200);
}
function endTimeAttack(finished) {
  if (!attack) return;
  // Totals come from attack as-is: callers bank the current level's
  // time/deaths first (completeLevel for a finish, the timeout branch
  // for a mid-level clock-out), so nothing is ever counted twice.
  const totalTime = attack.totalTime;
  const deaths = attack.deaths;
  const levels = finished ? LEVELS.length : attack.idx;
  const medal = finished ? timeAttackMedal(attack.timeLeft) : null;
  const result = { finished, reachedLevel: finished ? LEVELS.length : attack.idx + 1, timeLeft: attack.timeLeft, totalTime, orbs: attack.orbs, deaths, levels, medal };
  const isBest = recordAttackBest(save, result);
  persistSave();
  if (finished) SFX.attackWin(); else SFX.timeUp();
  if (finished) flash('52,211,153', 0.25);
  else flash('244,114,182', 0.3);
  attack = null;
  phase = 'attack';
  $('attack-title').textContent = finished ? `Time Attack — ${medalLabel(medal)}!` : 'Time Up!';
  $('attack-sub').textContent = finished
    ? (isBest ? 'New best Time Attack!' : `Best ${fmtClock(save.attack.time)} · ${medalLabel(save.attack.medal)}`)
    : `The clock ran out on level ${result.reachedLevel} — ${LEVELS[result.reachedLevel - 1].name}.`;
  $('attack-time').textContent = finished ? `Total ${fmtClock(totalTime)}` : `Lasted ${fmtClock(totalTime)}`;
  $('attack-left').textContent = finished ? `${fmtClock(result.timeLeft)} left on the clock` : `${fmtClock(Math.max(0, result.timeLeft))} left`;
  $('attack-orbs').textContent = `◈ ${result.orbs} orbs (+${ORB_TIME_BONUS}s each)`;
  $('attack-deaths').textContent = `☠ ${deaths} deaths · ${levels}/12 levels`;
  showScreen('attack');
  updateHUD(true);
}
function pauseGame() {
  if (phase !== 'playing') return;
  pushScreen('pause');
}
function resumeGame() {
  if (phase !== 'pause') return;
  popScreen();
  phase = 'playing'; showScreen('playing');
}
function quitToMenu() { goMenu(); }
function completeLevel() {
  const def = run.level;
  const time = run.time;
  const score = run.score;
  const isBest = recordBest(save, run.levelId, time, score, run.orbsGot);
  persistSave();
  // Time Attack: bank this level's time/deaths, then either roll on
  // to the next level in the sequence or finish the run at level 12.
  if (attack) {
    attack.totalTime += time;
    attack.deaths += run.deaths;
    if (attack.idx >= LEVELS.length - 1) { endTimeAttack(true); return; }
  }
  const medal = medalForTime(run.levelId, time);
  phase = 'complete';
  $('complete-title').textContent = `${def.name} — Clear!`;
  $('complete-time').textContent = attack
    ? `Time ${time.toFixed(2)}s · ⏱ ${fmtClock(attack.timeLeft)} left`
    : `Time ${time.toFixed(2)}s`;
  $('complete-score').textContent = `Score ${score}`;
  $('complete-orbs').textContent = `Orbs ${run.orbsGot}/${run.orbs.length}`;
  $('complete-deaths').textContent = `Deaths ${run.deaths}`;
  $('complete-best').textContent = attack
    ? `${isBest ? 'New best time! · ' : ''}${medalLabel(medal)} medal · Level ${attack.idx + 1}/12`
    : (isBest ? `New best time! · ${medalLabel(medal)} medal` : `Best ${save.best[run.levelId] ? save.best[run.levelId].time.toFixed(2) + 's' : '—'} · ${medalLabel(medal)} medal`);
  const hasNext = attack
    ? true
    : run.levelId + 1 <= LEVELS.length && isLevelUnlocked(save, run.levelId + 1);
  $('btn-next').textContent = hasNext ? 'Next Level' : 'Level Select';
  $('btn-next').style.display = '';
  showScreen('complete');
  updateHUD(true);
}
function startAttract() {
  demoRun = createRun(1);
  demoBot = createDecisionBot();
}
// Attract mode: the decision bot plays level 1 behind the menu, so the
// menu scene is alive (the demo player actually flips and dies).
function stepAttract(dt) {
  if (!demoRun) return;
  const input = demoBot.input(demoRun, DT);
  stepRun(demoRun, input, DT);
  drainEvents(demoRun);
  if (demoRun.done || demoRun.time > 60) startAttract();
}

// Event -> feel: every physics event fires its FEEDBACK tier bundle
// (sound + particles + shake + flash + pop) within the same frame.
function handleEvents(events) {
  if (!run) return;
  const p = run.player;
  for (const e of events) {
    const fb = FEEDBACK[e.type];
    if (fb) addTrauma(fb.trauma);
    switch (e.type) {
      case 'flip':
        SFX.flip();
        burst(p.x + 12, p.y + 16, 10, COL.player, 160, 0.4, 2.5);
        // Big, slow ring: the 90px/0.45s ring never registered in
        // playtest stills. 130px/0.9s reads in a still and in motion —
        // the 0.7s life was caught reliably only on downward flips.
        spawnShockwave(p.x + 12, p.y + 16, COL.player, 130, 0.9, 6);
        zoomT = 1; // camera zoom pulse (visual only)
        stretchT = 0.14; // stretch along the flip axis
        break;
      case 'orb': {
        const now = performance.now();
        orbCombo = (now - lastOrbAt < 1500) ? orbCombo + 1 : 1;
        lastOrbAt = now;
        SFX.orb(orbCombo);
        burst(e.x, e.y, 12, COL.orb, 200, 0.5, 3);
        // Time Attack: orbs ARE the clock — +2s each, and the pop says
        // so. Score still accrues underneath.
        if (attack) {
          attack.timeLeft += ORB_TIME_BONUS;
          attack.orbs++;
          addPop(e.x, e.y - 14, `+${ORB_TIME_BONUS}s`, COL.orb);
        } else {
          addPop(e.x, e.y - 14, orbCombo > 1 ? `+100 ×${orbCombo}` : '+100', COL.orb);
        }
        break;
      }
      case 'checkpoint':
        SFX.checkpoint();
        burst(e.x, e.y, 16, COL.checkpoint, 180, 0.7, 3);
        spawnShockwave(e.x, e.y, COL.checkpoint, 70, 0.5, 3);
        flash('167,139,250', 0.12);
        toast('Checkpoint', 1400);
        break;
      case 'respawn':
        SFX.respawn();
        spawnShockwave(e.x, e.y, COL.player, 60, 0.4, 3);
        flash('34,211,238', 0.1);
        // Snap the camera to the respawn view: after a far death the
        // glide back left the player off-screen for ~0.3s.
        camSnap = true;
        break;
      case 'death':
        SFX.death();
        // The trail piles up at the death spot (slow play stacks 26
        // rects into a near-solid block) and reads as a body — clear it.
        trail.length = 0;
        burst(p.x + 12, p.y + 16, 48, COL.player, 320, 0.8, 4);
        burst(p.x + 12, p.y + 16, 24, COL.hazard, 240, 0.7, 3);
        doHitStop(FEEDBACK.death.hitStop);
        doSlowMo(0.55);
        flash('244,114,182', 0.22);
        break;
      case 'exit':
        SFX.exit();
        burst(p.x + 12, p.y + 16, 40, COL.exit, 300, 1.0, 4);
        spawnShockwave(p.x + 12, p.y + 16, COL.exit, 140, 0.7, 5);
        flash('52,211,153', 0.25);
        break;
      case 'crusherSlam':
        SFX.slam();
        addTrauma(FEEDBACK.crusherSlam.trauma);
        // Dust kicked up where the crusher meets its surface.
        burst(e.x, e.y + 36, 10, '#fbbf24', 140, 0.5, 3);
        burst(e.x - 18, e.y + 36, 5, '#94a3b8', 90, 0.4, 2);
        burst(e.x + 18, e.y + 36, 5, '#94a3b8', 90, 0.4, 2);
        break;
      default: break;
    }
  }
}

// ---------------------------------------------------------------- HUD
let hudCache = '';
function updateHUD(force = false) {
  if (!run) return;
  const def = run.level;
  const best = save.best[run.levelId];
  const text = [
    def.name, run.orbsGot, run.orbs.length, run.score,
    run.time.toFixed(1), run.deaths, best ? best.time.toFixed(2) : '—',
    attack ? attack.timeLeft.toFixed(1) : '',
  ].join('|');
  if (!force && text === hudCache) return;
  hudCache = text;
  $('hud-level').textContent = attack ? `TA ${attack.idx + 1}/12 · ${def.name}` : `${def.id} · ${def.name}`;
  // Time Attack: the HUD clock is the countdown, not the level time.
  // It turns red under 30s — the "hurry" read at a glance.
  const timeEl = $('hud-time');
  if (attack) {
    timeEl.textContent = `⏱ ${fmtClock(attack.timeLeft)}`;
    timeEl.classList.toggle('low', attack.timeLeft < 30);
  } else {
    timeEl.textContent = `${run.time.toFixed(1)}s`;
    timeEl.classList.remove('low');
  }
  $('hud-orbs').textContent = `◈ ${run.orbsGot}/${run.orbs.length}`;
  $('hud-score').textContent = `Score ${run.score}`;
  $('hud-deaths').textContent = `☠ ${run.deaths}`;
  $('hud-best').textContent = best ? `Best ${best.time.toFixed(2)}s` : 'Best —';
}
let toastTimer = null;
function toast(text, ms = 2500) {
  const el = $('hud-toast');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('hidden', !text);
  if (toastTimer) clearTimeout(toastTimer);
  if (text) toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}
function refreshMenuBest() {
  const el = $('menu-best');
  if (!el) return;
  const cleared = Object.keys(save.best).length;
  if (cleared === 0) {
    el.textContent = `No runs yet — ${LEVELS.length} levels of spikes, saws and crushers await.`;
    return;
  }
  // Medals are derived from best times, so this line is always honest.
  const medals = { gold: 0, silver: 0, bronze: 0 };
  for (const [id, b] of Object.entries(save.best)) medals[medalForTime(Number(id), b.time)]++;
  let text = `${cleared} of ${LEVELS.length} levels cleared · ${medals.gold} gold, ${medals.silver} silver, ${medals.bronze} bronze.`;
  if (save.attack) text += ` Time Attack best ${fmtClock(save.attack.time)} · ${medalLabel(save.attack.medal)}.`;
  el.textContent = text;
}
// Time Attack button: a locked gate, not a dead button — it says
// exactly what unlocks it and how far along the player is.
function refreshAttackButton() {
  const btn = $('btn-attack');
  if (!btn) return;
  const cleared = Object.keys(save.best).length;
  if (isTimeAttackUnlocked(save)) {
    btn.disabled = false;
    btn.textContent = save.attack
      ? `⏱ Time Attack — best ${fmtClock(save.attack.time)} · ${medalLabel(save.attack.medal)}`
      : '⏱ Time Attack';
  } else {
    btn.disabled = true;
    btn.textContent = `⏱ Time Attack — clear ${TIME_ATTACK_UNLOCK_CLEARS} levels (${cleared}/${TIME_ATTACK_UNLOCK_CLEARS})`;
  }
}
function refreshLevelSelect() {
  const grid = $('level-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const def of LEVELS) {
    const unlocked = isLevelUnlocked(save, def.id);
    const best = save.best[def.id];
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'level-card' + (unlocked ? '' : ' locked');
    card.style.setProperty('--accent', def.accent);
    card.disabled = !unlocked;
    // Medal + orb record on the card: the replay reason, at a glance.
    const medal = best ? `<span class="level-medal medal-${medalForTime(def.id, best.time)}">${medalLabel(medalForTime(def.id, best.time))}</span>` : '';
    const orbPart = best && best.orbs > 0 ? ` · ◈ ${best.orbs}/${parseLevel(def).orbs.length}` : '';
    card.innerHTML = `<span class="level-num">${def.id}</span>`
      + `<span class="level-name">${def.name}</span>`
      + `<span class="level-meta">${unlocked ? (best ? `Best ${best.time.toFixed(2)}s${orbPart} ${medal}` : def.hint) : 'Clear the previous level to unlock'}</span>`;
    card.addEventListener('click', () => { ensureAudio(); startLevel(def.id); });
    card.addEventListener('mouseenter', () => { if (!muted) SFX.hover(); });
    grid.appendChild(card);
  }
}

// ---------------------------------------------------------------- main loop
function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - lastTime) / 1000 || 0.016);
  lastTime = now;
  fpsEma = lerp(fpsEma, 1 / Math.max(rawDt, 1e-4), 0.05);
  // Pause freezes EVERYTHING (sim + juice). The sim already stops in
  // stepGame, but the feel/particle/shockwave updates ran on wall time,
  // so a ring fired just before pausing decayed away behind the pause
  // menu — and Space-then-Pause could never freeze it for a still frame.
  // (Shake offsets are zeroed while paused so the backdrop sits still.)
  if (phase !== 'pause') updateFeel(rawDt);
  else { shakeX = 0; shakeY = 0; }
  const dt = rawDt * timeScale;
  if (hitStopT > 0) { render(); return; } // frozen: render, don't step
  accumulator += dt;
  let steps = 0;
  while (accumulator >= DT && steps < 5) {
    accumulator -= DT; steps++;
    stepGame(DT);
  }
  if (steps === 5) accumulator = 0; // spiral-of-death guard
  if (phase !== 'pause') {
    updateParticles(rawDt);
    updatePops(rawDt);
    updateShockwaves(rawDt);
    updateTrail(rawDt);
    computeCamera(rawDt);
  }
  render();
}
function stepGame(dt) {
  if (phase === 'menu' || phase === 'levels' || phase === 'howto' || phase === 'settings') {
    stepAttract(dt);
    return;
  }
  if (phase !== 'playing' || !run) return;
  let input;
  if (autopilot) {
    input = autopilot.input(run, DT);
  } else {
    const move = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
    input = { move, flip: flipQueued };
    flipQueued = false;
  }
  const wasGrounded = run.player.grounded;
  const px = run.player.x, py = run.player.y;
  stepRun(run, input, DT);
  // Time Attack: the clock runs in fixed sim steps, so it ticks
  // through deaths and slow-mo alike — dying costs clock, pausing
  // does not (stepGame never runs while paused). At zero the run ends.
  if (attack && !run.done) {
    attack.timeLeft -= DT;
    if (attack.timeLeft <= 0) {
      attack.timeLeft = 0;
      // Bank the partial level before ending: endTimeAttack reads the
      // totals as-is, so the run's elapsed time is counted exactly once.
      attack.totalTime += run.time;
      attack.deaths += run.deaths;
      updateHUD(true);
      endTimeAttack(false);
      return;
    }
  }
  const events = drainEvents(run);
  handleEvents(events);
  // Landing dust + squash.
  if (!wasGrounded && run.player.grounded) {
    SFX.land();
    squashT = 0.1;
    burst(run.player.x + 12, run.player.grav === 1 ? run.player.y + 32 : run.player.y, 6, COL.player, 90, 0.35, 2);
  }
  // Near-miss: a saw sweeping within 30–70px of the player (outside the
  // kill radius) without touching earns a whoosh + brief slow-mo — the
  // "that was close" beat. Cooldown 1.2s so a patrolling saw can't
  // strobe it. Presentation-side only; the sim never sees it.
  if (!run.dead && !run.done) {
    const pcx = run.player.x + 12, pcy = run.player.y + 16;
    let closest = Infinity;
    for (const s of run.saws) {
      const d = Math.hypot(s.x - pcx, s.y - pcy);
      if (d < closest) closest = d;
    }
    if (closest > 30 && closest < 70 && run.time - lastNearMissAt > 1.2) {
      lastNearMissAt = run.time;
      nearMisses++;
      SFX.nearMiss();
      doSlowMo(0.22);
      addTrauma(FEEDBACK.nearMiss.trauma);
      addPop(pcx, pcy - 26, 'close!', '#fda4af');
    }
  }
  // No trail while dead: the sim keeps stepping through the death beat
  // with the player frozen at the death point, and an ungated push
  // refilled the trail there — 26 player-sized rects stacking into a
  // solid body that reads as a frozen corpse (v0.3.2 live playtest).
  // The death handler clears the trail once; the push must not refill it.
  if (!run.dead && !run.done) pushTrail(px + 12, py + 16, run.player.grav);
  if (run.done && run.won) completeLevel();
  updateHUD();
}

// ---------------------------------------------------------------- rendering
function render() {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Background: deep-space indigo gradient + violet grid.
  const g = ctx.createLinearGradient(0, 0, 0, viewH);
  g.addColorStop(0, COL.bg2); g.addColorStop(1, COL.bg);
  ctx.fillStyle = g; ctx.fillRect(0, 0, viewW, viewH);
  const level = currentLevel() || (phase === 'menu' || phase === 'levels' || phase === 'howto' || phase === 'settings' ? (demoRun ? demoRun.level : null) : null);
  const activeRun = run || demoRun;
  if (level) {
    // Grid (world-locked, faint).
    ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
    ctx.beginPath();
    const startCol = Math.max(0, Math.floor(camX / TILE) - 1);
    const endCol = Math.min(level.cols, Math.ceil((camX + viewW / camScale) / TILE) + 1);
    for (let c = startCol; c <= endCol; c++) {
      const sx = (c * TILE - camX) * camScale + shakeX;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, viewH);
    }
    for (let r = 0; r <= ROWS; r++) {
      const sy = HUD_H + r * TILE * camScale + shakeY;
      ctx.moveTo(0, sy); ctx.lineTo(viewW, sy);
    }
    ctx.stroke();
    drawLevel(level, activeRun);
  }
  if (activeRun) drawRun(activeRun);
  drawShockwaves();
  drawParticles();
  drawPops();
  // Death / exit flash.
  if (flashT > 0) {
    ctx.fillStyle = `rgba(${flashColor},${(flashT / 0.22 * 0.28).toFixed(3)})`;
    ctx.fillRect(0, 0, viewW, viewH);
  }
  // Vignette.
  const vg = ctx.createRadialGradient(viewW / 2, viewH / 2, Math.min(viewW, viewH) * 0.42, viewW / 2, viewH / 2, Math.max(viewW, viewH) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(4,4,20,0.5)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, viewW, viewH);
}
function drawLevel(level, activeRun) {
  const s = camScale;
  // Solid tiles (floor/ceiling) with emissive rims.
  ctx.fillStyle = '#1e1b4b';
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < level.cols; c++) {
      if (!level.solids[r][c]) continue;
      const sx = wx2sx(c * TILE), sy = wy2sy(r * TILE);
      if (sx < -TILE * s || sx > viewW + TILE * s) continue;
      ctx.fillRect(sx, sy, TILE * s + 1, TILE * s + 1);
    }
  }
  // Rims on the exposed edges (floor top, ceiling bottom).
  ctx.fillStyle = 'rgba(139,92,246,0.55)';
  for (let c = 0; c < level.cols; c++) {
    if (level.solids[ROWS - 1][c] && !level.solids[ROWS - 2][c]) {
      const sx = wx2sx(c * TILE);
      ctx.fillRect(sx, wy2sy((ROWS - 1) * TILE), TILE * s + 1, 2);
    }
    if (level.solids[0][c] && !level.solids[1][c]) {
      const sx = wx2sx(c * TILE);
      ctx.fillRect(sx, wy2sy(TILE) - 2, TILE * s + 1, 2);
    }
  }
  // Spikes: magenta triangles.
  ctx.save();
  ctx.shadowColor = COL.hazard; ctx.shadowBlur = 10;
  for (const sp of level.spikes) {
    const sx = wx2sx(sp.x), sy = wy2sy(sp.y);
    if (sx < -TILE * s || sx > viewW + TILE * s) continue;
    ctx.fillStyle = COL.hazard;
    ctx.beginPath();
    if (sp.dir === 'up') {
      ctx.moveTo(sx, sy + TILE * s); ctx.lineTo(sx + TILE * s / 2, sy + TILE * s - 24 * s); ctx.lineTo(sx + TILE * s, sy + TILE * s);
    } else {
      ctx.moveTo(sx, sy); ctx.lineTo(sx + TILE * s / 2, sy + 24 * s); ctx.lineTo(sx + TILE * s, sy);
    }
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // Orbs: pulsing gold.
  const t = performance.now() / 1000;
  for (const o of (activeRun ? activeRun.orbs : level.orbs)) {
    if (o.taken) continue;
    const sx = wx2sx(o.x), sy = wy2sy(o.y);
    if (sx < -20 || sx > viewW + 20) continue;
    const pulse = 1 + Math.sin(t * 3 + o.x) * 0.15;
    ctx.save();
    ctx.shadowColor = COL.orb; ctx.shadowBlur = 12;
    ctx.fillStyle = COL.orb;
    ctx.beginPath(); ctx.arc(sx, sy, 10 * s * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = COL.orbCore;
    ctx.beginPath(); ctx.arc(sx, sy, 4.5 * s * pulse, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  // Checkpoints: violet beacons (dim until touched).
  for (const k of (activeRun ? activeRun.checkpoints : level.checkpoints)) {
    const sx = wx2sx(k.x), sy = wy2sy(k.y);
    if (sx < -30 || sx > viewW + 30) continue;
    const active = k.active;
    ctx.save();
    ctx.shadowColor = COL.checkpoint; ctx.shadowBlur = active ? 14 : 5;
    ctx.fillStyle = active ? COL.checkpoint : 'rgba(167,139,250,0.35)';
    ctx.beginPath();
    ctx.moveTo(sx, sy - 14 * s); ctx.lineTo(sx + 10 * s, sy); ctx.lineTo(sx, sy + 14 * s); ctx.lineTo(sx - 10 * s, sy);
    ctx.closePath(); ctx.fill();
    if (active) {
      ctx.strokeStyle = 'rgba(167,139,250,0.6)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(sx, sy, (18 + Math.sin(t * 4) * 3) * s, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }
  // Exit portal: vertical bars, pulsing.
  const ex = level.exit;
  const exx = wx2sx(ex.x);
  if (exx > -60 && exx < viewW + 60) {
    ctx.save();
    ctx.shadowColor = COL.exit; ctx.shadowBlur = 18;
    const pulse = 0.7 + Math.sin(t * 4) * 0.3;
    ctx.fillStyle = `rgba(52,211,153,${0.25 + pulse * 0.2})`;
    ctx.fillRect(exx - 20 * s, HUD_H, 40 * s, viewH - HUD_H);
    ctx.fillStyle = COL.exit;
    ctx.fillRect(exx - 3 * s, HUD_H, 6 * s, viewH - HUD_H);
    ctx.fillStyle = COL.exitCore;
    ctx.fillRect(exx - 1 * s, HUD_H, 2 * s, viewH - HUD_H);
    ctx.restore();
  }
  // Crushers: amber blocks with telegraph flash.
  if (activeRun) {
    for (const c of activeRun.crushers) {
      const sx = wx2sx(c.x), sy = wy2sy(c.y);
      const tele = c.phase === 'telegraph';
      ctx.save();
      ctx.shadowColor = COL.crusher; ctx.shadowBlur = tele ? 18 : 8;
      ctx.fillStyle = tele ? '#fde68a' : COL.crusher;
      ctx.fillRect(sx, sy, 40 * s, 36 * s);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(sx, sy + 30 * s, 40 * s, 6 * s);
      ctx.restore();
    }
  }
  // Saws: rotating toothed discs.
  if (activeRun) {
    for (const sw of activeRun.saws) {
      const sx = wx2sx(sw.x), sy = wy2sy(sw.y);
      if (sx < -40 || sx > viewW + 40) continue;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(t * 6);
      ctx.shadowColor = COL.saw; ctx.shadowBlur = 12;
      ctx.fillStyle = COL.saw;
      ctx.beginPath();
      const teeth = 8, R = 15 * s, r2 = 10 * s;
      for (let i = 0; i < teeth * 2; i++) {
        const a = (i / (teeth * 2)) * Math.PI * 2;
        const rr = i % 2 === 0 ? R : r2;
        ctx[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * rr, Math.sin(a) * rr);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#fff1f2';
      ctx.beginPath(); ctx.arc(0, 0, 4 * s, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
  }
}
function drawRun(activeRun) {
  const s = camScale;
  const p = activeRun.player;
  // Trail (motion streak, fades with life).
  for (const tr of trail) {
    const sx = wx2sx(tr.x - 12), sy = wy2sy(tr.y - 16);
    ctx.fillStyle = `rgba(34,211,238,${(tr.life / 0.28 * 0.25).toFixed(3)})`;
    ctx.fillRect(sx, sy, 24 * s, 32 * s);
  }
  // While dead (the death beat) the body is NOT drawn: it burst into
  // particles on death, and a frozen upside-down body hanging on the
  // ceiling reads as a broken respawn. The body returns at the respawn.
  if (activeRun.dead) return;
  // Player: cyan rounded body, core glow, gravity arrow.
  // Squash & stretch: flip stretches along the travel axis, landing
  // squashes — both decay to the exact rest scale (1, 1).
  const px = wx2sx(p.x), py = wy2sy(p.y);
  const pw = 24 * s, ph = 32 * s;
  let sxScale = 1, syScale = 1;
  if (stretchT > 0) {
    const k = stretchT / 0.14;
    syScale = 1 + 0.28 * k; sxScale = 1 - 0.15 * k;
  } else if (squashT > 0) {
    const k = squashT / 0.1;
    syScale = 1 - 0.25 * k; sxScale = 1 + 0.2 * k;
  }
  ctx.save();
  ctx.translate(px + pw / 2, py + ph / 2);
  ctx.scale(sxScale, syScale);
  ctx.translate(-(px + pw / 2), -(py + ph / 2));
  ctx.shadowColor = COL.player; ctx.shadowBlur = 16;
  ctx.fillStyle = COL.player;
  const r = 6 * s;
  ctx.beginPath();
  ctx.moveTo(px + r, py); ctx.lineTo(px + pw - r, py); ctx.quadraticCurveTo(px + pw, py, px + pw, py + r);
  ctx.lineTo(px + pw, py + ph - r); ctx.quadraticCurveTo(px + pw, py + ph, px + pw - r, py + ph);
  ctx.lineTo(px + r, py + ph); ctx.quadraticCurveTo(px, py + ph, px, py + ph - r);
  ctx.lineTo(px, py + r); ctx.quadraticCurveTo(px, py, px + r, py);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = COL.playerCore;
  ctx.fillRect(px + pw * 0.28, py + ph * 0.3, pw * 0.44, ph * 0.4);
  // Gravity arrow (points the way gravity pulls — the flip direction).
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const ax = px + pw / 2, ay = p.grav === 1 ? py + ph + 8 * s : py - 8 * s;
  ctx.beginPath();
  if (p.grav === 1) { ctx.moveTo(ax - 5 * s, ay - 4 * s); ctx.lineTo(ax + 5 * s, ay - 4 * s); ctx.lineTo(ax, ay + 4 * s); }
  else { ctx.moveTo(ax - 5 * s, ay + 4 * s); ctx.lineTo(ax + 5 * s, ay + 4 * s); ctx.lineTo(ax, ay - 4 * s); }
  ctx.closePath(); ctx.fill();
  ctx.restore();
}
function drawParticles() {
  const s = camScale;
  for (const p of particles) {
    if (!p.alive) continue;
    const a = clamp(p.life / p.maxLife, 0, 1);
    const sx = wx2sx(p.x), sy = wy2sy(p.y);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.fillRect(sx - p.size * s / 2, sy - p.size * s / 2, p.size * s, p.size * s);
  }
  ctx.globalAlpha = 1;
}
function drawPops() {
  const s = camScale;
  ctx.save();
  ctx.font = `bold ${Math.round(15 * s)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  for (const p of pops) {
    const a = clamp(p.life / p.maxLife, 0, 1);
    const sx = wx2sx(p.x), sy = wy2sy(p.y);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, sx, sy);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- attract + hooks
window.__flux = {
  get version() { return VERSION; },
  get state() {
    return {
      phase, levelId: run ? run.levelId : selectedLevel,
      score: run ? run.score : null, orbs: run ? run.orbsGot : null,
      deaths: run ? run.deaths : null, time: run ? run.time : null,
      done: run ? run.done : null, won: run ? run.won : null,
      muted, fps: Math.round(fpsEma),
      attack: attack ? { level: attack.idx + 1, timeLeft: attack.timeLeft, orbs: attack.orbs } : null,
    };
  },
  info() {
    const r = run || (phase === 'menu' ? demoRun : null);
    if (!r) return null;
    const sp = playerScreenPosFor(r);
    return {
      levelId: r.levelId, levelName: r.level.name,
      player: sp,
      playerWorld: { x: r.player.x, y: r.player.y, grav: r.player.grav, grounded: r.player.grounded },
      orbs: r.orbsGot, orbsTotal: r.orbs.length, deaths: r.deaths,
      time: r.time, done: r.done, won: r.won,
      exit: worldToScreen(r.exit.x, r.exit.y),
    };
  },
  levels() {
    return LEVELS.map((d) => ({
      id: d.id, name: d.name, par: d.par, accent: d.accent,
      best: save.best[d.id] || null, unlocked: isLevelUnlocked(save, d.id),
    }));
  },
  startLevel(id) { startLevel(id); },
  startTimeAttack() { startTimeAttack(); },
  attack() {
    return attack ? {
      level: attack.idx + 1, levels: LEVELS.length,
      timeLeft: attack.timeLeft, totalTime: attack.totalTime,
      orbs: attack.orbs, deaths: attack.deaths,
      budget: timeAttackBudget(),
    } : null;
  },
  isTimeAttackUnlocked() { return isTimeAttackUnlocked(save); },
  timeAttackBudget() { return timeAttackBudget(); },
  // Test hook (render check only): force the attack clock, to drive
  // the timeout path without waiting out the full 461s budget.
  attackSetTimeLeft(s) { if (attack) attack.timeLeft = s; },
  setMove(dir) { keys.left = dir < 0; keys.right = dir > 0; },
  flip() { if (phase === 'playing') { ensureAudio(); queueFlip(); } },
  autopilot(on) {
    if (on) { autopilot = createDecisionBot(); }
    else autopilot = null;
  },
  pause() { pauseGame(); },
  resume() { resumeGame(); },
  quitToMenu() { quitToMenu(); },
  setMuted(m) { setMuted(m); },
  setFlash(on) { setFlash(on); },
  // Feel state for tests: every value must return to its rest value
  // (trauma 0, timeScale 1, flashT 0, zoomT 0, no shockwaves) once the
  // game sits idle — an effect that leaks is a bug.
  feel() {
    return {
      trauma, timeScale, hitStopT, slowMoT, flashT, zoomT,
      stretchT, squashT, camX, camScale,
      shockwaves: shockwaves.length,
      trail: trail.length,
      particlesAlive: particles.reduce((n, p) => n + (p.alive ? 1 : 0), 0),
      orbCombo, nearMisses,
      flashOn: save.settings.flash !== false,
      shake: save.settings.shake ?? 1,
    };
  },
  get save() { return JSON.parse(JSON.stringify(save)); },
};
function playerScreenPosFor(r) {
  const s = worldToScreen(r.player.x + 12, r.player.y + 16);
  return { x: s.x, y: s.y, w: 24 * camScale, h: 32 * camScale };
}

// ---------------------------------------------------------------- wiring + init
function bindUI() {
  $('btn-play').addEventListener('click', () => startLevel(selectedLevel));
  $('btn-attack').addEventListener('click', () => startTimeAttack());
  $('btn-attack-retry').addEventListener('click', () => startTimeAttack());
  $('btn-attack-menu').addEventListener('click', () => quitToMenu());
  $('btn-levels').addEventListener('click', () => { refreshLevelSelect(); pushScreen('levels'); });
  $('btn-howto').addEventListener('click', () => pushScreen('howto'));
  $('btn-settings').addEventListener('click', () => pushScreen('settings'));
  $('btn-levels-back').addEventListener('click', () => popScreen());
  $('btn-howto-back').addEventListener('click', () => popScreen());
  $('btn-settings-back').addEventListener('click', () => popScreen());
  $('btn-resume').addEventListener('click', () => resumeGame());
  $('btn-restart').addEventListener('click', () => { popScreen(); phase = 'playing'; restartLevel(); });
  $('btn-quit').addEventListener('click', () => quitToMenu());
  $('btn-next').addEventListener('click', () => nextLevel());
  $('btn-replay').addEventListener('click', () => restartLevel());
  $('btn-complete-menu').addEventListener('click', () => quitToMenu());
  $('btn-mute-menu').addEventListener('click', () => setMuted(!muted));
  $('btn-mute-hud').addEventListener('click', () => setMuted(!muted));
  $('btn-mute-settings').addEventListener('click', () => setMuted(!muted));
  $('btn-flash-settings').addEventListener('click', () => setFlash(save.settings.flash === false));
  $('btn-pause').addEventListener('click', () => pauseGame());
  const shakeInput = $('setting-shake'), shakeVal = $('setting-shake-val');
  if (shakeInput) {
    shakeInput.value = Math.round((save.settings.shake ?? 1) * 100);
    shakeVal.textContent = `${shakeInput.value}%`;
    shakeInput.addEventListener('input', () => {
      save.settings.shake = clamp(Number(shakeInput.value) / 100, 0, 1);
      shakeVal.textContent = `${shakeInput.value}%`;
      persistSave();
    });
  }
  const resetBtn = $('btn-reset-best');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    save.best = {}; save.unlocked = 1; save.attack = null; persistSave();
    refreshMenuBest(); refreshAttackButton(); refreshLevelSelect();
    toast('Best times cleared', 2000);
  });
  // Touch controls.
  const zl = $('touch-left'), zr = $('touch-right'), fb = $('touch-flip');
  if (zl) bindHold(zl, () => { keys.left = true; }, () => { keys.left = false; });
  if (zr) bindHold(zr, () => { keys.right = true; }, () => { keys.right = false; });
  if (fb) fb.addEventListener('pointerdown', (e) => {
    e.preventDefault(); ensureAudio();
    if (phase === 'playing') queueFlip();
    else if (phase === 'menu') startLevel(selectedLevel);
  });
}
// First-visit: the menu IS the how-to (one clear primary action, no
// version text anywhere player-facing).
bindUI();
updateMuteLabels();
updateFlashLabel();
refreshMenuBest();
refreshAttackButton();
selectedLevel = save.unlocked || 1;
goMenu();
lastTime = performance.now();
requestAnimationFrame(frame);
