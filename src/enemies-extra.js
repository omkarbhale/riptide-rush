// The second round of enemies for Riptide Rush (#114): Puffer, Shield Bearer, Ink Squid, Phase Eel and
// the Anglerfish Warden. Pure simulation: no DOM, no window, no timers, randomness only from game.rng.
//
// Three pieces, all registered from src/game.js:
//   EXTRA_KINDS     behaviour tables, merged into ENEMY_KINDS. Same shape as game.js's kinds, plus:
//                     present(e)      false: not hittable by dash, reflect, blast or contact (hidden eels)
//                     dashHit(...)    'strip' (a hit that removes a barrier or a hit point, no kill, no refund)
//                     onStrip(...)    runs once per dash for a 'strip'
//                     dashOnly        only a dash touches it: no shard, blast or reflect (the Warden)
//   createExtras(ops) per-game state: shards, shells (ink arcs) and puddles, plus the ops this module
//                     needs from game.js (killEnemy, damagePlayer, spawnEnemy, healPlayer, entityCount, moveSpeed).
//   stepExtras / pulseExtras / playerSpeedScale   the per-step pass, the Pulse hook and the puddle slow.
//   breakBarrier    removes a Shield Bearer's Barrier from a Drifter or Spitter, once (game.js calls it on a strip).
//
// Every number lives in config.js under ENEMY.puffer, ENEMY.shieldbearer, ENEMY.inksquid, ENEMY.phaseeel
// and ENEMY.warden.
import { ENEMY, PLAYER, PULSE, DASH, SPAWN, ARENA, LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H } from './config.js';

const TAU = Math.PI * 2;
const P = ENEMY.puffer;
const SB = ENEMY.shieldbearer;
const SQ = ENEMY.inksquid;
const EL = ENEMY.phaseeel;
const WD = ENEMY.warden;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function unit(dx, dy) {
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
}

// Blend a velocity toward a target. `rate` is already multiplied by dt.
function steer(e, tx, ty, rate) {
  const k = Math.min(1, rate);
  e.vx += (tx - e.vx) * k;
  e.vy += (ty - e.vy) * k;
}

function chase(e, game, dt, speed, rate) {
  const [ux, uy] = unit(game.player.x - e.x, game.player.y - e.y);
  steer(e, ux * speed, uy * speed, rate * dt);
}

// Keeps a point inside the arena clamp for an entity of radius r (same clamp as game.js).
function clampArena(x, y, r) {
  return [clamp(x, ARENA.inset + r, W - ARENA.inset - r), clamp(y, ARENA.inset + r, H - ARENA.inset - r)];
}

// True if the segment a->b passes within r of (cx, cy). Mirrors game.js's segmentHitsCircle, kept local
// so this module never imports game.js.
function segHits(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  return px * px + py * py <= r * r;
}

const opsOf = (game) => game.extras.ops;

// Is this enemy hittable right now? A kind without `present` always is. `def` may be {}.
export function isPresent(e, def) {
  return def.present ? def.present(e) : true;
}

// ---- Shield Bearer barriers -----------------------------------------------------------------------

// A dash that reaches a barrier takes it: no kill, no refund. The Drifter or Spitter is then spent
// for the rest of its life, so a later aura pass does not give it a new one.
export function breakBarrier(game, e) {
  e.barrier = false;
  e.barrierBy = 0;
  e.barrierSpent = true;
  game.events.push({ type: 'barrierBreak', x: e.x, y: e.y, enemyType: e.kind });
}

// Killing a Bearer removes every Barrier it gave out, in the same frame.
function releaseBarriers(game, bearerId) {
  for (const o of game.enemies) {
    if (o.barrierBy === bearerId) {
      o.barrier = false;
      o.barrierBy = 0;
    }
  }
}

// ---- Puffer shrapnel ------------------------------------------------------------------------------

