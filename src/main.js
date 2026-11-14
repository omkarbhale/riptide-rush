// Boot, fixed-timestep loop, screen state machine, and the wiring between the sim, the effects layer,
// the sound layer and the renderer. Sim events go to feedback.js and hud.js; this file only handles state
// changes, input routing and the saved options.
import { SIM_DT, MAX_FRAME_DT, LOGICAL_WIDTH, LOGICAL_HEIGHT } from './config.js';
import { createGame, update, drainEvents } from './game.js';
import { createInput } from './input.js';
import { drawFrame, currentZoom } from './render.js';
import { createFx, FX_QUALITY_BURST_SCALE } from './fx.js';
import { audio } from './audio.js';
import { createFeedback } from './feedback.js';
import {
  MODES,
  MODE_IDS,
  bestScore,
  dailyEntry,
  dailyShareText,
  isModeId,
  loadMode,
  recordModeRun,
  rulesFor,
  saveMode,
  seedFor,
  utcDayKey,
} from './modes.js';
import { copyText, hideShareField, modesHit, showShareField } from './modes-ui.js';
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
import { loadScores, recordRun, saveScores } from './scores.js';

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
// mode: the mode picked on the title screen (remembered). It only changes on the title screen, so it is also
// the mode of the run in progress. bests: each mode's best (Classic: top of the top-five list; Daily Tide:
// today's official score).
const app = {
  screen: 'title',
  game: createGame(newSeed()),
  hud: createHud(),
  mode: loadMode(storage()),
  dayKey: utcDayKey(), // today's UTC date, refreshed on the title screen
  runDayKey: utcDayKey(), // the UTC date the current or last run started on
  bests: {},
  daily: { official: null, plays: 0 },
  official: false, // the last run was today's official Daily Tide result
  share: null, // { state: 'pending' | 'copied' | 'fallback', at } for the share prompt
  tapClaimUntil: 0, // performance.now() until which the tap that just hit a button does not also act (see tapClaimed)
  lastRun: { score: 0, wave: 0, combo: 0 },
  scores: loadScores(storage()), // the top five runs (scores.js), Classic's table
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

// Reads every mode's best and today's daily entry. localStorage can be missing or throw (private windows,
// blocked storage); the helpers in modes.js give the defaults, and the game still works.
function refreshBests() {
  const s = storage();
  app.dayKey = utcDayKey();
  app.bests = Object.fromEntries(MODE_IDS.map((id) => [id, bestScore(s, id, app.dayKey)]));
  app.daily = dailyEntry(s, app.dayKey);
}
refreshBests();

// What the mode UI needs this frame (see modes-ui.js).
function modesView() {
  return {
    mode: app.mode,
    dayKey: app.dayKey,
    runDayKey: app.runDayKey,
    bests: app.bests,
    daily: app.daily,
    official: app.official,
    share: app.share,
  };
}

function selectMode(id) {
  if (app.screen !== 'title' || !isModeId(id)) return;
  app.mode = id;
  saveMode(storage(), id);
  refreshBests();
}

function cycleMode(step) {
  const i = MODE_IDS.indexOf(app.mode);
  selectMode(MODE_IDS[(i + step + MODE_IDS.length) % MODE_IDS.length]);
}

// The share prompt: only an official Daily Tide result can be shared. Copies the one-line result, or shows it
// in a selectable field when the clipboard refuses.
function share() {
  if (app.screen !== 'over' || !app.official) return;
  const text = dailyShareText(app.runDayKey, app.lastRun);
  app.share = { state: 'pending', at: app.time };
  copyText(text).then((state) => {
    if (app.screen !== 'over') return;
    app.share = { state, at: app.time };
    if (state === 'fallback') showShareField(text, app.layout);
  });
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
  if (e.repeat) return;
  // Keys 1-4 pick the mode on the title screen; C copies the share line on the game-over card.
  if (app.screen === 'title') {
    const mode = Object.values(MODES).find((m) => m.key === e.key);
    if (mode) selectMode(mode.id);
  } else if (app.screen === 'over' && e.code === 'KeyC') {
    share();
  }
});

