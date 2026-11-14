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
  SPAWN,
  ENEMY,
} from './config.js';

const W = LOGICAL_WIDTH;
const H = LOGICAL_HEIGHT;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function unit(dx, dy) {
  const len = Math.hypot(dx, dy);
  return len > 1e-9 ? [dx / len, dy / len] : [0, 0];
}

// Blend a velocity toward a target. `rate` is the fraction per step (already multiplied by dt).
function steer(e, tx, ty, rate) {
  const k = Math.min(1, rate);
  e.vx += (tx - e.vx) * k;
  e.vy += (ty - e.vy) * k;
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

// Distance from centre c to the segment a->b.
export function distToSegment(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? clamp(((cx - ax) * dx + (cy - ay) * dy) / len2, 0, 1) : 0;
  return Math.hypot(ax + dx * t - cx, ay + dy * t - cy);
}

// The closing slash arc: a point within r of the dash end (ex, ey), in the half-circle the dash
// was heading into (direction dx, dy).
function inFinalArc(ex, ey, dx, dy, x, y, r) {
  const vx = x - ex;
  const vy = y - ey;
  return vx * vx + vy * vy <= r * r && vx * dx + vy * dy >= 0;
}

const LUNGE_CONE_COS = Math.cos((DASH.lungeConeDegrees * Math.PI) / 180);

// Score multiplier for a combo count: 1 + floor(combo / 5), capped at x10.
export function multiplierFor(count) {
  return Math.min(COMBO.multiplierCap, 1 + Math.floor(count / COMBO.multiplierStep));
}

// Combo timer length for a combo count: 2.5 s, shrinking slightly with combo, never below 1.6 s.
export function comboWindowFor(count) {
  return Math.max(COMBO.windowMin, COMBO.window - COMBO.windowShrinkPerCombo * count);
}

// Colour tier index (0 = cyan ... 4 = white) for a combo count.
export function tierFor(count) {
  let tier = 0;
  COMBO.tiers.forEach((threshold, i) => {
    if (count >= threshold) tier = i + 1;
  });
  return tier;
}

export function spawnIntervalFor(wave) {
  return Math.max(SPAWN.minInterval, SPAWN.baseInterval - SPAWN.intervalStep * (wave - 1));
}

export function spawnCountFor(wave) {
  return 1 + Math.floor((wave - 1) / 4);
}

// Spawn weights for a wave. A kind only appears once its minWave is reached.
export function kindWeights(wave) {
  const weights = {};
  for (const [kind, def] of Object.entries(ENEMY_KINDS)) {
    if (def.minWave <= wave) weights[kind] = def.weight;
  }
  return weights;
}

// Behaviour table. Each kind: radius, points, minWave, weight, init(e, game), think(e, game, dt),
// and optional onStagger(e) and dashKillable(e, dash). think() only sets velocity; the shared
// integrator moves the enemy and clamps it to the arena.
export const ENEMY_KINDS = {
  drifter: {
    radius: ENEMY.drifter.radius,
    points: ENEMY.drifter.points,
    minWave: ENEMY.drifter.minWave,
    weight: ENEMY.drifter.weight,
    init() {},
    think(e, game, dt) {
      const c = ENEMY.drifter;
      const [ux, uy] = unit(game.player.x - e.x, game.player.y - e.y);
      steer(e, ux * c.speed, uy * c.speed, c.steer * dt);
    },
  },

  spitter: {
    radius: ENEMY.spitter.radius,
    points: ENEMY.spitter.points,
    minWave: ENEMY.spitter.minWave,
    weight: ENEMY.spitter.weight,
    init(e) {
      e.shotCd = ENEMY.spitter.firstShotDelay;
      e.telegraph = 0;
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

      // A shot is only ever started or released while the player is not mid-dash and has had
      // SPITTER.postDashQuiet since the last one, so no bullet arrives with no time to react.
      const quiet = !p.dash.active && p.sinceDash >= c.postDashQuiet;
      if (e.state === 'windup') {
        if (quiet) e.stateT -= dt;
        e.telegraph = 1 - Math.max(0, e.stateT) / c.windup;
        if (e.stateT <= 0 && quiet) {
          // Release along the aim locked when the wind-up started.
          e.state = 'idle';
          e.telegraph = 0;
          e.shotCd = c.fireInterval;
          const off = e.r + c.bulletRadius + 2;
          const sx = e.x + e.dirX * off;
          const sy = e.y + e.dirY * off;
          fireBullet(game, sx, sy, e.dirX * c.bulletSpeed, e.dirY * c.bulletSpeed);
          game.events.push({ type: 'enemyShoot', x: sx, y: sy, enemyType: 'spitter' });
        }
      } else {
        e.shotCd -= dt;
        if (e.shotCd <= 0 && dist <= c.fireRange && quiet) {
          e.state = 'windup';
          e.stateT = c.windup;
          e.dirX = ux;
          e.dirY = uy;
          e.telegraph = 0;
        }
      }
    },
    onStagger(e) {
      // A pulse breaks the wind-up; the shot is simply re-armed.
      if (e.state === 'windup') {
        e.state = 'idle';
        e.telegraph = 0;
        e.shotCd = ENEMY.spitter.fireInterval;
      }
    },
  },

  charger: {
    radius: ENEMY.charger.radius,
    points: ENEMY.charger.points,
    minWave: ENEMY.charger.minWave,
    weight: ENEMY.charger.weight,
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
};

export function createGame(seed = 1, options = {}) {
  return {
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
      dashGrace: 0,        // seconds of invulnerability left after a dash (afterglow for the renderer)
      sinceDash: ENEMY.spitter.postDashQuiet, // seconds since the last dash ended (starts quiet)
      aimX: W / 2,         // last aim point, for the renderer's aim preview
      aimY: H / 2,
      pulseCooldown: 0,
      dash: { charges: DASH.maxCharges, recharge: 0, active: null },
    },
    enemies: [],
    bullets: [],
    warnings: [],
    combo: { count: 0, timer: 0, tier: 0 },
    wave: { number: 1, timer: SPAWN.waveDuration, spawnTimer: SPAWN.firstSpawnDelay },
    events: [{ type: 'waveStart', wave: 1 }],
  };
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
  p.dashGrace = Math.max(0, p.dashGrace - dt);
  p.sinceDash += dt;
  p.pulseCooldown = Math.max(0, p.pulseCooldown - dt);
  game.slowmo = Math.max(0, game.slowmo - dt);
  tickCombo(game, dt);
  tickRecharge(game, dt);

  if (input.pulse && p.pulseCooldown <= 0) firePulse(game);
  if (input.dash && !p.dash.active && p.dash.charges >= 1) startDash(game, input);

  if (p.dash.active) stepDash(game, dt);
  else stepMove(game, input, dt);

  const aimX = input.aimX ?? p.x;
  const aimY = input.aimY ?? p.y;
  p.aimX = aimX;
  p.aimY = aimY;
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
export function killEnemy(game, e, slashIndex = 1) {
  if (!e.alive) return;
  e.alive = false;
  const c = game.combo;
  c.count += 1;
  c.timer = comboWindowFor(c.count);
  const mult = multiplierFor(c.count);
  let points = ENEMY_KINDS[e.kind].points * mult;
  if (slashIndex > 1) points += COMBO.multiBonus * mult;
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
    points,
  });
}

