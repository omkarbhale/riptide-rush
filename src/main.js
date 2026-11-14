// Boot, fixed-timestep loop, screen state machine, and the bridge from sim events to presentation.
import {
  LOGICAL_WIDTH as W,
  LOGICAL_HEIGHT as H,
  SIM_DT,
  MAX_FRAME_DT,
  HIGH_SCORE_KEY,
  RESTART_GATE,
} from './config.js';
import { createGame, update, drainEvents, tierFor } from './game.js';
import { createInput } from './input.js';
import { drawFrame, PALETTE } from './render.js';

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const input = createInput(canvas);

// screen: 'title' | 'playing' | 'paused' | 'over'
const app = {
  screen: 'title',
  game: createGame(newSeed()),
  highScore: loadHighScore(),
  newBest: false,
  overAge: 0,
  effects: [],
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

function startRun() {
  app.game = createGame(newSeed());
  app.screen = 'playing';
  app.newBest = false;
  app.overAge = 0;
  app.effects = [];
  input.reset();
}

function pause() {
  if (app.screen !== 'playing') return;
  app.screen = 'paused';
  input.reset();
}

function resume() {
  app.screen = 'playing';
  input.reset();
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

function addEffect(fx) {
  app.effects.push({ age: 0, ...fx });
}

// Maps sim events to presentation effects and to the few state changes the sim forces.
function handleEvent(ev) {
  switch (ev.type) {
    case 'dash':
      input.consume('dash');
      addEffect({ kind: 'dash', x: ev.x, y: ev.y, angle: ev.angle, life: 0.22 });
      break;
    case 'pulse':
      input.consume('pulse');
      addEffect({ kind: 'pulse', x: ev.x, y: ev.y, life: 0.3, perfect: false });
      break;
    case 'perfectPulse': {
      const pulse = [...app.effects].reverse().find((fx) => fx.kind === 'pulse');
      if (pulse) pulse.perfect = true;
      addEffect({ kind: 'float', x: ev.x, y: ev.y, text: 'PERFECT PULSE', color: PALETTE.gold, life: 0.9, size: 26 });
      break;
    }
    case 'reflect':
      addEffect({ kind: 'reflect', x: ev.x, y: ev.y, life: 0.25 });
      break;
    case 'kill': {
      const color = PALETTE.tiers[tierFor(ev.combo)];
      addEffect({ kind: 'kill', x: ev.x, y: ev.y, life: 0.25, color });
      addEffect({ kind: 'float', x: ev.x, y: ev.y, text: `+${ev.points}`, color, life: 0.7 });
      break;
    }
    case 'comboTier':
      if (ev.tier > 0) {
        addEffect({ kind: 'float', x: app.game.player.x, y: app.game.player.y - 30, text: `COMBO TIER ${ev.tier}`, color: PALETTE.tiers[ev.tier], life: 0.9 });
      }
      break;
    case 'comboLost':
      addEffect({ kind: 'float', x: app.game.player.x, y: app.game.player.y - 30, text: 'COMBO LOST', color: PALETTE.danger, life: 0.8 });
      break;
    case 'hurt':
      addEffect({ kind: 'hurt', life: 0.5 });
      break;
    case 'waveStart':
      addEffect({ kind: 'float', x: W / 2, y: H / 2 - 120, text: `WAVE ${ev.wave}`, color: PALETTE.player, life: 1.4, size: 40 });
      break;
    case 'gameOver':
      endRun(ev.score);
      break;
    default:
      break;
  }
}

function simStep() {
  pumpInput(SIM_DT);
  if (app.screen !== 'playing') return;
  update(app.game, input.snapshot(), SIM_DT);
  for (const ev of drainEvents(app.game)) handleEvent(ev);
}

function updateEffects(dt) {
  for (const fx of app.effects) fx.age += dt;
  app.effects = app.effects.filter((fx) => fx.age < fx.life);
}

// Fixed 120 Hz simulation; render runs once per animation frame with interpolation alpha.
let last = performance.now();
function frame(now) {
  let dt = (now - last) / 1000;
  last = now;
  if (dt < 0) dt = 0;
  if (dt > MAX_FRAME_DT) dt = MAX_FRAME_DT;
  app.time += dt;

  if (app.screen === 'playing' || app.screen === 'over') {
    app.acc += dt;
    while (app.acc >= SIM_DT) {
      simStep();
      app.acc -= SIM_DT;
    }
  } else {
    // Menus and pause: no simulation, but keep reading input once per frame.
    app.acc = 0;
    pumpInput(dt);
  }
  if (app.screen === 'playing' || app.screen === 'over') updateEffects(dt);

  drawFrame(ctx, {
    screen: app.screen,
    game: app.game,
    alpha: app.acc / SIM_DT,
    time: app.time,
    highScore: app.highScore,
    newBest: app.newBest,
    overAge: app.overAge,
    effects: app.effects,
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
