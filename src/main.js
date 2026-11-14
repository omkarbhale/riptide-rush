// Boot, fixed-timestep loop, screen state machine, and the wiring between the sim, the effects layer,
// the sound layer and the renderer. Sim events go to feedback.js and hud.js; this file only handles state
// changes, input routing and the saved options.
import { SIM_DT, MAX_FRAME_DT } from './config.js';
import { createGame, update, drainEvents } from './game.js';
import { createInput } from './input.js';
import { drawFrame } from './render.js';
import { createFx } from './fx.js';
import { audio } from './audio.js';
import { createFeedback } from './feedback.js';
import {
  HOWTO_CARDS,
  OPTION_ROWS,
  SUMMARY_GATE,
  activateSetting,
  computeLayout,
  createHud,
  hudEvents,
  hudUpdate,
  howtoHit,
  loadHowtoSeen,
  loadSettings,
  pauseHit,
  runRecord,
  saveHowtoSeen,
  saveSettings,
  setVolume,
  stepSetting,
  trackFraction,
} from './hud.js';
import { loadScores, recordRun, saveScores, topScore } from './scores.js';

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

// screen: 'title' | 'howto' | 'playing' | 'paused' | 'over'
const app = {
  screen: 'title',
  game: createGame(newSeed()),
  hud: createHud(),
  scores: loadScores(storage()), // the top five runs (scores.js)
  highScore: 0,
  newBest: false,
  runRank: -1, // where the last run landed on the top five, -1 when it did not make it
  overAge: 0,
  howtoSeen: loadHowtoSeen(storage()),
  howtoIndex: 0,
  howtoFrom: 'title', // the screen the how-to was opened from: 'title' (first run) or 'paused'
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

// The best score is the top of the top-five list (scores.js); blocked storage keeps it for this page only.
app.highScore = topScore(app.scores);

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

function mapPoint(clientX, clientY) {
  const p = cssPoint(clientX, clientY);
  const L = app.layout;
  return { x: (p.x - L.px) / L.s, y: (p.y - L.py) / L.s };
}

// A left click inside the pause options panel is handled here and never resumes the game. A click
// outside the panel is not claimed, so it resumes as before.
function claimPointer(button, clientX, clientY) {
  if (button !== 0) return false;
  const p = cssPoint(clientX, clientY);
  // The how-to's Skip button is the only click it claims; other clicks advance a card as usual.
  if (app.screen === 'howto') {
    if (howtoHit(app.layout, p.x, p.y) !== 'skip') return false;
    closeHowto();
    return true;
  }
  if (app.screen !== 'paused') return false;
  const hit = pauseHit(app.layout, p.x, p.y);
  if (!hit) return false;
  if (hit.row !== null) {
    app.menuRow = hit.row;
    if (hit.part === 'track') changeSettings(setVolume(app.settings, trackFraction(app.layout, p.x)));
    else activateMenuRow(hit.row);
  }
  return true;
}

// Enter or a click on a pause-menu row: the how-to row opens the cards, the rest change a setting.
function activateMenuRow(i) {
  const row = OPTION_ROWS[i];
  if (row === 'howto') openHowto('paused');
  else changeSettings(activateSetting(app.settings, row));
}

function startRun() {
  app.game = createGame(newSeed());
  app.hud = createHud();
  app.screen = 'playing';
  app.newBest = false;
  app.runRank = -1;
  app.overAge = 0;
  app.acc = 0;
  input.reset();
  feedback.startRun();
}

// The how-to cards: from the title on the first run, or from the pause menu at any time.
function openHowto(from) {
  app.howtoFrom = from;
  app.howtoIndex = 0;
  app.screen = 'howto';
  input.reset();
}

// Leaves the cards (finished or skipped). The first run goes straight into play; from the pause menu it
// returns to the pause screen.
function closeHowto() {
  if (!app.howtoSeen) {
    app.howtoSeen = true;
    saveHowtoSeen(storage());
  }
  input.reset();
  if (app.howtoFrom === 'title') startRun();
  else app.screen = 'paused';
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

// The run goes onto the top-five list, which is saved at once. The summary reads the rank and the new best.
function endRun() {
  app.screen = 'over';
  app.overAge = 0;
  const r = recordRun(app.scores, runRecord(app.game, app.hud, Date.now()));
  app.scores = r.scores;
  app.runRank = r.rank;
  app.newBest = r.newBest;
  app.highScore = topScore(r.scores);
  saveScores(storage(), r.scores);
  input.reset();
}

function handleAction(action) {
  switch (app.screen) {
    case 'title':
      if (action === 'confirm' || action === 'select') {
        if (app.howtoSeen) startRun();
        else openHowto('title');
      }
      break;
    case 'howto':
      // Esc or P skips at once. Confirm, Enter or Right moves on; after the last card it closes.
      if (action === 'pause') closeHowto();
      else if (action === 'confirm' || action === 'select' || action === 'right') {
        if (app.howtoIndex < HOWTO_CARDS.length - 1) app.howtoIndex += 1;
        else closeHowto();
      } else if (action === 'left') app.howtoIndex = Math.max(0, app.howtoIndex - 1);
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
      } else if (action === 'select') activateMenuRow(app.menuRow);
      break;
    case 'over':
      if ((action === 'confirm' || action === 'select') && app.overAge >= SUMMARY_GATE) startRun();
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
  let ended = false;
  for (const ev of events) {
    // A dash or pulse has fired: clear its buffered press so it cannot fire twice.
    if (ev.type === 'dash') input.consume('dash');
    else if (ev.type === 'pulse') input.consume('pulse');
    else if (ev.type === 'gameOver') ended = true;
  }
  hudEvents(app.hud, events, app.game);
  // The run is recorded after this step's HUD tallies, so its last kills count toward the summary.
  if (ended) endRun();
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
  hudUpdate(app.hud, dt, app.screen === 'title' ? null : app.game, app.layout);

  drawFrame(ctx, {
    screen: app.screen,
    game: app.game,
    alpha: app.acc / SIM_DT,
    time: app.time,
    dt: live ? dt : 0,
    highScore: app.highScore,
    newBest: app.newBest,
    runRank: app.runRank,
    scores: app.scores,
    howtoIndex: app.howtoIndex,
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
// and the backing store is sized for devicePixelRatio.
function fit() {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
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
