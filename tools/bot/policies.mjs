// Scripted policies for the headless bot harness. Each policy reads the live game and returns one
// intent per step: a move vector, an aim point and whether a dash or pulse was pressed this step.
// sim-run.mjs turns presses into the sim's buffered input. Policies only read the game; they never
// write to it. Any randomness comes from the rng the harness passes in, so runs stay seeded.
import { ARENA, DASH, ENEMY, LOGICAL_HEIGHT as H, LOGICAL_WIDTH as W, PLAYER, PULSE } from '../../src/config.js';
import { segmentHitsCircle } from '../../src/game.js';

const TAU = Math.PI * 2;
const LO_X = ARENA.inset + PLAYER.radius;
const HI_X = W - ARENA.inset - PLAYER.radius;
const LO_Y = ARENA.inset + PLAYER.radius;
const HI_Y = H - ARENA.inset - PLAYER.radius;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap = (a) => a - TAU * Math.round(a / TAU);

function norm(dx, dy) {
  const l = Math.hypot(dx, dy);
  return l > 1e-9 ? [dx / l, dy / l] : [0, 0];
}

export function blankIntent() {
  return { moveX: 0, moveY: 0, aimX: null, aimY: null, dash: false, pulse: false };
}

// Gentle push toward the middle when Rip is within 90 px of an edge.
function wallPush(p) {
  const m = 90;
  let x = 0;
  let y = 0;
  if (p.x - LO_X < m) x += (m - (p.x - LO_X)) / m;
  if (HI_X - p.x < m) x -= (m - (HI_X - p.x)) / m;
  if (p.y - LO_Y < m) y += (m - (p.y - LO_Y)) / m;
  if (HI_Y - p.y < m) y -= (m - (HI_Y - p.y)) / m;
  return [x, y];
}

// Nearest live enemy matching pred, as { e, d }, or null.
function nearest(game, pred) {
  const p = game.player;
  let best = null;
  let bd2 = Infinity;
  for (const e of game.enemies) {
    if (!e.alive || !pred(e)) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bd2) {
      bd2 = d2;
      best = e;
    }
  }
  return best ? { e: best, d: Math.sqrt(bd2) } : null;
}

const notMine = (e) => e.kind !== 'mine';

// Live enemy bullets flying at Rip, soonest first. t is seconds until the bullet reaches her body.
function incomingBullets(game, horizon) {
  const p = game.player;
  const out = [];
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'enemy') continue;
    const speed = Math.hypot(b.vx, b.vy);
    if (speed <= 0) continue;
    if ((p.x - b.x) * b.vx + (p.y - b.y) * b.vy <= 0) continue; // moving away from her
    const dist = Math.hypot(b.x - p.x, b.y - p.y);
    const t = Math.max(0, dist - PLAYER.radius) / speed;
    if (t <= horizon) out.push({ b, dist, t });
  }
  out.sort((a, c) => a.t - c.t);
  return out;
}

// ---- Beginner -------------------------------------------------------------------------------------
// Moves away from the nearest enemy. Dashes rarely, and only at a close non-mine target. Never pulses.
export const beginner = {
  name: 'beginner',
  salt: 0x1001,
  createMemory: () => ({ lastDash: -Infinity }),
  decide(game, rng, mem) {
    const p = game.player;
    const out = blankIntent();
    const near = nearest(game, () => true);
    if (near) [out.moveX, out.moveY] = norm(p.x - near.e.x, p.y - near.e.y);
    const [wx, wy] = wallPush(p);
    out.moveX += wx;
    out.moveY += wy;

    const close = nearest(game, notMine);
    if (
      close &&
      close.d <= 90 &&
      p.dash.charges >= 1 &&
      p.dash.active === null &&
      game.time - mem.lastDash >= 2 &&
      rng() < 0.25
    ) {
      out.dash = true;
      out.aimX = close.e.x;
      out.aimY = close.e.y;
      mem.lastDash = game.time;
    }
    return out;
  },
};

