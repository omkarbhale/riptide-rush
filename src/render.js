// Placeholder presentation for the core loop: readable shapes in the issue's palette, plus HUD and
// menus. Reads game state and view state only; never mutates the simulation.
// Final art (src/art.js) and particles/shake (src/fx.js) replace these later.
import {
  LOGICAL_WIDTH as W,
  LOGICAL_HEIGHT as H,
  ARENA,
  PLAYER,
  DASH,
  PULSE,
  SPAWN,
  ENEMY,
  RESTART_GATE,
} from './config.js';
import { mulberry32, multiplierFor, comboWindowFor, dashPreview } from './game.js';

export const PALETTE = {
  bgTop: '#050a18',
  bgBottom: '#0a1830',
  player: '#3cf2ff',
  dash: '#eaffff',
  danger: '#ff3d81',
  bullet: '#ffb347',
  gold: '#ffe066',
  tiers: ['#3cf2ff', '#5dff9b', '#ffe066', '#ff3d81', '#ffffff'],
  enemy: { drifter: '#ff3d81', spitter: '#b48cff', charger: '#ff7a3d' },
};

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const lerp = (a, b, t) => a + (b - a) * t;

const plankton = (() => {
  const r = mulberry32(4242);
  return Array.from({ length: 70 }, () => ({
    x: r() * W,
    y: r() * H,
    s: 0.6 + r() * 1.6,
    v: 3 + r() * 9,
  }));
})();

export function drawFrame(ctx, view) {
  ctx.setTransform(ctx.canvas.width / W, 0, 0, ctx.canvas.height / H, 0, 0);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  drawBackground(ctx, view.time);

  const { game, screen } = view;
  if (screen !== 'title' && game) {
    drawWarnings(ctx, game, view.time);
    drawEnemies(ctx, game, view.alpha, view.time);
    drawBullets(ctx, game, view.alpha);
    drawDashFeedback(ctx, game);
    drawPlayer(ctx, game, view.alpha, view.time);
  }
  drawEffects(ctx, view.effects);
  if (screen !== 'title' && game) drawHud(ctx, game, view.highScore);

  if (screen === 'title') drawTitle(ctx, view);
  if (screen === 'paused') drawPaused(ctx, view);
  if (screen === 'over') drawGameOver(ctx, view);
}

