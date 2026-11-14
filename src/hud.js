// HUD, menus and the pause options panel. render.js hands this module the window layout and the view;
// this module draws every piece of text, panel and screen overlay the player reads on top of the arena.
// Everything above the drawing functions is pure (plain numbers in, plain objects out), so it runs under
// `node --test`. Nothing here touches window or document at import time.
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, ARENA, PLAYER, PICKUP, MODIFIER, DASH, PULSE, RESTART_GATE } from './config.js';
import { multiplierFor, comboWindowFor } from './game.js';
import { PALETTE } from './art.js';
import { dashMaxCharges, PICKUP_KINDS } from './pickups.js';

export const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
// HUD text is never smaller than this on screen (the smallest HUD font is 12 logical px).
export const MIN_HUD_CSS_PX = 12;
// A HUD block fades to this alpha while the player or an enemy is beneath it.
export const HUD_BENEATH_ALPHA = 0.35;

export const SHAKE_STEPS = Object.freeze([1, 0.5, 0]);
export const OPTION_ROWS = Object.freeze(['volume', 'muted', 'shake', 'reducedFlashes']);
export const OPTION_LABELS = Object.freeze({
  volume: 'Master volume',
  muted: 'Mute',
  shake: 'Screen shake',
  reducedFlashes: 'Reduced flashes',
});
export const SETTINGS_KEY = 'riptide-rush.settings';
const LEGACY_MUTE_KEY = 'riptide-rush.muted'; // read once, so an earlier mute choice survives the move
export const DEFAULT_SETTINGS = Object.freeze({ volume: 1, muted: false, shake: 1, reducedFlashes: false });

const DIM = 'rgba(234, 255, 255, 0.6)';
const FAINT = 'rgba(234, 255, 255, 0.5)';
const SOFT = 'rgba(234, 255, 255, 0.85)';
const BACKING = 'rgba(2, 6, 16, 0.42)';
const BACKING_EDGE = 'rgba(234, 255, 255, 0.08)';
const PANEL_FILL = 'rgba(2, 6, 16, 0.72)';
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
const PANEL = Object.freeze({ w: 440, h: 306, top: 330 });

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
    banners: [], // { text, color, size, y, t, life }
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

