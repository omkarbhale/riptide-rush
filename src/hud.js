// HUD, menus and the pause options panel. render.js hands this module the window layout and the view;
// this module draws every piece of text, panel and screen overlay the player reads on top of the arena.
// Everything above the drawing functions is pure (plain numbers in, plain objects out), so it runs under
// `node --test`. Nothing here touches window or document at import time.
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, ARENA, PLAYER, PICKUP, MODIFIER, DASH, PULSE } from './config.js';
import { multiplierFor, comboWindowFor, tierFor } from './game.js';
import { PALETTE, draw } from './art.js';
import { dashMaxCharges, PICKUP_KINDS } from './pickups.js';
import { TOP_N } from './scores.js';

export const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
// HUD text is never smaller than this on screen (the smallest HUD font is 12 logical px).
export const MIN_HUD_CSS_PX = 12;
// A HUD block fades to this alpha while the player or an enemy is beneath it.
export const HUD_BENEATH_ALPHA = 0.35;

export const SHAKE_STEPS = Object.freeze([1, 0.5, 0]);
// The last row is not an option: it opens the how-to cards (main.js handles it), so it is never saved.
export const OPTION_ROWS = Object.freeze(['volume', 'muted', 'shake', 'reducedFlashes', 'howto']);
export const OPTION_LABELS = Object.freeze({
  volume: 'Master volume',
  muted: 'Mute',
  shake: 'Screen shake',
  reducedFlashes: 'Reduced flashes',
  howto: 'How to play',
});
export const SETTINGS_KEY = 'riptide-rush.settings';
const LEGACY_MUTE_KEY = 'riptide-rush.muted'; // read once, so an earlier mute choice survives the move
export const DEFAULT_SETTINGS = Object.freeze({ volume: 1, muted: false, shake: 1, reducedFlashes: false });

const DIM = 'rgba(234, 255, 255, 0.6)';
const FAINT = 'rgba(234, 255, 255, 0.5)';
const SOFT = 'rgba(234, 255, 255, 0.85)';
const BACKING = 'rgba(2, 6, 16, 0.42)';
const BACKING_EDGE = 'rgba(234, 255, 255, 0.08)';
const PANEL_FILL = 'rgba(2, 6, 16, 0.9)';
const TAU = Math.PI * 2;

const SCORE_POP_S = 0.2;
const MULT_PULSE_S = 0.35;
const PIP_REFILL_S = 0.3;
const PIP_SPENT_S = 0.25;
const HP_SHAKE_S = 0.45;
const WAVE_BANNER_S = 1.6;
const FLAWLESS_BANNER_S = 1.8;
const FADE_RATE = 10; // per second: how fast a HUD block moves toward its target alpha
const HUD_BLOCKS = Object.freeze(['score', 'wave', 'hearts', 'dash', 'pulse']);

// Options panel, in logical units: width, height, and its top edge (absolute logical y).
const PANEL = Object.freeze({ w: 440, h: 360, top: 330 });

// Input is ignored for this long after a death, so a mid-fight click cannot skip the summary (#110).
export const SUMMARY_GATE = 0.3;
export const HOWTO_SEEN_KEY = 'riptide-rush.howtoSeen';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
const roundStep = (v) => Math.round(v * 20) / 20;

// ---- layout -----------------------------------------------------------------------------------------
// The arena keeps 16:9 and letterboxes inside the window: `s` is its scale, (px, py) its top-left corner,
// both in CSS px. HUD text scales by `hs = max(1, s)`, independently of the arena, so it never falls below
// MIN_HUD_CSS_PX on screen. HUD blocks anchor to the window edges, so a narrow window keeps them in the bands.
export function computeLayout(winW, winH) {
  const w = Math.max(1, Number(winW) || 1);
  const h = Math.max(1, Number(winH) || 1);
  const s = Math.min(w / W, h / H);
  const pw = W * s;
  const ph = H * s;
  return { winW: w, winH: h, s, px: (w - pw) / 2, py: (h - ph) / 2, pw, ph, hs: Math.max(1, s) };
}

// The HUD panels in CSS px. Used for the fade test, for keeping spawn markers out from under the HUD,
// and for the backing panels that sit behind the text.
export function hudBoxes(L, modCount = 0) {
  const k = L.hs;
  const w = L.winW;
  const h = L.winH;
  const scoreBottom = modCount > 0 ? 148 + 28 * modCount : 136;
  return {
    score: { x: 12 * k, y: 8 * k, w: 340 * k, h: (scoreBottom - 8) * k },
    wave: { x: w - 182 * k, y: 8 * k, w: 170 * k, h: 104 * k },
    hearts: { x: 12 * k, y: h - 62 * k, w: 130 * k, h: 44 * k },
    dash: { x: w / 2 - 112 * k, y: h - 62 * k, w: 224 * k, h: 56 * k },
    pulse: { x: w - 96 * k, y: h - 84 * k, w: 84 * k, h: 78 * k },
  };
}

// The same panels in logical arena units, for the renderer's spawn-marker clamp.
export function hudRectsLogical(L, modCount = 0) {
  const b = hudBoxes(L, modCount);
  return HUD_BLOCKS.map((name) => {
    const r = b[name];
    return { name, x: (r.x - L.px) / L.s, y: (r.y - L.py) / L.s, w: r.w / L.s, h: r.h / L.s };
  });
}

function overlapsRect(x, y, r, q) {
  return x + r > q.x && x - r < q.x + q.w && y + r > q.y && y - r < q.y + q.h;
}

const ARENA_BOUNDS = Object.freeze({ minX: ARENA.inset, minY: ARENA.inset, maxX: W - ARENA.inset, maxY: H - ARENA.inset });

// Moves a circle of radius r out of any rectangle it overlaps, to the nearest free spot that stays in the
// arena. Four passes at most; a marker that cannot get out is returned as far as it got.
export function clampOutOfRects(x, y, r, rects, bounds = ARENA_BOUNDS) {
  let px = x;
  let py = y;
  for (let pass = 0; pass < 4; pass++) {
    const hit = rects.find((q) => overlapsRect(px, py, r, q));
    if (!hit) break;
    const cands = [
      { x: hit.x - r, y: py },
      { x: hit.x + hit.w + r, y: py },
      { x: px, y: hit.y - r },
      { x: px, y: hit.y + hit.h + r },
    ]
      .map((c) => ({ x: clamp(c.x, bounds.minX, bounds.maxX), y: clamp(c.y, bounds.minY, bounds.maxY) }))
      .filter((c) => !overlapsRect(c.x, c.y, r, hit));
    if (cands.length === 0) break;
    let best = cands[0];
    let bestD = Infinity;
    for (const c of cands) {
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    px = best.x;
    py = best.y;
  }
  return { x: px, y: py };
}

// Which HUD blocks the player or an enemy is beneath right now (CSS px circles against the panels).
export function coveredBlocks(L, game) {
  const boxes = hudBoxes(L, Object.keys(game.modifiers).length);
  const circles = [];
  const p = game.player;
  circles.push({ x: L.px + p.x * L.s, y: L.py + p.y * L.s, r: PLAYER.radius * L.s });
  for (const e of game.enemies) {
    if (e.alive === false) continue;
    circles.push({ x: L.px + e.x * L.s, y: L.py + e.y * L.s, r: (e.r ?? 14) * L.s });
  }
  const out = {};
  for (const name of HUD_BLOCKS) {
    const b = boxes[name];
    out[name] = circles.some((c) => {
      const nx = clamp(c.x, b.x, b.x + b.w);
      const ny = clamp(c.y, b.y, b.y + b.h);
      return Math.hypot(c.x - nx, c.y - ny) < c.r;
    });
  }
  return out;
}

// ---- settings ---------------------------------------------------------------------------------------
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const v = Number(r.volume);
  const shake = Number(r.shake);
  return {
    volume: Number.isFinite(v) ? roundStep(clamp01(v)) : DEFAULT_SETTINGS.volume,
    muted: r.muted === true,
    shake: SHAKE_STEPS.includes(shake) ? shake : DEFAULT_SETTINGS.shake,
    reducedFlashes: r.reducedFlashes === true,
  };
}

