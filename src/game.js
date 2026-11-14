// Pure simulation for Riptide Rush. No DOM, no window, no timers.
// Same seed + same input sequence => identical state. Presentation reads `game` and drains
// `game.events`; it never writes back into the simulation.
import {
  LOGICAL_WIDTH,
  LOGICAL_HEIGHT,
  ARENA,
  PLAYER,
  DASH,
  PULSE,
  COMBO,
  HITSTOP,
  SPAWN,
  ENEMY,
} from './config.js';
import { planWave, spawnQueue } from './waves.js';

const W = LOGICAL_WIDTH;
const H = LOGICAL_HEIGHT;
const TAU = Math.PI * 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function unit(dx, dy) {
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
}

// Wraps an angle into (-PI, PI].
function wrapAngle(a) {
  return a - TAU * Math.round(a / TAU);
}

// Blend a velocity toward a target. `rate` is the fraction per step (already multiplied by dt).
function steer(e, tx, ty, rate) {
  const k = Math.min(1, rate);
  e.vx += (tx - e.vx) * k;
  e.vy += (ty - e.vy) * k;
}

// Chase the player at `speed`, blending velocity at `rate` per second.
function chase(e, game, dt, speed, rate) {
  const [ux, uy] = unit(game.player.x - e.x, game.player.y - e.y);
  steer(e, ux * speed, uy * speed, rate * dt);
}

// Deterministic PRNG (mulberry32). The simulation's only source of randomness.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// True if the segment a->b passes within radius r of centre c. This is what makes dashes swept:
// a dash checks the whole path it covered this step, so it cannot tunnel through an enemy.
export function segmentHitsCircle(ax, ay, bx, by, cx, cy, r) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
  const px = ax + dx * t - cx;
  const py = ay + dy * t - cy;
  return px * px + py * py <= r * r;
}

// Score multiplier for a combo count: 1 + floor(combo / 5), capped at x10.
export function multiplierFor(count) {
  return Math.min(COMBO.multiplierCap, 1 + Math.floor(count / COMBO.multiplierStep));
}

// Combo timer length for a combo count. It starts at 2.5 s at x1 and shrinks linearly with the
// multiplier to a floor of 1.6 s at x10 (issue #11). Above x10 it stays at the floor.
export function comboWindowFor(count) {
  const t = (multiplierFor(count) - 1) / (COMBO.multiplierCap - 1); // 0 at x1, 1 at x10
  return COMBO.window * (1 - t) + COMBO.windowMin * t;
}

// Hit-stop for a kill, in ms: 40 for a single kill, +10 for each further kill in one slash, cap 100.
export function hitStopFor(slashIndex) {
  return Math.min(HITSTOP.max, HITSTOP.single + HITSTOP.perExtraKill * (slashIndex - 1));
}

// Colour tier index (0 = cyan ... 4 = white) for a combo count.
export function tierFor(count) {
  let tier = 0;
  COMBO.tiers.forEach((threshold, i) => {
    if (count >= threshold) tier = i + 1;
  });
  return tier;
}