// ---- game over ----------------------------------------------------------------------------------------
// The game-over stack, in CSS px. Offsets are logical units from the window centre. These lines never overlap
// each other. The arena's own GAME OVER floater (feedback.js) is drawn separately and rises through this
// stack for part of its life; removing it is a feedback.js change (see #77).
export function gameOverEntries(L, v) {
  const k = L.hs;
  const cx = L.winW / 2;
  const cy = L.winH / 2;
  const y = (off) => cy + off * k;
  const out = [
    { id: 'title', text: 'WRECKED', size: 88 * k, weight: 'bold', color: PALETTE.danger, x: cx, y: y(-190) },
    { id: 'score', text: `Score  ${v.score}`, size: 44 * k, weight: 'bold', color: PALETTE.gold, x: cx, y: y(-115) },
  ];
  if (v.newBest) {
    out.push({ id: 'best', text: 'NEW BEST!', size: 26 * k, weight: 'bold', color: PALETTE.combo[1], x: cx, y: y(-60), glow: true });
  } else {
    out.push({ id: 'best', text: `Best  ${v.highScore}`, size: 26 * k, weight: '600', color: SOFT, x: cx, y: y(-60) });
  }
  out.push(
    { id: 'waveLabel', text: 'WAVE REACHED', size: 13 * k, weight: '600', color: DIM, x: cx - 130 * k, y: y(28) },
    { id: 'waveValue', text: String(v.wave), size: 30 * k, weight: 'bold', color: PALETTE.player, x: cx - 130 * k, y: y(62) },
    { id: 'comboLabel', text: 'PEAK COMBO', size: 13 * k, weight: '600', color: DIM, x: cx + 130 * k, y: y(28) },
    { id: 'comboValue', text: String(v.peakCombo), size: 30 * k, weight: 'bold', color: PALETTE.combo[2], x: cx + 130 * k, y: y(62) },
  );
  if (v.overAge >= RESTART_GATE) {
    out.push({
      id: 'prompt',
      text: 'Click, Space or R to dive again',
      size: 22 * k,
      weight: 'bold',
      color: PALETTE.dash,
      x: cx,
      y: y(150),
      alpha: blinkAlpha(v.time, 5, 0.6),
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

function drawTitle(ctx, L, view) {
  const k = L.hs;
  const cx = L.winW / 2;
  const Y = (v) => L.winH / 2 + (v - H / 2) * k;
  const X = (v) => cx + (v - W / 2) * k;
  dimWindow(ctx, L, 0.5);
  ctx.save();
  ctx.shadowColor = PALETTE.player;
  ctx.shadowBlur = 30 * k;
  text(ctx, 'RIPTIDE RUSH', cx, Y(220), `bold ${96 * k}px ${FONT}`, PALETTE.player, 'center', 'middle');
  ctx.restore();
  text(ctx, 'Dash through everything. Every kill refunds a charge.', cx, Y(300), `${24 * k}px ${FONT}`, PALETTE.dash, 'center', 'middle');

  const lines = [
    ['WASD / Arrows', 'swim'],
    ['Mouse', 'aim'],
    ['Left click / Space', 'dash-slash toward the cursor'],
    ['Right click / Shift', 'pulse: reflect bullets, stagger enemies'],
    ['Esc / P', 'pause and options'],
    ['M', 'mute'],
  ];
  lines.forEach(([keys, what], i) => {
    const y = Y(380 + i * 30);
    text(ctx, keys, X(W / 2 - 14), y, `${18 * k}px ${FONT}`, PALETTE.gold, 'right', 'alphabetic');
    text(ctx, what, X(W / 2 + 14), y, `${18 * k}px ${FONT}`, 'rgba(234, 255, 255, 0.8)', 'left', 'alphabetic');
  });

  group(ctx, blinkAlpha(view.time, 4, 0.6), () => {
    text(ctx, 'Click or press Space to dive in', cx, Y(600), `bold ${26 * k}px ${FONT}`, PALETTE.gold, 'center', 'middle');
  });
  text(ctx, `Best: ${view.highScore}`, cx, Y(648), `${20 * k}px ${FONT}`, DIM, 'center', 'middle');
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
  text(ctx, 'Up/Down select   Left/Right change   Enter toggle', p.x + p.w / 2, p.y + 290 * k, `${13 * k}px ${FONT}`, FAINT, 'center', 'middle');
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
  dimWindow(ctx, L, 0.6);
  const entries = gameOverEntries(L, {
    score: view.game.score,
    highScore: view.highScore,
    newBest: view.newBest,
    wave: view.game.wave.number,
    peakCombo: view.hud.peakCombo,
    overAge: view.overAge,
    time: view.time,
  });
  for (const e of entries) {
    ctx.save();
    ctx.globalAlpha = ctx.globalAlpha * (e.alpha ?? 1);
    if (e.glow) {
      ctx.shadowColor = e.color;
      ctx.shadowBlur = 18 * L.hs;
    }
    text(ctx, e.text, e.x, e.y, `${e.weight} ${e.size}px ${FONT}`, e.color, 'center', 'middle');
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
  if (game && screen === 'paused') drawHud(ctx, L, game, hud, view.highScore ?? 0, false);
  if (screen === 'title') drawTitle(ctx, L, view);
  if (screen === 'paused') drawPaused(ctx, L, view);
  if (screen === 'over' && game) drawGameOver(ctx, L, { ...view, hud });
  if (settings.muted) text(ctx, 'MUTED (M)', L.winW / 2, 32 * L.hs, `600 ${13 * L.hs}px ${FONT}`, DIM, 'center');
  ctx.restore();
}