// Reads the saved options. A missing or corrupt record gives the defaults; the old mute key still counts.
export function loadSettings(storage) {
  let raw = null;
  let legacyMuted = false;
  try {
    const text = storage ? storage.getItem(SETTINGS_KEY) : null;
    raw = text ? JSON.parse(text) : null;
    legacyMuted = storage ? storage.getItem(LEGACY_MUTE_KEY) === '1' : false;
  } catch {
    raw = null;
  }
  const base = raw && typeof raw === 'object' ? raw : {};
  return normalizeSettings({ ...base, muted: raw ? base.muted : legacyMuted });
}

export function saveSettings(storage, settings) {
  try {
    if (storage) storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
  } catch {
    // Storage can be blocked; the options then last for this page only.
  }
}

// One step of an option by keys: volume in 0.1 steps, shake through its three levels (no wrap), toggles flip.
export function stepSetting(s, row, dir) {
  switch (row) {
    case 'volume':
      return { ...s, volume: roundStep(clamp01(s.volume + (dir < 0 ? -0.1 : 0.1))) };
    case 'muted':
      return { ...s, muted: !s.muted };
    case 'shake': {
      // SHAKE_STEPS runs from 100% down to 0%, so Right (dir > 0) moves toward 100% and Left toward 0%.
      const i = Math.max(0, SHAKE_STEPS.indexOf(s.shake));
      const j = clamp(i + (dir < 0 ? 1 : -1), 0, SHAKE_STEPS.length - 1);
      return { ...s, shake: SHAKE_STEPS[j] };
    }
    case 'reducedFlashes':
      return { ...s, reducedFlashes: !s.reducedFlashes };
    default:
      return s;
  }
}

// Enter on a row: toggles flip, shake cycles 100 → 50 → 0 → 100, the volume row does nothing.
export function activateSetting(s, row) {
  if (row === 'shake') {
    const i = Math.max(0, SHAKE_STEPS.indexOf(s.shake));
    return { ...s, shake: SHAKE_STEPS[(i + 1) % SHAKE_STEPS.length] };
  }
  if (row === 'volume') return s;
  return stepSetting(s, row, 1);
}

export function setVolume(s, fraction) {
  return { ...s, volume: roundStep(clamp01(Number(fraction) || 0)) };
}

// The first-run how-to shows once. Blocked storage means it shows again next visit, which is harmless.
export function loadHowtoSeen(storage) {
  try {
    return storage ? storage.getItem(HOWTO_SEEN_KEY) === '1' : false;
  } catch {
    return false;
  }
}

export function saveHowtoSeen(storage) {
  try {
    if (storage) storage.setItem(HOWTO_SEEN_KEY, '1');
  } catch {
    // Storage can be blocked; the cards then show again on the next visit.
  }
}

// ---- pause options panel --------------------------------------------------------------------------
// Geometry in CSS px, shared by the drawing and the mouse hit test so they cannot disagree.
export function pauseGeometry(L) {
  const k = L.hs;
  const cx = L.winW / 2;
  const cy = L.winH / 2;
  const panel = {
    x: cx - (PANEL.w / 2) * k,
    y: cy + (PANEL.top - H / 2) * k,
    w: PANEL.w * k,
    h: PANEL.h * k,
  };
  const rowsTop = panel.y + 56 * k;
  const rows = OPTION_ROWS.map((id, i) => {
    const rowCy = rowsTop + (27 + i * 54) * k;
    return {
      id,
      x: panel.x,
      y: rowCy - 27 * k,
      w: panel.w,
      h: 54 * k,
      cy: rowCy,
      track: id === 'volume' ? { x: panel.x + 200 * k, y: rowCy - 4 * k, w: 140 * k, h: 8 * k } : null,
    };
  });
  return { k, cx, cy, panel, rows };
}

