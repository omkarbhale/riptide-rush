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
  AGGRO,
} from './config.js';
// PICKUPS: health recovery and modifier drops (#54). Hooks are marked below.
import {
  createPickupState,
  onKill,
  shockwaveVictims,
  updatePickups,
  absorbHit,
  onHurt,
  onWaveEnd,
  dashMaxCharges,
  dashRechargeScale,
  dashDistanceScale,
  comboDrainScale,
} from './pickups.js';
import { planWave, formationOffsets, FORMATIONS } from './waves.js';

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

// Enemies speed up gently with the wave they came from, with no cap (#97), and once aggressive (#83).
export function speedScaleFor(wave) {
  return 1 + SPAWN.speedPerWave * (Math.max(1, wave) - 1);
}
function moveSpeed(e, base) {
  return base * speedScaleFor(e.wave) * (e.aggro ? AGGRO.speedMul : 1);
}

// Spitter bullets: slow at the first Spitter waves, faster each wave, up to a cap (#97 beginner ramp).
export function bulletSpeedFor(wave) {
  const c = ENEMY.spitter;
  return Math.min(c.bulletSpeedMax, c.bulletSpeed + c.bulletSpeedPerWave * (Math.max(2, wave) - 2));
}

// One-time hint text, shown once per run as a floater the first time its trigger happens (#84).
export const HINT_TEXT = Object.freeze({
  spitter: 'DASH THROUGH BULLETS - OR RIGHT-CLICK TO REFLECT',
  shellback: 'ARMORED FRONT - STRIKE FROM BEHIND OR PULSE IT',
});
function hintOnce(game, key, x, y) {
  if (game.hints[key]) return;
  game.hints[key] = true;
  game.events.push({ type: 'hint', text: HINT_TEXT[key], x, y });
}