// Eight shards fly out from the origin. `chain` is shared by this burst's shards, so each shard kill
// steps the slash index up: the chain reads as a multi-kill, with its bonus and hit-stop.
function burst(game, origin, slashIndex) {
  const chain = { n: slashIndex };
  game.events.push({
    type: 'puffBurst',
    x: origin.x,
    y: origin.y,
    enemyType: 'puffer',
    count: P.shardCount,
    range: P.shardRange,
  });
  for (let i = 0; i < P.shardCount; i++) {
    const a = (TAU * i) / P.shardCount;
    game.extras.shards.push({
      id: game.nextId++,
      x: origin.x,
      y: origin.y,
      vx: Math.cos(a) * P.shardSpeed,
      vy: Math.sin(a) * P.shardSpeed,
      travelled: 0,
      chain,
      alive: true,
    });
  }
}

// ---- Ink arcs and puddles -------------------------------------------------------------------------

function lob(game, e) {
  const pl = game.player;
  let lx = pl.vx * SQ.lobLead;
  let ly = pl.vy * SQ.lobLead;
  const lead = Math.hypot(lx, ly);
  const cap = PLAYER.maxSpeed * SQ.lobLead; // a dash's speed must not throw the arc across the arena
  if (lead > cap) {
    lx *= cap / lead;
    ly *= cap / lead;
  }
  const [tx, ty] = clampArena(pl.x + lx, pl.y + ly, 0);
  game.extras.shells.push({
    id: game.nextId++,
    from: e.id,
    sx: e.x,
    sy: e.y,
    lx: tx,
    ly: ty,
    x: e.x,
    y: e.y,
    t: 0,
    dur: SQ.flightTime,
    state: 'flight', // flight | reflect
    alive: true,
  });
  game.events.push({
    type: 'lobThrow',
    x: e.x,
    y: e.y,
    enemyType: 'inksquid',
    tx,
    ty,
    flightTime: SQ.flightTime,
  });
}

// Rip's current top-speed multiple: a puddle she stands in halves it.
export function playerSpeedScale(game) {
  const pl = game.player;
  for (const pd of game.extras.puddles) {
    if (pd.alive && Math.hypot(pl.x - pd.x, pl.y - pd.y) <= pd.r) return SQ.puddleSlow;
  }
  return 1;
}

// ---- Phase Eel cycle ------------------------------------------------------------------------------

// Reappears at a point EL.placeMin..placeMax px from Rip, inside the arena. It tries a few random
// angles so the clamp rarely pulls it closer.
function teleportEel(game, e) {
  const pl = game.player;
  let best = null;
  for (let i = 0; i < 8 && best === null; i++) {
    const a = game.rng() * TAU;
    const d = EL.placeMin + game.rng() * (EL.placeMax - EL.placeMin);
    const x = pl.x + Math.cos(a) * d;
    const y = pl.y + Math.sin(a) * d;
    if (x >= ARENA.inset + e.r && x <= W - ARENA.inset - e.r && y >= ARENA.inset + e.r && y <= H - ARENA.inset - e.r) {
      best = [x, y];
    }
  }
  if (best === null) {
    const a = game.rng() * TAU;
    best = clampArena(pl.x + Math.cos(a) * EL.placeMax, pl.y + Math.sin(a) * EL.placeMax, e.r);
  }
  e.x = best[0];
  e.y = best[1];
  e.px = e.x;
  e.py = e.y;
}

function hideEel(game, e) {
  game.events.push({ type: 'eelHide', x: e.x, y: e.y, enemyType: 'phaseeel' });
  e.state = 'hidden';
  e.stateT = EL.hiddenTime;
  e.biteLeft = 0;
  e.vx = 0;
  e.vy = 0;
  teleportEel(game, e);
}

