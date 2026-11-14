// Presentation for one frame. Entities are drawn by src/art.js, particles, shake, flashes and floaters
// by src/fx.js, and pulse shockwaves come from src/feedback.js. The HUD and every menu are drawn by
// src/hud.js. This module reads game and view state and never writes into the simulation, so it can run
// at display rate while the sim steps at 120 Hz.
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, PULSE, SPAWN, ENEMY, PLAYER, DASH, ARENA } from './config.js';
import { dashPreview } from './game.js';
import { draw, PALETTE } from './art.js';
import { drawPickups } from './pickups-art.js'; // PICKUPS (#54)
import {
  DEFAULT_SETTINGS,
  computeLayout,
  createHud,
  drawHudLayer,
  hudRectsLogical,
  clampOutOfRects,
} from './hud.js';

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const TAU = Math.PI * 2;
const SPAWN_POP_S = 0.3; // enemies grow in over this long after they appear
const STAGGER_FLASH = 0.25; // white tint held for the whole stagger
const START_FLASH_S = 0.15; // brighter flash at the moment a stagger lands
const AIM_LINE_SPEED = 60; // dashes on the telegraph aim line scroll at this rate (px/s)
const SPAWN_MARKER_SCALE = 0.8; // spawn markers are drawn at this scale of the enemy
const ARENA_BOUNDS = Object.freeze({
  minX: ARENA.inset,
  minY: ARENA.inset,
  maxX: W - ARENA.inset,
  maxY: H - ARENA.inset,
});

// Motion polish (presentation only). Each value is kept small so it adds weight without hiding anything.
const STRETCH_DASH = 1.3; // the player stretches to this much along the dash while dashing
const SPRING_W = 28; // stretch spring: angular frequency (rad/s)
const SPRING_ZETA = 0.45; // damping ratio: about 20% overshoot when it settles
const POP_SQUASH_END = 0.3; // a death pop squashes for this fraction of its life, then pops out
const POP_SQUASH_X = 0.7; // along the squash axis (the dash direction) while squashed
const POP_SQUASH_Y = 1.25; // across the squash axis while squashed
const POP_OUT = 1.35; // scale the pop expands to as it fades
const BOB_PX = 2.5; // pickups bob by this many logical px...
const BOB_RATE = 2.6; // ...at this rate (rad/s)
const DARK_R_IN = 60; // the hit-stop darkening is clear inside this radius around the kill...
const DARK_R_OUT = 300; // ...and fully dark at this one
const ZOOM_OUT = 0.98; // the arena eases out by 2% in the top combo tiers...
const ZOOM_TIER = 3; // ...tier 3 (magenta) and tier 4 (white)
const ZOOM_RATE = 4; // ease rate for the zoom (1/s)

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const NO_KICK = Object.freeze({ x: 0, y: 0 });

// ---- enemy drawing ---------------------------------------------------------------------------------
// art.js ignores unknown enemy types silently. To show a visible fallback instead, each type is probed
// once with a stub context that records paint calls: a known type paints, an unknown one does not.
const PAINT_OPS = new Set(['fill', 'stroke', 'fillRect', 'drawImage', 'fillText']);
const artProbe = new Map();
function artDraws(kind) {
  let known = artProbe.get(kind);
  if (known !== undefined) return known;
  let painted = false;
  const stub = new Proxy(
    {},
    {
      get(_target, key) {
        if (PAINT_OPS.has(key)) return () => {
          painted = true;
        };
        if (key === 'createRadialGradient' || key === 'createLinearGradient') return () => ({ addColorStop() {} });
        return () => {};
      },
      set() {
        return true;
      },
    },
  );
  draw.enemy(stub, kind, 0, 0, 0, 0, undefined);
  known = painted;
  artProbe.set(kind, known);
  return known;
}