// Behaviour table. Each kind: radius, points, init(e, game), think(e, game, dt), and optional:
//   onStagger(e, game)   called when a Pulse staggers it
//   staggerTime          seconds of stagger (default PULSE.stagger)
//   staggerable: false   Pulse has no effect (mines)
//   dashHit(game, e, d, x, y) -> 'kill' | 'deflect' | 'ignore'   (default 'kill')
//   onDeath(game, e)     runs when the enemy leaves play by any cause that kills it
//   dieOnContact         a contact hit that lands also removes the enemy (no score)
//   contact: false       never hurts by touching
//   lifetime             seconds, then the enemy fades silently (no score, no combo)
//   graceTime            seconds after spawn during which contact cannot hurt Rip
// think() only sets velocity; the shared integrator moves the enemy and clamps it to the arena.
export const ENEMY_KINDS = {
  drifter: {
    radius: ENEMY.drifter.radius,
    points: ENEMY.drifter.points,
    init() {},
    think(e, game, dt) {
      chase(e, game, dt, ENEMY.drifter.speed, ENEMY.drifter.steer);
    },
  },

  spitter: {
    radius: ENEMY.spitter.radius,
    points: ENEMY.spitter.points,
    init(e) {
      e.shotCd = ENEMY.spitter.firstShotDelay;
    },
    think(e, game, dt) {
      const c = ENEMY.spitter;
      const p = game.player;
      const dist = Math.hypot(p.x - e.x, p.y - e.y);
      const [ux, uy] = unit(p.x - e.x, p.y - e.y);
      let dx;
      let dy;
      if (dist < c.minRange) {
        dx = -ux;
        dy = -uy;
      } else if (dist > c.maxRange) {
        dx = ux;
        dy = uy;
      } else {
        dx = -uy * e.strafe; // hold distance and circle the player
        dy = ux * e.strafe;
      }
      steer(e, dx * c.speed, dy * c.speed, 4 * dt);

      e.shotCd -= dt;
      if (e.shotCd <= 0 && dist <= c.fireRange && entityCount(game) < SPAWN.maxEntities) {
        e.shotCd = c.fireInterval;
        const off = e.r + c.bulletRadius + 2;
        fireBullet(game, e.x + ux * off, e.y + uy * off, ux * c.bulletSpeed, uy * c.bulletSpeed);
      }
    },
  },

  charger: {
    radius: ENEMY.charger.radius,
    points: ENEMY.charger.points,
    init(e, game) {
      const c = ENEMY.charger;
      e.state = 'idle';
      e.stateT = 0;
      e.cooldown = c.firstCooldownMin + (c.firstCooldownMax - c.firstCooldownMin) * game.rng();
    },
    think(e, game, dt) {
      const c = ENEMY.charger;
      const p = game.player;
      if (e.state === 'idle') {
        const dist = Math.hypot(p.x - e.x, p.y - e.y);
        const [ux, uy] = unit(p.x - e.x, p.y - e.y);
        steer(e, ux * c.idleSpeed, uy * c.idleSpeed, 2 * dt);
        e.cooldown -= dt;
        if (e.cooldown <= 0 && dist <= c.triggerRange) {
          // The aim is locked here, so the telegraph line is an honest warning.
          e.state = 'telegraph';
          e.stateT = c.telegraph;
          e.dirX = ux;
          e.dirY = uy;
          e.vx = 0;
          e.vy = 0;
        }
      } else if (e.state === 'telegraph') {
        e.vx = 0;
        e.vy = 0;
        e.stateT -= dt;
        if (e.stateT <= 0) {
          e.state = 'lunge';
          e.stateT = c.lungeTime;
          e.vx = e.dirX * c.lungeSpeed;
          e.vy = e.dirY * c.lungeSpeed;
        }
      } else {
        // lunge: straight line until time runs out or it hits the arena wall
        e.vx = e.dirX * c.lungeSpeed;
        e.vy = e.dirY * c.lungeSpeed;
        e.stateT -= dt;
        if (e.stateT <= 0 || e.hitWall) {
          e.state = 'idle';
          e.cooldown = c.cooldown;
        }
      }
    },
    onStagger(e) {
      if (e.state !== 'idle') {
        e.state = 'idle';
        e.cooldown = Math.max(e.cooldown, 1.0);
      }
    },
  },

  // Armoured front arc. A dash that reaches the front bounces Rip back; from the side or behind it
  // kills. A Pulse drops the armour for a while, and any dash kills while it is down.
  shellback: {
    radius: ENEMY.shellback.radius,
    points: ENEMY.shellback.points,
    staggerTime: ENEMY.shellback.staggerTime,
    init(e, game) {
      e.facing = Math.atan2(game.player.y - e.y, game.player.x - e.x);
    },
    think(e, game, dt) {
      const c = ENEMY.shellback;
      const want = Math.atan2(game.player.y - e.y, game.player.x - e.x);
      const limit = c.turnRate * dt;
      e.facing = wrapAngle(e.facing + clamp(wrapAngle(want - e.facing), -limit, limit));
      steer(e, Math.cos(e.facing) * c.speed, Math.sin(e.facing) * c.speed, 4 * dt);
    },
    dashHit(game, e, d, x, y) {
      if (e.stagger > 0) return 'kill';
      const fromCentre = Math.atan2(y - e.y, x - e.x);
      return Math.abs(wrapAngle(fromCentre - e.facing)) <= ENEMY.shellback.armorHalfAngle ? 'deflect' : 'kill';
    },
    onStagger(e, game) {
      game.events.push({ type: 'stagger', x: e.x, y: e.y });
    },
  },

  // Dies into three minis. Contact that lands also splits it, with no score.
  splitter: {
    radius: ENEMY.splitter.radius,
    points: ENEMY.splitter.points,
    dieOnContact: true,
    init() {},
    think(e, game, dt) {
      chase(e, game, dt, ENEMY.splitter.speed, ENEMY.splitter.steer);
    },
    onDeath(game, e) {
      const c = ENEMY.splitter;
      for (const a of c.splitAngles) {
        if (entityCount(game) >= SPAWN.maxEntities) break;
        const x = e.x + Math.cos(a) * c.splitOffset;
        const y = e.y + Math.sin(a) * c.splitOffset;
        spawnEnemy(game, 'mini', x, y, e.wave);
      }
    },
  },

  // Fast and short-lived. Spawn grace means it cannot hurt Rip for its first moments.
  mini: {
    radius: ENEMY.mini.radius,
    points: ENEMY.mini.points,
    lifetime: ENEMY.mini.lifetime,
    graceTime: ENEMY.mini.graceTime,
    dieOnContact: true,
    init() {},
    think(e, game, dt) {
      chase(e, game, dt, ENEMY.mini.speed, ENEMY.mini.steer);
    },
  },

  // Stationary. Arms when Rip comes near, then detonates. Only a dash touches it; Pulse ignores it.
  mine: {
    radius: ENEMY.mine.radius,
    points: ENEMY.mine.points,
    contact: false,
    staggerable: false,
    init(e) {
      e.state = 'idle';
      e.stateT = 0;
    },
    think(e, game, dt) {
      const c = ENEMY.mine;
      e.vx = 0;
      e.vy = 0;
      if (e.state === 'idle') {
        if (Math.hypot(game.player.x - e.x, game.player.y - e.y) <= c.armRange) {
          e.state = 'armed';
          e.stateT = c.fuse;
          game.events.push({ type: 'mineArm', x: e.x, y: e.y });
        }
      } else {
        e.stateT -= dt;
        if (e.stateT <= 0) detonateMine(game, e);
      }
    },
  },
};

