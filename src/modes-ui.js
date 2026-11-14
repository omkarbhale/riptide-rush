// Mode UI: the title-screen mode picker, the small mode label during play, and the daily share prompt on the
// game-over card. Drawn after the HUD layer (render.js), in window pixels, scaled like the HUD. Clicks are
// hit-tested here too (main.js asks modesHit before it queues an action), so a click on a button never starts
// a run. Only copyText and the fallback field touch the DOM, and only when called.
import { PALETTE } from './art.js';
import { MODES, MODE_IDS, dailyMutator, dailySeed, formatScore } from './modes.js';

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const TEXT = 'rgba(234, 255, 255, 0.85)';
const DIM = 'rgba(234, 255, 255, 0.55)';
const FAINT = 'rgba(234, 255, 255, 0.4)';
const LOGICAL_H = 720;
const LOGICAL_MID = LOGICAL_H / 2;
const COPIED_SHOW_S = 1.6; // the "COPIED" label stays this long

// Title picker, in logical units (the title's own coordinate system, centred on the arena's middle).
const PICK = Object.freeze({ y: 70, w: 196, h: 46, gap: 14, hintY: 136, detailY: 114 });
const PICK_TOTAL = 4 * PICK.w + 3 * PICK.gap; // the widest the row gets, in logical units

// Game-over card, in offsets from the window centre (CSS px scaled by L.hs, like hud.js gameOverEntries).
const OVER = Object.freeze({ tag: -256, note: 190, share: 226, shareW: 220, shareH: 44 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Scale for the picker row: the HUD scale, reduced when the window is too narrow for the row.
function pickerScale(L) {
  return Math.min(L.hs, Math.max(0.5, (L.winW - 32) / PICK_TOTAL));
}

function titleY(L, v) {
  return L.winH / 2 + (v - LOGICAL_MID) * L.hs;
}

function pickerRects(L) {
  const k = pickerScale(L);
  const w = PICK.w * k;
  const h = PICK.h * k;
  const gap = PICK.gap * k;
  const total = 4 * w + 3 * gap;
  const x0 = L.winW / 2 - total / 2;
  const y = titleY(L, PICK.y) - h / 2;
  return MODE_IDS.map((id, i) => ({ id, x: x0 + i * (w + gap), y, w, h }));
}

function shareRect(L) {
  const k = L.hs;
  const w = OVER.shareW * k;
  const h = OVER.shareH * k;
  const cy = L.winH / 2 + OVER.share * k;
  return { x: L.winW / 2 - w / 2, y: cy - h / 2, w, h };
}

// The share button shows only for an official Daily Tide result (the first run of the UTC day).
function shareShown(view) {
  return view.screen === 'over' && Boolean(view.modes?.official);
}

// What a click lands on, in CSS px: { kind: 'mode', id } on the title picker, { kind: 'share' } on the
// game-over card, or null.
export function modesHit(L, screen, x, y, modes) {
  if (screen === 'title') {
    for (const r of pickerRects(L)) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { kind: 'mode', id: r.id };
    }
    return null;
  }
  if (screen === 'over' && modes?.official) {
    const r = shareRect(L);
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return { kind: 'share' };
  }
  return null;
}

// The line under the picker: what the selected mode is, and for Daily Tide the date and the day's record.
export function detailLine(modes, id) {
  const best = modes.bests?.[id] ?? 0;
  const bestText = best > 0 ? `Best ${formatScore(best)}` : 'No best yet';
  if (id === 'daily') {
    const mutator = dailyMutator(dailySeed(modes.dayKey)).name;
    const off = modes.daily?.official;
    const record = off ? `today's record ${formatScore(off.score)}` : 'one official attempt today';
    return `${modes.dayKey} · ${mutator} · ${record}`;
  }
  if (id === 'one-life') return `1 hit point, no heal orbs. ${bestText}`;
  if (id === 'no-pulse') return `No Pulse: no reflect, no stagger. ${bestText}`;
  return `Endless waves, every rule as usual. ${bestText}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function text(ctx, s, x, y, font, color, align = 'center', baseline = 'middle') {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillText(s, x, y);
}

function drawTitlePicker(ctx, L, modes) {
  const k = pickerScale(L);
  const rects = pickerRects(L);
  rects.forEach((r, i) => {
    const id = MODE_IDS[i];
    const mode = MODES[id];
    const on = modes.mode === id;
    ctx.save();
    if (on) {
      ctx.shadowColor = PALETTE.player;
      ctx.shadowBlur = 16 * k;
      ctx.fillStyle = 'rgba(60, 242, 255, 0.18)';
    } else {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    }
    roundRect(ctx, r.x, r.y, r.w, r.h, 10 * k);
    ctx.fill();
    ctx.lineWidth = on ? 2 : 1.25;
    ctx.strokeStyle = on ? PALETTE.player : 'rgba(255, 255, 255, 0.2)';
    ctx.stroke();
    ctx.restore();
    text(ctx, `${mode.key}  ${mode.name}`, r.x + r.w / 2, r.y + r.h / 2, `bold ${16 * k}px ${FONT}`, on ? PALETTE.player : TEXT);
  });

  const cx = L.winW / 2;
  text(ctx, detailLine(modes, modes.mode), cx, titleY(L, PICK.detailY), `${15 * k}px ${FONT}`, PALETTE.dash);
  text(ctx, 'Keys 1-4 or click to choose · Left/Right to cycle', cx, titleY(L, PICK.hintY), `${13 * k}px ${FONT}`, FAINT);
}

// The mode name, and for Daily Tide its date and mutator, small at the top centre during play.
function drawRunLabel(ctx, L, modes) {
  const k = L.hs;
  const mode = MODES[modes.mode];
  let label = mode.name.toUpperCase();
  if (modes.mode === 'daily') {
    const key = modes.runDayKey ?? modes.dayKey;
    label += `  ·  ${key}  ·  ${dailyMutator(dailySeed(key)).name.toUpperCase()}`;
  }
  text(ctx, label, L.winW / 2, 20 * k, `600 ${12 * k}px ${FONT}`, DIM, 'center', 'middle');
}

function shareLabel(modes, time) {
  const s = modes.share;
  if (!s) return 'SHARE';
  if (s.state === 'pending') return '...';
  if (s.state === 'copied' && time - s.at < COPIED_SHOW_S) return 'COPIED';
  return 'SHARE';
}

function drawGameOverCard(ctx, L, view) {
  const k = L.hs;
  const cx = L.winW / 2;
  const cy = L.winH / 2;
  const modes = view.modes;
  const mode = MODES[modes.mode];

  let tag = mode.name.toUpperCase();
  if (modes.mode === 'daily') {
    const key = modes.runDayKey ?? modes.dayKey;
    tag += `  ·  ${key}  ·  ${dailyMutator(dailySeed(key)).name.toUpperCase()}`;
  }
  text(ctx, tag, cx, cy + OVER.tag * k, `600 ${15 * k}px ${FONT}`, PALETTE.player);

  if (modes.mode !== 'daily') return;
  const key = modes.runDayKey ?? modes.dayKey;
  if (modes.official) {
    text(ctx, `OFFICIAL RESULT · RECORDED FOR ${key}`, cx, cy + OVER.note * k, `600 ${14 * k}px ${FONT}`, PALETTE.gold);
    const r = shareRect(L);
    const fallback = modes.share?.state === 'fallback';
    ctx.save();
    ctx.shadowColor = PALETTE.gold;
    ctx.shadowBlur = 12 * k;
    ctx.fillStyle = 'rgba(255, 224, 102, 0.14)';
    roundRect(ctx, r.x, r.y, r.w, r.h, 10 * k);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = PALETTE.gold;
    ctx.stroke();
    ctx.restore();
    text(ctx, shareLabel(modes, view.time), cx, r.y + r.h / 2, `bold ${18 * k}px ${FONT}`, PALETTE.gold);
    if (fallback) {
      text(ctx, 'Clipboard blocked: select the text below and copy it', cx, r.y + r.h + 22 * k, `${13 * k}px ${FONT}`, TEXT);
    }
  } else {
    const record = modes.daily?.official;
    const tail = record ? `today's record ${formatScore(record.score)}` : 'no record today';
    text(ctx, `PRACTICE · NOT RECORDED · ${tail}`, cx, cy + OVER.note * k, `600 ${14 * k}px ${FONT}`, DIM);
  }
}

