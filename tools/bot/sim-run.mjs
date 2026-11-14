// Runs one seeded game of the pure simulation under a policy and returns its metrics.
// Presses are buffered like the browser input layer does (INPUT_BUFFER seconds), an accepted dash or
// pulse is the sim's own 'dash' / 'pulse' event, and every lost hit point is attributed to a cause.
import { ENEMY, INPUT_BUFFER, PLAYER, SIM_DT } from '../../src/config.js';
import { createGame, drainEvents, ENEMY_KINDS, mulberry32, segmentHitsCircle, update } from '../../src/game.js';
import { createChecker } from './invariants.mjs';

// Time since the last dash ended, in buckets. Undefined before the first dash.
export function bucketFor(since) {
  if (since === null) return 'no dash yet';
  if (since < 0.2) return '0-0.2s';
  if (since < 0.5) return '0.2-0.5s';
  return 'later';
}

// Who landed the hit that happened during this step. Order matches update(): mine blasts resolve in
// the enemy phase, bullets next, contact last. Only one hit can land per step (invulnerability).
export function attributeHit(game, enemies, bullets, events) {
  const p = game.player;
  for (const ev of events) {
    if (ev.type === 'mineExplode' && Math.hypot(p.x - ev.x, p.y - ev.y) <= ENEMY.mine.blastRadius + PLAYER.radius) {
      return 'mine';
    }
  }
  for (const b of bullets) {
    if (b.owner !== 'enemy' || !(b.life > 0)) continue;
    if (segmentHitsCircle(b.px, b.py, b.x, b.y, p.x, p.y, PLAYER.radius + b.r)) return 'spitter';
  }
  let best = null;
  let bestD = Infinity;
  for (const e of enemies) {
    const def = ENEMY_KINDS[e.kind];
    if (def.contact === false || e.grace > 0) continue;
    if (!e.alive && !def.dieOnContact) continue; // died to a dash or blast earlier this step
    const d = Math.hypot(e.x - p.x, e.y - p.y);
    if (d < e.r + PLAYER.radius && d < bestD) {
      bestD = d;
      best = e;
    }
  }
  return best ? best.kind : 'unknown';
}