// ---- Intermediate ---------------------------------------------------------------------------------
// Keeps a loose distance from the nearest non-mine enemy. Dashes at it whenever a charge is ready and it
// is in range. Pulses when an enemy bullet is about to reach her.
export const intermediate = {
  name: 'intermediate',
  salt: 0x2002,
  createMemory: () => ({}),
  decide(game) {
    const p = game.player;
    const out = blankIntent();
    const target = nearest(game, notMine) ?? nearest(game, () => true);
    if (target) {
      const [ux, uy] = norm(target.e.x - p.x, target.e.y - p.y);
      if (target.d > 170) {
        out.moveX += ux;
        out.moveY += uy;
      } else if (target.d < 90) {
        out.moveX -= ux * 0.6;
        out.moveY -= uy * 0.6;
      } else {
        out.moveX += -uy * 0.5; // circle it
        out.moveY += ux * 0.5;
      }
    }

    const threats = incomingBullets(game, 0.5);
    if (threats.length > 0) {
      const [bx, by] = norm(threats[0].b.vx, threats[0].b.vy);
      out.moveX += -by * 1.5; // sidestep the bullet's line
      out.moveY += bx * 1.5;
    }
    const [wx, wy] = wallPush(p);
    out.moveX += wx;
    out.moveY += wy;

    if (target && p.dash.charges >= 1 && p.dash.active === null && target.d <= 320) {
      out.dash = true;
      out.aimX = target.e.x;
      out.aimY = target.e.y;
    }
    if (p.pulseCooldown <= 0 && threats.length > 0 && threats[0].dist <= PULSE.radius && threats[0].t < 0.45) {
      out.pulse = true;
    }
    return out;
  },
};

// ---- Expert ---------------------------------------------------------------------------------------
// Plans dash chains: every few steps it scores each candidate dash (toward an enemy or a ring
// direction) by the enemies its swept path would kill, and fires the best one when a charge is ready.
// It stands behind the nearest cluster so the next chain can cross it, dodges bullets and lunges, keeps
// off armed mines, and times pulses into the perfect window (impact within PULSE.perfectWindow).
const PLAN_EVERY = 8; // steps between re-plans: about 67 ms, a quick but human-plausible think time
const PLAN_REACH = 340; // enemies farther than this are not part of a chain yet
const RING_AIMS = 12;
const VALUE = { drifter: 1, mini: 0.6, spitter: 1.2, charger: 1.2, splitter: 1.5, shellback: 1.5, mine: 0.8 };

// True if a dash from p along (ux, uy) reaches the front arc of a Shellback, which would deflect it.
function frontal(e, p, ux, uy) {
  const s = clamp((e.x - p.x) * ux + (e.y - p.y) * uy, 0, DASH.distance);
  const cx = p.x + ux * s;
  const cy = p.y + uy * s;
  const ang = Math.atan2(cy - e.y, cx - e.x);
  return Math.abs(wrap(ang - e.facing)) <= ENEMY.shellback.armorHalfAngle;
}

// Best dash from Rip's current position: the aim point whose swept path kills the most value.
function planChain(game) {
  const p = game.player;
  const near = [];
  for (const e of game.enemies) if (e.alive && Math.hypot(e.x - p.x, e.y - p.y) <= PLAN_REACH) near.push(e);
  const aims = near.map((e) => [e.x, e.y]);
  for (let i = 0; i < RING_AIMS; i++) {
    const a = (i * TAU) / RING_AIMS;
    aims.push([p.x + Math.cos(a) * 100, p.y + Math.sin(a) * 100]);
  }

  let best = { kills: 0, value: 0, aimX: null, aimY: null };
  for (const [ax, ay] of aims) {
    const [ux, uy] = norm(ax - p.x, ay - p.y);
    if (ux === 0 && uy === 0) continue;
    const ex = clamp(p.x + ux * DASH.distance, LO_X, HI_X);
    const ey = clamp(p.y + uy * DASH.distance, LO_Y, HI_Y);
    let kills = 0;
    let value = 0;
    let blocked = false;
    for (const e of near) {
      if (!segmentHitsCircle(p.x, p.y, ex, ey, e.x, e.y, e.r + PLAYER.radius)) continue;
      if (e.kind === 'shellback' && e.stagger <= 0 && frontal(e, p, ux, uy)) {
        blocked = true;
        break;
      }
      kills += 1;
      value += VALUE[e.kind] ?? 1;
    }
    if (!blocked && value > best.value) best = { kills, value, aimX: ax, aimY: ay };
  }
  return best;
}