function surfaceEel(game, e) {
  e.state = 'visible';
  e.stateT = EL.visibleTime;
  const pl = game.player;
  const [ux, uy] = unit(pl.x - e.x, pl.y - e.y);
  e.biteDX = ux;
  e.biteDY = uy;
  e.biteLeft = Math.hypot(pl.x - e.x, pl.y - e.y);
  e.vx = ux * EL.biteSpeed; // the bite starts on the surfacing step, not one step later
  e.vy = uy * EL.biteSpeed;
  game.events.push({ type: 'eelSurface', x: e.x, y: e.y, enemyType: 'phaseeel', duration: EL.visibleTime });
  game.events.push({ type: 'eelBite', x: e.x, y: e.y, enemyType: 'phaseeel', tx: pl.x, ty: pl.y, speed: EL.biteSpeed });
}

// ---- Anglerfish Warden ----------------------------------------------------------------------------

function telegraphOf(e) {
  return e.phase === 2 ? WD.phase2Telegraph : WD.telegraph;
}
function cycleOf(e) {
  return e.phase === 2 ? WD.phase2Cycle : WD.cycle;
}
function recoverOf(e) {
  return cycleOf(e) - telegraphOf(e) - WD.exposeTime;
}
// Whole cycles between lures, so a lure always lands on a snap: 6 s is two phase 1 cycles, three phase 2.
function lureSnapsOf(e) {
  return Math.max(1, Math.round(WD.lureEvery / cycleOf(e)));
}

function enterTelegraph(game, e) {
  e.state = 'telegraph';
  e.stateT = telegraphOf(e);
  e.exposed = false;
  const lure = (e.snaps + 1) % lureSnapsOf(e) === 0;
  game.events.push({
    type: 'bossTelegraph',
    x: e.x,
    y: e.y,
    enemyType: 'warden',
    duration: e.stateT,
    lure,
    phase: e.phase,
  });
}

function snap(game, e) {
  e.snaps += 1;
  if (e.snaps % lureSnapsOf(e) === 0) spawnLure(game, e);
  e.state = 'expose';
  e.stateT = WD.exposeTime;
  e.exposed = true;
  game.events.push({ type: 'bossExpose', x: e.x, y: e.y, enemyType: 'warden', duration: WD.exposeTime });
}

function spawnLure(game, e) {
  const ops = opsOf(game);
  const base = game.rng() * TAU;
  let count = 0;
  for (let i = 0; i < WD.lureCount; i++) {
    if (ops.entityCount(game) >= SPAWN.maxEntities) break;
    const a = base + (TAU * i) / WD.lureCount;
    const d = ops.spawnEnemy(game, 'drifter', e.x + Math.cos(a) * WD.lureRing, e.y + Math.sin(a) * WD.lureRing, e.wave);
    d.lureSpeed = WD.lureSpeed;
    d.lureOf = e.id;
    d.killBonus = WD.lureBonus;
    count += 1;
  }
  game.events.push({ type: 'lureSpawn', x: e.x, y: e.y, enemyType: 'warden', count });
}

// ---- Kind tables ----------------------------------------------------------------------------------

