// Presentation for one frame. Entities are drawn by src/art.js, particles, shake, flashes and floaters
// by src/fx.js, and pulse shockwaves come from src/feedback.js. This module reads game and view state
// and never writes into the simulation, so it can run at display rate while the sim steps at 120 Hz.
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, PULSE, SPAWN, ENEMY, PLAYER, DASH, RESTART_GATE } from './config.js';
import { multiplierFor, comboWindowFor, dashPreview } from './game.js';
import { draw, PALETTE } from './art.js';

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const DIM = 'rgba(234, 255, 255, 0.6)';
const TAU = Math.PI * 2;
const SPAWN_POP_S = 0.3; // enemies grow in over this long after they appear
const STAGGER_FLASH = 0.25; // white tint held for the whole stagger
const START_FLASH_S = 0.15; // brighter flash at the moment a stagger lands
const AIM_LINE_SPEED = 60; // dashes on the telegraph aim line scroll at this rate (px/s)

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

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

function drawWarnings(ctx, game, t) {
  // A spawn marker is a faint ghost of the enemy that will appear, growing more solid as it nears.
  for (const wn of game.warnings) {
    const k = clamp01(1 - wn.t / SPAWN.warning);
    ctx.save();
    ctx.globalAlpha = 0.25 + 0.55 * k;
    drawEnemy(ctx, wn.kind, ENEMY[wn.kind]?.radius ?? 14, wn.x, wn.y, 0, t, { scale: 0.8, telegraph: k });
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

function drawBullets(ctx, game, view) {
  for (const b of game.bullets) {
    const x = lerp(b.px, b.x, view.alpha);
    const y = lerp(b.py, b.y, view.alpha);
    draw.bullet(ctx, x, y, view.time, { reflected: b.owner === 'player', scale: 1 });
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

function drawPlayer(ctx, game, view) {
  const p = game.player;
  const x = lerp(p.px, p.x, view.alpha);
  const y = lerp(p.py, p.y, view.alpha);
  const dashing = !!p.dash.active;
  draw.player(ctx, x, y, p.facing, view.time, {
    dashing,
    // Post-hit invulnerability blinks; a dash is invulnerable too but does not blink.
    invulnerable: p.invuln > 0 && !dashing,
    charges: p.dash.charges,
  });
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

// ---- HUD and screens -------------------------------------------------------------------------------

function drawHud(ctx, game, highScore) {
  const c = game.combo;
  const mult = multiplierFor(c.count);
  const tierColor = PALETTE.combo[c.tier] ?? PALETTE.player;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.fillText('SCORE', 28, 32);
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillStyle = PALETTE.gold;
  ctx.fillText(String(game.score), 28, 72);
  const scoreWidth = ctx.measureText(String(game.score)).width;
  ctx.font = `bold 26px ${FONT}`;
  ctx.fillStyle = tierColor;
  ctx.fillText(`x${mult}`, 28 + scoreWidth + 14, 72);

  // Combo timer bar, coloured by tier.
  const barW = 260;
  const frac = c.count > 0 ? Math.max(0, Math.min(1, c.timer / comboWindowFor(c.count))) : 0;
  ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.fillRect(28, 88, barW, 8);
  ctx.fillStyle = tierColor;
  ctx.shadowColor = tierColor;
  ctx.shadowBlur = 10;
  ctx.fillRect(28, 88, barW * frac, 8);
  ctx.shadowBlur = 0;
  if (c.count > 0) {
    ctx.font = `600 15px ${FONT}`;
    ctx.fillText(`COMBO ${c.count}`, 28, 120);
  }

  // Top right: wave and best.
  ctx.textAlign = 'right';
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.fillText('WAVE', W - 28, 32);
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillStyle = PALETTE.player;
  ctx.fillText(String(game.wave.number), W - 28, 72);
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.fillText(`BEST ${highScore}`, W - 28, 100);

  // Bottom left: hit points.
  for (let i = 0; i < PLAYER.maxHp; i++) {
    const hx = 40 + i * 34;
    const hy = H - 40;
    ctx.beginPath();
    ctx.arc(hx, hy, 11, 0, TAU);
    if (i < game.player.hp) {
      ctx.fillStyle = PALETTE.player;
      ctx.shadowColor = PALETTE.player;
      ctx.shadowBlur = 10;
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      ctx.strokeStyle = PALETTE.danger;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Bottom centre: dash charge pips. The pip being recharged fills as its timer runs.
  const d = game.player.dash;
  ctx.textAlign = 'center';
  for (let i = 0; i < DASH.maxCharges; i++) {
    const px = W / 2 - 52 + i * 52;
    const py = H - 42;
    const ready = i < d.charges;
    const recharging = i === d.charges && d.charges < DASH.maxCharges;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.PI / 4);
    ctx.strokeStyle = PALETTE.dash;
    ctx.lineWidth = 2;
    if (ready) {
      ctx.fillStyle = PALETTE.dash;
      ctx.shadowColor = PALETTE.dash;
      ctx.shadowBlur = 10;
      ctx.fillRect(-9, -9, 18, 18);
    } else {
      ctx.strokeRect(-9, -9, 18, 18);
      if (recharging) {
        ctx.fillStyle = 'rgba(234, 255, 255, 0.5)';
        const f = Math.min(1, d.recharge / DASH.rechargeTime);
        ctx.fillRect(-9, 9 - 18 * f, 18, 18 * f);
      }
    }
    ctx.restore();
  }
  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = 'rgba(234, 255, 255, 0.5)';
  ctx.fillText('DASH', W / 2, H - 14);

  // Bottom right: pulse cooldown ring.
  const cdFrac = game.player.pulseCooldown > 0 ? 1 - game.player.pulseCooldown / PULSE.cooldown : 1;
  const rx = W - 62;
  const ry = H - 52;
  ctx.beginPath();
  ctx.arc(rx, ry, 20, 0, TAU);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rx, ry, 20, -Math.PI / 2, -Math.PI / 2 + TAU * cdFrac);
  ctx.strokeStyle = cdFrac >= 1 ? PALETTE.gold : PALETTE.player;
  ctx.stroke();
  ctx.font = `600 12px ${FONT}`;
  ctx.fillStyle = 'rgba(234, 255, 255, 0.5)';
  ctx.fillText('PULSE', rx, H - 14);
  ctx.restore();
}

function centred(ctx, text, x, y, font, color) {
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y);
}

function dim(ctx, alpha) {
  ctx.fillStyle = `rgba(2, 5, 13, ${alpha})`;
  ctx.fillRect(0, 0, W, H);
}

function drawMuted(ctx) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = DIM;
  ctx.fillText('MUTED (M)', W / 2, 32);
  ctx.restore();
}

function drawTitle(ctx, view) {
  dim(ctx, 0.5);
  ctx.save();
  ctx.shadowColor = PALETTE.player;
  ctx.shadowBlur = 30;
  centred(ctx, 'RIPTIDE RUSH', W / 2, 220, `bold 96px ${FONT}`, PALETTE.player);
  ctx.restore();
  centred(ctx, 'Dash through everything. Every kill refunds a charge.', W / 2, 300, `24px ${FONT}`, PALETTE.dash);

  const lines = [
    ['WASD / Arrows', 'swim'],
    ['Mouse', 'aim'],
    ['Left click / Space', 'dash-slash toward the cursor'],
    ['Right click / Shift', 'pulse: reflect bullets, stagger enemies'],
    ['Esc / P', 'pause'],
    ['M', 'mute'],
  ];
  ctx.font = `18px ${FONT}`;
  lines.forEach(([keys, what], i) => {
    const y = 380 + i * 30;
    ctx.textAlign = 'right';
    ctx.fillStyle = PALETTE.gold;
    ctx.fillText(keys, W / 2 - 14, y);
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(234, 255, 255, 0.8)';
    ctx.fillText(what, W / 2 + 14, y);
  });

  const blink = 0.55 + 0.45 * Math.sin(view.time * 4);
  ctx.globalAlpha = blink;
  centred(ctx, 'Click or press Space to dive in', W / 2, 600, `bold 26px ${FONT}`, PALETTE.gold);
  ctx.globalAlpha = 1;
  centred(ctx, `Best: ${view.highScore}`, W / 2, 648, `20px ${FONT}`, DIM);
}

function drawPaused(ctx) {
  dim(ctx, 0.55);
  centred(ctx, 'PAUSED', W / 2, H / 2 - 20, `bold 72px ${FONT}`, PALETTE.player);
  centred(ctx, 'Esc, P or click to resume', W / 2, H / 2 + 40, `22px ${FONT}`, PALETTE.dash);
}

function drawGameOver(ctx, view) {
  dim(ctx, 0.6);
  centred(ctx, 'WRECKED', W / 2, H / 2 - 110, `bold 88px ${FONT}`, PALETTE.danger);
  centred(ctx, `Score  ${view.game.score}`, W / 2, H / 2 - 20, `bold 44px ${FONT}`, PALETTE.gold);
  if (view.newBest) {
    centred(ctx, 'NEW BEST!', W / 2, H / 2 + 34, `bold 26px ${FONT}`, PALETTE.combo[1]);
  } else {
    centred(ctx, `Best  ${view.highScore}`, W / 2, H / 2 + 34, `24px ${FONT}`, 'rgba(234, 255, 255, 0.7)');
  }
  if (view.overAge >= RESTART_GATE) {
    const blink = 0.55 + 0.45 * Math.sin(view.time * 5);
    ctx.globalAlpha = blink;
    centred(ctx, 'Click, Space or R to dive again', W / 2, H / 2 + 100, `bold 22px ${FONT}`, PALETTE.dash);
    ctx.globalAlpha = 1;
  }
}

// view:{ screen, game, alpha, time, dt, highScore, newBest, overAge, muted, fx, rings }
export function drawFrame(ctx, view) {
  ctx.setTransform(ctx.canvas.width / W, 0, 0, ctx.canvas.height / H, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  draw.background(ctx, W, H, view.time);

  const { game, screen, fx } = view;
  if (screen !== 'title' && game) {
    // The shake offsets the world (entities, pulses, particles), not the HUD or the arena backdrop.
    const shake = fx.getShakeOffset();
    ctx.save();
    ctx.translate(shake.x, shake.y);
    drawWarnings(ctx, game, view.time);
    drawEnemies(ctx, game, view);
    drawBullets(ctx, game, view);
    drawDashFeedback(ctx, game);
    drawPlayer(ctx, game, view);
    drawRings(ctx, view.rings);
    fx.drawWorld(ctx);
    ctx.restore();
    fx.drawScreen(ctx, W, H);
    drawHud(ctx, game, view.highScore);
  }

  if (screen === 'title') drawTitle(ctx, view);
  if (screen === 'paused') drawPaused(ctx);
  if (screen === 'over') drawGameOver(ctx, view);
  if (view.muted) drawMuted(ctx);
}