// options: { spawning, startWave } . startWave lets tests and soaks begin at any wave of the script.
export function createGame(seed = 1, options = {}) {
  const game = {
    seed,
    rng: mulberry32(seed),
    spawning: options.spawning !== false,
    time: 0,
    step: 0,
    over: false,
    score: 0,
    kills: 0,
    burstKills: 0,   // kills credited to the current pulse's reflected bullets
    slowmo: 0,       // seconds of world slow-motion left
    nextId: 1,
    player: {
      x: W / 2,
      y: H / 2,
      px: W / 2,
      py: H / 2,
      vx: 0,
      vy: 0,
      facing: 0,
      hp: PLAYER.maxHp,
      invuln: 0,
      pulseCooldown: 0,
      dash: { charges: DASH.maxCharges, recharge: 0, active: null },
      bounce: null,
    },
    enemies: [],
    bullets: [],
    warnings: [],
    combo: { count: 0, timer: 0, tier: 0 },
    wave: { number: 0, phase: 'active', timer: 0, queue: [], nextSpawnAt: 0 },
    events: [],
  };
  beginWave(game, options.startWave ?? 1);
  return game;
}

// Returns the queued events and clears the queue.
export function drainEvents(game) {
  const events = game.events;
  game.events = [];
  return events;
}