// ---- Dash -----------------------------------------------------------------------------------

// Where a dash aimed at (aimX, aimY) goes. Pure: reads the sim, never writes it.
// Lunge assist: if the nearest enemy inside the aim cone is between the dash distance and
// DASH.lungeMaxDistance out, and the blade would reach it, the dash is extended along the aim line
// to pass through it. A dash is never shortened or re-aimed.
function planDash(game, aimX, aimY) {
  const p = game.player;
  let [dx, dy] = unit(aimX - p.x, aimY - p.y);
  if (dx === 0 && dy === 0) {
    dx = Math.cos(p.facing);
    dy = Math.sin(p.facing);
  }
  let nearest = null;
  for (const e of game.enemies) {
    if (!e.alive) continue;
    const vx = e.x - p.x;
    const vy = e.y - p.y;
    const along = vx * dx + vy * dy;
    const len = Math.hypot(vx, vy);
    if (along <= 0 || len === 0 || along / len < LUNGE_CONE_COS) continue;
    if (!nearest || along < nearest.along) {
      nearest = { e, along, lateral: Math.abs(vx * dy - vy * dx) };
    }
  }
  const assisted =
    nearest !== null &&
    nearest.along > DASH.distance &&
    nearest.along <= DASH.lungeMaxDistance &&
    nearest.lateral <= nearest.e.r + DASH.bladeRadius;
  const dist = assisted ? nearest.along : DASH.distance;
  const [ex, ey] = clampToArena(p.x + dx * dist, p.y + dy * dist, PLAYER.radius);
  return {
    dirX: dx,
    dirY: dy,
    dist,
    dur: DASH.duration * (dist / DASH.distance), // same speed, slightly longer when extended
    ex,
    ey,
    assisted,
  };
}