function drawBackground(ctx, t) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, PALETTE.bgTop);
  g.addColorStop(1, PALETTE.bgBottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#7fd6ff';
  for (const p of plankton) {
    const y = (p.y + t * p.v) % H;
    ctx.globalAlpha = 0.18 + 0.12 * Math.sin(t * 1.5 + p.x);
    ctx.beginPath();
    ctx.arc(p.x, y, p.s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = 'rgba(60, 242, 255, 0.16)';
  ctx.lineWidth = 2;
  ctx.strokeRect(ARENA.inset, ARENA.inset, W - 2 * ARENA.inset, H - 2 * ARENA.inset);
}

function drawWarnings(ctx, game, t) {
  ctx.strokeStyle = PALETTE.danger;
  ctx.lineWidth = 3;
  for (const wn of game.warnings) {
    const k = 1 - wn.t / SPAWN.warning; // 0 at first sight, 1 when the enemy appears
    ctx.globalAlpha = 0.35 + 0.65 * k;
    ctx.beginPath();
    ctx.arc(wn.x, wn.y, 22 - 10 * k + 2 * Math.sin(t * 20), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

const ENEMY_SHAPES = {
  drifter(ctx, e, t) {
    const r = e.r * (1 + 0.08 * Math.sin(t * 8 + e.id));
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.8, 0);
    ctx.lineTo(0, r);
    ctx.lineTo(-r * 0.8, 0);
    ctx.closePath();
    ctx.fill();
  },
  spitter(ctx, e) {
    ctx.beginPath();
    ctx.arc(0, 0, e.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = PALETTE.dash;
    ctx.beginPath();
    ctx.arc(0, 0, e.r * 0.35, 0, Math.PI * 2);
    ctx.fill();
  },
  charger(ctx, e) {
    const angle = e.state === 'lunge' || e.state === 'telegraph' ? Math.atan2(e.dirY, e.dirX) : Math.atan2(e.vy, e.vx);
    ctx.rotate(Number.isFinite(angle) ? angle : 0);
    const r = e.r * 1.3;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.7, r * 0.8);
    ctx.lineTo(-r * 0.7, -r * 0.8);
    ctx.closePath();
    ctx.fill();
  },
};

function drawEnemies(ctx, game, alpha, t) {
  for (const e of game.enemies) {
    const x = lerp(e.px, e.x, alpha);
    const y = lerp(e.py, e.y, alpha);
    const color = PALETTE.enemy[e.kind] ?? PALETTE.danger;

    if (e.kind === 'charger' && e.state === 'telegraph') {
      // Telegraph: a dashed aim line that flashes harder as the lunge nears.
      const k = 1 - e.stateT / ENEMY.charger.telegraph;
      ctx.save();
      ctx.strokeStyle = PALETTE.danger;
      ctx.lineWidth = 3 + 3 * k;
      ctx.globalAlpha = 0.35 + 0.65 * Math.abs(Math.sin(t * (10 + 30 * k)));
      ctx.setLineDash([12, 10]);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + e.dirX * 420, y + e.dirY * 420);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.shadowColor = color;
    ctx.shadowBlur = 14;
    ctx.fillStyle = e.stagger > 0 ? '#ffffff' : color;
    ctx.globalAlpha = e.stagger > 0 ? 0.6 : 1;
    const draw = ENEMY_SHAPES[e.kind];
    if (draw) draw(ctx, e, t);
    ctx.restore();
  }
}

function drawBullets(ctx, game, alpha) {
  for (const b of game.bullets) {
    const x = lerp(b.px, b.x, alpha);
    const y = lerp(b.py, b.y, alpha);
    const mine = b.owner === 'player';
    const color = mine ? PALETTE.dash : PALETTE.bullet;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

// Afterglow after a dash, and an aim preview: a faint line and ring where the next dash would end,
// brighter (gold) when it would kill. Reads state only.
function drawDashFeedback(ctx, game) {
  const p = game.player;
  if (p.dashGrace > 0 && !p.dash.active) {
    ctx.save();
    ctx.globalAlpha = 0.5 * (p.dashGrace / DASH.killGrace);
    ctx.fillStyle = PALETTE.dash;
    ctx.shadowColor = PALETTE.dash;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PLAYER.radius * 1.4, 0, Math.PI * 2);
    ctx.fill();
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
  ctx.arc(pv.x, pv.y, PLAYER.radius + 6, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(ctx, game, alpha, t) {
  const p = game.player;
  const x = lerp(p.px, p.x, alpha);
  const y = lerp(p.py, p.y, alpha);
  const dash = p.dash.active;

  if (dash) {
    // Trail from the dash start to the current position.
    ctx.save();
    ctx.strokeStyle = PALETTE.dash;
    ctx.lineCap = 'round';
    ctx.shadowColor = PALETTE.dash;
    ctx.shadowBlur = 20;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = PLAYER.radius * 1.4;
    ctx.beginPath();
    ctx.moveTo(dash.sx, dash.sy);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
  }

  // Post-hit invulnerability blinks the fish.
  if (p.invuln > 0 && !dash && Math.floor(t * 16) % 2 === 0) return;

  const color = dash ? PALETTE.dash : PALETTE.player;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(p.facing);
  ctx.shadowColor = color;
  ctx.shadowBlur = dash ? 28 : 16;
  ctx.fillStyle = color;
  const r = PLAYER.radius;
  ctx.beginPath();
  ctx.moveTo(r * 1.6, 0);
  ctx.lineTo(-r, r * 0.9);
  ctx.lineTo(-r * 0.4, 0);
  ctx.lineTo(-r, -r * 0.9);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Effects are short-lived records pushed by main.js from sim events; they age in real time.
function drawEffects(ctx, effects) {
  for (const fx of effects) {
    const k = Math.min(1, fx.age / fx.life);
    ctx.save();
    switch (fx.kind) {
      case 'pulse': {
        ctx.strokeStyle = fx.perfect ? PALETTE.gold : PALETTE.player;
        ctx.lineWidth = 3 + 4 * (1 - k);
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, PULSE.radius * k, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'dash': {
        ctx.strokeStyle = PALETTE.dash;
        ctx.lineCap = 'round';
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2 + 10 * (1 - k);
        ctx.beginPath();
        ctx.moveTo(fx.x, fx.y);
        ctx.lineTo(fx.x + Math.cos(fx.angle) * DASH.distance, fx.y + Math.sin(fx.angle) * DASH.distance);
        ctx.stroke();
        break;
      }
      case 'kill': {
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = 4 * (1 - k) + 1;
        ctx.globalAlpha = 1 - k;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 12 + 40 * k, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'reflect': {
        ctx.strokeStyle = PALETTE.dash;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 6 + 16 * k, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case 'float': {
        ctx.fillStyle = fx.color;
        ctx.globalAlpha = 1 - k;
        ctx.font = `bold ${fx.size ?? 22}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.shadowColor = fx.color;
        ctx.shadowBlur = 8;
        ctx.fillText(fx.text, fx.x, fx.y - 40 * k);
        break;
      }
      case 'hurt': {
        const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
        g.addColorStop(0, 'rgba(255, 61, 129, 0)');
        g.addColorStop(1, 'rgba(255, 61, 129, 0.55)');
        ctx.globalAlpha = 1 - k;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        break;
      }
      default:
        break;
    }
    ctx.restore();
  }
}

function drawHud(ctx, game, highScore) {
  const c = game.combo;
  const mult = multiplierFor(c.count);
  const tierColor = PALETTE.tiers[c.tier] ?? PALETTE.player;

  ctx.save();
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = 'rgba(234, 255, 255, 0.6)';
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
  ctx.fillStyle = 'rgba(234, 255, 255, 0.6)';
  ctx.fillText('WAVE', W - 28, 32);
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillStyle = PALETTE.player;
  ctx.fillText(String(game.wave.number), W - 28, 72);
  ctx.font = `600 15px ${FONT}`;
  ctx.fillStyle = 'rgba(234, 255, 255, 0.6)';
  ctx.fillText(`BEST ${highScore}`, W - 28, 100);

  // Bottom left: hit points.
  for (let i = 0; i < PLAYER.maxHp; i++) {
    const hx = 40 + i * 34;
    const hy = H - 40;
    ctx.beginPath();
    ctx.arc(hx, hy, 11, 0, Math.PI * 2);
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
  ctx.arc(rx, ry, 20, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(rx, ry, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cdFrac);
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
  centred(ctx, 'Click or press Space to dive in', W / 2, 580, `bold 26px ${FONT}`, PALETTE.gold);
  ctx.globalAlpha = 1;
  centred(ctx, `Best: ${view.highScore}`, W / 2, 630, `20px ${FONT}`, 'rgba(234, 255, 255, 0.6)');
}

function drawPaused(ctx, view) {
  dim(ctx, 0.55);
  centred(ctx, 'PAUSED', W / 2, H / 2 - 20, `bold 72px ${FONT}`, PALETTE.player);
  centred(ctx, 'Esc, P or click to resume', W / 2, H / 2 + 40, `22px ${FONT}`, PALETTE.dash);
}

function drawGameOver(ctx, view) {
  dim(ctx, 0.6);
  centred(ctx, 'WRECKED', W / 2, H / 2 - 110, `bold 88px ${FONT}`, PALETTE.danger);
  centred(ctx, `Score  ${view.game.score}`, W / 2, H / 2 - 20, `bold 44px ${FONT}`, PALETTE.gold);
  if (view.newBest) {
    centred(ctx, 'NEW BEST!', W / 2, H / 2 + 34, `bold 26px ${FONT}`, PALETTE.tiers[1]);
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