export const EXTRA_KINDS = {
  // Swells when Rip comes within swellRange (stops and grows for swellTime), then bursts. A dash kill,
  // a contact or the swell's end all burst it; only a dash kill and a contact count as a death for score.
  puffer: {
    radius: P.radius,
    points: P.points,
    dieOnContact: true,
    init(e) {
      e.swell = 0;
      e.swelling = false;
    },
    think(e, game, dt) {
      const pl = game.player;
      const d = Math.hypot(pl.x - e.x, pl.y - e.y);
      if (d <= P.swellRange) {
        if (!e.swelling) {
          e.swelling = true;
          game.events.push({ type: 'puffSwell', x: e.x, y: e.y, enemyType: 'puffer', duration: P.swellTime });
        }
        e.swell = Math.min(1, e.swell + dt / P.swellTime);
        steer(e, 0, 0, 8 * dt);
        if (e.swell >= 1) {
          e.alive = false;
          burst(game, e, 1);
        }
      } else {
        e.swell = 0;
        e.swelling = false;
        chase(e, game, dt, opsOf(game).moveSpeed(e, P.speed), P.steer);
      }
    },
    onDeath(game, e, slashIndex = 1) {
      burst(game, e, slashIndex);
    },
    onStagger(e, game) {
      // A Pulse pushes it back P.knockback px. It does not burst.
      const pl = game.player;
      const [ux, uy] = unit(e.x - pl.x, e.y - pl.y);
      const [x, y] = clampArena(e.x + ux * P.knockback, e.y + uy * P.knockback, e.r);
      e.x = x;
      e.y = y;
      e.swell = 0;
      e.swelling = false;
    },
  },

  // Holds a 120 px aura. Every Drifter and Spitter in the aura gets a Barrier (stepExtras). A dash that
  // reaches a Barrier takes it and nothing else; the Bearer itself takes one hit point per dash.
  shieldbearer: {
    radius: SB.radius,
    points: SB.points,
    staggerTime: SB.auraOffTime,
    init(e) {
      e.hp = SB.hp;
      e.maxHp = SB.hp;
      e.aura = true;
      e.auraRadius = SB.auraRadius;
    },
    think(e, game, dt) {
      chase(e, game, dt, opsOf(game).moveSpeed(e, SB.speed), SB.steer);
    },
    dashHit(game, e) {
      return e.hp > 1 ? 'strip' : 'kill';
    },
    onStrip(game, e) {
      e.hp -= 1;
      game.events.push({ type: 'bearerHit', x: e.x, y: e.y, enemyType: 'shieldbearer', hp: e.hp, maxHp: e.maxHp });
    },
    onDeath(game, e) {
      releaseBarriers(game, e.id);
    },
  },

  // Keeps 320 to 420 px from Rip and lobs an arc every lobInterval. The arc lands lobLead seconds ahead
  // of Rip's velocity and leaves a puddle (stepExtras). It has no touch damage of its own.
  inksquid: {
    radius: SQ.radius,
    points: SQ.points,
    init(e) {
      e.lobCd = SQ.firstLobDelay;
    },
    think(e, game, dt) {
      const pl = game.player;
      const dist = Math.hypot(pl.x - e.x, pl.y - e.y);
      const [ux, uy] = unit(pl.x - e.x, pl.y - e.y);
      const v = opsOf(game).moveSpeed(e, SQ.speed);
      let dx;
      let dy;
      if (dist < SQ.minRange) {
        dx = -ux;
        dy = -uy;
      } else if (dist > SQ.maxRange) {
        dx = ux;
        dy = uy;
      } else {
        dx = -uy * e.strafe;
        dy = ux * e.strafe;
      }
      steer(e, dx * v, dy * v, 4 * dt);
      e.lobCd -= dt;
      if (e.lobCd <= 0) {
        lob(game, e);
        e.lobCd = SQ.lobInterval;
      }
    },
  },

  // Hidden for hiddenTime, then a ripple telegraph, then visible for visibleTime with a bite toward
  // Rip's position at the moment it surfaces. Only a visible eel can be dashed, reflected or touched.
  // A Pulse during the ripple stuns it: it stays visible for stunTime, then goes under again.
  phaseeel: {
    radius: EL.radius,
    points: EL.points,
    staggerTime: EL.stunTime,
    present(e) {
      return e.state === 'visible' || e.state === 'stunned';
    },
    init(e) {
      e.state = 'hidden';
      e.stateT = EL.hiddenTime;
      e.visible = false;
      e.biteLeft = 0;
      e.biteDX = 0;
      e.biteDY = 0;
    },
    think(e, game, dt) {
      e.vx = 0;
      e.vy = 0;
      switch (e.state) {
        case 'hidden':
          e.stateT -= dt;
          if (e.stateT <= 0) {
            e.state = 'ripple';
            e.stateT = EL.rippleTime;
            game.events.push({ type: 'eelRipple', x: e.x, y: e.y, enemyType: 'phaseeel', duration: EL.rippleTime });
          }
          break;
        case 'ripple':
          e.stateT -= dt;
          if (e.stateT <= 0) surfaceEel(game, e);
          break;
        case 'visible':
          e.stateT -= dt;
          if (e.biteLeft > 0) {
            e.biteLeft -= EL.biteSpeed * dt;
            if (e.biteLeft > 0) {
              e.vx = e.biteDX * EL.biteSpeed;
              e.vy = e.biteDY * EL.biteSpeed;
            }
          }
          if (e.stateT <= 0) hideEel(game, e);
          break;
        case 'stunned':
          // The stun is over (think only runs once the stagger has worn off): under again.
          hideEel(game, e);
          break;
        default:
          break;
      }
    },
    onStagger(e, game) {
      if (e.state !== 'ripple') {
        e.stagger = 0; // only the ripple is stunnable: otherwise a Pulse does nothing to it
        return;
      }
      e.state = 'stunned';
      e.stateT = 0;
      game.events.push({ type: 'eelStun', x: e.x, y: e.y, enemyType: 'phaseeel', duration: EL.stunTime });
    },
  },

  // The boss. Each cycle: a telegraph (it holds still and the lure flashes), a snap, then the weak point
  // is exposed and only exposed hits land. Every second snap-pair (6 s) it lures four Drifters at 220 px/s.
  // Phase 2 starts at half hit points: faster, with a shorter cycle. A perfect Pulse in the last 0.12 s of
  // a telegraph stuns it for stunTime and exposes it for that long. Only a dash hurts it (dashOnly).
  warden: {
    radius: WD.radius,
    points: WD.points,
    dieOnContact: false,
    staggerable: false, // an ordinary Pulse does nothing to it; see pulseExtras for the perfect-Pulse stun
    dashOnly: true,
    init(e, game) {
      e.hp = WD.hp;
      e.maxHp = WD.hp;
      e.phase = e.wave >= WD.phase2Wave ? 2 : 1;
      e.snaps = 0;
      e.exposed = false;
      e.state = 'telegraph';
      e.stateT = telegraphOf(e);
      game.events.push({
        type: 'bossIntro',
        x: e.x,
        y: e.y,
        enemyType: 'warden',
        phase: e.phase,
        hp: e.hp,
        maxHp: e.maxHp,
      });
      enterTelegraph(game, e); // its first telegraph is announced like every later one
    },
    think(e, game, dt) {
      if (e.state === 'stunned') {
        e.exposed = true;
        steer(e, 0, 0, 8 * dt);
        e.stateT -= dt;
        if (e.stateT <= 0) {
          e.exposed = false;
          e.state = 'recover';
          e.stateT = recoverOf(e);
        }
        return;
      }
      e.stateT -= dt;
      switch (e.state) {
        case 'telegraph':
          steer(e, 0, 0, 8 * dt);
          if (e.stateT <= 0) snap(game, e);
          break;
        case 'expose':
          steer(e, 0, 0, 8 * dt);
          if (e.stateT <= 0) {
            e.exposed = false;
            e.state = 'recover';
            e.stateT = recoverOf(e);
          }
          break;
        case 'recover':
          chase(e, game, dt, e.phase === 2 ? WD.phase2Speed : WD.speed, 2);
          if (e.stateT <= 0) enterTelegraph(game, e);
          break;
        default:
          break;
      }
    },
    // A dash on the exposed body: a hit point at most once per dash (game.js keeps the per-dash set).
    dashHit(game, e) {
      if (!e.exposed) return 'ignore';
      return e.hp <= 1 ? 'kill' : 'strip';
    },
    onStrip(game, e) {
      e.hp -= 1;
      game.events.push({
        type: 'bossHit',
        x: e.x,
        y: e.y,
        enemyType: 'warden',
        hp: e.hp,
        maxHp: e.maxHp,
        phase: e.phase,
      });
      if (e.phase === 1 && e.hp * 2 <= e.maxHp) {
        e.phase = 2;
        game.events.push({ type: 'bossPhase', x: e.x, y: e.y, enemyType: 'warden', phase: 2 });
      }
    },
    onDeath(game, e) {
      // The lure fades with its boss: those Drifters leave without score, so the boss wave can end.
      let faded = 0;
      for (const o of game.enemies) {
        if (o.alive && o.lureOf === e.id) {
          o.alive = false;
          o.killBonus = 0;
          faded += 1;
        }
      }
      game.events.push({ type: 'bossDown', x: e.x, y: e.y, enemyType: 'warden', phase: e.phase, lures: faded });
      opsOf(game).healPlayer(game, e.x, e.y, 'warden');
    },
  },
};

