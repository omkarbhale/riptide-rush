// Boot, fixed-timestep loop, screen state machine, and the wiring between the sim, the effects layer,
// the sound layer and the renderer. Sim events go to feedback.js and hud.js; this file only handles state
// changes, input routing and the saved options.
import { SIM_DT, MAX_FRAME_DT, HIGH_SCORE_KEY, RESTART_GATE, LOGICAL_WIDTH, LOGICAL_HEIGHT } from './config.js';
import { createGame, update, drainEvents } from './game.js';
import { createInput } from './input.js';
import { drawFrame, currentZoom } from './render.js';
import { createFx, FX_QUALITY_BURST_SCALE } from './fx.js';
import { audio } from './audio.js';
import { createFeedback } from './feedback.js';
import {
  OPTION_ROWS,
  activateSetting,
  computeLayout,
  createHud,
  hudEvents,
  hudUpdate,
  loadSettings,
  pauseHit,
  saveSettings,
  setVolume,
  stepSetting,
  trackFraction,
} from './hud.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');

// Saved options (volume, mute, screen shake, reduced flashes). Blocked storage gives the defaults.
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

// screen: 'title' | 'playing' | 'paused' | 'over'
const app = {
  screen: 'title',
  game: createGame(newSeed()),
  hud: createHud(),
  highScore: loadHighScore(),
  newBest: false,
  overAge: 0,
  settings: loadSettings(storage()),
  menuRow: 0, // the option under the keyboard cursor on the pause screen
  layout: computeLayout(window.innerWidth, window.innerHeight),
  time: 0,
  acc: 0,
};
const input = createInput(canvas, { mapPoint, claimPointer });
const fx = createFx();
const feedback = createFeedback({ audio, fx });

function newSeed() {
  return (Math.floor(Math.random() * 0x7fffffff) ^ Date.now()) >>> 0;
}