// ---- fallback text field ------------------------------------------------------------------------
// When the clipboard is refused, the share line goes into a read-only field the player can select and copy.
// It is created on first use only, and hidden again when the next run starts.
let field = null;

function fieldRect(L) {
  const r = shareRect(L);
  const w = clamp(560 * L.hs, 200, Math.max(200, L.winW - 24));
  return { x: L.winW / 2 - w / 2, y: r.y + r.h + 40 * L.hs, w };
}

export function showShareField(text, L) {
  if (typeof document === 'undefined' || !document.body) return;
  try {
    if (!field) {
      field = document.createElement('input');
      field.type = 'text';
      field.readOnly = true;
      field.setAttribute('aria-label', 'Daily Tide share text');
      Object.assign(field.style, {
        position: 'fixed',
        zIndex: '10',
        boxSizing: 'border-box',
        padding: '10px 12px',
        font: '16px system-ui, sans-serif',
        color: '#eaffff',
        background: '#050a18',
        border: '1px solid rgba(60, 242, 255, 0.6)',
        borderRadius: '8px',
        outline: 'none',
      });
      document.body.appendChild(field);
    }
    const rect = fieldRect(L);
    field.value = text;
    Object.assign(field.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.w}px`, display: 'block' });
    field.focus();
    field.select();
  } catch {
    // no DOM to show the text in: the share button still says what happened
  }
}

export function hideShareField() {
  if (!field) return;
  try {
    field.style.display = 'none';
  } catch {
    // ignore
  }
}

// Copies text to the clipboard. Resolves 'copied', or 'fallback' when the clipboard is missing or refused.
export async function copyText(value) {
  try {
    const clip = globalThis.navigator?.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      await clip.writeText(value);
      return 'copied';
    }
  } catch {
    // refused (no focus, insecure page, permission): fall through to the field
  }
  return 'fallback';
}

// Draws the mode UI for this frame. view.modes carries the mode state (see main.js modesView).
export function drawModesLayer(ctx, L, view) {
  const modes = view.modes;
  if (!modes) return;
  ctx.save();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  if (view.screen === 'title') drawTitlePicker(ctx, L, modes);
  else if (view.screen === 'playing' || view.screen === 'paused') drawRunLabel(ctx, L, modes);
  else if (view.screen === 'over' && view.game) drawGameOverCard(ctx, L, view);
  ctx.restore();
}