// One fixed simulation step. `input` is a plain snapshot:
// { moveX, moveY (-1..1), aimX, aimY (logical px), dash (bool), pulse (bool) }.
// `dash` and `pulse` mean "a buffered press is armed"; the caller clears it on the matching event.
export function update(game, input, dt) {
  if (game.over) return;
  const p = game.player;
  game.step += 1;
  game.time += dt;

  p.px = p.x;
  p.py = p.y;
  for (const e of game.enemies) {
    e.px = e.x;
    e.py = e.y;
  }
  for (const b of game.bullets) {
    b.px = b.x;
    b.py = b.y;
  }

  p.invuln = Math.max(0, p.invuln - dt);
  p.pulseCooldown = Math.max(0, p.pulseCooldown - dt);
  game.slowmo = Math.max(0, game.slowmo - dt);
  tickCombo(game, dt);
  tickRecharge(game, dt);

  if (input.pulse && p.pulseCooldown <= 0) firePulse(game);
  if (input.dash && !p.dash.active && !p.bounce && p.dash.charges >= 1) startDash(game, input);

  if (p.dash.active) stepDash(game, dt);
  else if (p.bounce) stepBounce(game, dt);
  else stepMove(game, input, dt);

  const aimX = input.aimX ?? p.x;
  const aimY = input.aimY ?? p.y;
  if (Math.hypot(aimX - p.x, aimY - p.y) > 4) p.facing = Math.atan2(aimY - p.y, aimX - p.x);

  const worldDt = game.slowmo > 0 ? dt * PULSE.slowmoScale : dt;
  for (const e of game.enemies) updateEnemy(game, e, worldDt);
  for (const b of game.bullets) updateBullet(b, worldDt);

  updateSpawner(game, dt);

  bulletsHitPlayer(game);
  enemiesTouchPlayer(game);
  reflectedBulletsHitEnemies(game);

  game.enemies = game.enemies.filter((e) => e.alive);
  game.bullets = game.bullets.filter((b) => b.alive);
}

// ---- Combo, score and dash charges ----------------------------------------------------------

function updateTier(game) {
  const tier = tierFor(game.combo.count);
  if (tier !== game.combo.tier) {
    game.combo.tier = tier;
    game.events.push({ type: 'comboTier', tier });
  }
}

function tickCombo(game, dt) {
  const c = game.combo;
  if (c.count <= 0) return;
  c.timer -= dt;
  if (c.timer <= 0) {
    const lost = c.count;
    c.count = 0;
    c.timer = 0;
    updateTier(game);
    game.events.push({ type: 'comboLost', count: lost });
  }
}

function tickRecharge(game, dt) {
  const d = game.player.dash;
  if (d.charges >= DASH.maxCharges) {
    d.recharge = 0;
    return;
  }
  d.recharge += dt;
  while (d.recharge >= DASH.rechargeTime && d.charges < DASH.maxCharges) {
    d.recharge -= DASH.rechargeTime;
    d.charges += 1;
  }
  if (d.charges >= DASH.maxCharges) d.recharge = 0;
}

// Every kill: +1 combo, timer reset, score = base x multiplier (combo after this kill),
// plus a multi-kill bonus for the 2nd+ kill of one slash, and an immediate dash charge refund.
// `slashIndex` is 1-based: which kill this is within the current dash or pulse.
// `cause` says how it died: 'dash', 'defuse' (a mine dashed through), 'reflect' or 'blast'.
// The kill event carries `bonus` (the multi-kill points) and `hitStopMs` so feedback can scale.
export function killEnemy(game, e, slashIndex = 1, cause = 'dash') {
  if (!e.alive) return;
  e.alive = false;
  const def = ENEMY_KINDS[e.kind];
  const c = game.combo;
  c.count += 1;
  c.timer = comboWindowFor(c.count);
  const mult = multiplierFor(c.count);
  const bonus = slashIndex > 1 ? COMBO.multiBonus * mult : 0;
  const points = def.points * mult + bonus;
  game.score += points;
  game.kills += 1;
  const d = game.player.dash;
  d.charges = Math.min(DASH.maxCharges, d.charges + 1);
  updateTier(game);
  game.events.push({
    type: 'kill',
    x: e.x,
    y: e.y,
    enemyType: e.kind,
    combo: c.count,
    multi: slashIndex,
    bonus,
    points,
    hitStopMs: hitStopFor(slashIndex),
    cause,
  });
  if (def.onDeath) def.onDeath(game, e);
}