function inside(r, x, y) {
  return x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

// What a click at CSS (x, y) lands on: null outside the panel; { row, part } on a row (part 'track' is the
// volume slider); { row: null, part: 'panel' } on the panel's header or footer.
export function pauseHit(L, x, y) {
  const g = pauseGeometry(L);
  if (!inside(g.panel, x, y)) return null;
  for (let i = 0; i < g.rows.length; i++) {
    const row = g.rows[i];
    if (!inside(row, x, y)) continue;
    const tr = row.track;
    const onTrack = tr && inside({ x: tr.x - 8 * g.k, y: tr.y - 12 * g.k, w: tr.w + 16 * g.k, h: tr.h + 24 * g.k }, x, y);
    return { row: i, part: onTrack ? 'track' : 'row' };
  }
  return { row: null, part: 'panel' };
}

// Where along the volume track a CSS x falls, as a 0..1 fraction.
export function trackFraction(L, x) {
  const tr = pauseGeometry(L).rows[0].track;
  return clamp01((x - tr.x) / tr.w);
}

// ---- blink, banners and state -----------------------------------------------------------------------
// A pulse that never drops below `floor` (0.6 by default), so a prompt can blink without vanishing.
export function blinkAlpha(t, speed, floor = 0.6) {
  return floor + (1 - floor) * (0.5 + 0.5 * Math.sin(t * speed));
}

export function createHud() {
  return {
    time: 0,
    shown: 0, // score as displayed; counts up toward the real score
    lastTarget: 0,
    popT: 0, // seconds left on the score pop after a gain
    lastMult: 1,
    multT: 0, // seconds left on the multiplier pulse after a step up
    lastCharges: null,
    pipT: [0, 0, 0, 0],
    pipKind: ['', '', '', ''],
    lastHp: null,
    hpShakeT: 0,
    peakCombo: 0,
    bestChain: 0, // most kills in one dash or pulse (the kill event's `multi`)
    dashes: 0, // dashes started this run
    killDashes: 0, // dashes that killed at least one enemy (the summary's accuracy)
    dashKilled: false, // whether the current dash has killed yet
    banners: [], // { text, color, size, y, t, life }
    boss: { game: null, id: null, shown: 0, lastHp: null, maxHp: 1, flashT: 0, goneT: 0 }, // the boss bar (#129)
    alpha: { score: 1, wave: 1, hearts: 1, dash: 1, pulse: 1 },
  };
}

function addBanner(hud, text, color, size, y, life) {
  hud.banners.push({ text, color, size, y, t: 0, life });
}

// Sim events that the HUD reacts to. Called once per simulation step, after the step and its events.
export function hudEvents(hud, events, game) {
  hud.peakCombo = Math.max(hud.peakCombo, game.combo.count);
  for (const ev of events) {
    if (ev.type === 'dash') {
      hud.dashes += 1;
      hud.dashKilled = false;
    } else if (ev.type === 'kill') {
      hud.bestChain = Math.max(hud.bestChain, ev.multi ?? 1);
      // A dash that kills counts once, however many enemies it takes. Mines dashed through count too.
      if ((ev.cause === 'dash' || ev.cause === 'defuse') && !hud.dashKilled) {
        hud.dashKilled = true;
        hud.killDashes += 1;
      }
    }
    if (ev.type === 'waveStart') {
      addBanner(hud, `WAVE ${ev.wave}`, PALETTE.player, 44, 150, WAVE_BANNER_S);
    } else if (ev.type === 'heal' && ev.source === 'flawless') {
      // A flawless clear restores HP; at full HP the same heal pays out points instead.
      const text = ev.bonus > 0 ? `FLAWLESS +${ev.bonus}` : `FLAWLESS +${PICKUP.heal.restore}`;
      addBanner(hud, text, PALETTE.gold, 26, 205, FLAWLESS_BANNER_S);
    }
  }
}

// Per-frame animation and fade state. Real time, so it keeps moving through hit-stop and pause.
export function hudUpdate(hud, dt, game, L) {
  hud.time += dt;
  for (const b of hud.banners) b.t += dt;
  hud.banners = hud.banners.filter((b) => b.t < b.life);
  stepBossBar(hud, dt, game);
  if (!game) return;

  const target = game.score;
  if (target < hud.shown) hud.shown = target;
  if (target > hud.lastTarget) hud.popT = SCORE_POP_S;
  hud.lastTarget = target;
  const gap = target - hud.shown;
  if (gap > 0) hud.shown = Math.min(target, hud.shown + Math.max(1, gap * (1 - Math.exp(-dt * 10))));
  hud.popT = Math.max(0, hud.popT - dt);

  const mult = multiplierFor(game.combo.count);
  if (mult > hud.lastMult) hud.multT = MULT_PULSE_S;
  hud.lastMult = mult;
  hud.multT = Math.max(0, hud.multT - dt);

  const charges = game.player.dash.charges;
  if (hud.lastCharges === null) hud.lastCharges = charges;
  if (charges > hud.lastCharges) {
    for (let i = hud.lastCharges; i < charges && i < 4; i++) {
      hud.pipT[i] = PIP_REFILL_S;
      hud.pipKind[i] = 'refill';
    }
  } else if (charges < hud.lastCharges) {
    for (let i = charges; i < hud.lastCharges && i < 4; i++) {
      hud.pipT[i] = PIP_SPENT_S;
      hud.pipKind[i] = 'spent';
    }
  }
  hud.lastCharges = charges;
  for (let i = 0; i < 4; i++) hud.pipT[i] = Math.max(0, hud.pipT[i] - dt);

  const hp = game.player.hp;
  if (hud.lastHp !== null && hp < hud.lastHp) hud.hpShakeT = HP_SHAKE_S;
  hud.lastHp = hp;
  hud.hpShakeT = Math.max(0, hud.hpShakeT - dt);

  const covered = coveredBlocks(L, game);
  for (const name of HUD_BLOCKS) {
    const want = covered[name] ? HUD_BENEATH_ALPHA : 1;
    hud.alpha[name] += (want - hud.alpha[name]) * Math.min(1, dt * FADE_RATE);
  }
}

// ---- run summary (game over) -------------------------------------------------------------------------
// Medals by score, highest first. The thresholds are provisional until the balance pass settles them (#110).
export const MEDALS = Object.freeze([
  { id: 'abyssal', label: 'ABYSSAL', min: 30000, color: PALETTE.combo[3] },
  { id: 'gold', label: 'GOLD', min: 15000, color: PALETTE.gold },
  { id: 'silver', label: 'SILVER', min: 5000, color: '#dfe9f2' },
  { id: 'bronze', label: 'BRONZE', min: 1000, color: '#cd7f4b' },
]);
export function medalFor(score) {
  return MEDALS.find((m) => score >= m.min) ?? null;
}

// The count-up runs from COUNT_START to COUNT_START + COUNT_LEN seconds after the death.
const COUNT_START = 0.25;
const COUNT_LEN = 1.1;
export function countUp(target, age) {
  const p = clamp01((age - COUNT_START) / COUNT_LEN);
  return Math.round(target * (1 - (1 - p) ** 3));
}

// 1234567 -> "1,234,567"
export function groupDigits(n) {
  return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// m:ss for a number of seconds.
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// The finished run as the top-five list stores it (scores.js). `at` is a timestamp the caller supplies.
export function runRecord(game, hud, at) {
  return {
    score: game.score,
    wave: game.wave?.number,
    kills: game.kills,
    peakCombo: hud.peakCombo,
    chain: hud.bestChain,
    seconds: game.time,
    at,
  };
}

// The summary's stats in reading order. A stat the game does not expose is left out, never shown blank.
export function runStats(game, hud) {
  const out = [];
  const add = (label, value) => {
    if (value !== undefined && value !== null) out.push({ label, value });
  };
  add('WAVE REACHED', game.wave?.number);
  add('PEAK COMBO', hud.peakCombo);
  add('BEST MULTI', hud.bestChain > 0 ? `x${hud.bestChain}` : null);
  add('KILLS', game.kills);
  add('ACCURACY', hud.dashes > 0 ? `${Math.round((100 * hud.killDashes) / hud.dashes)}%` : null);
  add('TIME', Number.isFinite(game.time) ? formatTime(game.time) : null);
  return out;
}

// The summary's panels, in logical units (the 1280x720 arena), so the same layout fits 1920x1080, 1366x768 and 800x900.
const SUMMARY = Object.freeze({
  title: 96,
  sub: 154,
  panelTop: 186,
  panelH: 380,
  left: { x: 268, w: 344 },
  right: { x: 632, w: 384 },
  prompt: 622,
});

// The summary's panels in CSS px, for the backing and the overlap test.
export function summaryPanels(L) {
  const k = L.hs;
  const X = (v) => L.winW / 2 + (v - W / 2) * k;
  const Y = (v) => L.winH / 2 + (v - H / 2) * k;
  const panel = (p) => ({ x: X(p.x), y: Y(SUMMARY.panelTop), w: p.w * k, h: SUMMARY.panelH * k });
  return { left: panel(SUMMARY.left), right: panel(SUMMARY.right) };
}

// Every text line on the summary, in CSS px, each with its centre y (middle baseline), alignment and alpha.
// `v`: { score, highScore, newBest, overAge, time, stats (runStats), scores (top-five list), runRank }.
// These lines never overlap each other. The arena's own GAME OVER floater (feedback.js) is drawn separately and
// rises through this stack for part of its life; removing it is a feedback.js change (see #77).
export function gameOverEntries(L, v) {
  const k = L.hs;
  const X = (u) => L.winW / 2 + (u - W / 2) * k;
  const Y = (u) => L.winH / 2 + (u - H / 2) * k;
  const over = v.overAge ?? 0;
  const { left, right } = summaryPanels(L);
  const out = [];
  const line = (id, text, x, y, size, weight, color, extra = {}) =>
    out.push({ id, text, x, y, size: size * k, weight, color, align: 'left', alpha: 1, ...extra });

  out.push({ id: 'title', text: 'WRECKED', x: X(W / 2), y: Y(SUMMARY.title), size: 68 * k, weight: 'bold', color: PALETTE.danger, align: 'center', alpha: 1 });
  if (v.newBest) {
    out.push({
      id: 'best', text: 'NEW BEST!', x: X(W / 2), y: Y(SUMMARY.sub), size: 26 * k, weight: 'bold',
      color: PALETTE.combo[1], align: 'center', alpha: 1, glow: true,
    });
  } else {
    out.push({
      id: 'best', text: `Best ${groupDigits(v.highScore)}`, x: X(W / 2), y: Y(SUMMARY.sub), size: 22 * k, weight: '600',
      color: SOFT, align: 'center', alpha: 1,
    });
  }

  // Left panel: the score counts up, then the medal, then the stats in two columns.
  const lx = left.x + 26 * k;
  const ly = (u) => Y(SUMMARY.panelTop + u);
  line('scoreLabel', 'SCORE', lx, ly(34), 13, '600', DIM);
  line('score', groupDigits(countUp(v.score ?? 0, over)), lx, ly(92), 56, 'bold', PALETTE.gold);
  const medal = medalFor(v.score ?? 0);
  const medalAlpha = clamp01((over - (COUNT_START + COUNT_LEN)) / 0.25);
  if (medal) {
    line('medal', medal.label, lx + 46 * k, ly(146), 20, 'bold', medal.color, { alpha: medalAlpha });
  } else {
    line('medal', `Reach ${groupDigits(MEDALS[MEDALS.length - 1].min)} for a medal`, lx, ly(146), 15, '600', DIM, { alpha: medalAlpha });
  }
  const stats = v.stats ?? [];
  stats.forEach((s, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    // left.w is already in CSS px, so only the logical offsets are scaled here.
    const sx = col === 0 ? left.x + 26 * k : left.x + left.w / 2 + 8 * k;
    const reveal = clamp01((over - (1.2 + i * 0.15)) / 0.25);
    line(`stat${i}`, s.label, sx, ly(206 + row * 58), 12, '600', DIM, { alpha: reveal });
    const shown = typeof s.value === 'number' ? groupDigits(s.value) : String(s.value);
    line(`statv${i}`, shown, sx, ly(232 + row * 58), 26, 'bold', PALETTE.player, { alpha: reveal });
  });

  // Right panel: the top five. This run's row is highlighted by the caller, using runRank.
  const rx = right.x + 22 * k;
  const ry = (u) => Y(SUMMARY.panelTop + u);
  const tableAlpha = clamp01((over - 0.9) / 0.3);
  line('tableHead', 'TOP SCORES', rx, ry(34), 13, '600', DIM, { alpha: tableAlpha });
  const colScore = right.x + 200 * k;
  const colWave = right.x + 282 * k;
  const colTime = right.x + right.w - 22 * k;
  const head = (id, text, x) => out.push({ id, text, x, y: ry(64), size: 12 * k, weight: '600', color: DIM, align: 'right', alpha: tableAlpha });
  head('hScore', 'SCORE', colScore);
  head('hWave', 'WAVE', colWave);
  head('hTime', 'TIME', colTime);
  const scores = v.scores ?? [];
  for (let i = 0; i < TOP_N; i++) {
    const e = scores[i];
    const isRun = i === v.runRank;
    const color = isRun ? PALETTE.gold : SOFT;
    const y = ry(92 + i * 52);
    const base = { y, weight: isRun ? 'bold' : '600', color, alpha: tableAlpha };
    out.push({ id: `rank${i}`, text: `${i + 1}`, x: rx, size: 18 * k, align: 'left', ...base });
    out.push({ id: `tscore${i}`, text: e ? groupDigits(e.score) : '—', x: colScore, size: 18 * k, align: 'right', ...base });
    out.push({ id: `twave${i}`, text: e?.wave != null ? String(e.wave) : '—', x: colWave, size: 18 * k, align: 'right', ...base });
    out.push({ id: `ttime${i}`, text: e?.seconds != null ? formatTime(e.seconds) : '—', x: colTime, size: 18 * k, align: 'right', ...base });
  }
  if (v.runRank < 0 && (v.score ?? 0) > 0) {
    out.push({
      id: 'thisRun', text: `This run  ${groupDigits(v.score)}`, x: rx, y: ry(352), size: 15 * k, weight: '600',
      color: DIM, align: 'left', alpha: tableAlpha,
    });
  }

  if (over >= SUMMARY_GATE) {
    out.push({
      id: 'prompt', text: 'Click, Space or R to dive again', x: X(W / 2), y: Y(SUMMARY.prompt), size: 22 * k,
      weight: 'bold', color: PALETTE.dash, align: 'center', alpha: blinkAlpha(v.time ?? 0, 5, 0.6),
    });
  }
  return out;
}

// ---- drawing ----------------------------------------------------------------------------------------
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function backing(ctx, r, k) {
  ctx.fillStyle = BACKING;
  roundRect(ctx, r.x, r.y, r.w, r.h, 14 * k);
  ctx.fill();
  ctx.strokeStyle = BACKING_EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Draws `fn` with the block's fade alpha; the alpha is restored afterwards.
function group(ctx, alpha, fn) {
  ctx.save();
  ctx.globalAlpha = ctx.globalAlpha * alpha;
  fn();
  ctx.restore();
}

function text(ctx, s, x, y, font, color, align = 'left', baseline = 'alphabetic') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

function dimWindow(ctx, L, alpha) {
  ctx.fillStyle = `rgba(2, 5, 13, ${alpha})`;
  ctx.fillRect(0, 0, L.winW, L.winH);
}

// Small shapes for the modifier rows, one per kind, in the kind's colour.
function drawIcon(ctx, kind, x, y, r, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.beginPath();
  if (kind === 'sparkCoral') {
    ctx.moveTo(0, -r);
    ctx.lineTo(r, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r, 0);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'riptideCoal') {
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.9, r * 0.7);
    ctx.lineTo(-r * 0.9, r * 0.7);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'shieldScale') {
    ctx.lineWidth = 2;
    ctx.arc(0, 0, r * 0.85, 0, TAU);
    ctx.stroke();
  } else if (kind === 'frenzy') {
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const rad = i % 2 === 0 ? r : r * 0.4;
      if (i === 0) ctx.moveTo(Math.cos(a) * rad, Math.sin(a) * rad);
      else ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.arc(0, 0, r * 0.8, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawScoreBlock(ctx, L, game, hud, boxes) {
  const k = L.hs;
  const ax = (v) => v * k;
  const tierColor = PALETTE.combo[game.combo.tier] ?? PALETTE.player;
  group(ctx, hud.alpha.score, () => {
    backing(ctx, boxes.score, k);
    text(ctx, 'SCORE', ax(28), ax(32), `600 ${13 * k}px ${FONT}`, DIM);

    const shown = String(Math.round(hud.shown));
    const pop = 1 + 0.22 * (hud.popT / SCORE_POP_S);
    ctx.save();
    ctx.translate(ax(28), ax(72));
    ctx.scale(pop, pop);
    text(ctx, shown, 0, 0, `bold ${40 * k}px ${FONT}`, PALETTE.gold);
    ctx.font = `bold ${40 * k}px ${FONT}`;
    const scoreWidth = ctx.measureText(shown).width * pop;
    ctx.restore();

    const mult = multiplierFor(game.combo.count);
    const mp = 1 + 0.45 * (hud.multT / MULT_PULSE_S);
    ctx.save();
    ctx.translate(ax(28) + scoreWidth + ax(14), ax(72));
    ctx.scale(mp, mp);
    text(ctx, `x${mult}`, 0, 0, `bold ${26 * k}px ${FONT}`, tierColor);
    ctx.restore();

    // Combo timer bar: coloured by tier, and it flashes when nearly empty.
    const count = game.combo.count;
    const frac = count > 0 ? clamp01(game.combo.timer / comboWindowFor(count)) : 0;
    const barY = ax(88);
    const barW = 260 * k;
    const barH = 8 * k;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(ax(28), barY, barW, barH);
    const low = count > 0 && frac < 0.25;
    const a = ctx.globalAlpha;
    if (low) ctx.globalAlpha = a * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(hud.time * 22)));
    ctx.fillStyle = tierColor;
    ctx.shadowColor = tierColor;
    ctx.shadowBlur = 10 * k;
    ctx.fillRect(ax(28), barY, barW * frac, barH);
    ctx.shadowBlur = 0;
    ctx.globalAlpha = a;
    if (count > 0) text(ctx, `COMBO ${count}`, ax(28), ax(120), `600 ${15 * k}px ${FONT}`, tierColor);

    // Active modifiers: icon, name, and a bar that shrinks as the modifier runs out.
    Object.keys(game.modifiers)
      .sort()
      .forEach((kind, i) => {
        const y = ax(160 + 28 * i);
        const color = PICKUP_KINDS[kind]?.color ?? PALETTE.player;
        const dur = MODIFIER[kind]?.duration ?? 1;
        const left = clamp01(game.modifiers[kind] / dur);
        drawIcon(ctx, kind, ax(40), y, 8 * k, color);
        text(ctx, PICKUP_KINDS[kind]?.label ?? kind, ax(58), y, `600 ${13 * k}px ${FONT}`, SOFT, 'left', 'middle');
        ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
        ctx.fillRect(ax(170), y - 4 * k, 150 * k, 8 * k);
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 8 * k;
        ctx.fillRect(ax(170), y - 4 * k, 150 * k * left, 8 * k);
        ctx.shadowBlur = 0;
      });
  });
}

function drawWaveBlock(ctx, L, game, hud, boxes, best) {
  const k = L.hs;
  const rx = L.winW - 28 * k; // right-aligned text, 28 logical px in from the window edge
  group(ctx, hud.alpha.wave, () => {
    backing(ctx, boxes.wave, k);
    text(ctx, 'WAVE', rx, 32 * k, `600 ${13 * k}px ${FONT}`, DIM, 'right');
    text(ctx, String(game.wave.number), rx, 72 * k, `bold ${40 * k}px ${FONT}`, PALETTE.player, 'right');
    text(ctx, `BEST ${best}`, rx, 100 * k, `600 ${15 * k}px ${FONT}`, DIM, 'right');
  });
}

function drawHeartsBlock(ctx, L, game, hud, boxes) {
  const k = L.hs;
  const by = (v) => L.winH - (H - v) * k;
  group(ctx, hud.alpha.hearts, () => {
    backing(ctx, boxes.hearts, k);
    const shake = hud.hpShakeT > 0 ? Math.sin(hud.time * 70) * 3.5 * k * (hud.hpShakeT / HP_SHAKE_S) : 0;
    for (let i = 0; i < PLAYER.maxHp; i++) {
      const hx = (40 + i * 34) * k + shake;
      const hy = by(H - 40);
      ctx.beginPath();
      ctx.arc(hx, hy, 11 * k, 0, TAU);
      if (i < game.player.hp) {
        ctx.fillStyle = PALETTE.player;
        ctx.shadowColor = PALETTE.player;
        ctx.shadowBlur = 10 * k;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = PALETTE.danger;
        ctx.lineWidth = 2 * k;
        ctx.stroke();
      }
    }
  });
}

function drawDashBlock(ctx, L, game, hud, boxes) {
  const k = L.hs;
  const by = (v) => L.winH - (H - v) * k;
  const d = game.player.dash;
  const maxCharges = dashMaxCharges(game);
  group(ctx, hud.alpha.dash, () => {
    backing(ctx, boxes.dash, k);
    for (let i = 0; i < maxCharges; i++) {
      const px = L.winW / 2 + (i - (maxCharges - 1) / 2) * 52 * k;
      const py = by(H - 42);
      const ready = i < d.charges;
      const recharging = i === d.charges && d.charges < maxCharges;
      const t = hud.pipT[i] ?? 0;
      const kind = hud.pipKind[i];
      let scale = 1;
      if (t > 0 && kind === 'refill') scale = 1 + 0.45 * (t / PIP_REFILL_S);
      if (t > 0 && kind === 'spent') scale = 1 + 0.3 * Math.sin(Math.PI * (1 - t / PIP_SPENT_S));
      const s = 9 * k;
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.scale(scale, scale);
      ctx.strokeStyle = PALETTE.dash;
      ctx.lineWidth = 2 * k;
      if (ready) {
        ctx.fillStyle = PALETTE.dash;
        ctx.shadowColor = PALETTE.dash;
        ctx.shadowBlur = (10 + (t > 0 && kind === 'refill' ? 14 * (t / PIP_REFILL_S) : 0)) * k;
        ctx.fillRect(-s, -s, 2 * s, 2 * s);
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeRect(-s, -s, 2 * s, 2 * s);
        if (recharging) {
          const f = Math.min(1, d.recharge / DASH.rechargeTime);
          ctx.fillStyle = 'rgba(234, 255, 255, 0.5)';
          ctx.fillRect(-s, s - 2 * s * f, 2 * s, 2 * s * f);
        }
      }
      ctx.restore();
    }
    text(ctx, 'DASH', L.winW / 2, by(H - 14), `600 ${12 * k}px ${FONT}`, FAINT, 'center');
  });
}

function drawPulseBlock(ctx, L, game, hud, boxes) {
  const k = L.hs;
  const by = (v) => L.winH - (H - v) * k;
  const cd = game.player.pulseCooldown;
  const cdFrac = cd > 0 ? 1 - cd / PULSE.cooldown : 1;
  const rx = L.winW - 62 * k;
  const ry = by(H - 52);
  group(ctx, hud.alpha.pulse, () => {
    backing(ctx, boxes.pulse, k);
    ctx.beginPath();
    ctx.arc(rx, ry, 20 * k, 0, TAU);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.lineWidth = 4 * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rx, ry, 20 * k, -Math.PI / 2, -Math.PI / 2 + TAU * cdFrac);
    ctx.strokeStyle = cdFrac >= 1 ? PALETTE.gold : PALETTE.player;
    ctx.stroke();
    text(ctx, 'PULSE', rx, by(H - 14), `600 ${12 * k}px ${FONT}`, FAINT, 'center');
  });
}

function drawBanners(ctx, L, hud) {
  const k = L.hs;
  const cx = L.winW / 2;
  const cy = L.winH / 2;
  for (const b of hud.banners) {
    const grow = b.t < 0.16 ? 1.25 - 0.25 * (b.t / 0.16) : 1;
    const fade = b.t > b.life - 0.4 ? Math.max(0, (b.life - b.t) / 0.4) : 1;
    const y = cy + (b.y - H / 2) * k;
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * fade;
    ctx.translate(cx, y);
    ctx.scale(grow, grow);
    ctx.shadowColor = b.color;
    ctx.shadowBlur = 18 * k;
    text(ctx, b.text, 0, 0, `bold ${b.size * k}px ${FONT}`, b.color, 'center', 'middle');
    ctx.restore();
  }
}

// ---- boss health bar (#129) ------------------------------------------------------------------------
// The Warden's bar at the top of the arena: its name, one segment per hit point (each dash on the exposed core
// takes one), a tick at the phase 2 line, a ghost of the hit points just lost, a flash on each hit, and the weak
// point state. When the Warden falls the bar reads DEFEATED for a moment, then goes.
const BOSS_NAME = 'ANGLERFISH WARDEN';
const BOSS_FLASH_S = 0.25; // a hit point lost: the segments flash this long (real time)
const BOSS_GONE_S = 1.4; // DEFEATED stays this long after the Warden falls (real time)
const BOSS_GHOST_RATE = 5; // per second: how fast the ghost of lost hit points drops onto the live count

// The Warden on the field, or null.
export function bossOf(game) {
  if (!game || !Array.isArray(game.enemies)) return null;
  for (const e of game.enemies) if (e.kind === 'warden' && e.alive !== false) return e;
  return null;
}

// Where the bar sits, in CSS px. Centred on the window, beside the top panels, when there is room between them;
// below them when there is not, so the bar never covers a HUD block.
export function bossBarBox(L, modCount = 0) {
  const k = L.hs;
  const w = L.winW;
  const boxes = hudBoxes(L, modCount);
  const room = 2 * Math.min(w / 2 - (boxes.score.x + boxes.score.w + 12 * k), boxes.wave.x - 12 * k - w / 2);
  const h = 46 * k;
  if (room >= 260 * k) {
    const bw = Math.min(440 * k, room);
    return { x: w / 2 - bw / 2, y: 8 * k, w: bw, h };
  }
  const top = Math.max(boxes.score.y + boxes.score.h, boxes.wave.y + boxes.wave.h) + 8 * k;
  const bw = Math.min(440 * k, w - 24 * k);
  return { x: w / 2 - bw / 2, y: top, w: bw, h };
}

// Keeps the bar's animation state, in real time. A new game resets it; a Warden that leaves starts DEFEATED.
export function stepBossBar(hud, dt, game) {
  const b = hud.boss;
  if (b.game !== game) Object.assign(b, { game, id: null, shown: 0, lastHp: null, maxHp: 1, flashT: 0, goneT: 0 });
  b.flashT = Math.max(0, b.flashT - dt);
  b.goneT = Math.max(0, b.goneT - dt);
  const e = bossOf(game);
  if (e === null) {
    if (b.id !== null) {
      b.goneT = BOSS_GONE_S;
      b.id = null;
    }
    return;
  }
  if (b.id !== e) {
    b.id = e;
    b.shown = e.hp;
    b.lastHp = e.hp;
    b.goneT = 0;
  }
  if (e.hp < b.lastHp) b.flashT = BOSS_FLASH_S;
  b.lastHp = e.hp;
  b.maxHp = e.maxHp;
  b.shown += (e.hp - b.shown) * Math.min(1, dt * BOSS_GHOST_RATE);
}

// Draws the bar while the Warden lives, and for its DEFEATED beat after. Returns false when there is nothing to draw.
export function drawBossBar(ctx, L, game, hud) {
  const b = hud.boss;
  const e = bossOf(game);
  const live = e !== null;
  if (!live && !(b.goneT > 0)) return false;
  const k = L.hs;
  const box = bossBarBox(L, Object.keys(game.modifiers).length);
  const fade = live ? 1 : clamp01(b.goneT / BOSS_GONE_S);
  const maxHp = Math.max(1, Math.round(live ? e.maxHp : b.maxHp));
  const hp = live ? Math.max(0, e.hp) : 0;
  const phase2 = live && e.phase === 2;
  const liveColor = phase2 ? PALETTE.wardenPhase2 : PALETTE.danger;
  const open = live && !!e.exposed;
  group(ctx, fade, () => {
    backing(ctx, box, k);
    const x0 = box.x + 10 * k;
    const inner = box.w - 20 * k;
    // The name on the left; on the right, WEAK POINT OPEN while the core can be hit, else the phase.
    text(ctx, live ? BOSS_NAME : 'DEFEATED', x0, box.y + 17 * k, `bold ${13 * k}px ${FONT}`, live ? SOFT : PALETTE.gold);
    if (live) {
      const label = open ? 'WEAK POINT OPEN' : phase2 ? 'PHASE 2' : 'PHASE 1';
      text(ctx, label, x0 + inner, box.y + 17 * k, `bold ${12 * k}px ${FONT}`, open ? PALETTE.gold : DIM, 'right');
    }
    // One segment per hit point.
    const gap = 3 * k;
    const segW = (inner - gap * (maxHp - 1)) / maxHp;
    const sy = box.y + 27 * k;
    const sh = 11 * k;
    const segX = (i) => x0 + i * (segW + gap);
    const ghostTo = live ? Math.ceil(b.shown) : 0;
    const flash = live && b.flashT > 0 ? 0.6 * (b.flashT / BOSS_FLASH_S) : 0;
    for (let i = 0; i < maxHp; i++) {
      ctx.fillStyle = 'rgba(234, 255, 255, 0.08)';
      ctx.fillRect(segX(i), sy, segW, sh);
      if (i < hp) {
        ctx.fillStyle = liveColor;
        ctx.fillRect(segX(i), sy, segW, sh);
        if (flash > 0) {
          ctx.fillStyle = `rgba(255, 255, 255, ${flash})`;
          ctx.fillRect(segX(i), sy, segW, sh);
        }
      } else if (i < ghostTo) {
        ctx.fillStyle = 'rgba(234, 255, 255, 0.35)';
        ctx.fillRect(segX(i), sy, segW, sh);
      }
    }
    // The phase 2 line: the bar passes it at half hit points.
    if (live && maxHp >= 2) {
      ctx.fillStyle = SOFT;
      ctx.fillRect(segX(Math.floor(maxHp / 2)) - gap / 2 - 0.75 * k, sy - 3 * k, 1.5 * k, sh + 6 * k);
    }
    // The weak point: a gold outline that pulses while the core is open.
    if (open) {
      const pulse = 0.5 + 0.5 * Math.sin(hud.time * 14);
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (0.5 + 0.5 * pulse);
      ctx.strokeStyle = PALETTE.gold;
      ctx.lineWidth = 2 * k;
      roundRect(ctx, box.x - 2 * k, box.y - 2 * k, box.w + 4 * k, box.h + 4 * k, 16 * k);
      ctx.stroke();
      ctx.restore();
    }
  });
  return true;
}

// The in-game HUD for the playing and paused screens (the paused screen dims it).
function drawHud(ctx, L, game, hud, best, showBanners) {
  const boxes = hudBoxes(L, Object.keys(game.modifiers).length);
  drawScoreBlock(ctx, L, game, hud, boxes);
  drawWaveBlock(ctx, L, game, hud, boxes, best);
  drawHeartsBlock(ctx, L, game, hud, boxes);
  drawDashBlock(ctx, L, game, hud, boxes);
  drawPulseBlock(ctx, L, game, hud, boxes);
  if (showBanners) drawBanners(ctx, L, hud);
}

// Runs `fn` in arena logical units (1280x720, centred in the window, scaled by L.hs). Glow radii passed to
// shadowBlur are not transformed, so callers multiply them by k themselves (see glowBlur).
function inArena(ctx, L, fn) {
  const k = L.hs;
  ctx.save();
  ctx.translate(L.winW / 2, L.winH / 2);
  ctx.scale(k, k);
  ctx.translate(-W / 2, -H / 2);
  fn(k);
  ctx.restore();
}

// A bright band that travels across a run of text: base colour, a hot centre at position p (0..1 across), base again.
function sweepGradient(ctx, x0, x1, base, hot, p) {
  const g = ctx.createLinearGradient(x0, 0, x1, 0);
  const c = (f) => clamp01(f);
  g.addColorStop(0, base);
  g.addColorStop(c(p - 0.12), base);
  g.addColorStop(c(p), hot);
  g.addColorStop(c(p + 0.12), base);
  g.addColorStop(1, base);
  return g;
}

// A keycap drawn in arena units (the caller has scaled the context): a rounded key with its label.
function keycap(ctx, label, cx, cy) {
  ctx.font = `bold 15px ${FONT}`;
  const w = Math.max(48, ctx.measureText(label).width + 22);
  const h = 30;
  ctx.fillStyle = 'rgba(234, 255, 255, 0.07)';
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 7);
  ctx.fill();
  ctx.strokeStyle = 'rgba(60, 242, 255, 0.55)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  // The darker lower edge gives the cap its weight.
  ctx.fillStyle = 'rgba(60, 242, 255, 0.18)';
  roundRect(ctx, cx - w / 2 + 2, cy + h / 2 - 5, w - 4, 3, 2);
  ctx.fill();
  text(ctx, label, cx, cy + 1, `bold 15px ${FONT}`, PALETTE.gold, 'center', 'middle');
  return w;
}

// The figure-eight the title fish swims: x runs once around, y twice, so the path crosses itself.
const EIGHT = Object.freeze({ cx: W / 2, cy: 430, ax: 300, ay: 56, speed: 0.75 });

function drawTitle(ctx, L, view) {
  const t = view.time ?? 0;
  dimWindow(ctx, L, 0.45);
  inArena(ctx, L, (k) => {
    // The logo: a slow wobble, and a glow band that sweeps across the letters every few seconds.
    ctx.save();
    ctx.translate(W / 2, 196 + Math.sin(t * 1.7) * 3);
    ctx.rotate(Math.sin(t * 1.1) * 0.025);
    ctx.font = `bold 96px ${FONT}`;
    const logoW = ctx.measureText('RIPTIDE RUSH').width;
    // On a narrow window the logo shrinks to keep 40 px clear on each side.
    const fit = Math.min(1, (L.winW / k - 80) / logoW);
    ctx.scale(fit, fit);
    const p = ((t % 3.6) / 3.6) * 1.5 - 0.25; // travels from before the left edge to past the right, then rests
    ctx.shadowColor = PALETTE.player;
    ctx.shadowBlur = 30 * k; // shadows are not transformed, so this one is in CSS px
    ctx.fillStyle = sweepGradient(ctx, -logoW / 2, logoW / 2, PALETTE.player, '#ffffff', p);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('RIPTIDE RUSH', 0, 0);
    ctx.restore();

    text(ctx, 'Dash through everything. Every kill refunds a charge.', W / 2, 270, `24px ${FONT}`, PALETTE.dash, 'center', 'middle');

    // The fish and three drifters on the figure-eight. Each drifter trails the fish a little further back.
    const at = (a) => ({ x: EIGHT.cx + EIGHT.ax * Math.sin(a), y: EIGHT.cy + EIGHT.ay * Math.sin(2 * a) });
    const heading = (a) => Math.atan2(2 * EIGHT.ay * Math.cos(2 * a), EIGHT.ax * Math.cos(a));
    const th = t * EIGHT.speed;
    // The path itself, faint, so the figure-eight reads as one loop rather than random swimming.
    ctx.beginPath();
    for (let i = 0; i <= 96; i++) {
      const q = at((i / 96) * Math.PI * 2);
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(60, 242, 255, 0.12)';
    ctx.lineWidth = 2;
    ctx.stroke();
    [
      { lag: 0.55, size: 1.05 },
      { lag: 1.1, size: 0.9 },
      { lag: 1.75, size: 0.8 },
    ].forEach(({ lag, size }) => {
      const a = th - lag;
      const q = at(a);
      draw.enemy(ctx, 'drifter', q.x, q.y, heading(a), t, { scale: size * 1.2 });
    });
    const f = at(th);
    draw.player(ctx, f.x, f.y, heading(th), t, { scale: 1.5 });

    // Controls: key caps with what each one does. Three groups across, centred.
    const groups = [
      { keys: 'WASD', what: 'swim' },
      { keys: 'MOUSE', what: 'aim' },
      { keys: 'CLICK · SPACE', what: 'dash-slash' },
      { keys: 'RIGHT · SHIFT', what: 'pulse' },
    ];
    groups.forEach((g, i) => {
      const cx = W / 2 + (i - 1.5) * 180;
      keycap(ctx, g.keys, cx, 540);
      text(ctx, g.what, cx, 582, `16px ${FONT}`, SOFT, 'center', 'middle');
    });

    group(ctx, blinkAlpha(t, 4, 0.6), () => {
      text(ctx, 'Click or press Space to dive in', W / 2, 630, `bold 26px ${FONT}`, PALETTE.gold, 'center', 'middle');
    });
    const best = view.highScore > 0 ? `BEST  ${groupDigits(view.highScore)}` : 'No best yet';
    text(ctx, best, W / 2, 670, `20px ${FONT}`, DIM, 'center', 'middle');
    text(ctx, 'M  mute        Esc  options', W / 2, 702, `14px ${FONT}`, FAINT, 'center', 'middle');
  });
}

// ---- first-run how-to (#110) -------------------------------------------------------------------------
// Three cards, one at a time. Each has a short animation drawn in arena units (see inArena).
export const HOWTO_CARDS = Object.freeze([
  {
    id: 'dash',
    title: 'DASH THROUGH',
    lines: ['Dash-slash through enemies to kill them.', 'Every kill refunds a dash charge straight away.'],
    keys: 'Left click or Space',
  },
  {
    id: 'chain',
    title: 'CHAIN KILLS',
    lines: ['Each kill adds to your combo and multiplies', 'your score. Keep the chain before the timer runs out.'],
    keys: 'The bar under the score is your combo timer',
  },
  {
    id: 'pulse',
    title: 'PULSE REFLECTS',
    lines: ['A short pulse reflects enemy bullets back at their shooters.', 'Time it for a perfect pulse: slow motion and a quick cooldown.'],
    keys: 'Right click or Shift',
  },
]);

const CARD = Object.freeze({ x: 320, y: 96, w: 640, h: 440 });

// The how-to card, the skip button and the card dots, in CSS px.
export function howtoLayout(L) {
  const k = L.hs;
  const X = (u) => L.winW / 2 + (u - W / 2) * k;
  const Y = (u) => L.winH / 2 + (u - H / 2) * k;
  return {
    k,
    X,
    Y,
    card: { x: X(CARD.x), y: Y(CARD.y), w: CARD.w * k, h: CARD.h * k },
    skip: { x: X(CARD.x + CARD.w - 170), y: Y(CARD.y + 14), w: 150 * k, h: 30 * k },
    dotsY: Y(CARD.y + CARD.h + 34),
  };
}

// What a click at CSS (x, y) hits on the how-to screen: 'skip', or null.
export function howtoHit(L, x, y) {
  const g = howtoLayout(L);
  return inside(g.skip, x, y) ? 'skip' : null;
}

// Each illustration runs on its own clock, in arena units centred on (W/2, H/2).
const ILLUSTRATION = {
  // A fish dashes left to right through three drifters. Each one dies as the fish reaches it.
  dash(ctx, t, k) {
    const period = 2.6;
    const p = (t % period) / period;
    const x0 = 360;
    const x1 = 920;
    const y = 232;
    const fx = x0 + (x1 - x0) * clamp01(p / 0.6);
    const fade = p < 0.08 ? p / 0.08 : p > 0.9 ? (1 - p) / 0.1 : 1;
    const drifters = [560, 680, 800];
    ctx.save();
    ctx.globalAlpha = clamp01(fade);
    // The dash streak, behind the fish.
    if (p < 0.6) {
      const g = ctx.createLinearGradient(x0, 0, fx, 0);
      g.addColorStop(0, 'rgba(234, 255, 255, 0)');
      g.addColorStop(1, PALETTE.dash);
      ctx.strokeStyle = g;
      ctx.lineWidth = 8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(fx, y);
      ctx.stroke();
    }
    drifters.forEach((dx, i) => {
      const dy = y + (i === 1 ? -26 : i === 2 ? 22 : 0);
      if (fx < dx - 10) {
        draw.enemy(ctx, 'drifter', dx, dy, 0, t, { scale: 1.2 });
      } else {
        // A thin ring where the drifter died, fading as it grows.
        const age = clamp01((fx - dx) / 70);
        ctx.save();
        ctx.globalAlpha *= 1 - age;
        ctx.strokeStyle = PALETTE.gold;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(dx, dy, 10 + 30 * age, 0, TAU);
        ctx.stroke();
        ctx.restore();
      }
    });
    draw.player(ctx, fx, y, 0, t, { scale: 1.35 });
    ctx.restore();
  },

  // The combo counts up through the tiers; the multiplier steps at each 5 kills.
  chain(ctx, t, k) {
    const count = Math.floor((t * 1.5) % 8);
    const mult = multiplierFor(count);
    const tier = tierFor(count);
    const color = PALETTE.combo[tier] ?? PALETTE.player;
    const pop = 1 + 0.18 * Math.max(0, 1 - ((t * 1.5) % 1) / 0.25);
    text(ctx, 'COMBO', W / 2, 180, `600 16px ${FONT}`, DIM, 'center', 'middle');
    ctx.save();
    ctx.translate(W / 2, 236);
    ctx.scale(pop, pop);
    text(ctx, `${count}`, 0, 0, `bold 72px ${FONT}`, color, 'center', 'middle');
    ctx.restore();
    text(ctx, `x${mult}`, W / 2 + 92, 236, `bold 40px ${FONT}`, PALETTE.gold, 'center', 'middle');
    // Eight pips: lit up to the combo.
    for (let i = 0; i < 8; i++) {
      const px = W / 2 + (i - 3.5) * 40;
      ctx.beginPath();
      ctx.arc(px, 318, 10, 0, TAU);
      if (i < count) {
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10 * k;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.strokeStyle = 'rgba(234, 255, 255, 0.35)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  },

  // A spitter fires; the fish pulses and the bullet turns back and downs the spitter. Three seconds a loop.
  pulse(ctx, t, k) {
    const c = t % 3;
    const fishX = 470; // the ring reaches 110 units either side, so the fish sits well inside the card
    const spitX = 910;
    const y = 262;
    const hitX = fishX + 110;
    // The spitter is there until its bullet comes back to it, then it bursts.
    if (c < 1.5) draw.enemy(ctx, 'spitter', spitX, y, Math.PI, t, { scale: 1.25 });
    else {
      const age = clamp01((c - 1.5) / 0.4);
      ctx.strokeStyle = PALETTE.gold;
      ctx.lineWidth = 3 * (1 - age);
      ctx.beginPath();
      ctx.arc(spitX, y, 10 + 40 * age, 0, TAU);
      ctx.stroke();
    }
    // The bullet flies left, meets the pulse ring, then flies back.
    if (c >= 0.3 && c < 1.5) {
      const bx = c < 0.9 ? spitX - ((c - 0.3) / 0.6) * (spitX - hitX) : hitX + ((c - 0.9) / 0.6) * (spitX - hitX);
      draw.bullet(ctx, bx, y, t, {});
    }
    // The pulse ring grows out from the fish as the bullet meets it, then fades.
    if (c >= 0.7 && c < 1.5) {
      const r = 110 * clamp01((c - 0.7) / 0.2);
      draw.pulse(ctx, fishX, y, r, clamp01(1 - (c - 0.9) / 0.6));
    }
    if (c >= 0.9 && c < 1.6) {
      text(ctx, 'REFLECTED', fishX, y - 48, `bold 16px ${FONT}`, PALETTE.player, 'center', 'middle');
    }
    draw.player(ctx, fishX, y, 0, t, { scale: 1.35 });
  },
};

// The how-to screen: one card at a time, with its illustration, the skip button and the card dots.
function drawHowto(ctx, L, view) {
  dimWindow(ctx, L, 0.72);
  const g = howtoLayout(L);
  const k = g.k;
  const index = clamp(view.howtoIndex ?? 0, 0, HOWTO_CARDS.length - 1);
  const card = HOWTO_CARDS[index];
  const t = view.time ?? 0;
  const X = (u) => g.X(u);
  const Y = (u) => g.Y(u);

  // The card panel. Nearly opaque, so the paused arena's ghost aim line does not show through the card.
  ctx.fillStyle = 'rgba(3, 8, 20, 0.96)';
  roundRect(ctx, g.card.x, g.card.y, g.card.w, g.card.h, 16 * k);
  ctx.fill();
  ctx.strokeStyle = 'rgba(60, 242, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  text(ctx, `HOW TO PLAY   ${index + 1} / ${HOWTO_CARDS.length}`, g.card.x + 26 * k, Y(CARD.y + 30), `600 ${14 * k}px ${FONT}`, DIM, 'left', 'middle');
  text(ctx, 'Esc  skip', g.skip.x + g.skip.w, Y(CARD.y + 30), `600 ${14 * k}px ${FONT}`, PALETTE.player, 'right', 'middle');

  // The illustration sits in its own strip of the card, clipped to it, drawn in arena units.
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.card.x, Y(CARD.y + 56), g.card.w, 236 * k);
  ctx.clip();
  ctx.translate(L.winW / 2, L.winH / 2);
  ctx.scale(k, k);
  ctx.translate(-W / 2, -H / 2);
  ILLUSTRATION[card.id](ctx, t, k);
  ctx.restore();

  text(ctx, card.title, X(W / 2), Y(CARD.y + 318), `bold ${30 * k}px ${FONT}`, PALETTE.gold, 'center', 'middle');
  card.lines.forEach((line, i) => {
    text(ctx, line, X(W / 2), Y(CARD.y + 352 + i * 26), `${18 * k}px ${FONT}`, SOFT, 'center', 'middle');
  });
  text(ctx, card.keys, X(W / 2), Y(CARD.y + 412), `600 ${16 * k}px ${FONT}`, PALETTE.player, 'center', 'middle');

  // The dots, one per card; the current one is filled.
  HOWTO_CARDS.forEach((_, i) => {
    const dx = X(W / 2) + (i - (HOWTO_CARDS.length - 1) / 2) * 22 * k;
    ctx.beginPath();
    ctx.arc(dx, g.dotsY, 5 * k, 0, TAU);
    if (i === index) {
      ctx.fillStyle = PALETTE.player;
      ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(234, 255, 255, 0.4)';
      ctx.lineWidth = 1.5 * k;
      ctx.stroke();
    }
  });
  text(ctx, 'Click or Space: next     Left / Right: browse', X(W / 2), Y(CARD.y + CARD.h + 72), `${15 * k}px ${FONT}`, FAINT, 'center', 'middle');
}

function drawOptions(ctx, L, view) {
  const g = pauseGeometry(L);
  const k = g.k;
  const s = view.settings ?? DEFAULT_SETTINGS;
  const sel = view.menuRow ?? 0;
  const p = g.panel;
  ctx.fillStyle = PANEL_FILL;
  roundRect(ctx, p.x, p.y, p.w, p.h, 14 * k);
  ctx.fill();
  ctx.strokeStyle = 'rgba(60, 242, 255, 0.3)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  text(ctx, 'OPTIONS', p.x + 22 * k, p.y + 30 * k, `600 ${14 * k}px ${FONT}`, DIM);

  for (let i = 0; i < g.rows.length; i++) {
    const row = g.rows[i];
    if (i === sel) {
      ctx.fillStyle = 'rgba(60, 242, 255, 0.12)';
      roundRect(ctx, row.x + 8 * k, row.y + 3 * k, row.w - 16 * k, row.h - 6 * k, 8 * k);
      ctx.fill();
      ctx.fillStyle = PALETTE.player;
      ctx.beginPath();
      ctx.moveTo(p.x + 12 * k, row.cy - 6 * k);
      ctx.lineTo(p.x + 20 * k, row.cy);
      ctx.lineTo(p.x + 12 * k, row.cy + 6 * k);
      ctx.closePath();
      ctx.fill();
    }
    text(ctx, OPTION_LABELS[row.id], p.x + 30 * k, row.cy, `${18 * k}px ${FONT}`, SOFT, 'left', 'middle');

    let value;
    if (row.id === 'volume') value = `${Math.round(s.volume * 100)}%`;
    else if (row.id === 'muted') value = s.muted ? 'On' : 'Off';
    else if (row.id === 'shake') value = `${Math.round(s.shake * 100)}%`;
    else if (row.id === 'howto') value = '›';
    else value = s.reducedFlashes ? 'On' : 'Off';
    text(ctx, value, p.x + p.w - 22 * k, row.cy, `bold ${18 * k}px ${FONT}`, PALETTE.gold, 'right', 'middle');

    if (row.track) {
      const tr = row.track;
      ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.fillRect(tr.x, tr.y, tr.w, tr.h);
      ctx.fillStyle = PALETTE.player;
      ctx.fillRect(tr.x, tr.y, tr.w * s.volume, tr.h);
      ctx.beginPath();
      ctx.arc(tr.x + tr.w * s.volume, tr.y + tr.h / 2, 6 * k, 0, TAU);
      ctx.fillStyle = PALETTE.dash;
      ctx.fill();
    }
  }
  text(ctx, 'Up/Down select   Left/Right change   Enter toggle', p.x + p.w / 2, p.y + 342 * k, `${13 * k}px ${FONT}`, FAINT, 'center', 'middle');
}

function drawPaused(ctx, L, view) {
  const k = L.hs;
  const cx = L.winW / 2;
  const Y = (v) => L.winH / 2 + (v - H / 2) * k;
  dimWindow(ctx, L, 0.55);
  text(ctx, 'PAUSED', cx, Y(250), `bold ${72 * k}px ${FONT}`, PALETTE.player, 'center', 'middle');
  text(ctx, 'Esc or P to resume', cx, Y(300), `${22 * k}px ${FONT}`, PALETTE.dash, 'center', 'middle');
  drawOptions(ctx, L, view);
}

function drawGameOver(ctx, L, view) {
  dimWindow(ctx, L, 0.62);
  const k = L.hs;
  const Y = (u) => L.winH / 2 + (u - H / 2) * k;
  const game = view.game;
  const over = view.overAge ?? 0;
  const rank = view.runRank ?? -1;
  const panels = summaryPanels(L);
  for (const p of [panels.left, panels.right]) {
    // Nearly opaque, so the arena's drifters drifting behind the summary do not show through the stats.
    ctx.fillStyle = 'rgba(3, 8, 20, 0.94)';
    roundRect(ctx, p.x, p.y, p.w, p.h, 14 * k);
    ctx.fill();
    ctx.strokeStyle = 'rgba(60, 242, 255, 0.3)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // This run's row in the table is highlighted.
  if (rank >= 0 && rank < TOP_N) {
    const rowY = Y(SUMMARY.panelTop + 92 + rank * 52) - 22 * k;
    ctx.fillStyle = 'rgba(255, 224, 102, 0.14)';
    roundRect(ctx, panels.right.x + 10 * k, rowY, panels.right.w - 20 * k, 44 * k, 8 * k);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 224, 102, 0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // The medal badge appears once the count-up has finished.
  const medal = medalFor(game.score);
  const medalAlpha = clamp01((over - (COUNT_START + COUNT_LEN)) / 0.25);
  if (medal && medalAlpha > 0) {
    const bx = panels.left.x + 26 * k + 14 * k;
    const by = Y(SUMMARY.panelTop + 146);
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * medalAlpha;
    ctx.beginPath();
    ctx.arc(bx, by, 14 * k, 0, TAU);
    ctx.fillStyle = medal.color;
    ctx.shadowColor = medal.color;
    ctx.shadowBlur = 12 * k;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.beginPath();
    ctx.arc(bx, by, 8 * k, 0, TAU);
    ctx.strokeStyle = 'rgba(2, 6, 16, 0.55)';
    ctx.lineWidth = 2 * k;
    ctx.stroke();
    ctx.restore();
  }

  const entries = gameOverEntries(L, {
    score: game.score,
    highScore: view.highScore,
    newBest: view.newBest,
    overAge: over,
    time: view.time,
    stats: runStats(game, view.hud),
    scores: view.scores,
    runRank: rank,
  });
  for (const e of entries) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * (e.alpha ?? 1);
    if (e.glow) {
      ctx.shadowColor = e.color;
      ctx.shadowBlur = 18 * k;
    }
    text(ctx, e.text, e.x, e.y, `${e.weight} ${e.size}px ${FONT}`, e.color, e.align ?? 'center', 'middle');
    ctx.restore();
  }
}

// Draws the HUD and every screen overlay. Window pixels, scaled by layout.hs, independent of the arena.
export function drawHudLayer(ctx, L, view) {
  const { screen, game } = view;
  const hud = view.hud ?? createHud();
  const settings = view.settings ?? DEFAULT_SETTINGS;
  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  if (game && screen === 'playing') drawHud(ctx, L, game, hud, view.highScore ?? 0, true);
  if (game && screen === 'playing') drawBossBar(ctx, L, game, hud);
  if (game && screen === 'paused') drawHud(ctx, L, game, hud, view.highScore ?? 0, false);
  if (screen === 'title') drawTitle(ctx, L, view);
  if (screen === 'howto') drawHowto(ctx, L, view);
  if (screen === 'paused') drawPaused(ctx, L, view);
  if (screen === 'over' && game) drawGameOver(ctx, L, { ...view, hud });
  if (settings.muted) text(ctx, 'MUTED (M)', L.winW / 2, 32 * L.hs, `600 ${13 * L.hs}px ${FONT}`, DIM, 'center');
  ctx.restore();
}