function startDash(game, input) {
  const p = game.player;
  const plan = planDash(game, input.aimX ?? p.x, input.aimY ?? p.y);
  p.dash.charges -= 1;
  p.dash.active = {
    t: 0,
    dur: plan.dur,
    sx: p.x,
    sy: p.y,
    ex: plan.ex,
    ey: plan.ey,
    lastX: p.x,
    lastY: p.y,
    dirX: plan.dirX,
    dirY: plan.dirY,
    kills: 0,
    nearMiss: false,
    assisted: plan.assisted,
  };
  p.facing = Math.atan2(plan.dirY, plan.dirX);
  game.events.push({ type: 'dash', x: p.x, y: p.y, angle: p.facing, assisted: plan.assisted });
}

// The end point a dash aimed at (aimX, aimY) would reach and whether it would kill anything.
// Runs the same plan and the same kill tests as the real dash, on the current enemies; pure.
export function dashPreview(game, aimX, aimY) {
  const p = game.player;
  const plan = planDash(game, aimX, aimY);
  const kills = game.enemies.some(
    (e) =>
      e.alive &&
      canBeKilled(e, plan) &&
      (segmentHitsCircle(p.x, p.y, plan.ex, plan.ey, e.x, e.y, e.r + DASH.bladeRadius) ||
        inFinalArc(plan.ex, plan.ey, plan.dirX, plan.dirY, e.x, e.y, DASH.finalArcRadius)),
  );
  return { x: plan.ex, y: plan.ey, kills, assisted: plan.assisted };
}

function stepDash(game, dt) {
  const p = game.player;
  const d = p.dash.active;
  d.t = Math.min(d.dur, d.t + dt);
  const k = d.t / d.dur;
  const x = d.sx + (d.ex - d.sx) * k;
  const y = d.sy + (d.ey - d.sy) * k;
  sweepDash(game, d, x, y);
  p.x = x;
  p.y = y;
  if (d.t >= d.dur) {
    finishDash(game, d);
  } else {
    p.vx = (d.ex - d.sx) / d.dur;
    p.vy = (d.ey - d.sy) / d.dur;
  }
}

// The last step of a dash: closing arc, whiff feedback, exit grace and carried momentum.
function finishDash(game, d) {
  const p = game.player;
  finalArc(game, d);
  if (d.kills === 0 && d.nearMiss) game.events.push({ type: 'dashWhiff', x: d.ex, y: d.ey });
  p.dash.active = null;
  p.dashGrace = Math.max(p.dashGrace, d.kills > 0 ? DASH.killGrace : DASH.exitGrace);
  p.sinceDash = 0;
  p.vx = d.dirX * DASH.exitSpeed;
  p.vy = d.dirY * DASH.exitSpeed;
}

// Enemies a dash can kill at all (some kinds only from the side or behind; see ENEMY_KINDS).
function canBeKilled(e, d) {
  const def = ENEMY_KINDS[e.kind];
  return !def.dashKillable || def.dashKillable(e, d);
}

// A bullet destroyed by the dash: small score, no combo, no charge refund.
function cutBullet(game, b) {
  b.alive = false;
  game.score += DASH.bulletCutScore;
  game.events.push({ type: 'bulletCut', x: b.x, y: b.y });
}

// The closing slash arc at the dash end: kills enemies and cuts bullets within reach of the end point.
function finalArc(game, d) {
  for (const e of game.enemies) {
    if (!e.alive || !canBeKilled(e, d)) continue;
    if (inFinalArc(d.ex, d.ey, d.dirX, d.dirY, e.x, e.y, DASH.finalArcRadius)) {
      d.kills += 1;
      killEnemy(game, e, d.kills);
    }
  }
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'enemy') continue;
    if (inFinalArc(d.ex, d.ey, d.dirX, d.dirY, b.x, b.y, DASH.finalArcRadius + b.r)) cutBullet(game, b);
  }
}