// ---- Dash -----------------------------------------------------------------------------------

function startDash(game, input) {
  const p = game.player;
  let [dx, dy] = unit((input.aimX ?? p.x) - p.x, (input.aimY ?? p.y) - p.y);
  if (dx === 0 && dy === 0) {
    dx = Math.cos(p.facing);
    dy = Math.sin(p.facing);
  }
  const [ex, ey] = clampToArena(p.x + dx * DASH.distance, p.y + dy * DASH.distance, PLAYER.radius);
  p.dash.charges -= 1;
  p.dash.active = {
    t: 0,
    dur: DASH.duration,
    sx: p.x,
    sy: p.y,
    ex,
    ey,
    lastX: p.x,
    lastY: p.y,
    dirX: dx,
    dirY: dy,
    kills: 0,
    deflected: false,
  };
  p.facing = Math.atan2(dy, dx);
  game.events.push({ type: 'dash', x: p.x, y: p.y, angle: p.facing });
}

function stepDash(game, dt) {
  const p = game.player;
  const d = p.dash.active;
  d.t = Math.min(d.dur, d.t + dt);
  const k = d.t / d.dur;
  const x = d.sx + (d.ex - d.sx) * k;
  const y = d.sy + (d.ey - d.sy) * k;
  sweepDash(game, d, x, y);
  if (d.deflected) {
    // Rip is still at the last point the dash cleared, so the bounce starts from there.
    startBounce(game, d);
    return;
  }
  p.x = x;
  p.y = y;
  if (d.t >= d.dur) {
    p.dash.active = null;
    p.vx = d.dirX * DASH.exitSpeed;
    p.vy = d.dirY * DASH.exitSpeed;
  } else {
    p.vx = (d.ex - d.sx) / d.dur;
    p.vy = (d.ey - d.sy) / d.dur;
  }
}

// Checks every enemy the dash path crossed since the last step (segment test, not a point test).
// A kill is a kill; a Shellback's armour turns the dash into a deflect, which ends the dash.
// It walks only the enemies that existed at the start of the step, so a splitter's minis are not
// caught by the dash that split it.
function sweepDash(game, d, x, y) {
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (!e.alive) continue;
    if (!segmentHitsCircle(d.lastX, d.lastY, x, y, e.x, e.y, e.r + PLAYER.radius)) continue;
    const def = ENEMY_KINDS[e.kind];
    const verdict = def.dashHit ? def.dashHit(game, e, d, x, y) : 'kill';
    if (verdict === 'deflect') {
      d.deflected = true;
      game.events.push({ type: 'deflect', x, y });
      return; // d.lastX stays at the last clear point
    }
    if (verdict === 'kill') {
      d.kills += 1;
      killEnemy(game, e, d.kills, e.kind === 'mine' ? 'defuse' : 'dash');
    }
  }
  d.lastX = x;
  d.lastY = y;
}

// A deflected dash ends at once. Rip bounces DASH.bounceDistance back along the dash, invulnerable.
function startBounce(game, d) {
  const p = game.player;
  p.dash.active = null;
  const sx = p.x;
  const sy = p.y;
  p.bounce = {
    t: 0,
    dur: DASH.bounceTime,
    sx,
    sy,
    ex: sx - d.dirX * DASH.bounceDistance,
    ey: sy - d.dirY * DASH.bounceDistance,
  };
  p.invuln = Math.max(p.invuln, DASH.bounceTime);
  p.vx = 0;
  p.vy = 0;
}

