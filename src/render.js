// Presentation for one frame. Entities are drawn by src/art.js, particles, shake, flashes and floaters
// by src/fx.js, and pulse shockwaves come from src/feedback.js. The HUD and every menu are drawn by
// src/hud.js. This module reads game and view state and never writes into the simulation, so it can run
// at display rate while the sim steps at 120 Hz.
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, PULSE, SPAWN, ENEMY, PLAYER, DASH, ARENA } from './config.js';
import { dashPreview } from './game.js';
import { draw, PALETTE } from './art.js';
import { drawPickups } from './pickups-art.js'; // PICKUPS (#54)
import { drawModesLayer } from './modes-ui.js'; // mode picker, mode label, daily share prompt (#124)
import {
  DEFAULT_SETTINGS,
  computeLayout,
  createHud,
  drawHudLayer,
  hudRectsLogical,
  clampOutOfRects,
  bossOf,
} from './hud.js';
import {
  AIM_RAY,
  HALO,
  aimLineEnd,
  aimLook,
  aimPresence,
  angleTo,
  crosshairAlpha,
  haloLook,
  locatorLook,
  ribbonAlpha,
  smoothAngle,
} from './player-vis.js';

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

// Telegraph progress 0..1 for kinds that have a telegraph in config (Charger today, and the #129 kinds below).
export function telegraphOf(e) {
  // A spitter's wind-up rises 0 to 1 over its own timer (the sim exposes it as e.telegraph).
  if (e.kind === 'spitter') return e.state === 'windup' ? clamp01(e.telegraph) : 0;
  // A Puffer's swell is its telegraph: the burst is due when the swell ends.
  if (e.kind === 'puffer') return e.swelling ? clamp01(e.swell ?? 0) : 0;
  // A Phase Eel's ripple is its telegraph: it surfaces when the ripple ends. It starts at 0.4, not 0, so the ripple is
  // readable on its first frame, and grows to full over the ripple.
  if (e.kind === 'phaseeel') {
    return e.state === 'ripple' ? 0.4 + 0.6 * clamp01(1 - e.stateT / ENEMY.phaseeel.rippleTime) : 0;
  }
  // The Warden's telegraph runs 1 s in phase 1 and 0.8 s in phase 2; the snap lands at its end.
  if (e.kind === 'warden') {
    if (e.state !== 'telegraph') return 0;
    const dur = e.phase === 2 ? ENEMY.warden.phase2Telegraph : ENEMY.warden.telegraph;
    return clamp01(1 - e.stateT / dur);
  }
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

// ---- #114 enemies and their hazards (#129) ---------------------------------------------------------
// Every state field the sim exposes reaches the art here. The art's own defaults would draw a shield aura and a
// hidden eel, so each field is passed explicitly, falling back to the value that draws the plain enemy.
const ARC_HEIGHT = 60; // px: the apex of an ink arc above its ground point
const HIT_FLASH_S = 0.18; // a lost hit point flashes the enemy this long (real time)
const EXPOSE_RAMP_S = 0.1; // the weak point lights up over this long after the Warden opens
const BOSS_INTRO_S = 2.2; // the intro banner's life (real time)
const BOSS_DEATH_S = 0.9; // the Warden's death sequence (real time)
const WEAK_LABEL_DY = 84; // px below the Warden's centre for its WEAK POINT label, clear of the intro banner

// Per-enemy presentation memory, keyed by the enemy object: the last hit point seen, and whether the weak point
// was open last frame. Real-time state, written only from drawEnemies.
const hpSeen = new WeakMap();
const exposeSeen = new WeakMap();

// White flash over a lost hit point (a Shield Bearer's hit, or a Warden's hit on the exposed core).
function hitFlashOf(e, t) {
  let s = hpSeen.get(e);
  if (s === undefined) {
    s = { hp: e.hp, at: -Infinity };
    hpSeen.set(e, s);
  }
  if (typeof e.hp === 'number') {
    if (e.hp < s.hp) s.at = t;
    s.hp = e.hp;
  }
  return 0.8 * clamp01(1 - (t - s.at) / HIT_FLASH_S);
}

// The Warden's weak point: 0 while closed; once open it lights up over EXPOSE_RAMP_S and then pulses.
function exposeOf(e, t) {
  let s = exposeSeen.get(e);
  if (s === undefined) {
    s = { on: false, at: -Infinity };
    exposeSeen.set(e, s);
  }
  const on = !!e.exposed;
  if (on !== s.on) {
    s.on = on;
    s.at = t;
  }
  if (!on) return 0;
  return clamp01((t - s.at) / EXPOSE_RAMP_S) * (0.8 + 0.2 * Math.sin(t * 12));
}

// Whether the Warden's next snap is a lure: the same count the sim uses (enemies-extra.js enterTelegraph).
export function lureNext(e) {
  const cycle = e.phase === 2 ? ENEMY.warden.phase2Cycle : ENEMY.warden.cycle;
  const every = Math.max(1, Math.round(ENEMY.warden.lureEvery / cycle));
  return (e.snaps + 1) % every === 0;
}

// The per-type opts for draw.enemy (the sim's state, read per frame). Returns a fresh object.
export function typeOpts(e, t) {
  switch (e.kind) {
    case 'puffer':
      // Inflates with the swell; a beat of white over the swell tells it is about to burst.
      return {
        inflate: clamp01(e.swell ?? 0),
        flash: e.swelling ? 0.2 + 0.3 * (0.5 + 0.5 * Math.sin(t * 22)) : 0,
      };
    case 'shieldbearer':
      // The aura is drawn only while it is up: a Pulse stagger takes it down for auraOffTime.
      return { aura: e.aura ? (e.auraRadius ?? ENEMY.shieldbearer.auraRadius) : 0 };
    case 'phaseeel':
      // A hidden eel draws nothing; its ripple (the telegraph) does.
      return { visibility: e.visible ? 1 : 0 };
    case 'warden':
      return { phase: e.phase === 2 ? 2 : 1, vulnerable: exposeOf(e, t), hp: e.hp, maxHp: e.maxHp };
    default:
      return {};
  }
}

// The Puffer's burst reach: a dashed ring at shardRange that fills in as the swell grows.
function drawPufferReach(ctx, x, y, swell, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.15 + 0.5 * swell;
  ctx.strokeStyle = PALETTE.bullet;
  ctx.lineWidth = 1.5 + swell;
  ctx.setLineDash([6, 8]);
  ctx.lineDashOffset = -t * 30;
  ctx.beginPath();
  ctx.arc(x, y, ENEMY.puffer.shardRange, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The Warden's lure telegraph: a dashed ring where the lure Drifters will appear at its snap.
function drawLureRing(ctx, x, y, tg, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.25 + 0.6 * tg;
  ctx.strokeStyle = PALETTE.wardenLure;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 10]);
  ctx.lineDashOffset = -t * 40;
  ctx.beginPath();
  ctx.arc(x, y, ENEMY.warden.lureRing, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// A lure Drifter wears a faint ring in the lure colour, so it is not mistaken for a plain Drifter.
function drawLureTint(ctx, x, y, r, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.35 + 0.15 * Math.sin(t * 6);
  ctx.strokeStyle = PALETTE.wardenLure;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.7, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The Phase Eel's ripple: a dashed ring that closes in on the spot it will surface at, so the warning reads from the
// first frame of the ripple and tightens as the surfacing nears.
function drawRippleClose(ctx, x, y, tg, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.2 + 0.6 * tg;
  ctx.strokeStyle = PALETTE.phaseeel;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 7]);
  ctx.lineDashOffset = -t * 30;
  ctx.beginPath();
  ctx.arc(x, y, 14 + 46 * (1 - tg), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The weak point, ringed in gold while it is open: a pulsing ring over the core, which the art draws at WEAK_CORE
// in the Warden's own frame (its nose is +x). The ring follows the Warden's heading, so the core stays under it.
const WEAK_CORE = Object.freeze({ dx: -14, r: 22 }); // a quarter of the art's Warden unit (W = 4R = 56) behind centre
function drawWeakRing(ctx, x, y, angle, v, t) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = clamp01(v) * (0.55 + 0.45 * Math.sin(t * 12));
  ctx.strokeStyle = PALETTE.gold;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(WEAK_CORE.dx, 0, WEAK_CORE.r * (1 + 0.12 * Math.sin(t * 12)), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The weak point's label, above the Warden while the core can be hit.
function drawWeakLabel(ctx, x, y, v) {
  ctx.save();
  ctx.globalAlpha = clamp01((v - 0.2) / 0.5);
  ctx.font = `bold 12px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText('WEAK POINT', x, y);
  ctx.restore();
}

function drawEnemies(ctx, game, view) {
  for (const e of game.enemies) {
    const x = lerp(e.px, e.x, view.alpha);
    const y = lerp(e.py, e.y, view.alpha);
    const t = view.time;
    const tg = telegraphOf(e);
    if (tg > 0) drawAimLine(ctx, e, x, y, tg, t);
    if (e.kind === 'puffer' && e.swelling) drawPufferReach(ctx, x, y, clamp01(e.swell ?? 0), t);
    if (e.kind === 'phaseeel' && tg > 0) drawRippleClose(ctx, x, y, tg, t);
    if (e.kind === 'warden' && tg > 0 && lureNext(e)) drawLureRing(ctx, x, y, tg, t);
    const o = typeOpts(e, t);
    o.scale = popScale(e);
    o.telegraph = tg;
    o.barrier = e.barrier ? 1 : 0;
    o.flash = Math.max(flashOf(e), hitFlashOf(e, t), o.flash ?? 0);
    const angle = headingOf(e, view.dt);
    drawEnemy(ctx, e.kind, e.r, x, y, angle, t, o);
    if (e.lureOf != null) drawLureTint(ctx, x, y, e.r, t);
    if (e.kind === 'warden' && (o.vulnerable ?? 0) > 0.05) drawWeakRing(ctx, x, y, angle, o.vulnerable, t);
    if (e.kind === 'warden' && (o.vulnerable ?? 0) > 0.2) drawWeakLabel(ctx, x, y + WEAK_LABEL_DY, o.vulnerable);
  }
}

// Ground layer, under the enemies: ink puddles (they slow Rip), and the landing shadow of each arc in flight. The
// shadow is the telegraph: it fills in over the flight, and the puddle it becomes lasts puddleTime.
function drawGround(ctx, game, t) {
  const ex = game.extras;
  if (!ex) return;
  for (const pd of ex.puddles) {
    if (pd.alive) draw.hazard(ctx, 'puddle', pd.x, pd.y, pd.r, t, { life: 1 - pd.t / pd.dur });
  }
  for (const s of ex.shells) {
    if (s.alive && s.state === 'flight') {
      draw.hazard(ctx, 'shadow', s.lx, s.ly, ENEMY.inksquid.puddleRadius, t, { progress: clamp01(s.t / s.dur) });
    }
  }
}

// Air layer, above the enemies and below the bullets: ink arcs and Puffer shards. An arc in flight is a blob that
// rises and falls over its ground point; a reflected arc flies back as a cyan shot. Shards are small amber diamonds
// with a short trail, so they read apart from the enemy bullets' glow.
function drawAirborne(ctx, game, t) {
  const ex = game.extras;
  if (!ex) return;
  for (const s of ex.shells) {
    if (!s.alive) continue;
    if (s.state === 'reflect') {
      draw.bullet(ctx, s.x, s.y, t, { reflected: true, scale: 1 });
      continue;
    }
    const k = clamp01(s.t / s.dur);
    const lift = Math.sin(Math.PI * k);
    draw.hazard(ctx, 'shadow', s.x, s.y, 9, t, { progress: 1 });
    draw.hazard(ctx, 'lob', s.x, s.y - lift * ARC_HEIGHT, 9, t, { height: lift });
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const r = ENEMY.puffer.shardRadius;
  for (const sh of ex.shards) {
    if (!sh.alive) continue;
    const sp = Math.hypot(sh.vx, sh.vy) || 1;
    const ux = sh.vx / sp;
    const uy = sh.vy / sp;
    ctx.globalAlpha = 0.45;
    ctx.strokeStyle = PALETTE.bullet;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sh.x - ux * r * 3, sh.y - uy * r * 3);
    ctx.lineTo(sh.x, sh.y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = PALETTE.bullet;
    ctx.beginPath();
    ctx.moveTo(sh.x + ux * r * 1.8, sh.y + uy * r * 1.8);
    ctx.lineTo(sh.x - uy * r * 0.9, sh.y + ux * r * 0.9);
    ctx.lineTo(sh.x - ux * r * 0.8, sh.y - uy * r * 0.8);
    ctx.lineTo(sh.x + uy * r * 0.9, sh.y - ux * r * 0.9);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

// ---- the Warden's intro and death (#129) ---------------------------------------------------------------
// Presentation memory for the Warden: which one is live, when it arrived, and the last place it was seen (for its
// death sequence). Reset whenever a new game object arrives.
let bossState = null;

function stepBoss(game, t) {
  if (!bossState || bossState.game !== game) {
    bossState = { game, obj: null, last: null, lures: [], introAt: -Infinity, death: null };
  }
  const bs = bossState;
  const w = bossOf(game);
  if (w !== null) {
    if (w !== bs.obj) {
      bs.obj = w;
      bs.introAt = t;
      bs.death = null;
    }
    bs.last = { x: w.x, y: w.y, phase: w.phase, angle: headings.get(w) ?? 0 };
    bs.lures = game.enemies
      .filter((o) => o.lureOf === w.id && o.alive !== false)
      .map((o) => ({ x: o.x, y: o.y }));
  } else if (bs.obj !== null && bs.last !== null) {
    // The Warden has left the field: it fell, and the boss wave ends with it.
    bs.death = { ...bs.last, lures: bs.lures, at: t };
    bs.obj = null;
  }
}

// The death: two gold rings open out from where the Warden fell, its last silhouette swells and fades, and the
// lure Drifters that fade with it leave small rings behind.
function drawBossDeath(ctx, bs, t) {
  const d = bs?.death;
  if (!d) return;
  const age = t - d.at;
  if (age < 0 || age > BOSS_DEATH_S) return;
  const k = clamp01(age / BOSS_DEATH_S);
  const ease = 1 - (1 - k) * (1 - k) * (1 - k);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let j = 0; j < 2; j++) {
    const f = clamp01((k - j * 0.15) / 0.85);
    ctx.globalAlpha = (1 - f) * 0.9;
    ctx.strokeStyle = PALETTE.gold;
    ctx.lineWidth = 1 + 6 * (1 - f);
    ctx.beginPath();
    ctx.arc(d.x, d.y, 30 + 240 * f, 0, TAU);
    ctx.stroke();
  }
  const lf = clamp01(k * 1.4);
  ctx.strokeStyle = PALETTE.wardenLure;
  ctx.lineWidth = 2;
  for (const p of d.lures) {
    ctx.globalAlpha = 1 - lf;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4 + 26 * lf, 0, TAU);
    ctx.stroke();
  }
  ctx.restore();
  ctx.save();
  ctx.globalAlpha = Math.max(0, 1 - k * 1.2);
  drawEnemy(ctx, 'warden', ENEMY.warden.radius, d.x, d.y, d.angle, t, {
    scale: 1 + 0.35 * ease,
    flash: Math.max(0, 1 - k * 3),
    phase: d.phase,
    vulnerable: 1 - k,
  });
  ctx.restore();
}

// The intro banner: the Warden's name and the one rule that matters, over the arena for a moment. Window px.
function drawBossIntro(ctx, L, bs, t) {
  const age = t - (bs?.introAt ?? -Infinity);
  if (!(age >= 0 && age < BOSS_INTRO_S)) return;
  const k = L.hs;
  const a = Math.min(clamp01(age / 0.2), clamp01((BOSS_INTRO_S - age) / 0.5));
  const punch = 1 + 0.12 * (1 - clamp01(age / 0.3));
  ctx.save();
  ctx.globalAlpha = a;
  ctx.translate(L.winW / 2, L.py + L.ph * 0.3); // high: clear of the Warden's body and the WAVE banner
  ctx.scale(punch, punch);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = PALETTE.danger;
  ctx.shadowBlur = 18 * k;
  ctx.font = `bold ${36 * k}px ${FONT}`;
  ctx.fillStyle = PALETTE.danger;
  ctx.fillText('ANGLERFISH WARDEN', 0, 0);
  ctx.shadowBlur = 0;
  ctx.font = `600 ${15 * k}px ${FONT}`;
  ctx.fillStyle = 'rgba(234, 255, 255, 0.85)';
  ctx.fillText('Dash the core when it opens. Dodge the lure.', 0, 34 * k);
  ctx.restore();
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

// ---- player visibility (issue #131) -----------------------------------------------------------------
// Presentation state that lives across frames: the last hit and dash timings (real time), the dash ribbon,
// the locator ring, and the displayed aim angle. It is reset whenever a new game object arrives.
let vis = null;
function newVis(game) {
  return {
    game,
    prevHp: game.player.hp,
    hurtAt: -Infinity,
    ribbon: null, // { dash, sx, sy, hx, hy, endT } for the dash in progress or the last one
    locatorAt: -Infinity,
    locatorX: 0,
    locatorY: 0,
    aimAngle: null,
  };
}

// Reads the sim once per frame into vis, and publishes the player position for input's aim origin.
function stepVis(game, view, pos) {
  if (!vis || vis.game !== game) vis = newVis(game);
  const p = game.player;
  if (p.hp < vis.prevHp) vis.hurtAt = view.time;
  vis.prevHp = p.hp;
  const dash = p.dash.active;
  if (dash) {
    if (!vis.ribbon || vis.ribbon.dash !== dash) {
      vis.ribbon = { dash, sx: dash.sx, sy: dash.sy, hx: pos.x, hy: pos.y, endT: null };
    }
    vis.ribbon.hx = pos.x;
    vis.ribbon.hy = pos.y;
  } else if (vis.ribbon && vis.ribbon.endT === null) {
    // The dash has just ended (it ran out, or a Shellback bounced it): the ring snaps onto where Rip stopped.
    vis.ribbon.endT = view.time;
    vis.locatorAt = view.time;
    vis.locatorX = p.x;
    vis.locatorY = p.y;
  }
  aimPresence.player = { x: p.x, y: p.y };
}

// The dash ribbon: one continuous line from where the dash started to where Rip is (or where it stopped),
// brighter at the head, so the eye can follow the whole path. It fades out after the dash.
function drawRibbon(ctx, view) {
  const r = vis.ribbon;
  if (!r) return;
  const endAge = r.endT === null ? 0 : view.time - r.endT;
  const a = ribbonAlpha(endAge);
  if (a <= 0) return;
  const g = ctx.createLinearGradient(r.sx, r.sy, r.hx, r.hy);
  g.addColorStop(0, 'rgba(60, 242, 255, 0)');
  g.addColorStop(1, PALETTE.dash);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.strokeStyle = g;
  ctx.globalAlpha = 0.55 * a;
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(r.sx, r.sy);
  ctx.lineTo(r.hx, r.hy);
  ctx.stroke();
  ctx.globalAlpha = a;
  ctx.lineWidth = 2.2;
  ctx.stroke();
  ctx.restore();
}

// Afterglow after a dash: a white-hot halo that fades and widens over the grace, so the safe window reads on screen.
function drawAfterglow(ctx, game) {
  const p = game.player;
  if (!(p.dashGrace > 0 && !p.dash.active)) return;
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

const RGB_DASH = '234, 255, 255';
const RGB_GOLD = '255, 224, 102';

// The aim: one tapered ray from the player to where the next dash would end (lunge assist included), with a
// reticle at the end. Gold and bright when the dash would kill. The angle eases toward the true dash angle
// for display only; the dash itself always uses the real direction. Hidden while dashing (the ribbon shows it).
function drawAimRay(ctx, game, origin, view) {
  const p = game.player;
  if (p.dash.active || game.over) return;
  const pv = dashPreview(game, p.aimX, p.aimY);
  const target = angleTo(origin, pv);
  vis.aimAngle = vis.aimAngle === null ? target : smoothAngle(vis.aimAngle, target, view.dt);
  const a = vis.aimAngle;
  const end = aimLineEnd(origin, pv, a);
  const look = aimLook({ kills: pv.kills, charges: p.dash.charges });
  const rgb = look.gold ? RGB_GOLD : RGB_DASH;
  const nx = -Math.sin(a);
  const ny = Math.cos(a);
  const g = ctx.createLinearGradient(origin.x, origin.y, end.x, end.y);
  g.addColorStop(0, `rgba(${rgb}, 0.1)`);
  g.addColorStop(1, `rgba(${rgb}, 1)`);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = look.alpha;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(origin.x + nx * AIM_RAY.startHalf, origin.y + ny * AIM_RAY.startHalf);
  ctx.lineTo(end.x + nx * AIM_RAY.endHalf, end.y + ny * AIM_RAY.endHalf);
  ctx.lineTo(end.x - nx * AIM_RAY.endHalf, end.y - ny * AIM_RAY.endHalf);
  ctx.lineTo(origin.x - nx * AIM_RAY.startHalf, origin.y - ny * AIM_RAY.startHalf);
  ctx.closePath();
  ctx.fill();
  // The reticle: a ring at the end, with a dot. Gold rings glow when the dash would kill.
  ctx.strokeStyle = look.gold ? PALETTE.gold : PALETTE.dash;
  ctx.fillStyle = ctx.strokeStyle;
  ctx.lineWidth = look.gold ? 2.4 : 1.6;
  if (look.gold) {
    ctx.shadowColor = PALETTE.gold;
    ctx.shadowBlur = 10;
  }
  ctx.beginPath();
  ctx.arc(end.x, end.y, AIM_RAY.reticle, 0, TAU);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(end.x, end.y, 1.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// The spotlight: a soft dark disc under the player. It lowers the brightness of whatever is behind the
// player, so effects and floaters close to Rip read dimmer and the halo stands out. Drawn under the player.
function drawSpotlight(ctx, x, y) {
  const r = HALO.spotRadius;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(2, 4, 12, ${HALO.spotAlpha})`);
  g.addColorStop(0.5, `rgba(2, 4, 12, ${HALO.spotAlpha * 0.6})`);
  g.addColorStop(1, 'rgba(2, 4, 12, 0)');
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// The halo: a crisp bright cyan ring with a thin dark rim outside it. Nothing else in the arena uses this
// signature, so the player is always the ring. Drawn above enemies, particles and floaters.
function drawHalo(ctx, x, y, look) {
  ctx.save();
  // A soft wide glow behind the ring, a little stronger when boosted.
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = 0.18 + 0.2 * look.glow;
  ctx.strokeStyle = PALETTE.player;
  ctx.lineWidth = 6 + 3 * look.glow;
  ctx.beginPath();
  ctx.arc(x, y, look.radius, 0, TAU);
  ctx.stroke();
  // The bright ring: brighter, whiter and a touch thicker when boosted.
  ctx.globalAlpha = 0.85 + 0.15 * look.glow;
  ctx.strokeStyle = look.glow ? PALETTE.dash : PALETTE.player;
  ctx.lineWidth = HALO.width + 0.6 * look.glow;
  ctx.beginPath();
  ctx.arc(x, y, look.radius, 0, TAU);
  ctx.stroke();
  // The thin dark rim, outside the ring.
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = 'rgb(2, 4, 12)';
  ctx.lineWidth = HALO.rimWidth;
  ctx.beginPath();
  ctx.arc(x, y, look.radius + HALO.rimOffset, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The locator ring after a dash: it contracts onto the point where the dash stopped, so the new position
// snaps into view instead of teleporting unseen.
function drawLocator(ctx, view) {
  const k = locatorLook(view.time - vis.locatorAt);
  if (!k) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = k.alpha;
  ctx.strokeStyle = PALETTE.dash;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(vis.locatorX, vis.locatorY, k.radius, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

// The crosshair for mouse aim: a small white cross with a dark outline, at the real cursor. It fades out as
// the cursor nears the player, so it never sits on top of Rip. Drawn outside the screen shake, so it stays
// under the cursor.
function drawCrosshair(ctx, origin, cursor) {
  const a = crosshairAlpha(Math.hypot(cursor.x - origin.x, cursor.y - origin.y));
  if (a <= 0.01) return;
  const s = 8; // arm length
  const gap = 3.5; // empty centre
  const cx = cursor.x;
  const cy = cursor.y;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.lineCap = 'butt';
  for (const [w, col] of [
    [3.2, 'rgb(2, 4, 12)'],
    [1.4, '#f4f8ff'],
  ]) {
    ctx.lineWidth = w;
    ctx.strokeStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx - s, cy);
    ctx.lineTo(cx - gap, cy);
    ctx.moveTo(cx + gap, cy);
    ctx.lineTo(cx + s, cy);
    ctx.moveTo(cx, cy - s);
    ctx.lineTo(cx, cy - gap);
    ctx.moveTo(cx, cy + gap);
    ctx.lineTo(cx, cy + s);
    ctx.stroke();
  }
  ctx.restore();
}

// The cursor is hidden over the canvas only while playing with the mouse aiming, so menus keep it.
// Written only when it changes.
function syncCursor(ctx, screen, game) {
  const style = ctx.canvas?.style;
  if (!style) return;
  const hide = screen === 'playing' && !!game && !game.over && aimPresence.source === 'mouse' && aimPresence.mouseSeen;
  const want = hide ? 'none' : '';
  if (style.cursor !== want) style.cursor = want;
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

function drawPlayer(ctx, game, view, pos) {
  const p = game.player;
  const { x, y } = pos;
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
    const p = game.player;
    const pos = { x: lerp(p.px, p.x, view.alpha), y: lerp(p.py, p.y, view.alpha) };
    stepVis(game, view, pos);
    let enemies = 0;
    for (const e of game.enemies) if (e.alive !== false) enemies++;
    const halo = haloLook({ hurtAge: view.time - vis.hurtAt, enemies, reducedFlashes: settings.reducedFlashes });
    ctx.save();
    ctx.translate((shake.x + kick.x) * settings.shake, (shake.y + kick.y) * settings.shake);
    const avoid = hudRectsLogical(L, Object.keys(game.modifiers).length);
    if (!settings.reducedFlashes) drawDarken(ctx, fx); // a full-arena effect, so reduced flashes skip it
    lap('darken');
    drawGround(ctx, game, view.time); // #129: ink puddles and arc shadows, under everything that moves
    drawWarnings(ctx, game, view.time, avoid);
    lap('warnings');
    drawPickups(ctx, pickupsBobbed(game, view.time), view.alpha, view.time); // PICKUPS (#54): pickups, shield aura, pickup fx
    lap('pickups');
    stepBoss(game, view.time);
    drawEnemies(ctx, game, view);
    drawPops(ctx, fx, view.time, !settings.reducedFlashes);
    drawBossDeath(ctx, bossState, view.time); // #129: the Warden's death, above its body
    drawAirborne(ctx, game, view.time); // #129: arcs in flight and Puffer shards, above the enemies
    lap('enemies');
    drawBullets(ctx, game, view);
    lap('bullets');
    drawAfterglow(ctx, game);
    drawRibbon(ctx, view);
    lap('dashFeedback');
    drawRings(ctx, view.rings);
    lap('rings');
    fx.drawWorld(ctx);
    lap('fxWorld');
    // Above the particles and floaters: the spotlight dims what is behind Rip, then the aim, the halo and Rip.
    drawSpotlight(ctx, pos.x, pos.y);
    drawAimRay(ctx, game, pos, view);
    drawHalo(ctx, pos.x, pos.y, halo);
    drawPlayer(ctx, game, view, pos);
    drawLocator(ctx, view);
    lap('player');
    ctx.restore();
    // Reduced flashes: no full-screen flash or vignette pulse.
    if (!settings.reducedFlashes) fx.drawScreen(ctx, W, H);
    lap('fxScreen');
    // The crosshair is drawn after the shake is undone, so it sits under the real cursor.
    if (screen === 'playing' && !game.over && aimPresence.source === 'mouse' && aimPresence.mouseSeen) {
      drawCrosshair(ctx, pos, aimPresence.cursor);
    }
    syncCursor(ctx, screen, game);
  } else {
    syncCursor(ctx, screen, null);
  }

  // HUD, title, pause and game-over screens, in window pixels, scaled by L.hs and not by the arena.
  ctx.setTransform(dev, 0, 0, dev, 0, 0);
  drawHudLayer(ctx, L, { ...view, hud, settings, muted: settings.muted, menuRow: view.menuRow ?? 0 });
  if (screen === 'playing' && game) drawBossIntro(ctx, L, bossState, view.time); // #129: the Warden's arrival
  drawModesLayer(ctx, L, view);
  lap('hud');
}