// Every step of the dash, over the path it covered since the last step (segment test, not a point test):
// kills every enemy the blade crossed, cuts enemy bullets on the same path, and notes near misses.
function sweepDash(game, d, x, y) {
  for (const e of game.enemies) {
    if (!e.alive) continue;
    if (canBeKilled(e, d) && segmentHitsCircle(d.lastX, d.lastY, x, y, e.x, e.y, e.r + DASH.bladeRadius)) {
      d.kills += 1;
      killEnemy(game, e, d.kills);
    } else if (!d.nearMiss && distToSegment(d.lastX, d.lastY, x, y, e.x, e.y) <= DASH.whiffRadius) {
      d.nearMiss = true;
    }
  }
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'enemy') continue;
    if (segmentHitsCircle(d.lastX, d.lastY, x, y, b.x, b.y, b.r + DASH.bladeRadius)) cutBullet(game, b);
  }
  d.lastX = x;
  d.lastY = y;
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
    if (e.alive && Math.hypot(e.x - p.x, e.y - p.y) <= PULSE.radius + e.r) staggerEnemy(e);
  }

  if (perfect) {
    p.pulseCooldown = 0;
    game.slowmo = PULSE.slowmoDuration;
    game.events.push({ type: 'perfectPulse', x: p.x, y: p.y });
  }
}

function staggerEnemy(e) {
  e.stagger = PULSE.stagger;
  const def = ENEMY_KINDS[e.kind];
  if (def.onStagger) def.onStagger(e);
}

// ---- Enemies, bullets and spawning ----------------------------------------------------------

export function spawnEnemy(game, kind, x, y) {
  const def = ENEMY_KINDS[kind];
  const e = {
    id: game.nextId++,
    kind,
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
    hitWall: false,
    state: 'idle',
    stateT: 0,
    telegraph: 0,
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
  e.age += dt;
  if (e.stagger > 0) {
    e.stagger = Math.max(0, e.stagger - dt);
    const f = Math.exp(-6 * dt);
    e.vx *= f;
    e.vy *= f;
  } else {
    ENEMY_KINDS[e.kind].think(e, game, dt);
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

// Contact is fair. A non-lunging enemy hurts only when its centre gets inside its radius plus the
// player's core (grazes are safe). Chargers hurt only during their lunge. Nothing hurts for the first
// SPAWN.safeTime seconds of its life.
function enemiesTouchPlayer(game) {
  const p = game.player;
  for (const e of game.enemies) {
    if (!e.alive || e.age < SPAWN.safeTime) continue;
    let reach;
    if (e.kind === 'charger') {
      if (e.state !== 'lunge') continue;
      reach = e.r + PLAYER.radius;
    } else {
      reach = e.r + PLAYER.coreRadius;
    }
    if (Math.hypot(e.x - p.x, e.y - p.y) < reach) damagePlayer(game, e.x, e.y);
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
        killEnemy(game, e, game.burstKills);
        break;
      }
    }
  }
}

// Returns true if the hit landed. Dashing, the post-dash grace and post-hit invulnerability block damage.
export function damagePlayer(game, fromX, fromY) {
  const p = game.player;
  if (game.over || p.invuln > 0 || p.dashGrace > 0 || p.dash.active) return false;
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

function updateSpawner(game, dt) {
  const w = game.wave;
  w.timer -= dt;
  if (w.timer <= 0) {
    w.number += 1;
    w.timer += SPAWN.waveDuration;
    game.events.push({ type: 'waveStart', wave: w.number });
  }

  if (game.spawning) {
    w.spawnTimer -= dt;
    if (w.spawnTimer <= 0) {
      w.spawnTimer += spawnIntervalFor(w.number);
      for (let i = 0; i < spawnCountFor(w.number); i++) {
        if (game.enemies.length + game.warnings.length >= SPAWN.maxAlive) break;
        const kind = pickKind(game, w.number);
        const [x, y] = spawnPoint(game);
        game.warnings.push({ kind, x, y, t: SPAWN.warning });
      }
    }
  }

  // Warnings count down; the enemy appears when its marker expires.
  for (const wn of game.warnings) wn.t -= dt;
  const due = game.warnings.filter((wn) => wn.t <= 0);
  if (due.length > 0) {
    game.warnings = game.warnings.filter((wn) => wn.t > 0);
    for (const wn of due) spawnEnemy(game, wn.kind, wn.x, wn.y);
  }
}

function pickKind(game, wave) {
  const weights = kindWeights(wave);
  const kinds = Object.keys(weights);
  let total = 0;
  for (const k of kinds) total += weights[k];
  let r = game.rng() * total;
  for (const k of kinds) {
    r -= weights[k];
    if (r < 0) return k;
  }
  return kinds[0];
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