function stepBounce(game, dt) {
  const p = game.player;
  const b = p.bounce;
  b.t = Math.min(b.dur, b.t + dt);
  const k = b.t / b.dur;
  const [x, y] = clampToArena(b.sx + (b.ex - b.sx) * k, b.sy + (b.ey - b.sy) * k, PLAYER.radius);
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.invuln = Math.max(p.invuln, b.dur - b.t);
  if (b.t >= b.dur) p.bounce = null;
}

// ---- Movement -------------------------------------------------------------------------------

function stepMove(game, input, dt) {
  const p = game.player;
  let mx = input.moveX ?? 0;
  let my = input.moveY ?? 0;
  const ml = Math.hypot(mx, my);
  if (ml > 0) {
    mx /= ml;
    my /= ml;
    p.vx += mx * PLAYER.accel * dt;
    p.vy += my * PLAYER.accel * dt;
    const speed = Math.hypot(p.vx, p.vy);
    if (speed > PLAYER.maxSpeed) {
      p.vx *= PLAYER.maxSpeed / speed;
      p.vy *= PLAYER.maxSpeed / speed;
    }
  } else {
    const f = Math.exp(-PLAYER.friction * dt);
    p.vx *= f;
    p.vy *= f;
  }
  p.x += p.vx * dt;
  p.y += p.vy * dt;
  const [cx, cy] = clampToArena(p.x, p.y, PLAYER.radius);
  if (cx !== p.x) p.vx = 0;
  if (cy !== p.y) p.vy = 0;
  p.x = cx;
  p.y = cy;
}

function clampToArena(x, y, r) {
  return [
    clamp(x, ARENA.inset + r, W - ARENA.inset - r),
    clamp(y, ARENA.inset + r, H - ARENA.inset - r),
  ];
}

// ---- Pulse ----------------------------------------------------------------------------------

function firePulse(game) {
  const p = game.player;
  p.pulseCooldown = PULSE.cooldown;
  game.burstKills = 0;
  game.events.push({ type: 'pulse', x: p.x, y: p.y });

  let perfect = false;
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'enemy') continue;
    const dist = Math.hypot(b.x - p.x, b.y - p.y);
    if (dist > PULSE.radius) continue;
    const speed = Math.hypot(b.vx, b.vy);
    // Seconds until this bullet reaches the player's body.
    const impactIn = speed > 0 ? Math.max(0, dist - PLAYER.radius) / speed : 0;
    if (impactIn <= PULSE.perfectWindow) perfect = true;
    b.owner = 'player';
    b.vx *= -PULSE.reflectSpeedScale;
    b.vy *= -PULSE.reflectSpeedScale;
    b.life = PULSE.reflectLife;
    game.events.push({ type: 'reflect', x: b.x, y: b.y });
  }

  for (const e of game.enemies) {
    if (!e.alive || ENEMY_KINDS[e.kind].staggerable === false) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) <= PULSE.radius + e.r) staggerEnemy(game, e);
  }

  if (perfect) {
    p.pulseCooldown = 0;
    game.slowmo = PULSE.slowmoDuration;
    game.events.push({ type: 'perfectPulse', x: p.x, y: p.y });
  }
}

function staggerEnemy(game, e) {
  const def = ENEMY_KINDS[e.kind];
  e.stagger = def.staggerTime ?? PULSE.stagger;
  if (def.onStagger) def.onStagger(e, game);
}

// ---- Enemies, bullets and spawning ----------------------------------------------------------

// Live entities the cap counts: enemies, spawn warnings and bullets.
function entityCount(game) {
  return game.enemies.length + game.warnings.length + game.bullets.length;
}