function drawEnemy(ctx, kind, r, x, y, angle, t, opts) {
  if (artDraws(kind)) {
    draw.enemy(ctx, kind, x, y, angle, t, opts);
    return;
  }
  // Fallback for a type art.js does not draw yet: a dashed magenta ring with a question mark.
  const beat = 0.6 + 0.4 * Math.sin(t * 8);
  ctx.save();
  ctx.translate(x, y);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = ctx.globalAlpha * beat;
  ctx.strokeStyle = PALETTE.danger;
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.arc(0, 0, r * 1.2, 0, TAU);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = PALETTE.danger;
  ctx.font = `bold ${Math.round(r)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('?', 0, 1);
  ctx.restore();
}

// Facing per enemy: the lock direction while telegraphing or lunging, otherwise the velocity.
// Eased toward the target so a turn reads as a turn. Presentation state only.
const headings = new WeakMap();
function headingOf(e, dt) {
  let target;
  if ((e.state === 'telegraph' || e.state === 'lunge') && (e.dirX || e.dirY)) {
    target = Math.atan2(e.dirY, e.dirX);
  } else if (Math.hypot(e.vx, e.vy) > 4) {
    target = Math.atan2(e.vy, e.vx);
  }
  let h = headings.get(e);
  if (h === undefined) {
    h = target ?? 0;
  } else if (target !== undefined) {
    let d = (target - h) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d < -Math.PI) d += TAU;
    h += d * Math.min(1, dt * 14);
  }
  headings.set(e, h);
  return h;
}

// Telegraph progress 0..1 for kinds that have a telegraph in config (Charger today).
function telegraphOf(e) {
  // A spitter's wind-up rises 0 to 1 over its own timer (the sim exposes it as e.telegraph).
  if (e.kind === 'spitter') return e.state === 'windup' ? clamp01(e.telegraph) : 0;
  const dur = ENEMY[e.kind]?.telegraph;
  if (!dur || e.state !== 'telegraph') return 0;
  return clamp01(1 - e.stateT / dur);
}

function flashOf(e) {
  if (!(e.stagger > 0)) return 0;
  const start = clamp01((e.stagger - (PULSE.stagger - START_FLASH_S)) / START_FLASH_S);
  return STAGGER_FLASH + 0.6 * start;
}

function popScale(e) {
  const k = clamp01(e.age / SPAWN_POP_S);
  return 0.55 + 0.45 * (1 - (1 - k) ** 3);
}

// A long dashed line along the locked lunge, so the danger reads from across the arena.
function drawAimLine(ctx, e, x, y, tg, t) {
  const def = ENEMY[e.kind];
  const len = def?.aimLength ?? (def?.lungeSpeed ?? 0) * (def?.lungeTime ?? 0);
  if (len <= 0 || !(e.dirX || e.dirY)) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.2 + 0.5 * tg;
  ctx.strokeStyle = PALETTE.danger;
  ctx.lineWidth = 2 + 2 * tg;
  ctx.setLineDash([10, 10]);
  ctx.lineDashOffset = -t * AIM_LINE_SPEED;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + e.dirX * len, y + e.dirY * len);
  ctx.stroke();
  ctx.restore();
}

// A spawn marker is a faint ghost of the enemy that will appear, growing more solid as it nears. It is
// moved off the HUD panels (avoid, in arena units) so a warning never sits under a readout.
function drawWarnings(ctx, game, t, avoid) {
  for (const wn of game.warnings) {
    const k = clamp01(1 - wn.t / SPAWN.warning);
    const r = (ENEMY[wn.kind]?.radius ?? 14) * SPAWN_MARKER_SCALE;
    const at = clampOutOfRects(wn.x, wn.y, r, avoid, ARENA_BOUNDS);
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.55 * k;
    drawEnemy(ctx, wn.kind, ENEMY[wn.kind]?.radius ?? 14, at.x, at.y, 0, t, { scale: SPAWN_MARKER_SCALE, telegraph: k });
    ctx.restore();
  }
}

function drawEnemies(ctx, game, view) {
  for (const e of game.enemies) {
    const x = lerp(e.px, e.x, view.alpha);
    const y = lerp(e.py, e.y, view.alpha);
    const tg = telegraphOf(e);
    if (tg > 0) drawAimLine(ctx, e, x, y, tg, view.time);
    drawEnemy(ctx, e.kind, e.r, x, y, headingOf(e, view.dt), view.time, {
      scale: popScale(e),
      telegraph: tg,
      flash: flashOf(e),
    });
  }
}

// Death pops: an enemy that dies squashes along the dash direction, then pops out and fades, instead of
// vanishing. The records come from fx (real time, so they show through hit-stop). Each is drawn at its
// kill point with the same art as the live enemy.
function drawPops(ctx, fx, t, flashes) {
  // The optional fx calls let a partial stand-in (in tests) render without the newer effects.
  for (const p of fx.getPops?.() ?? []) {
    if (!p.alive) continue;
    const k = clamp01(p.age / p.life);
    let sx;
    let sy;
    let alpha = 1;
    if (k < POP_SQUASH_END) {
      const q = k / POP_SQUASH_END;
      sx = 1 + (POP_SQUASH_X - 1) * q;
      sy = 1 + (POP_SQUASH_Y - 1) * q;
    } else {
      const q = (k - POP_SQUASH_END) / (1 - POP_SQUASH_END);
      const e = 1 - (1 - q) * (1 - q) * (1 - q); // ease out of the squash into the pop
      sx = lerp(POP_SQUASH_X, POP_OUT, e);
      sy = lerp(POP_SQUASH_Y, POP_OUT, e);
      alpha = 1 - q * q;
    }
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.angle);
    ctx.scale(sx, sy);
    ctx.rotate(-p.angle);
    // A white flash on the first instant, so the death reads as a hit. Reduced flashes keep the squash only.
    const flash = flashes ? Math.max(0, 1 - k * 3) : 0;
    drawEnemy(ctx, p.kind, ENEMY[p.kind]?.radius ?? 14, 0, 0, 0, t, { scale: 1, flash });
    ctx.restore();
  }
}

function drawBullets(ctx, game, view) {
  for (const b of game.bullets) {
    const x = lerp(b.px, b.x, view.alpha);
    const y = lerp(b.py, b.y, view.alpha);
    // The velocity lets art.js draw the motion trail behind the bullet (#100).
    draw.bullet(ctx, x, y, view.time, { reflected: b.owner === 'player', scale: 1, vx: b.vx, vy: b.vy });
  }
}

// Afterglow after a dash, and an aim preview: a faint line and ring where the next dash would end,
// brighter (gold) when it would kill. Reads state only.
function drawDashFeedback(ctx, game) {
  const p = game.player;
  if (p.dashGrace > 0 && !p.dash.active) {
    // Afterglow: a white-hot halo that fades and widens over the grace, so the safe window reads on screen.
    const k = p.dashGrace / DASH.killGrace; // 1 at the dash end (or the kill), 0 when the grace is over
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.6 * k;
    ctx.strokeStyle = PALETTE.dash;
    ctx.shadowColor = PALETTE.dash;
    ctx.shadowBlur = 24;
    ctx.lineWidth = 3 + 4 * (1 - k);
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER.radius * (1.6 + 1.0 * (1 - k)), 0, TAU);
    ctx.stroke();
    ctx.restore();
  }
  if (p.dash.active || p.dash.charges < 1 || game.over) return;
  const pv = dashPreview(game, p.aimX, p.aimY);
  ctx.save();
  ctx.strokeStyle = pv.kills ? PALETTE.gold : PALETTE.dash;
  ctx.globalAlpha = pv.kills ? 0.9 : 0.3;
  ctx.lineWidth = pv.kills ? 3 : 2;
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(pv.x, pv.y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.arc(pv.x, pv.y, PLAYER.radius + 6, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// Stretch along the dash: a damped spring toward STRETCH_DASH while dashing and back to 1 afterwards,
// with a slight overshoot. Runs on real time (view.dt is 0 when paused), in short substeps for stability.
let stretch = 1;
let stretchV = 0;
function stepStretch(target, dt) {
  let left = Math.min(Math.max(dt, 0), 0.1);
  while (left > 0) {
    const h = Math.min(left, 1 / 240);
    const acc = -SPRING_W * SPRING_W * (stretch - target) - 2 * SPRING_ZETA * SPRING_W * stretchV;
    stretchV += acc * h;
    stretch += stretchV * h;
    left -= h;
  }
  return stretch;
}

function drawPlayer(ctx, game, view) {
  const p = game.player;
  const x = lerp(p.px, p.x, view.alpha);
  const y = lerp(p.py, p.y, view.alpha);
  const dashing = !!p.dash.active;
  // Squash and stretch: stretched along the facing (the dash direction), area kept by the cross axis.
  const s = stepStretch(dashing ? STRETCH_DASH : 1, view.dt);
  const stretched = Math.abs(s - 1) > 0.002;
  if (stretched) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(p.facing);
    ctx.scale(s, 1 / Math.sqrt(s));
    ctx.rotate(-p.facing);
    ctx.translate(-x, -y);
  }
  draw.player(ctx, x, y, p.facing, view.time, {
    dashing,
    // Post-hit invulnerability blinks; a dash is invulnerable too but does not blink.
    invulnerable: p.invuln > 0 && !dashing,
    charges: p.dash.charges,
  });
  if (stretched) ctx.restore();
}

// Pickups bob on their own phase. drawPickups reads only each item's position, so the bob goes into a
// copy of the item list; the game state is not changed.
function pickupsBobbed(game, t) {
  const items = game.pickups.items;
  if (items.length === 0) return game;
  const bobbed = items.map((it) => ({ ...it, y: it.y + BOB_PX * Math.sin(t * BOB_RATE + it.id * 0.7) }));
  return { ...game, pickups: { ...game.pickups, items: bobbed } };
}

// Pulse shockwaves: the art ring grows and fades; a reflected perfect pulse adds a gold ring.
function drawRings(ctx, rings) {
  for (const r of rings) {
    const k = clamp01(r.age / r.life);
    draw.pulse(ctx, r.x, r.y, PULSE.radius * k, 1 - k);
    if (r.perfect) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.strokeStyle = PALETTE.gold;
      ctx.lineWidth = 2 + 4 * (1 - k);
      ctx.beginPath();
      ctx.arc(r.x, r.y, PULSE.radius * (0.6 + 0.5 * k), 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }
}

// Hit-stop darkening on a big multi-kill: the arena backdrop dims away from the kill, and the kill's
// own area stays clear. It is drawn under the entities, so nothing gameplay-relevant is dimmed.
function drawDarken(ctx, fx) {
  const d = fx.getDarken?.();
  if (!d) return;
  const k = d.life / d.dur; // 1 at the kill, 0 when the darkening is over
  const a = d.alpha * k * k;
  if (a < 0.003) return;
  const g = ctx.createRadialGradient(d.x, d.y, DARK_R_IN, d.x, d.y, DARK_R_OUT);
  g.addColorStop(0, 'rgba(2, 4, 12, 0)');
  g.addColorStop(1, 'rgba(2, 4, 12, 1)');
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = a;
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

// The combo zoom: the arena eases out by 2% while the combo sits in its top tiers, and back in afterwards.
// Frozen while paused (dt is 0), so it never jumps on resume.
let zoom = 1;
function zoomNow(game, screen, dt) {
  const target = screen === 'playing' && game && game.combo.tier >= ZOOM_TIER ? ZOOM_OUT : 1;
  if (dt > 0) zoom += (target - zoom) * (1 - Math.exp(-Math.min(dt, 0.1) * ZOOM_RATE));
  return zoom;
}

// The zoom in effect now (1 normally). main.js inverts it when mapping pointer positions to the arena.
export function currentZoom() {
  return zoom;
}

// The letterbox bands around the arena: the same deep-sea gradient, drawn in window pixels. Only the strips
// outside the arena are filled, and nothing at all when the arena fills the window.
let bandGradient = null;
let bandGradientH = -1;
function drawBands(ctx, L) {
  const sides = L.px > 0.5;
  const tops = L.py > 0.5;
  if (!sides && !tops) return;
  if (bandGradient === null || bandGradientH !== L.winH) {
    bandGradient = ctx.createLinearGradient(0, 0, 0, L.winH);
    bandGradient.addColorStop(0, PALETTE.deepTop);
    bandGradient.addColorStop(1, PALETTE.deepBottom);
    bandGradientH = L.winH;
  }
  ctx.fillStyle = bandGradient;
  if (sides) {
    const right = L.px + L.pw;
    ctx.fillRect(0, 0, L.px, L.winH);
    ctx.fillRect(right, 0, L.winW - right, L.winH);
  }
  if (tops) {
    const bottom = L.py + L.ph;
    ctx.fillRect(0, 0, L.winW, L.py);
    ctx.fillRect(0, bottom, L.winW, L.winH - bottom);
  }
}

// view:{ screen, game, alpha, time, dt, highScore, newBest, overAge, muted, fx, rings, layout, hud, settings, menuRow, timings }
// `layout` comes from computeLayout(); without it the canvas size is used, which is what the tests do.
// `timings` is optional: when given, each section's ms is added to it (tools/perf.html uses this).
export function drawFrame(ctx, view) {
  const L = view.layout ?? computeLayout(ctx.canvas.width, ctx.canvas.height);
  const dev = ctx.canvas.width / L.winW; // device pixels per CSS px
  const settings = view.settings ?? DEFAULT_SETTINGS;
  const hud = view.hud ?? createHud();
  // Section timer for tools/perf.html. Canvas work is rasterised lazily, so the timer flushes (a 1x1 read)
  // at each boundary to charge the raster to the section that issued it. Off in play.
  const T = view.timings;
  let lapT = T ? performance.now() : 0;
  const lap = (name) => {
    if (!T) return;
    ctx.getImageData(0, 0, 1, 1);
    const now = performance.now();
    T[name] = (T[name] ?? 0) + (now - lapT);
    lapT = now;
  };

  ctx.setTransform(dev, 0, 0, dev, 0, 0);
  drawBands(ctx, L);
  lap('bands');

  // The arena, letterboxed in the middle of the window, with the combo zoom about its centre.
  const z = zoomNow(view.game, view.screen, view.dt);
  const base = dev * L.s;
  ctx.setTransform(base * z, 0, 0, base * z, dev * L.px + (1 - z) * (W / 2) * base, dev * L.py + (1 - z) * (H / 2) * base);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  draw.background(ctx, W, H, view.time);
  lap('background');

  const { game, screen, fx } = view;
  if (screen !== 'title' && game) {
    // Shake and the dash camera kick offset the world (entities, pulses, particles), not the HUD or the
    // arena backdrop. The Screen shake option scales both: 100%, 50% or 0%.
    const shake = fx.getShakeOffset();
    const kick = fx.getKickOffset?.() ?? NO_KICK;
    ctx.save();
    ctx.translate((shake.x + kick.x) * settings.shake, (shake.y + kick.y) * settings.shake);
    const avoid = hudRectsLogical(L, Object.keys(game.modifiers).length);
    if (!settings.reducedFlashes) drawDarken(ctx, fx); // a full-arena effect, so reduced flashes skip it
    lap('darken');
    drawWarnings(ctx, game, view.time, avoid);
    lap('warnings');
    drawPickups(ctx, pickupsBobbed(game, view.time), view.alpha, view.time); // PICKUPS (#54): pickups, shield aura, pickup fx
    lap('pickups');
    drawEnemies(ctx, game, view);
    drawPops(ctx, fx, view.time, !settings.reducedFlashes);
    lap('enemies');
    drawBullets(ctx, game, view);
    lap('bullets');
    drawDashFeedback(ctx, game);
    lap('dashFeedback');
    drawPlayer(ctx, game, view);
    lap('player');
    drawRings(ctx, view.rings);
    lap('rings');
    fx.drawWorld(ctx);
    lap('fxWorld');
    ctx.restore();
    // Reduced flashes: no full-screen flash or vignette pulse.
    if (!settings.reducedFlashes) fx.drawScreen(ctx, W, H);
    lap('fxScreen');
  }

  // HUD, title, pause and game-over screens, in window pixels, scaled by L.hs and not by the arena.
  ctx.setTransform(dev, 0, 0, dev, 0, 0);
  drawHudLayer(ctx, L, { ...view, hud, settings, muted: settings.muted, menuRow: view.menuRow ?? 0 });
  lap('hud');
}