// A drifter in a school holds its formation slot while Rip is not close; close in, it chases directly.
function holdSlot(e, game, dt, speed) {
  const s = e.school;
  const c = ENEMY.drifter;
  const cos = Math.cos(s.heading);
  const sin = Math.sin(s.heading);
  const tx = s.x + e.slotX * cos - e.slotY * sin;
  const ty = s.y + e.slotX * sin + e.slotY * cos;
  const dx = tx - e.x;
  const dy = ty - e.y;
  const d = Math.hypot(dx, dy);
  const [ux, uy] = unit(dx, dy);
  const want = Math.min(speed * c.slotSpeed, d * 4); // reach the slot without overshooting it
  steer(e, ux * want, uy * want, c.steer * dt);
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
//   staggerable: false   Pulse has no effect: no stagger and no reflect kill (mines)
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
      const c = ENEMY.drifter;
      const speed = moveSpeed(e, c.speed);
      const far = Math.hypot(game.player.x - e.x, game.player.y - e.y) > c.chaseRange;
      if (e.school && far) holdSlot(e, game, dt, speed);
      else chase(e, game, dt, speed, c.steer);
    },
  },

  spitter: {
    radius: ENEMY.spitter.radius,
    points: ENEMY.spitter.points,
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
      steer(e, dx * moveSpeed(e, c.speed), dy * moveSpeed(e, c.speed), 4 * dt);

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
          const v = bulletSpeedFor(e.wave);
          fireBullet(game, sx, sy, e.dirX * v, e.dirY * v);
          game.events.push({ type: 'enemyShoot', x: sx, y: sy, enemyType: 'spitter' });
        }
      } else {
        e.shotCd -= dt;
        if (e.shotCd <= 0 && dist <= c.fireRange && quiet && entityCount(game) < SPAWN.maxEntities) {
          e.state = 'windup';
          e.stateT = c.windup;
          e.dirX = ux;
          e.dirY = uy;
          e.telegraph = 0;
          game.events.push({ type: 'spitWindup', x: e.x, y: e.y, enemyType: 'spitter' }); // audible before the shot lands
          hintOnce(game, 'spitter', e.x, e.y); // #84: the first wind-up explains the bullets
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
    onAggro(e) {
      if (e.state !== 'windup') e.shotCd = 0; // a lone Spitter stops waiting out its first-shot delay (#83)
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
        steer(e, ux * moveSpeed(e, c.idleSpeed), uy * moveSpeed(e, c.idleSpeed), 2 * dt);
        e.cooldown -= dt;
        if (e.cooldown <= 0 && dist <= c.triggerRange) {
          // The aim is locked here, so the telegraph line is an honest warning.
          e.state = 'telegraph';
          e.stateT = c.telegraph;
          e.dirX = ux;
          e.dirY = uy;
          e.vx = 0;
          e.vy = 0;
          game.events.push({ type: 'chargerTelegraph', x: e.x, y: e.y });
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
          game.events.push({ type: 'chargerLunge', x: e.x, y: e.y });
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
    onAggro(e) {
      if (e.state === 'idle') e.cooldown = 0; // a lone Charger lunges at the next chance (#83)
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
      hintOnce(game, 'shellback', e.x, e.y); // #84: the first Shellback explains the armour
    },
    think(e, game, dt) {
      const c = ENEMY.shellback;
      const want = Math.atan2(game.player.y - e.y, game.player.x - e.x);
      const limit = c.turnRate * dt;
      e.facing = wrapAngle(e.facing + clamp(wrapAngle(want - e.facing), -limit, limit));
      const v = moveSpeed(e, c.speed);
      steer(e, Math.cos(e.facing) * v, Math.sin(e.facing) * v, 4 * dt);
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
      chase(e, game, dt, moveSpeed(e, ENEMY.splitter.speed), ENEMY.splitter.steer);
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
      chase(e, game, dt, moveSpeed(e, ENEMY.mini.speed), ENEMY.mini.steer);
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
        // Armed by Rip coming near, or by itself after selfArmTime so an idle mine cannot stall a wave (#83).
        if (Math.hypot(game.player.x - e.x, game.player.y - e.y) <= c.armRange || e.age >= c.selfArmTime) {
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
    modifiers: {},   // PICKUPS: kind -> seconds remaining (see pickups.js)
    pickups: createPickupState(), // PICKUPS
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
      bounce: null,
    },
    enemies: [],
    bullets: [],
    warnings: [],
    combo: { count: 0, timer: 0, tier: 0 },
    wave: { number: 0, phase: 'active', timer: 0, startedAt: 0, total: 0, release: false }, // the newest wave
    spawnQueue: [],      // school entries not yet released: { wave, kind, size, gap }
    nextSpawnAt: 0,      // the next school may be released at this time
    liveWaves: [],       // waves not yet cleared: { number, total, release }
    schools: [],         // Drifter schools: { id, x, y, heading, speed, wave }, anchors for formation (#97)
    hints: {},           // one-time hints already shown this run (#84)
    spitterReleased: false, // the first Spitter waits until the Drifter schools are cleared
    spitterWaitFrom: -1,    // when the first Spitter first came due on the gate (-1: not yet)
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
  p.dashGrace = Math.max(0, p.dashGrace - dt);
  p.sinceDash += dt;
  p.pulseCooldown = Math.max(0, p.pulseCooldown - dt);
  game.slowmo = Math.max(0, game.slowmo - dt);
  tickCombo(game, dt);
  tickRecharge(game, dt);

  if (input.pulse && p.pulseCooldown <= 0) firePulse(game);
  if (input.dash && !p.dash.active && !p.bounce && p.dash.charges >= 1) startDash(game, input);

  const dashing = Boolean(p.dash.active);
  if (dashing) stepDash(game, dt);
  else if (p.bounce) stepBounce(game, dt);
  else stepMove(game, input, dt);
  updatePickups(game, dt, dashing); // PICKUPS: drops move, magnet, collection, modifier timers

  const aimX = input.aimX ?? p.x;
  const aimY = input.aimY ?? p.y;
  p.aimX = aimX;
  p.aimY = aimY;
  if (Math.hypot(aimX - p.x, aimY - p.y) > 4) p.facing = Math.atan2(aimY - p.y, aimX - p.x);

  const worldDt = game.slowmo > 0 ? dt * PULSE.slowmoScale : dt;
  updateSchools(game, worldDt);
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
  c.timer -= dt * comboDrainScale(game); // PICKUPS: Riptide Coal
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
  const max = dashMaxCharges(game); // PICKUPS: Spark Coral
  if (d.charges >= max) {
    d.recharge = 0;
    return;
  }
  d.recharge += dt * dashRechargeScale(game); // PICKUPS: Frenzy
  while (d.recharge >= DASH.rechargeTime && d.charges < max) {
    d.recharge -= DASH.rechargeTime;
    d.charges += 1;
  }
  if (d.charges >= max) d.recharge = 0;
}

// Every kill: +1 combo, timer reset, score = base x multiplier (combo after this kill),
// plus a multi-kill bonus for the 2nd+ kill of one slash, and an immediate dash charge refund.
// `slashIndex` is 1-based: which kill this is within the current dash or pulse.
// `cause` says how it died: 'dash', 'defuse' (a mine dashed through), 'reflect', 'blast' or 'shockwave'.
// The kill event carries `bonus` (the multi-kill points) and `hitStopMs` so feedback can scale.
// Returns how many enemies died, counting Undertow chain kills, so callers can keep slashIndex in step.
export function killEnemy(game, e, slashIndex = 1, cause = 'dash') {
  if (!e.alive) return 0;
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
  d.charges = Math.min(dashMaxCharges(game), d.charges + 1); // PICKUPS: Spark Coral raises the cap
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
  // PICKUPS: drop roll, then the Undertow shockwave chain (victims die through killEnemy too).
  onKill(game, e);
  let kills = 1;
  for (const v of shockwaveVictims(game, e)) kills += killEnemy(game, v, slashIndex + kills, 'shockwave');
  return kills;
}

// ---- Dash -----------------------------------------------------------------------------------

// Where a dash aimed at (aimX, aimY) goes. Pure: reads the sim, never writes it.
// Lunge assist: if the nearest enemy inside the aim cone is between the dash distance and
// DASH.lungeMaxDistance out, and the blade would reach it, the dash is extended along the aim line
// to pass through it. A dash is never shortened or re-aimed.
export function planDash(game, aimX, aimY) {
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
  // PICKUPS: Frenzy lengthens every dash by the same factor, and the lunge window scales with it.
  const scale = dashDistanceScale(game);
  const baseDist = DASH.distance * scale;
  const assisted =
    nearest !== null &&
    nearest.along > baseDist &&
    nearest.along <= DASH.lungeMaxDistance * scale &&
    nearest.lateral <= nearest.e.r + DASH.bladeRadius;
  const dist = assisted ? nearest.along : baseDist;
  const [ex, ey] = clampToArena(p.x + dx * dist, p.y + dy * dist, PLAYER.radius);
  return {
    dirX: dx,
    dirY: dy,
    dist,
    dur: DASH.duration * (dist / DASH.distance), // same speed, slightly longer when extended (or under Frenzy)
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
    deflected: false,
    assisted: plan.assisted,
  };
  p.facing = Math.atan2(plan.dirY, plan.dirX);
  game.events.push({ type: 'dash', x: p.x, y: p.y, angle: p.facing, assisted: plan.assisted });
}

// What the dash does to enemy e at the point (x, y): 'kill', 'deflect' or 'ignore'.
function dashVerdict(game, e, d, x, y) {
  const def = ENEMY_KINDS[e.kind];
  return def.dashHit ? def.dashHit(game, e, d, x, y) : 'kill';
}

// The end point a dash aimed at (aimX, aimY) would reach and whether it would kill anything.
// Runs the same plan and the same kill tests as the real dash, on the current enemies; pure.
export function dashPreview(game, aimX, aimY) {
  const p = game.player;
  const plan = planDash(game, aimX, aimY);
  const kills = game.enemies.some(
    (e) =>
      e.alive &&
      (segmentHitsCircle(p.x, p.y, plan.ex, plan.ey, e.x, e.y, e.r + DASH.bladeRadius) ||
        inFinalArc(plan.ex, plan.ey, plan.dirX, plan.dirY, e.x, e.y, DASH.finalArcRadius)) &&
      dashVerdict(game, e, plan, plan.ex, plan.ey) === 'kill',
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
  if (d.deflected) {
    // Rip is still at the last point the dash cleared, so the bounce starts from there.
    startBounce(game, d);
    return;
  }
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

// A bullet destroyed by the dash: small score, no combo, no charge refund.
function cutBullet(game, b) {
  b.alive = false;
  game.score += DASH.bulletCutScore;
  game.events.push({ type: 'bulletCut', x: b.x, y: b.y });
}

// The closing slash arc at the dash end: kills enemies and cuts bullets within reach of the end point.
function finalArc(game, d) {
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (!e.alive) continue;
    if (!inFinalArc(d.ex, d.ey, d.dirX, d.dirY, e.x, e.y, DASH.finalArcRadius)) continue;
    if (dashVerdict(game, e, d, d.ex, d.ey) !== 'kill') continue;
    d.kills += killEnemy(game, e, d.kills + 1, e.kind === 'mine' ? 'defuse' : 'dash'); // PICKUPS: chain kills count
  }
  for (const b of game.bullets) {
    if (!b.alive || b.owner !== 'enemy') continue;
    if (inFinalArc(d.ex, d.ey, d.dirX, d.dirY, b.x, b.y, DASH.finalArcRadius + b.r)) cutBullet(game, b);
  }
}

// Every step of the dash, over the path it covered since the last step (segment test, not a point test):
// kills every enemy the blade crossed, cuts enemy bullets on the same path, and notes near misses.
// A kill is a kill; a Shellback's armour turns the dash into a deflect, which ends the dash.
// It walks only the enemies that existed at the start of the step, so a splitter's minis are not
// caught by the dash that split it.
function sweepDash(game, d, x, y) {
  const n = game.enemies.length;
  for (let i = 0; i < n; i++) {
    const e = game.enemies[i];
    if (!e.alive) continue;
    if (segmentHitsCircle(d.lastX, d.lastY, x, y, e.x, e.y, e.r + DASH.bladeRadius)) {
      const verdict = dashVerdict(game, e, d, x, y);
      if (verdict === 'deflect') {
        d.deflected = true;
        game.events.push({ type: 'deflect', x, y });
        return; // d.lastX stays at the last clear point
      }
      if (verdict === 'kill') {
        d.kills += killEnemy(game, e, d.kills + 1, e.kind === 'mine' ? 'defuse' : 'dash'); // PICKUPS: chain kills count
      }
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

// A deflected dash ends at once. Rip bounces DASH.bounceDistance back along the dash, invulnerable.
function startBounce(game, d) {
  const p = game.player;
  p.dash.active = null;
  p.sinceDash = 0;
  const sx = p.x;
  const sy = p.y;
  // The lesson costs tempo, not charges: the deflected dash's charge is refunded (#85).
  p.dash.charges = Math.min(dashMaxCharges(game), p.dash.charges + 1);
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
    game.score += PULSE.perfectBonus; // #78: the floater's +N is this award
    game.events.push({ type: 'perfectPulse', x: p.x, y: p.y, points: PULSE.perfectBonus });
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

// A school member passes its school and its formation slot (x, y offsets in the school frame) as `slot`.
export function spawnEnemy(game, kind, x, y, wave = game.wave.number, slot = null) {
  const def = ENEMY_KINDS[kind];
  // Spawns sit inside the arena clamp, so no enemy starts outside it (#82).
  const [cx, cy] = clampToArena(x, y, def.radius);
  const e = {
    id: game.nextId++,
    kind,
    wave,
    x: cx,
    y: cy,
    px: cx,
    py: cy,
    vx: 0,
    vy: 0,
    r: def.radius,
    alive: true,
    stagger: 0,
    age: 0,
    aggro: false,        // lone enemies turn aggressive after AGGRO.loneTime (#83)
    loneT: 0,
    school: slot ? slot.school : null,
    slotX: slot ? slot.x : 0,
    slotY: slot ? slot.y : 0,
    grace: Math.max(def.graceTime ?? 0, SPAWN.safeTime), // no enemy hurts for its first SPAWN.safeTime
    facing: 0,
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
    // Fair reach: a non-lunging enemy must get inside its radius plus the player's core, so grazes are
    // safe; a charger hurts only while lunging, at full body reach.
    let reach = e.r + PLAYER.coreRadius;
    if (e.kind === 'charger') {
      if (e.state !== 'lunge') continue;
      reach = e.r + PLAYER.radius;
    }
    if (Math.hypot(e.x - p.x, e.y - p.y) < reach && damagePlayer(game, e.x, e.y) && def.dieOnContact) {
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
      // #81: Pulse has no effect on a kind marked staggerable: false (mines), so a reflected bullet passes them.
      if (!e.alive || ENEMY_KINDS[e.kind].staggerable === false) continue;
      if (segmentHitsCircle(b.px, b.py, b.x, b.y, e.x, e.y, e.r + b.r)) {
        b.alive = false;
        game.burstKills += killEnemy(game, e, game.burstKills + 1, 'reflect');
        break;
      }
    }
  }
}

// Returns true if the attack connected: HP was lost, or a Shield Scale absorbed it. Dash grace, post-hit
// invulnerability and the shield's own bounce grace block the hit entirely and return false.
export function damagePlayer(game, fromX, fromY) {
  const p = game.player;
  if (game.over || p.invuln > 0 || p.dashGrace > 0 || p.dash.active || game.pickups.shieldGrace > 0) return false; // PICKUPS: grace
  if (absorbHit(game, fromX, fromY)) return true; // PICKUPS: the attack connects; a Shield Scale takes the damage
  p.hp -= 1;
  onHurt(game); // PICKUPS: this wave is no longer flawless
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

// Where a school's anchor appears: on the arena edge, this far inside it, at least minDistFromPlayer from Rip.
const SCHOOL_INSET = ARENA.inset + 30;

// Starts wave `number`: plans it as schools and queues them. The first school waits SPAWN.groupLeadIn
// so the banner lands first. The new wave is queued behind any schools still waiting from older waves.
function beginWave(game, number) {
  const plan = planWave(number);
  const w = game.wave;
  let total = 0;
  for (const school of plan.schools) {
    game.spawnQueue.push({ wave: number, kind: school.kind, size: school.size, gap: plan.cadence });
    total += school.size;
  }
  w.number = number;
  w.phase = 'active';
  w.timer = 0;
  w.startedAt = game.time;
  w.total = total;
  w.release = plan.release;
  game.liveWaves.push({ number, total, release: plan.release });
  game.nextSpawnAt = Math.max(game.nextSpawnAt, game.time + SPAWN.groupLeadIn);
  game.events.push({ type: 'waveStart', wave: number });
}

// Enemies, warnings and queued schools that still belong to wave n. A wave is cleared when this is zero.
function remainingOf(game, n) {
  let r = 0;
  for (const q of game.spawnQueue) if (q.wave === n) r += q.size;
  for (const wn of game.warnings) if (wn.wave === n) r += 1;
  for (const e of game.enemies) if (e.alive && e.wave === n) r += 1;
  return r;
}

// The wave state machine (#83, #97). Schools are released one at a time, as warnings, once their gap has
// passed, the entity cap has room and (for the first Spitter) the gate is open. Then:
//  - A non-release wave hands over to the next wave once it is down to SPAWN.stragglers of its count, or
//    after SPAWN.waveTimeLimit, so waves overlap. The old wave's stragglers keep fighting.
//  - A release wave runs to a clear, then a SPAWN.breather, and the next wave starts after it.
// A wave clears when none of its enemies, warnings or queued schools remain.
function updateSpawner(game, dt) {
  if (!game.spawning) return;
  releaseSchool(game);
  for (const wn of game.warnings) wn.t -= dt;
  const due = game.warnings.filter((wn) => wn.t <= 0);
  if (due.length > 0) {
    game.warnings = game.warnings.filter((wn) => wn.t > 0);
    for (const wn of due) spawnEnemy(game, wn.kind, wn.x, wn.y, wn.wave, wn.slot);
  }
  updateLoneEnemies(game, dt);

  const w = game.wave;
  if (w.phase === 'breather') {
    w.timer -= dt;
    if (w.timer <= 0) beginWave(game, w.number + 1);
  } else {
    const age = game.time - w.startedAt;
    if (w.release) {
      if (age >= SPAWN.releaseTimeLimit) beginWave(game, w.number + 1); // the breather is kept when it clears
    } else {
      const threshold = Math.max(1, Math.ceil(SPAWN.stragglers * w.total));
      if (remainingOf(game, w.number) <= threshold || age >= SPAWN.waveTimeLimit) beginWave(game, w.number + 1);
    }
  }

  for (const rec of [...game.liveWaves]) {
    if (remainingOf(game, rec.number) > 0) continue;
    game.liveWaves = game.liveWaves.filter((r) => r !== rec);
    game.events.push({ type: 'waveClear', wave: rec.number });
    if (rec.number === w.number && w.phase === 'active') {
      w.phase = 'breather';
      w.timer = rec.release ? SPAWN.breather : 0; // a non-release wave that cleared early hands over at once
    }
  }
  pruneSchools(game);
}

// Releases the first queued school that may come now: due by its gap, with room under the entity cap.
// The first Spitter of the run waits until no Drifter is alive, warning or queued (#84).
function releaseSchool(game) {
  if (game.spawnQueue.length === 0 || game.time < game.nextSpawnAt) return;
  const idx = game.spawnQueue.findIndex((entry) => spawnAllowed(game, entry));
  if (idx < 0) return;
  const entry = game.spawnQueue[idx];
  if (entityCount(game) + entry.size > SPAWN.maxEntities) return; // the wave script waits for room
  game.spawnQueue.splice(idx, 1);
  // The first minute teaches chaining with Drifters only: a scripted kind becomes a Drifter.
  const kind = game.time < SPAWN.drifterOnlyUntil ? 'drifter' : entry.kind;
  if (kind === 'spitter') game.spitterReleased = true;
  placeSchool(game, kind, entry.size, entry.wave);
  game.nextSpawnAt = game.time + entry.gap;
}

// The first Spitter waits for the Drifter schools to be cleared: none queued or warned, and no more than
// SPAWN.spitterGateDrifters left alive. It never waits past SPAWN.spitterGateTime, so a player who
// ignores Drifters still meets Spitters (#84, and no stall).
function spawnAllowed(game, entry) {
  if (entry.kind !== 'spitter' || game.spitterReleased) return true;
  if (game.time < SPAWN.drifterOnlyUntil) return true;
  if (game.spitterWaitFrom < 0) game.spitterWaitFrom = game.time;
  if (game.time - game.spitterWaitFrom >= SPAWN.spitterGateTime) return true;
  const drifterQueued = game.spawnQueue.some((q) => q.kind === 'drifter');
  const drifterWarned = game.warnings.some((wn) => wn.kind === 'drifter');
  let drifterAlive = 0;
  for (const e of game.enemies) if (e.alive && e.kind === 'drifter') drifterAlive += 1;
  return !drifterQueued && !drifterWarned && drifterAlive <= SPAWN.spitterGateDrifters;
}

// Puts a school on the field as warnings. A Drifter school gets a formation (line, wedge or ring) that
// swims with its anchor; every other kind is a school of one, placed alone.
function placeSchool(game, kind, size, wave) {
  const [ax, ay] = spawnPoint(game);
  if (kind !== 'drifter') {
    const [x, y] = clampToArena(ax, ay, ENEMY[kind].radius);
    game.warnings.push({ kind, x, y, t: SPAWN.warning, wave, slot: null });
    return;
  }
  const p = game.player;
  const heading = Math.atan2(p.y - ay, p.x - ax);
  const shape = size > 1 ? FORMATIONS[Math.floor(game.rng() * FORMATIONS.length)] : 'line';
  const school = {
    id: game.nextId++,
    x: ax,
    y: ay,
    heading,
    speed: ENEMY.drifter.speed * ENEMY.drifter.schoolSpeed * speedScaleFor(wave),
    wave,
  };
  game.schools.push(school);
  const offsets = formationOffsets(shape, size, SPAWN.schoolSpacing);
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  for (const o of offsets) {
    const x = ax + o.x * cos - o.y * sin;
    const y = ay + o.x * sin + o.y * cos;
    const [cx, cy] = clampToArena(x, y, ENEMY.drifter.radius);
    game.warnings.push({ kind, x: cx, y: cy, t: SPAWN.warning, wave, slot: { school, x: o.x, y: o.y } });
  }
}

// Schools hold their formation: the anchor swims toward Rip at the school's speed and faces her.
function updateSchools(game, dt) {
  if (game.schools.length === 0) return;
  const p = game.player;
  for (const s of game.schools) {
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const d = Math.hypot(dx, dy);
    s.heading = Math.atan2(dy, dx);
    if (d > 1e-6) {
      const step = Math.min(d, s.speed * dt);
      s.x += (dx / d) * step;
      s.y += (dy / d) * step;
    }
  }
}

// Drops schools with no enemy or warning left, so the list stays short.
function pruneSchools(game) {
  if (game.schools.length === 0) return;
  const live = new Set();
  for (const e of game.enemies) if (e.alive && e.school) live.add(e.school.id);
  for (const wn of game.warnings) if (wn.slot) live.add(wn.slot.school.id);
  game.schools = game.schools.filter((s) => live.has(s.id));
}

// A lone enemy (the last of its wave, with nothing else of that wave pending) turns aggressive after
// AGGRO.loneTime. Mines are exempt: an idle mine arms itself instead (#83).
function updateLoneEnemies(game, dt) {
  const alive = new Map();
  for (const e of game.enemies) if (e.alive) alive.set(e.wave, (alive.get(e.wave) ?? 0) + 1);
  const pending = new Set();
  for (const q of game.spawnQueue) pending.add(q.wave);
  for (const wn of game.warnings) pending.add(wn.wave);
  for (const e of game.enemies) {
    if (!e.alive || e.kind === 'mine' || e.aggro) continue;
    const lone = alive.get(e.wave) === 1 && !pending.has(e.wave);
    e.loneT = lone ? e.loneT + dt : 0;
    if (e.loneT >= AGGRO.loneTime) {
      e.aggro = true;
      const hook = ENEMY_KINDS[e.kind].onAggro;
      if (hook) hook(e, game);
    }
  }
}

// A spawn point (a school's anchor) on the arena edge, at least minDistFromPlayer from Rip
// (12 tries, then the last one).
function spawnPoint(game) {
  const p = game.player;
  const inset = SCHOOL_INSET;
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
