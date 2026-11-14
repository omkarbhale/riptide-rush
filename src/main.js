// Boot, fixed-timestep loop, screen state machine, and the wiring between the sim, the effects layer,
// the sound layer and the renderer. Sim events go to feedback.js; this file only handles state changes.
import {
  LOGICAL_WIDTH as W,
  LOGICAL_HEIGHT as H,
  SIM_DT,
  MAX_FRAME_DT,
  HIGH_SCORE_KEY,
  RESTART_GATE,
} from './config.js';
import { createGame, update, drainEvents } from './game.js';
import { createInput } from './input.js';
import { drawFrame } from './render.js';
import { createFx } from './fx.js';
import { audio } from './audio.js';
import { createFeedback } from './feedback.js';

const MUTE_KEY = 'riptide-rush.muted';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const input = createInput(canvas);
const fx = createFx();
const feedback = createFeedback({ audio, fx });

// screen: 'title' | 'playing' | 'paused' | 'over'
const app = {
  screen: 'title',
  game: createGame(newSeed()),
  highScore: loadHighScore(),
  newBest: false,
  overAge: 0,
  muted: loadMuted(),
  time: 0,
  acc: 0,
};

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

function loadMuted() {
  try {
    return window.localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveMuted(value) {
  try {
    window.localStorage.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // mute lasts for this page only
  }
}

// Audio is created on the first user gesture (browsers refuse an AudioContext before one).
// Until then audio calls are silent no-ops, so the mute state is applied again once it exists.
function setMuted(value) {
  app.muted = value;
  saveMuted(value);
  audio.setMuted(value);
}

function unlockAudio() {
  if (!audio.init()) return;
  audio.setMuted(app.muted);
  window.removeEventListener('pointerdown', unlockAudio, true);
  window.removeEventListener('keydown', unlockAudio, true);
}
window.addEventListener('pointerdown', unlockAudio, true);
window.addEventListener('keydown', unlockAudio, true);

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM' && !e.repeat) setMuted(!app.muted);
});

function startRun() {
  app.game = createGame(newSeed());
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
      if (action === 'confirm') startRun();
      break;
    case 'playing':
      if (action === 'pause') pause();
      else if (action === 'dash' || action === 'pulse') input.press(action);
      break;
    case 'paused':
      if (action === 'pause' || action === 'confirm') resume();
      break;
    case 'over':
      if (action === 'confirm' && app.overAge >= RESTART_GATE) startRun();
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
  }
  feedback.handleStep(events, app.game);
}

// Fixed 120 Hz simulation, advanced by the effects time scale: hit-stop holds it still, slow-mo
// slows it. Effects, floaters and the renderer keep running on real time.
let last = performance.now();
function frame(now) {
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

  drawFrame(ctx, {
    screen: app.screen,
    game: app.game,
    alpha: app.acc / SIM_DT,
    time: app.time,
    dt: live ? dt : 0,
    highScore: app.highScore,
    newBest: app.newBest,
    overAge: app.overAge,
    muted: app.muted,
    fx,
    rings: feedback.rings,
  });
  requestAnimationFrame(frame);
}

// Letterbox: the canvas keeps 16:9 and fits the window; the backing store is sized for devicePixelRatio.
function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scale = Math.min(window.innerWidth / W, window.innerHeight / H);
  const cssW = Math.max(1, Math.floor(W * scale));
  const cssH = Math.max(1, Math.floor(H * scale));
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