// Plays one game. Options: capSeconds (sim time at which a surviving run stops).
export function runOne(seed, policy, { capSeconds = 300 } = {}) {
  const game = createGame(seed);
  drainEvents(game); // the start-of-game events are recorded below, not counted as steps
  const botRng = mulberry32((seed * 7919 + policy.salt) >>> 0);
  const mem = policy.createMemory();
  const checker = createChecker(game);

  const m = {
    seed,
    policy: policy.name,
    time: 0,
    died: false,
    survivedToCap: false,
    wave: 1,
    score: 0,
    peakCombo: 0,
    steps: 0,
    stepsNoEnemyNear: 0,
    stepsIdleFull: 0,
    bucketSeconds: { 'no dash yet': 0, '0-0.2s': 0, '0.2-0.5s': 0, later: 0 },
    dashes: 0,
    dashesWithKill: 0,
    pulses: 0,
    perfectPulses: 0,
    deflects: 0,
    kills: 0,
    killsByCause: {},
    killsByType: {},
    killsByTypeCause: {},
    hits: [],
    waves: { 1: { startAt: 0, clearAt: null, hpLost: 0 } },
    // Heals (#105): every real heal (not a bonus at full HP), with its source and the seconds spent below full
    // health before it. belowSince is when the current below-full stretch began, null at full health.
    heals: [],
    belowSeconds: 0,
    aliveSum: 0,      // enemies alive, summed over steps of tension waves (wave 3 on, not a release wave)
    aliveSteps: 0,
  };
  let belowSince = null;

  let dashBuf = 0;
  let pulseBuf = 0;
  // A buffered dash keeps the aim it was pressed with (as the browser's input layer does), not the aim of
  // whichever later step the buffer is finally consumed in.
  let dashAim = { x: null, y: null };
  let lastDashEnd = null;
  let lastDeflectAt = null;
  let curDashHadKill = null; // null until the first dash; then a flag object for the current dash

  while (!game.over && game.time < capSeconds) {
    const intent = policy.decide(game, botRng, mem);
    if (intent.dash) {
      dashBuf = INPUT_BUFFER;
      dashAim = { x: intent.aimX, y: intent.aimY };
    }
    if (intent.pulse) pulseBuf = INPUT_BUFFER;
    const input = {
      moveX: intent.moveX,
      moveY: intent.moveY,
      aimX: dashBuf > 0 ? dashAim.x : intent.aimX,
      aimY: dashBuf > 0 ? dashAim.y : intent.aimY,
      dash: dashBuf > 0,
      pulse: pulseBuf > 0,
    };

    const wasDashing = game.player.dash.active !== null;
    const enemiesBefore = game.enemies; // update() appends spawns here and filters into a new array
    const bulletsBefore = game.bullets;
    update(game, input, SIM_DT);
    m.steps += 1;
    dashBuf = Math.max(0, dashBuf - SIM_DT);
    pulseBuf = Math.max(0, pulseBuf - SIM_DT);

    const events = drainEvents(game);
    checker.afterStep(events);
    if (game.player.hp < PLAYER.maxHp) m.belowSeconds += SIM_DT;
    if (game.wave.number >= 3 && !game.wave.release && game.wave.phase === 'active') {
      let alive = 0;
      for (const e of game.enemies) if (e.alive) alive += 1;
      m.aliveSum += alive;
      m.aliveSteps += 1;
    }
    if (wasDashing && game.player.dash.active === null) lastDashEnd = game.time;
    // Seconds spent in each time-since-dash bucket, so hit counts can be read as rates.
    m.bucketSeconds[bucketFor(lastDashEnd === null ? null : game.time - lastDashEnd)] += SIM_DT;

    // Enemy supply: steps with no enemy of any kind within 250 px of Rip (policy-independent).
    {
      const p = game.player;
      let near = false;
      for (const e of game.enemies) {
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        if (e.alive && dx * dx + dy * dy <= 250 * 250) {
          near = true;
          break;
        }
      }
      if (!near) {
        m.stepsNoEnemyNear += 1;
        if (p.dash.charges >= 3) m.stepsIdleFull += 1;
      }
    }

    for (const ev of events) {
      switch (ev.type) {
        case 'dash':
          m.dashes += 1;
          dashBuf = 0;
          curDashHadKill = { hit: false };
          break;
        case 'pulse':
          m.pulses += 1;
          pulseBuf = 0;
          break;
        case 'perfectPulse':
          m.perfectPulses += 1;
          break;
        case 'deflect':
          m.deflects += 1;
          lastDeflectAt = game.time;
          break;
        case 'kill':
          m.kills += 1;
          m.peakCombo = Math.max(m.peakCombo, ev.combo);
          m.killsByCause[ev.cause] = (m.killsByCause[ev.cause] ?? 0) + 1;
          m.killsByType[ev.enemyType] = (m.killsByType[ev.enemyType] ?? 0) + 1;
          {
            const key = `${ev.enemyType}:${ev.cause}`;
            m.killsByTypeCause[key] = (m.killsByTypeCause[key] ?? 0) + 1;
          }
          if (ev.cause === 'dash' && curDashHadKill && !curDashHadKill.hit) {
            curDashHadKill.hit = true;
            m.dashesWithKill += 1;
          }
          break;
        case 'waveStart':
          m.waves[ev.wave] = { startAt: game.time, clearAt: null, hpLost: 0 };
          break;
        case 'waveClear':
          if (m.waves[ev.wave]) m.waves[ev.wave].clearAt = game.time;
          break;
        case 'hurt': {
          const type = attributeHit(game, enemiesBefore, bulletsBefore, events);
          const since = lastDashEnd === null ? null : game.time - lastDashEnd;
          const bucket = bucketFor(since);
          // sameStep: the hit landed in the very step the dash ended (i-frames stop as the dash stops).
          const afterDeflect = lastDeflectAt !== null && game.time - lastDeflectAt <= 0.5;
          m.hits.push({ t: game.time, type, bucket, wave: game.wave.number, sameStep: since === 0, afterDeflect });
          if (m.waves[game.wave.number]) m.waves[game.wave.number].hpLost += 1;
          if (belowSince === null) belowSince = game.time;
          break;
        }
        case 'heal':
          if (ev.bonus === 0) {
            m.heals.push({ t: game.time, source: ev.source, wait: game.time - (belowSince ?? game.time) });
            belowSince = ev.hp < PLAYER.maxHp ? game.time : null;
          }
          break;
        default:
          break;
      }
    }
  }

  m.time = game.time;
  m.died = game.over;
  m.survivedToCap = !game.over;
  m.wave = game.wave.number;
  m.score = game.score;
  m.violations = Object.fromEntries(checker.violations);
  m.observations = Object.fromEntries(checker.observations);
  return m;
}
