// Presentation for health recovery and modifier drops (#54): pickup shapes, the Shield Scale aura,
// transient rings and floaters, and the modifier HUD. Reads game state only; never mutates it.
import { PLAYER, PICKUP, MODIFIER } from './config.js';
import { PICKUP_KINDS } from './pickups.js';

const FONT = '"Trebuchet MS", "Segoe UI", system-ui, sans-serif';
// Dark rim around each pickup's solid shape (the deep-sea background colour).
const PALETTE_RIM = '#0a1020';
const lerp = (a, b, t) => a + (b - a) * t;

// Each kind has its own silhouette, so pickups read apart at about 20 px.
const SHAPES = {
  // Heart: a green orb with a bright core.
  heal(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(0, r * 0.8);
    ctx.bezierCurveTo(-r * 1.3, r * 0.1, -r * 0.9, -r * 0.9, 0, -r * 0.35);
    ctx.bezierCurveTo(r * 0.9, -r * 0.9, r * 1.3, r * 0.1, 0, r * 0.8);
    ctx.closePath();
    ctx.fill();
  },
  // Four-point spark.
  sparkCoral(ctx, r) {
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const rad = i % 2 === 0 ? r : r * 0.38;
      const a = (Math.PI / 4) * i - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
    }
    ctx.closePath();
    ctx.fill();
  },
  // Hexagon coal chunk.
  riptideCoal(ctx, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  },
  // Shield: flat top, pointed foot.
  shieldScale(ctx, r) {
    ctx.beginPath();
    ctx.moveTo(-r * 0.9, -r * 0.7);
    ctx.lineTo(0, -r * 0.95);
    ctx.lineTo(r * 0.9, -r * 0.7);
    ctx.lineTo(r * 0.9, r * 0.1);
    ctx.lineTo(0, r);
    ctx.lineTo(-r * 0.9, r * 0.1);
    ctx.closePath();
    ctx.fill();
  },
  // Frenzy: an upward chevron.
  frenzy(ctx, r) {
    // Drawn larger than the others: a thin chevron reads smaller than a solid shape at the same radius.
    r *= 1.3;
    ctx.beginPath();
    ctx.moveTo(0, -r);
    ctx.lineTo(r, r * 0.6);
    ctx.lineTo(0, r * 0.05);
    ctx.lineTo(-r, r * 0.6);
    ctx.closePath();
    ctx.fill();
  },
  // Undertow: a ring with a gap, like a swirl.
  undertow(ctx, r) {
    ctx.lineWidth = Math.max(2, r * 0.45);
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.7, 0.4, Math.PI * 2 - 0.4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.25, 0, Math.PI * 2);
    ctx.fill();
  },
};