// localStorage can be missing or throw (private windows, blocked storage); the game still works.
function loadHighScore() {
  try {
    return Number(window.localStorage.getItem(HIGH_SCORE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveHighScore(value) {
  try {
    window.localStorage.setItem(HIGH_SCORE_KEY, String(value));
  } catch {
    // keep the best score in memory for this page only
  }
}

// Audio is created on the first user gesture (browsers refuse an AudioContext before one).
// Until then audio calls are silent no-ops, so the saved volume and mute are applied again once it exists.
function applyAudioSettings() {
  audio.setMasterVolume(app.settings.volume);
  audio.setMuted(app.settings.muted);
}

// Every option change goes through here: it applies the change, then saves it.
function changeSettings(next) {
  app.settings = next;
  saveSettings(storage(), next);
  applyAudioSettings();
}

function unlockAudio() {
  if (!audio.init()) return;
  applyAudioSettings();
  window.removeEventListener('pointerdown', unlockAudio, true);
  window.removeEventListener('keydown', unlockAudio, true);
}
window.addEventListener('pointerdown', unlockAudio, true);
window.addEventListener('keydown', unlockAudio, true);

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) changeSettings({ ...app.settings, muted: !app.settings.muted });
});

// ---- pointer mapping ------------------------------------------------------------------------------
// The canvas covers the window; the arena sits inside it letterboxed. Input maps a click to arena space.
function cssPoint(clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return { x: clientX - r.left, y: clientY - r.top };
}

// The arena is drawn about its centre at the combo zoom (see render.js), so the inverse includes it.
function mapPoint(clientX, clientY) {
  const p = cssPoint(clientX, clientY);
  const L = app.layout;
  const z = currentZoom();
  const cx = LOGICAL_WIDTH / 2;
  const cy = LOGICAL_HEIGHT / 2;
  return {
    x: cx + (p.x - L.px - L.s * cx) / (z * L.s),
    y: cy + (p.y - L.py - L.s * cy) / (z * L.s),
  };
}

// A left click inside the pause options panel is handled here and never resumes the game. A click
// outside the panel is not claimed, so it resumes as before.
function claimPointer(button, clientX, clientY) {
  if (app.screen !== 'paused' || button !== 0) return false;
  const p = cssPoint(clientX, clientY);
  const hit = pauseHit(app.layout, p.x, p.y);
  if (!hit) return false;
  if (hit.row !== null) {
    app.menuRow = hit.row;
    if (hit.part === 'track') changeSettings(setVolume(app.settings, trackFraction(app.layout, p.x)));
    else changeSettings(activateSetting(app.settings, OPTION_ROWS[hit.row]));
  }
  return true;
}

function startRun() {
  app.game = createGame(newSeed());
  app.hud = createHud();
  app.screen = 'playing';
  app.newBest = false;
  app.overAge = 0;
  app.acc = 0;
  input.reset();
  feedback.startRun();
}

function pause() {
  if (app.screen !== 'playing') return;
  app.screen = 'paused';
  app.menuRow = 0;
  input.reset();
  feedback.setPaused(true);
}

function resume() {
  app.screen = 'playing';
  input.reset();
  feedback.setPaused(false);
}

function endRun(score) {
  app.screen = 'over';
  app.overAge = 0;
  if (score > app.highScore) {
    app.highScore = score;
    app.newBest = true;
    saveHighScore(score);
  }
  input.reset();
}

function handleAction(action) {
  switch (app.screen) {
    case 'title':
      if (action === 'confirm' || action === 'select') startRun();
      break;
    case 'playing':
      if (action === 'pause') pause();
      else if (action === 'dash' || action === 'pulse') input.press(action);
      break;
    case 'paused':
      if (action === 'pause' || action === 'confirm') resume();
      else if (action === 'up') app.menuRow = (app.menuRow + OPTION_ROWS.length - 1) % OPTION_ROWS.length;
      else if (action === 'down') app.menuRow = (app.menuRow + 1) % OPTION_ROWS.length;
      else if (action === 'left' || action === 'right') {
        changeSettings(stepSetting(app.settings, OPTION_ROWS[app.menuRow], action === 'left' ? -1 : 1));
      } else if (action === 'select') changeSettings(activateSetting(app.settings, OPTION_ROWS[app.menuRow]));
      break;
    case 'over':
      if ((action === 'confirm' || action === 'select') && app.overAge >= RESTART_GATE) startRun();
      break;
    default:
      break;
  }
}

// Consumes queued presses for this step: ages the input buffer, then dispatches actions.
function pumpInput(stepDt) {
  input.tick(stepDt);
  for (const action of input.drain()) handleAction(action);
  if (app.screen === 'over') app.overAge += stepDt;
}

// Kill presentation: a squash-and-pop where the enemy fell, a small camera kick along the dash on a
// multi-kill, and a soft darkening on a big one. All of it is short and sits under the entities.
function feelKill(ev) {
  const facing = app.game.player.facing;
  fx.deathPop(ev.enemyType, ev.x, ev.y, facing);
  if (ev.multi >= 2) fx.kick(Math.cos(facing), Math.sin(facing), Math.min(7, 3 + 1.5 * (ev.multi - 2)));
  if (ev.multi >= 3) fx.darkenAt(ev.x, ev.y, Math.min(0.45, 0.2 + 0.08 * (ev.multi - 3)), ev.hitStopMs + 120);
}

// One simulation step. Presses that arrive while the sim is held (hit-stop) stay queued in the input
// layer until the next step, so nothing is dropped.
function simStep() {
  pumpInput(SIM_DT);
  if (app.screen !== 'playing') return;
  update(app.game, input.snapshot(), SIM_DT);
  const events = drainEvents(app.game);
  for (const ev of events) {
    // A dash or pulse has fired: clear its buffered press so it cannot fire twice.
    if (ev.type === 'dash') input.consume('dash');
    else if (ev.type === 'pulse') input.consume('pulse');
    else if (ev.type === 'gameOver') endRun(ev.score);
    else if (ev.type === 'kill') feelKill(ev);
  }
  hudEvents(app.hud, events, app.game);
  feedback.handleStep(events, app.game);
}

// Adaptive quality. The average frame interval is taken over 2 s of real time: above 20 ms the effects step
// down one level (fewer burst particles), and below 16.7 ms they step back up. Gaps longer than 250 ms
// (a hidden tab, a stall) are not frames and are not counted.
const QUALITY_WINDOW_MS = 2000;
const QUALITY_HIGH_MS = 20;
const QUALITY_LOW_MS = 16.7;
const QUALITY_MAX = FX_QUALITY_BURST_SCALE.length - 1;
const quality = { level: 0, sumMs: 0, frames: 0, windowMs: 0 };

function trackQuality(rawMs) {
  if (!(rawMs > 0) || rawMs > 250) {
    quality.sumMs = 0;
    quality.frames = 0;
    quality.windowMs = 0;
    return;
  }
  quality.sumMs += rawMs;
  quality.frames += 1;
  quality.windowMs += rawMs;
  if (quality.windowMs < QUALITY_WINDOW_MS) return;
  const avg = quality.sumMs / quality.frames;
  let next = quality.level;
  if (avg > QUALITY_HIGH_MS && next < QUALITY_MAX) next += 1;
  else if (avg < QUALITY_LOW_MS && next > 0) next -= 1;
  if (next !== quality.level) {
    quality.level = next;
    fx.setQuality(next);
  }
  quality.sumMs = 0;
  quality.frames = 0;
  quality.windowMs = 0;
}

// Fixed 120 Hz simulation, advanced by the effects time scale: hit-stop holds it still, slow-mo
// slows it. Effects, floaters and the renderer keep running on real time.
let last = performance.now();
function frame(now) {
  const rawMs = now - last;
  trackQuality(rawMs);
  let dt = (now - last) / 1000;
  last = now;
  if (dt < 0) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
  app.time += dt;

  const live = app.screen === 'playing' || app.screen === 'over';
  if (live) {
    const scale = fx.update(dt);
    app.acc += dt * scale;
    while (app.acc >= SIM_DT) {
      simStep();
      app.acc -= SIM_DT;
    }
  } else {
    // Menus and pause: the world and its effects freeze, but input is still read once per frame.
    fx.update(0);
    app.acc = 0;
    pumpInput(dt);
  }
  feedback.frame(live ? dt : 0, app.game);
  hudUpdate(app.hud, dt, app.screen === 'title' ? null : app.game, app.layout);

  drawFrame(ctx, {
    screen: app.screen,
    game: app.game,
    alpha: app.acc / SIM_DT,
    time: app.time,
    dt: live ? dt : 0,
    highScore: app.highScore,
    newBest: app.newBest,
    overAge: app.overAge,
    muted: app.settings.muted,
    fx,
    rings: feedback.rings,
    layout: app.layout,
    hud: app.hud,
    settings: app.settings,
    menuRow: app.menuRow,
  });
  requestAnimationFrame(frame);
}

// The canvas covers the whole window. The arena keeps its 16:9 shape inside it (see hud.js computeLayout),
// and the backing store is sized for devicePixelRatio, capped at 2: a 3x screen would cost 2.25x the raster
// for no visible gain at this size.
function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = Math.max(1, window.innerWidth);
  const cssH = Math.max(1, window.innerHeight);
  app.layout = computeLayout(cssW, cssH);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
}

window.addEventListener('resize', fit);
window.addEventListener('blur', pause);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
});

fit();
requestAnimationFrame(frame);