// Per-game state. `ops` is what this module needs from game.js; `nextId` comes from the game.
export function createExtras(ops) {
  return { ops, shards: [], shells: [], puddles: [] };
}

// A Pulse. Returns true when it is perfect: a perfect Pulse reflects an ink arc, or stuns a Warden
// in the last 0.12 s of its telegraph. Called before the stagger loop, so the perfect slow-motion is known.
export function pulseExtras(game) {
  const pl = game.player;
  let perfect = false;
  for (const s of game.extras.shells) {
    if (!s.alive || s.state !== 'flight') continue;
    if (Math.hypot(s.x - pl.x, s.y - pl.y) > PULSE.radius) continue;
    if (s.dur - s.t <= PULSE.perfectWindow) {
      s.state = 'reflect';
      perfect = true;
      game.events.push({ type: 'lobReflect', x: s.x, y: s.y, enemyType: 'inksquid' });
    } else {
      s.alive = false;
      game.events.push({ type: 'lobDeflect', x: s.x, y: s.y, enemyType: 'inksquid', cause: 'pulse' });
    }
  }
  for (const e of game.enemies) {
    if (!e.alive || e.kind !== 'warden' || e.state !== 'telegraph') continue;
    if (e.stateT > PULSE.perfectWindow) continue;
    if (Math.hypot(e.x - pl.x, e.y - pl.y) > PULSE.radius + e.r) continue;
    e.state = 'stunned';
    e.stateT = WD.stunTime;
    e.exposed = true;
    perfect = true;
    game.events.push({ type: 'bossStun', x: e.x, y: e.y, enemyType: 'warden', duration: WD.stunTime });
  }
  return perfect;
}