export function spawnEnemy(game, kind, x, y, wave = game.wave.number) {
  const def = ENEMY_KINDS[kind];
  const e = {
    id: game.nextId++,
    kind,
    wave,
    x,
    y,
    px: x,
    py: y,
    vx: 0,
    vy: 0,
    r: def.radius,
    alive: true,
    stagger: 0,
    age: 0,
    grace: def.graceTime ?? 0,
    facing: 0,
    hitWall: false,
    state: 'idle',
    stateT: 0,
    cooldown: 0,
    shotCd: 0,
    dirX: 0,
    dirY: 0,
    strafe: game.rng() < 0.5 ? -1 : 1,
  };
  def.init(e, game);
  game.enemies.push(e);
  return e;
}

function fireBullet(game, x, y, vx, vy) {
  game.bullets.push({
    id: game.nextId++,
    owner: 'enemy',
    x,
    y,
    px: x,
    py: y,
    vx,
    vy,
    r: ENEMY.spitter.bulletRadius,
    life: ENEMY.spitter.bulletLife,
    alive: true,
  });
}

function updateEnemy(game, e, dt) {
  if (!e.alive) return;
  const def = ENEMY_KINDS[e.kind];
  e.age += dt;
  if (def.lifetime !== undefined && e.age >= def.lifetime) {
    e.alive = false;
    return;
  }
  if (e.grace > 0) e.grace = Math.max(0, e.grace - dt);
  if (e.stagger > 0) {
    e.stagger = Math.max(0, e.stagger - dt);
    const f = Math.exp(-6 * dt);
    e.vx *= f;
    e.vy *= f;
  } else {
    def.think(e, game, dt);
  }
  e.x += e.vx * dt;
  e.y += e.vy * dt;
  const [cx, cy] = clampToArena(e.x, e.y, e.r);
  e.hitWall = cx !== e.x || cy !== e.y;
  if (cx !== e.x) e.vx = 0;
  if (cy !== e.y) e.vy = 0;
  e.x = cx;
  e.y = cy;
}

function updateBullet(b, dt) {
  if (!b.alive) return;
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.life -= dt;
  if (b.life <= 0 || b.x < -40 || b.x > W + 40 || b.y < -40 || b.y > H + 40) b.alive = false;
}

function bulletsHitPlayer(game) {
  const p = game.player;
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'enemy') continue;
    if (segmentHitsCircle(b.px, b.py, b.x, b.y, p.x, p.y, PLAYER.radius + b.r)) {
      b.alive = false;
      damagePlayer(game, b.x, b.y);
    }
  }
}

// Contact hurts Rip unless the enemy is in its spawn grace. A splitter or mini that lands its hit
// is removed (a splitter also splits); neither scores.
function enemiesTouchPlayer(game) {
  const p = game.player;
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    const def = ENEMY_KINDS[e.kind];
    if (!e.alive || def.contact === false || e.grace > 0) continue;
    if (Math.hypot(e.x - p.x, e.y - p.y) < e.r + PLAYER.radius && damagePlayer(game, e.x, e.y) && def.dieOnContact) {
      e.alive = false;
      if (def.onDeath) def.onDeath(game, e);
    }
  }
}

// A mine detonates: it hurts Rip if the blast reaches them, and kills every other enemy inside it.
// Kills from the blast score and count for combo like any other kill. A mine it kills does not
// detonate in turn.
function detonateMine(game, e) {
  const c = ENEMY.mine;
  e.alive = false;
  game.events.push({ type: 'mineExplode', x: e.x, y: e.y });
  const p = game.player;
  if (Math.hypot(p.x - e.x, p.y - e.y) <= c.blastRadius + PLAYER.radius) damagePlayer(game, e.x, e.y);
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const other = game.enemies[i];
    if (!other.alive || other === e) continue;
    if (Math.hypot(other.x - e.x, other.y - e.y) <= c.blastRadius + other.r) {
      killEnemy(game, other, 1, 'blast');
    }
  }
}

// Reflected bullets fly back at the shooter and kill whatever they hit.
function reflectedBulletsHitEnemies(game) {
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'player') continue;
    for (const e of game.enemies) {
      if (!e.alive) continue;
      if (segmentHitsCircle(b.px, b.py, b.x, b.y, e.x, e.y, e.r + b.r)) {
        b.alive = false;
        game.burstKills += 1;
        killEnemy(game, e, game.burstKills, 'reflect');
        break;
      }
    }
  }
}

