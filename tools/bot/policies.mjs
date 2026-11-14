// Scripted policies for the headless bot harness. Each policy reads the live game and returns one
// intent per step: a move vector, an aim point and whether a dash or pulse was pressed this step.
// sim-run.mjs turns presses into the sim's buffered input. Policies only read the game; they never
// write to it. Any randomness comes from the rng the harness passes in, so runs stay seeded.
import { ARENA, DASH, ENEMY, LOGICAL_HEIGHT as H, LOGICAL_WIDTH as W, PICKUP, PLAYER, PULSE } from '../../src/config.js';
import { distToSegment, planDash, segmentHitsCircle } from '../../src/game.js';

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
// Minimal human sense (#105): a bullet is noticed only once it has been in view for BEGINNER_SIGHT seconds,
// and the beginner reacts to about half of the bullets it notices (decided once per bullet, from the
// seeded rng). A reacting beginner sidesteps the bullet's line. Before #105 it never looked at bullets.
const BEGINNER_SIGHT = 0.4; // seconds a bullet must be in view before this policy can react to it
const BEGINNER_REACT = 0.5; // share of bullets this policy reacts to

export const beginner = {
  name: 'beginner',
  salt: 0x1001,
  createMemory: () => ({ lastDash: -Infinity, seen: new Map(), react: new Map() }),
  decide(game, rng, mem) {
    const p = game.player;
    const out = blankIntent();
    const near = nearest(game, () => true);
    if (near) [out.moveX, out.moveY] = norm(p.x - near.e.x, p.y - near.e.y);
    const [wx, wy] = wallPush(p);
    out.moveX += wx;
    out.moveY += wy;

    // Bullets it can see: each is stamped when first in view, and rolled once for whether it is reacted to.
    const inView = incomingBullets(game, 3);
    for (const th of inView) {
      if (!mem.seen.has(th.b.id)) {
        mem.seen.set(th.b.id, game.time);
        mem.react.set(th.b.id, rng() < BEGINNER_REACT);
      }
    }
    const threat = inView.find(
      (th) => th.t <= 0.8 && mem.react.get(th.b.id) && game.time - mem.seen.get(th.b.id) >= BEGINNER_SIGHT,
    );
    if (threat) {
      const [bx, by] = norm(threat.b.vx, threat.b.vy);
      out.moveX += -by * 1.5; // sidestep the bullet's line
      out.moveY += bx * 1.5;
    }

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
// is in range. Pulses when an enemy bullet is about to reach her. Modelled as a decent human (#97):
// a target or bullet is only acted on REACTION seconds after it came into view, the dash aim is off by up
// to AIM_ERROR radians, and it cannot dash more often than every MIN_DASH_GAP seconds (about 4 a second).
const REACTION = 0.2; // seconds
const AIM_ERROR = (4 * Math.PI) / 180; // radians either side of the aim line
const MIN_DASH_GAP = 0.25; // seconds between dash presses

export const intermediate = {
  name: 'intermediate',
  salt: 0x2002,
  createMemory: () => ({ seen: new Map(), lastDash: -Infinity }),
  decide(game, rng, mem) {
    const p = game.player;
    const out = blankIntent();
    // Reaction: the first step an id is in view stamps it; it counts only after REACTION seconds.
    const actionable = (id) => {
      if (!mem.seen.has(id)) mem.seen.set(id, game.time);
      return game.time - mem.seen.get(id) >= REACTION;
    };
    // A human reads the armour: a Shellback whose front faces Rip is not a dash target (it would deflect).
    const armoured = (e) => e.kind === 'shellback' && e.stagger <= 0 && Math.abs(wrap(Math.atan2(p.y - e.y, p.x - e.x) - e.facing)) <= ENEMY.shellback.armorHalfAngle;
    const target = nearest(game, (e) => notMine(e) && !armoured(e)) ?? nearest(game, notMine) ?? nearest(game, () => true);
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
    if (threats.length > 0 && actionable(threats[0].b.id)) {
      const [bx, by] = norm(threats[0].b.vx, threats[0].b.vy);
      out.moveX += -by * 1.5; // sidestep the bullet's line
      out.moveY += bx * 1.5;
    }
    const [wx, wy] = wallPush(p);
    out.moveX += wx;
    out.moveY += wy;

    if (
      target &&
      p.dash.charges >= 1 &&
      p.dash.active === null &&
      target.d <= 320 &&
      !armoured(target.e) &&
      actionable(target.e.id) &&
      game.time - mem.lastDash >= MIN_DASH_GAP
    ) {
      const base = Math.atan2(target.e.y - p.y, target.e.x - p.x);
      const a = base + (rng() * 2 - 1) * AIM_ERROR;
      out.dash = true;
      out.aimX = p.x + Math.cos(a) * target.d;
      out.aimY = p.y + Math.sin(a) * target.d;
      mem.lastDash = game.time;
    }
    if (
      p.pulseCooldown <= 0 &&
      threats.length > 0 &&
      threats[0].dist <= PULSE.radius &&
      threats[0].t < 0.45 &&
      actionable(threats[0].b.id)
    ) {
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
const CLUSTER_RADIUS = 60; // px: enemies this close to one another count as one school for a cluster aim
const VALUE = { drifter: 1, mini: 0.6, spitter: 1.2, charger: 1.2, splitter: 1.5, shellback: 1.5, mine: 0.8 };
const PICKUP_VALUE = 1.5; // a heal or modifier the dash path would collect
const SHELLBACK_KEEPOUT = 80; // px: the expert steps away from a Shellback this close
const PICKUP_REACH = 260; // px: how far the expert will go out of its way for a pickup

// True if a dash from p along (ux, uy) for `dist` px reaches the front arc of a Shellback, which would
// deflect it. Uses the Shellback's facing, which the expert can see (#97: the harness is honest about it).
function frontal(e, p, ux, uy, dist) {
  const s = clamp((e.x - p.x) * ux + (e.y - p.y) * uy, 0, dist);
  const cx = p.x + ux * s;
  const cy = p.y + uy * s;
  const ang = Math.atan2(cy - e.y, cx - e.x);
  return Math.abs(wrap(ang - e.facing)) <= ENEMY.shellback.armorHalfAngle;
}

// Does the dash's blade meet this Shellback's armour first? The sim deflects on the first point of the
// path that touches the blade's reach, and reads the armour from the angle to that point. Mirrors that.
function deflectsOn(e, p, plan) {
  const R = e.r + DASH.bladeRadius;
  const dx = plan.ex - p.x;
  const dy = plan.ey - p.y;
  const fx = p.x - e.x;
  const fy = p.y - e.y;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - R * R;
  if (a <= 0) return false;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return false;
  const t = Math.max(0, (-b - Math.sqrt(disc)) / (2 * a));
  if (t > 1) return false;
  const qx = p.x + dx * t;
  const qy = p.y + dy * t;
  const ang = Math.atan2(qy - e.y, qx - e.x);
  return Math.abs(wrap(ang - e.facing)) <= ENEMY.shellback.armorHalfAngle;
}

// Mirrors the sim's closing slash: a point within finalArcRadius of the dash end, forward of it.
function inFinalArc(plan, x, y) {
  const vx = x - plan.ex;
  const vy = y - plan.ey;
  return vx * vx + vy * vy <= DASH.finalArcRadius * DASH.finalArcRadius && vx * plan.dirX + vy * plan.dirY >= 0;
}

// Best dash from Rip's current position: the aim whose swept path kills the most value. The dash is the
// sim's own plan (planDash), so lunge assist and Frenzy reach are counted (#97: the expert sees its reach).
// Pickups the path would collect add value but never trigger a dash on their own.
function planChain(game) {
  const p = game.player;
  const near = [];
  for (const e of game.enemies) if (e.alive && Math.hypot(e.x - p.x, e.y - p.y) <= PLAN_REACH) near.push(e);
  const items = game.pickups.items.filter((it) => Math.hypot(it.x - p.x, it.y - p.y) <= PLAN_REACH);
  const aims = near.map((e) => [e.x, e.y]);
  // Cluster aims: the centroid of the enemies around each one. A line through a school is where a dash
  // kills the most, so the planner tries one for every school it can see (#97: multi-kill dashes).
  for (const e of near) {
    let cx = 0;
    let cy = 0;
    let n = 0;
    for (const o of near) {
      if (Math.hypot(o.x - e.x, o.y - e.y) <= CLUSTER_RADIUS) {
        cx += o.x;
        cy += o.y;
        n += 1;
      }
    }
    if (n > 1) aims.push([cx / n, cy / n]);
  }
  for (let i = 0; i < RING_AIMS; i++) {
    const a = (i * TAU) / RING_AIMS;
    aims.push([p.x + Math.cos(a) * 100, p.y + Math.sin(a) * 100]);
  }

  let best = { kills: 0, value: 0, aimX: null, aimY: null };
  for (const [ax, ay] of aims) {
    const [ux, uy] = norm(ax - p.x, ay - p.y);
    if (ux === 0 && uy === 0) continue;
    const plan = planDash(game, ax, ay);
    let kills = 0;
    let value = 0;
    let blocked = false;
    for (const e of near) {
      const hit =
        segmentHitsCircle(p.x, p.y, plan.ex, plan.ey, e.x, e.y, e.r + DASH.bladeRadius) || inFinalArc(plan, e.x, e.y);
      if (!hit) continue;
      if (e.kind === 'shellback' && e.stagger <= 0 && deflectsOn(e, p, plan)) {
        blocked = true;
        break;
      }
      kills += 1;
      value += VALUE[e.kind] ?? 1;
    }
    for (const it of items) {
      if (distToSegment(p.x, p.y, plan.ex, plan.ey, it.x, it.y) <= PICKUP.dashCollectRadius) value += PICKUP_VALUE;
    }
    if (!blocked && kills > 0 && value > best.value) best = { kills, value, aimX: ax, aimY: ay };
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
      } else if (e.kind === 'shellback') {
        // Keep out of a Shellback's reach: it hurts on contact, and its armour is no threat from the side.
        const d = Math.hypot(p.x - e.x, p.y - e.y);
        if (d < SHELLBACK_KEEPOUT) {
          const [ux, uy] = norm(p.x - e.x, p.y - e.y);
          const w = (1.5 * (SHELLBACK_KEEPOUT - d)) / SHELLBACK_KEEPOUT;
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
    // With no chain to fire, pick up a nearby heal or modifier: a skilled player collects them on the way.
    if (plan.kills === 0) {
      let best = null;
      let bd = PICKUP_REACH;
      for (const it of game.pickups.items) {
        const d = Math.hypot(it.x - p.x, it.y - p.y);
        if (d < bd) {
          bd = d;
          best = it;
        }
      }
      if (best) {
        const [ux, uy] = norm(best.x - p.x, best.y - p.y);
        mx += ux;
        my += uy;
      }
    }
    const [wx, wy] = wallPush(p);
    out.moveX = mx + wx;
    out.moveY = my + wy;

    // Dash: fire a planned chain when it is worth a charge: two or more kills, or a single kill while two or
    // more charges are ready. A lone kill on the last charge waits for a chain.
    const worth = plan.kills >= 1;
    if (worth && p.dash.charges >= 1 && !busy) {
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