// Pickups on the field, then the Shield Scale aura, then rings and floaters.
// Called by render.js between the warnings and the enemies.
export function drawPickups(ctx, game, alpha, t) {
  const s = game.pickups;
  for (const it of s.items) {
    // The final seconds blink so a pickup about to vanish reads as urgent.
    const blinking = it.age >= PICKUP.lifetime - PICKUP.blinkWindow;
    if (blinking && Math.floor(t * 10) % 2 === 0) continue;

    const color = PICKUP_KINDS[it.kind].color;
    const pulse = 1 + 0.12 * Math.sin(t * 6 + it.id);
    const r = PICKUP.radius * 1.05 * pulse;
    // Bob: a slow vertical float, out of phase per pickup so a cluster does not move in step.
    const bob = Math.sin(t * 3.2 + it.id * 1.7) * 1.8;
    ctx.save();
    ctx.translate(it.x, it.y + bob);

    // Glow: three soft discs, additive. Cheaper than shadowBlur on every pickup, and it reads at 20 px.
    ctx.globalCompositeOperation = 'lighter';
    const glow = 0.85 + 0.15 * Math.sin(t * 5 + it.id);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.1 * glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.18 * glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.3 * glow;
    ctx.beginPath();
    ctx.arc(0, 0, r * 1.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';

    // The solid shape, with a dark rim so it separates from the background and from bright bullets.
    ctx.globalAlpha = 1;
    ctx.fillStyle = color;
    ctx.strokeStyle = PALETTE_RIM;
    ctx.lineWidth = 1.2;
    SHAPES[it.kind](ctx, r);
    ctx.stroke();

    // A white core makes each pickup read as lit from within.
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.22, 0, Math.PI * 2);
    ctx.fill();

    // Sparkle: two four-point glints that twinkle around the pickup.
    ctx.globalCompositeOperation = 'lighter';
    for (let k = 0; k < 2; k++) {
      const phase = t * 4 + it.id * 2.3 + k * Math.PI;
      const tw = Math.max(0, Math.sin(phase));
      if (tw <= 0.05) continue;
      const a = it.id * 1.9 + k * 2.1 + t * 0.6;
      const sx = Math.cos(a) * r * 1.6;
      const sy = Math.sin(a) * r * 1.6;
      const len = r * (0.35 + 0.45 * tw);
      ctx.strokeStyle = 'rgba(255, 255, 255, ' + (0.85 * tw).toFixed(3) + ')';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(sx - len, sy);
      ctx.lineTo(sx + len, sy);
      ctx.moveTo(sx, sy - len);
      ctx.lineTo(sx, sy + len);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawShieldAura(ctx, game, alpha, t);
  drawFx(ctx, s.fx);
}

// Silver aura around Rip while a Shield Scale is active. The arc shows the time left.
function drawShieldAura(ctx, game, alpha, t) {
  const remaining = game.modifiers.shieldScale;
  if (remaining === undefined) return;
  const p = game.player;
  const x = lerp(p.px, p.x, alpha);
  const y = lerp(p.py, p.y, alpha);
  const frac = Math.max(0, Math.min(1, remaining / MODIFIER.shieldScale.duration));
  const r = PLAYER.radius + 12 + 1.5 * Math.sin(t * 5);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur = 14;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(230, 244, 255, 0.95)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac);
  ctx.stroke();
  ctx.restore();
}

function drawFx(ctx, fxList) {
  for (const fx of fxList) {
    const k = Math.min(1, fx.age / fx.life);
    ctx.save();
    if (fx.kind === 'ring') {
      ctx.strokeStyle = fx.color;
      ctx.shadowColor = fx.color;
      ctx.shadowBlur = 10;
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 2 + 4 * (1 - k);
      ctx.beginPath();
      ctx.arc(fx.x, fx.y, fx.r * (0.4 + 0.6 * k), 0, Math.PI * 2);
      ctx.stroke();
    } else if (fx.kind === 'text') {
      ctx.fillStyle = fx.color;
      ctx.shadowColor = fx.color;
      ctx.shadowBlur = 8;
      ctx.globalAlpha = 1 - k;
      ctx.font = `bold 18px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(fx.text, fx.x, fx.y - 30 * k);
    }
    ctx.restore();
  }
}

// HUD: one row per active modifier, with its icon, its name and a bar that shrinks as it runs out.
// Drawn under the combo timer at the top left. Rows are sorted by kind so they do not jump around.
export function drawModifierHud(ctx, game) {
  const kinds = Object.keys(game.modifiers).sort();
  if (kinds.length === 0) return;
  const barW = 150;
  ctx.save();
  ctx.font = `600 13px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  kinds.forEach((kind, i) => {
    const y = 160 + i * 28;
    const color = PICKUP_KINDS[kind].color;
    const frac = Math.max(0, Math.min(1, game.modifiers[kind] / MODIFIER[kind].duration));
    ctx.save();
    ctx.translate(40, y);
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    SHAPES[kind](ctx, 8);
    ctx.restore();
    ctx.fillStyle = 'rgba(234, 255, 255, 0.85)';
    ctx.fillText(PICKUP_KINDS[kind].label, 58, y);
    const bx = 170;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.fillRect(bx, y - 4, barW, 8);
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.fillRect(bx, y - 4, barW * frac, 8);
    ctx.shadowBlur = 0;
  });
  ctx.restore();
}