// A touch does not reach claimPointer: the touch layer turns a quick tap into 'confirm' when the finger lifts.
// So a touch on the mode picker or the share button is handled here, and the tap that follows it is claimed.
const TAP_CLAIM_MS = 500;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  const p = cssPoint(e.clientX, e.clientY);
  let claimed = false;
  if (app.screen === 'title') {
    const hit = modesHit(app.layout, 'title', p.x, p.y, modesView());
    if (hit?.kind === 'mode') {
      selectMode(hit.id);
      claimed = true;
    }
  } else if (app.screen === 'over') {
    if (modesHit(app.layout, 'over', p.x, p.y, modesView())?.kind === 'share') {
      share();
      claimed = true;
    }
  }
  if (claimed) app.tapClaimUntil = performance.now() + TAP_CLAIM_MS;
});

// True for the confirm that a touch on a claimed button produces, so the tap neither starts nor restarts a run.
function tapClaimed(action) {
  return (action === 'confirm' || action === 'select') && performance.now() < app.tapClaimUntil;
}

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
  if (button !== 0) return false;
  const p = cssPoint(clientX, clientY);
  // The mode picker on the title screen and the share button on the game-over card take their own clicks.
  if (app.screen === 'title') {
    const hit = modesHit(app.layout, 'title', p.x, p.y, modesView());
    if (hit?.kind !== 'mode') return false;
    selectMode(hit.id);
    return true;
  }
  if (app.screen === 'over') {
    if (modesHit(app.layout, 'over', p.x, p.y, modesView())?.kind !== 'share') return false;
    share();
    return true;
  }
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

// A run starts in the remembered mode. Daily Tide uses the day's seed and mutator; the others use a random seed
// and their own rule overrides (One Life: 1 HP; No Pulse: Pulse off).
function startRun() {
  app.runDayKey = utcDayKey();
  app.game = createGame(seedFor(app.mode, app.runDayKey, newSeed()), { rules: rulesFor(app.mode, app.runDayKey) });
  app.hud = createHud();
  app.screen = 'playing';
  app.newBest = false;
  app.official = false;
  app.share = null;
  hideShareField();
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

// Records the run under its mode. Classic goes onto the top-five list, saved at once; the summary reads the rank
// and the new best. The other modes keep their own best (Daily Tide: the day's official result).
function endRun() {
  app.screen = 'over';
  app.overAge = 0;
  const run = runRecord(app.game, app.hud, Date.now());
  app.lastRun = { score: run.score, wave: run.wave ?? 0, combo: run.peakCombo ?? 0 };
  app.runRank = -1;
  if (app.mode === 'classic') {
    const r = recordRun(app.scores, run);
    app.scores = r.scores;
    app.runRank = r.rank;
    app.newBest = r.newBest;
    app.official = false;
    saveScores(storage(), r.scores);
  } else {
    const result = recordModeRun(storage(), app.mode, app.runDayKey, {
      score: run.score,
      wave: run.wave,
      combo: run.peakCombo,
    });
    app.newBest = result.newBest && app.mode !== 'daily'; // Daily Tide shows its official result instead
    app.official = result.official;
  }
  refreshBests();
  input.reset();
}

function handleAction(action) {
  switch (app.screen) {
    case 'title':
      if (tapClaimed(action)) break;
      if (action === 'confirm' || action === 'select') {
        if (app.howtoSeen) startRun();
        else openHowto('title');
      } else if (action === 'left') cycleMode(-1);
      else if (action === 'right') cycleMode(1);
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
      else if (action === 'dash') input.press(action);
      else if (action === 'pulse' && app.game.rules.pulse) input.press(action); // No Pulse: the press is ignored
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
      if (tapClaimed(action)) break;
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
  let ended = false;
  for (const ev of events) {
    // A dash or pulse has fired: clear its buffered press so it cannot fire twice.
    if (ev.type === 'dash') input.consume('dash');
    else if (ev.type === 'pulse') input.consume('pulse');
    else if (ev.type === 'gameOver') ended = true;
    else if (ev.type === 'kill') feelKill(ev);
  }
  hudEvents(app.hud, events, app.game);
  // The run is recorded after this step's HUD tallies, so its last kills count toward the summary.
  if (ended) endRun();
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

  // The title screen shows today's record; a page left open past UTC midnight picks up the new day here.
  if (app.screen === 'title' && utcDayKey() !== app.dayKey) refreshBests();

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
    highScore: app.bests[app.mode] ?? 0,
    modes: modesView(),
    newBest: app.newBest,
    runRank: app.runRank,
    // The top-five table is Classic's. The other modes have no table yet, so their summary shows the blank rows.
    scores: app.mode === 'classic' ? app.scores : [],
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