// Returns true if the hit landed. Dashing and post-hit invulnerability block damage.
export function damagePlayer(game, fromX, fromY) {
  const p = game.player;
  if (game.over || p.invuln > 0 || p.dash.active) return false;
  p.hp -= 1;
  p.invuln = PLAYER.invulnAfterHit;
  const [dx, dy] = unit(p.x - fromX, p.y - fromY);
  p.vx += dx * PLAYER.hitKnockback;
  p.vy += dy * PLAYER.hitKnockback;
  game.events.push({ type: 'hurt', hp: p.hp, x: p.x, y: p.y });
  if (p.hp <= 0) {
    p.hp = 0;
    game.over = true;
    game.events.push({ type: 'gameOver', score: game.score });
  }
  return true;
}

// ---- Wave script ------------------------------------------------------------------------------

// Starts wave `number`: plans it from the script and queues its spawns. The first spawn waits
// SPAWN.groupLeadIn so the banner lands first.
function beginWave(game, number) {
  const w = game.wave;
  w.number = number;
  w.phase = 'active';
  w.queue = spawnQueue(planWave(number));
  w.nextSpawnAt = game.time + SPAWN.groupLeadIn;
  game.events.push({ type: 'waveStart', wave: number });
}

// The wave state machine. Active: release queued enemies one at a time, as warnings, once their gap
// has passed and the entity cap has room. A wave clears when its queue is empty and every enemy it
// spawned is dead. Then comes the breather, and the next wave starts after it.
function updateSpawner(game, dt) {
  if (!game.spawning) return;
  const w = game.wave;

  if (w.phase === 'breather') {
    w.timer -= dt;
    if (w.timer <= 0) beginWave(game, w.number + 1);
    return;
  }

  if (w.queue.length > 0 && game.time >= w.nextSpawnAt && entityCount(game) < SPAWN.maxEntities) {
    const entry = w.queue.shift();
    // The first minute teaches chaining with Drifters only: a scripted kind becomes a Drifter.
    const kind = game.time < SPAWN.drifterOnlyUntil ? 'drifter' : entry.kind;
    const [x, y] = spawnPoint(game);
    game.warnings.push({ kind, x, y, t: SPAWN.warning, wave: w.number });
    w.nextSpawnAt = game.time + entry.gap;
  }

  for (const wn of game.warnings) wn.t -= dt;
  const due = game.warnings.filter((wn) => wn.t <= 0);
  if (due.length > 0) {
    game.warnings = game.warnings.filter((wn) => wn.t > 0);
    for (const wn of due) spawnEnemy(game, wn.kind, wn.x, wn.y, wn.wave);
  }

  const pending =
    w.queue.length > 0 ||
    game.warnings.some((wn) => wn.wave === w.number) ||
    game.enemies.some((e) => e.alive && e.wave === w.number);
  if (!pending) {
    game.events.push({ type: 'waveClear', wave: w.number });
    w.phase = 'breather';
    w.timer = SPAWN.breather;
  }
}

// A point on the arena edge at least minDistFromPlayer from the player (12 tries, then the last one).
function spawnPoint(game) {
  const p = game.player;
  const inset = SPAWN.edgeInset;
  let x = inset;
  let y = inset;
  for (let attempt = 0; attempt < 12; attempt++) {
    const side = Math.floor(game.rng() * 4);
    const u = game.rng();
    if (side === 0) {
      x = inset + u * (W - 2 * inset);
      y = inset;
    } else if (side === 1) {
      x = inset + u * (W - 2 * inset);
      y = H - inset;
    } else if (side === 2) {
      x = inset;
      y = inset + u * (H - 2 * inset);
    } else {
      x = W - inset;
      y = inset + u * (H - 2 * inset);
    }
    if (Math.hypot(x - p.x, y - p.y) >= SPAWN.minDistFromPlayer) break;
  }
  return [x, y];
}