// Centroid of the nearest enemies (non-mines unless includeMines): where the next chain should start.
// take = how many of the nearest to average; the mine fallback takes 1, so a centroid of mines spread
// across the arena cannot land in empty space.
function nearestCluster(game, includeMines = false, maxDist = 420, takeN = 6) {
  const p = game.player;
  const list = [];
  for (const e of game.enemies) {
    if (!e.alive || (e.kind === 'mine' && !includeMines)) continue;
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d <= maxDist) list.push({ e, d });
  }
  if (list.length === 0) return null;
  list.sort((a, b) => a.d - b.d);
  const take = list.slice(0, takeN);
  let x = 0;
  let y = 0;
  for (const { e } of take) {
    x += e.x;
    y += e.y;
  }
  return { x: x / take.length, y: y / take.length };
}

export const expert = {
  name: 'expert',
  salt: 0x3003,
  createMemory: () => ({ tick: 0, plan: null, wasBusy: false }),
  decide(game, rng, mem) {
    const p = game.player;
    const out = blankIntent();
    const busy = p.dash.active !== null || p.bounce !== null;
    if (mem.wasBusy && !busy) mem.plan = null; // re-plan the moment a dash or bounce ends
    mem.wasBusy = busy;
    if (mem.plan === null || mem.tick % PLAN_EVERY === 0) {
      mem.plan = planChain(game);
      // The hold-spot target is planned with the chain, so it is not rebuilt every step.
      // With only mines left, a skilled player goes and defuses them: the wave cannot end otherwise.
      mem.cluster = nearestCluster(game) ?? nearestCluster(game, true, Infinity, 1);
    }
    mem.tick += 1;
    const plan = mem.plan;
    const threats = incomingBullets(game, 0.6);

    // Movement: sidestep bullets, keep off armed mines and out of charger lunge lines, else hold a spot
    // just short of the nearest cluster.
    let mx = 0;
    let my = 0;
    for (const th of threats.slice(0, 3)) {
      const [bx, by] = norm(th.b.vx, th.b.vy);
      let px = -by;
      let py = bx;
      if (px * (p.x - th.b.x) + py * (p.y - th.b.y) < 0) {
        px = -px;
        py = -py;
      }
      const w = 0.6 + 1.2 * (1 - Math.min(th.t, 0.6) / 0.6);
      mx += px * w;
      my += py * w;
    }
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (e.kind === 'mine') {
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < 120) {
          const [ux, uy] = norm(p.x - e.x, p.y - e.y);
          const w = (2 * (120 - d)) / 120;
          mx += ux * w;
          my += uy * w;
        }
      } else if (e.kind === 'charger' && (e.state === 'telegraph' || e.state === 'lunge')) {
        const along = (p.x - e.x) * e.dirX + (p.y - e.y) * e.dirY;
        if (along > 0) {
          const perpX = -e.dirY;
          const perpY = e.dirX;
          const off = (p.x - e.x) * perpX + (p.y - e.y) * perpY;
          if (Math.abs(off) < 55) {
            const sg = off >= 0 ? 1 : -1;
            mx += perpX * sg * 1.5;
            my += perpY * sg * 1.5;
          }
        }
      }
    }
    if (plan.kills === 0 || p.dash.charges === 0) {
      const c = mem.cluster;
      if (c) {
        const [ux, uy] = norm(c.x - p.x, c.y - p.y);
        const sx = c.x - ux * 110; // a spot 110 px short of the cluster, on the line to it
        const sy = c.y - uy * 110;
        const dd = Math.hypot(sx - p.x, sy - p.y);
        const [ax, ay] = norm(sx - p.x, sy - p.y);
        if (dd > 40) {
          mx += ax;
          my += ay;
        } else {
          mx += ux;
          my += uy;
        }
      } else {
        const [cx, cy] = norm(W / 2 - p.x, H / 2 - p.y);
        mx += cx * 0.5;
        my += cy * 0.5;
      }
    }
    const [wx, wy] = wallPush(p);
    out.moveX = mx + wx;
    out.moveY = my + wy;

    // Dash: fire the planned chain as soon as it kills something and a charge is ready.
    if (plan.kills >= 1 && p.dash.charges >= 1 && !busy) {
      out.dash = true;
      out.aimX = plan.aimX;
      out.aimY = plan.aimY;
    }

    // Pulse: press so the reflect lands inside the perfect window (impact within 0.12 s) and within reach.
    if (p.pulseCooldown <= 0) {
      for (const th of threats) {
        if (th.dist > PULSE.radius) continue;
        if (th.t <= PULSE.perfectWindow) {
          out.pulse = true;
          break;
        }
      }
    }
    return out;
  },
};

export const POLICIES = [beginner, intermediate, expert];