// The per-step pass, after enemies and bullets have moved: the dash clears puddles and arcs it crosses,
// arcs fly and land or fly back, puddles age, shards fly and kill, and Shield Bearer auras hand out Barriers.
export function stepExtras(game, dt) {
  const ex = game.extras;
  const ops = ex.ops;
  const pl = game.player;

  // A dash's blade clears what it crosses (this step's path: p.px,py -> p.x,p.y).
  const dashing = Boolean(pl.dash.active) || (pl.sinceDash === 0 && !pl.bounce);
  if (dashing) {
    for (const pd of ex.puddles) {
      if (pd.alive && segHits(pl.px, pl.py, pl.x, pl.y, pd.x, pd.y, pd.r + DASH.bladeRadius)) {
        pd.alive = false;
        game.events.push({ type: 'puddleDispel', x: pd.x, y: pd.y, enemyType: 'inksquid', radius: pd.r });
      }
    }
    for (const s of ex.shells) {
      if (s.alive && s.state === 'flight' && segHits(pl.px, pl.py, pl.x, pl.y, s.x, s.y, DASH.bladeRadius + SQ.shellRadius)) {
        s.alive = false;
        game.events.push({ type: 'lobDeflect', x: s.x, y: s.y, enemyType: 'inksquid', cause: 'dash' });
      }
    }
  }

  for (const pd of ex.puddles) {
    pd.t += dt;
    if (pd.t >= pd.dur) pd.alive = false;
  }

  for (const s of ex.shells) {
    if (!s.alive) continue;
    if (s.state === 'flight') {
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      s.x = s.sx + (s.lx - s.sx) * k;
      s.y = s.sy + (s.ly - s.sy) * k;
      if (s.t >= s.dur) {
        s.alive = false;
        ex.puddles.push({ id: game.nextId++, x: s.lx, y: s.ly, r: SQ.puddleRadius, t: 0, dur: SQ.puddleTime, alive: true });
        game.events.push({
          type: 'lobLand',
          x: s.lx,
          y: s.ly,
          enemyType: 'inksquid',
          radius: SQ.puddleRadius,
          duration: SQ.puddleTime,
        });
      }
    } else if (s.state === 'reflect') {
      const sq = game.enemies.find((o) => o.id === s.from && o.alive);
      if (!sq) {
        s.alive = false; // the squid is already dead: the reflected arc fizzles
        continue;
      }
      const dx = sq.x - s.x;
      const dy = sq.y - s.y;
      const d = Math.hypot(dx, dy);
      const step = SQ.reflectSpeed * dt;
      if (d <= sq.r + SQ.shellRadius || step >= d) {
        s.alive = false;
        ops.killEnemy(game, sq, 1, 'reflect');
      } else {
        s.x += (dx / d) * step;
        s.y += (dy / d) * step;
      }
    }
  }

  // Shards: each flies its range, kills the first enemy its path touches (a kill is a kill, for score and
  // combo), and hurts Rip if its path reaches her. The loop caps at the shard count at entry, so bursts from
  // this step's kills are picked up next step.
  const n = ex.shards.length;
  for (let i = 0; i < n; i++) {
    const sh = ex.shards[i];
    if (!sh.alive) continue;
    const px = sh.x;
    const py = sh.y;
    sh.x += sh.vx * dt;
    sh.y += sh.vy * dt;
    sh.travelled += Math.hypot(sh.vx, sh.vy) * dt;
    if (sh.travelled >= P.shardRange) {
      sh.alive = false;
      continue;
    }
    for (const e of game.enemies) {
      const def = EXTRA_KINDS[e.kind];
      if (!e.alive || def?.dashOnly || !isPresent(e, def ?? {})) continue;
      if (segHits(px, py, sh.x, sh.y, e.x, e.y, e.r + P.shardRadius)) {
        sh.alive = false;
        ops.killEnemy(game, e, ++sh.chain.n, 'shard');
        break;
      }
    }
    if (!sh.alive) continue;
    // A dashing Rip is untouchable: the shard passes through her rather than being spent on her.
    if (!pl.dash.active && segHits(px, py, sh.x, sh.y, pl.x, pl.y, PLAYER.radius + P.shardRadius)) {
      sh.alive = false;
      ops.damagePlayer(game, sh.x, sh.y);
    }
  }

  // Barriers: a Shield Bearer's aura is down while it is staggered. An enemy in the aura gets one Barrier
  // (no stacking), unless it has already spent one.
  const bearers = game.enemies.filter((e) => e.alive && e.kind === 'shieldbearer');
  for (const b of bearers) b.aura = b.stagger <= 0;
  for (const e of game.enemies) {
    if (!e.alive || (e.kind !== 'drifter' && e.kind !== 'spitter')) continue;
    if (e.barrier) {
      if (!bearers.some((b) => b.id === e.barrierBy)) {
        e.barrier = false;
        e.barrierBy = 0;
      }
      continue;
    }
    if (e.barrierSpent) continue;
    for (const b of bearers) {
      if (b.aura && Math.hypot(e.x - b.x, e.y - b.y) <= b.auraRadius) {
        e.barrier = true;
        e.barrierBy = b.id;
        break;
      }
    }
  }

  for (const e of game.enemies) if (e.kind === 'phaseeel') e.visible = isPresent(e, EXTRA_KINDS.phaseeel);

  ex.shards = ex.shards.filter((s) => s.alive);
  ex.shells = ex.shells.filter((s) => s.alive);
  ex.puddles = ex.puddles.filter((p) => p.alive);
}
