// Invariant checks for the headless bot harness. After every simulation step the checker looks at the
// live game and the events that step emitted, and records any rule the sim broke. It never writes to
// the game. A violation is a bug candidate; an observation is a fact worth reporting that is not a bug.
import { ARENA, COMBO, DASH, LOGICAL_HEIGHT, LOGICAL_WIDTH, PICKUP, PLAYER, SIM_DT, SPAWN } from '../../src/config.js';
import { ENEMY_KINDS, comboWindowFor, multiplierFor } from '../../src/game.js';
import { dashMaxCharges } from '../../src/pickups.js';

const W = LOGICAL_WIDTH;
const H = LOGICAL_HEIGHT;
const EPS = 1e-6;
// updateBullet removes any bullet further than this outside the screen.
const BULLET_MARGIN = 40;
// A wave still active after this many seconds is reported as stalled.
export const WAVE_STALL_SECONDS = 120;
// A mine idle for this long is reported as an observation (it may gate its wave indefinitely).
export const MINE_IDLE_SECONDS = 120;

// Fields each event type must carry. Numbers must be finite; zero is a valid value.
export const EVENT_FIELDS = {
  dash: ['x', 'y', 'angle'],
  deflect: ['x', 'y'],
  kill: ['x', 'y', 'enemyType', 'combo', 'multi', 'bonus', 'points', 'hitStopMs', 'cause'],
  pulse: ['x', 'y'],
  reflect: ['x', 'y'],
  perfectPulse: ['x', 'y'],
  stagger: ['x', 'y'],
  mineArm: ['x', 'y'],
  mineExplode: ['x', 'y'],
  hurt: ['hp', 'x', 'y'],
  gameOver: ['score'],
  waveStart: ['wave'],
  waveClear: ['wave'],
  comboTier: ['tier'],
  comboLost: ['count'],
  // Added with dash fairness, pickups and modifiers.
  bulletCut: ['x', 'y'],
  dashWhiff: ['x', 'y'],
  enemyShoot: ['x', 'y'],
  heal: ['x', 'y', 'hp', 'bonus'],
  pickup: ['x', 'y'],
  pickupDrop: ['x', 'y'],
  shieldBreak: ['x', 'y'],
  modifierEnd: [],
};

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const r3 = (v) => Math.round(v * 1000) / 1000;

// Creates a checker bound to a game that is at its initial state.
// violations: code -> { count, first: { time, detail } }   (count is the number of steps that broke it)
// observations: code -> count                              (facts, not bugs)
export function createChecker(game) {
  const violations = new Map();
  const observations = new Map();
  const st = {
    score: game.score,
    combo: game.combo.count,
    hp: game.player.hp,
    wave: game.wave.number,
    waveStartedAt: game.time,
    stallReported: false,
    emptyActive: 0,
    lastHurtAt: -Infinity,
    longMines: new Set(),
  };

  function flag(code, time, detail) {
    const v = violations.get(code);
    if (v) v.count += 1;
    else violations.set(code, { count: 1, first: { time: r3(time), detail } });
  }

  function observe(code) {
    observations.set(code, (observations.get(code) ?? 0) + 1);
  }

  // Call once per step, after update() and after the events were drained.
  function afterStep(events) {
    const t = game.time;
    const p = game.player;
    const w = game.wave;

    // Numbers are finite.
    if (!finite(p.x) || !finite(p.y) || !finite(p.vx) || !finite(p.vy) || !finite(game.score) || !finite(game.combo.timer)) {
      flag('NAN', t, `player (${p.x}, ${p.y}) score ${game.score}`);
    }

    // Rip stays inside the arena (update clamps her every step).
    const loX = ARENA.inset + PLAYER.radius - EPS;
    const hiX = W - ARENA.inset - PLAYER.radius + EPS;
    const loY = ARENA.inset + PLAYER.radius - EPS;
    const hiY = H - ARENA.inset - PLAYER.radius + EPS;
    if (p.x < loX || p.x > hiX || p.y < loY || p.y > hiY) {
      flag('PLAYER_OUT_OF_ARENA', t, `player at ${r3(p.x)}, ${r3(p.y)}`);
    }

    // Timers never go negative. Charger cooldown and spitter shot timers are deliberately excluded:
    // they are only compared with <= 0 and may run below zero without effect.
    if (p.invuln < -EPS || p.pulseCooldown < -EPS || game.slowmo < -EPS || p.dash.recharge < -EPS || game.combo.timer < -EPS) {
      flag('NEGATIVE_TIMER', t, `player/combo timer invuln ${r3(p.invuln)} pulseCd ${r3(p.pulseCooldown)} slowmo ${r3(game.slowmo)} combo ${r3(game.combo.timer)}`);
    }

    // Dash state.
    // The cap is 3, or 4 while Spark Coral is active (dashMaxCharges reads the active modifiers).
    const ch = p.dash.charges;
    const cap = dashMaxCharges(game);
    if (!Number.isInteger(ch) || ch < 0 || ch > cap) flag('DASH_CHARGES_RANGE', t, `charges ${ch} over cap ${cap}`);
    if (p.dash.active && p.bounce) flag('DASH_AND_BOUNCE_OVERLAP', t, 'dash and bounce both active');
    // Each dash carries its own duration: lunge assist and Frenzy make it longer than DASH.duration,
    // so the bound is the dash's own dur, never the constant.
    if (p.dash.active) {
      const d = p.dash.active;
      if (!(d.dur > 0) || d.t < -EPS || d.t > d.dur + EPS) flag('DASH_T_RANGE', t, `dash t ${r3(d.t)} of dur ${r3(d.dur)}`);
    }

    // Combo.
    if (game.combo.count < 0 || (game.combo.count === 0 && game.combo.timer !== 0)) {
      flag('COMBO_TIMER_WITHOUT_COUNT', t, `count ${game.combo.count} timer ${r3(game.combo.timer)}`);
    }

    // Enemies.
    for (const e of game.enemies) {
      if (!e.alive) flag('DEAD_ENTITY_IN_LIST', t, `dead ${e.kind}`);
      if (!finite(e.x) || !finite(e.y) || !finite(e.vx) || !finite(e.vy)) flag('NAN', t, `${e.kind} ${e.x}, ${e.y}`);
      if (e.x < ARENA.inset + e.r - EPS || e.x > W - ARENA.inset - e.r + EPS || e.y < ARENA.inset + e.r - EPS || e.y > H - ARENA.inset - e.r + EPS) {
        flag('ENEMY_OUT_OF_ARENA', t, `${e.kind} at ${r3(e.x)}, ${r3(e.y)} (r ${e.r})`);
      }
      if (e.stagger < -EPS || e.grace < -EPS || e.age < -EPS) {
        flag('NEGATIVE_TIMER', t, `${e.kind} stagger ${r3(e.stagger)} grace ${r3(e.grace)} age ${r3(e.age)}`);
      }
      if (e.kind === 'mine' && e.state === 'idle' && e.age > MINE_IDLE_SECONDS && !st.longMines.has(e.id)) {
        st.longMines.add(e.id);
        observe('MINE_IDLE_OVER_120S');
      }
    }

    // Bullets.
    for (const b of game.bullets) {
      if (!b.alive) flag('DEAD_ENTITY_IN_LIST', t, 'dead bullet');
      if (!finite(b.x) || !finite(b.y) || !finite(b.vx) || !finite(b.vy)) flag('NAN', t, `bullet ${b.x}, ${b.y}`);
      if (!(b.life > 0)) flag('NEGATIVE_TIMER', t, `bullet life ${r3(b.life)}`);
      if (b.x < -BULLET_MARGIN || b.x > W + BULLET_MARGIN || b.y < -BULLET_MARGIN || b.y > H + BULLET_MARGIN) {
        flag('BULLET_OUT_OF_BOUNDS', t, `bullet at ${r3(b.x)}, ${r3(b.y)}`);
      }
    }

    // Spawn warnings and the entity cap.
    for (const wn of game.warnings) {
      if (!(wn.t > 0)) flag('NEGATIVE_TIMER', t, `warning t ${r3(wn.t)}`);
    }
    const count = game.enemies.length + game.warnings.length + game.bullets.length;
    if (count > SPAWN.maxEntities) flag('ENTITY_CAP_EXCEEDED', t, `${count} live entities`);

    // Wave state machine.
    if (w.phase === 'breather') {
      if (!(w.timer > 0)) flag('NEGATIVE_TIMER', t, `breather timer ${r3(w.timer)}`);
    } else if (w.phase === 'active') {
      const pending =
        w.queue.length > 0 ||
        game.warnings.some((wn) => wn.wave === w.number) ||
        game.enemies.some((e) => e.alive && e.wave === w.number);
      // A reflect kill can empty the wave after the spawner has already run this step, so the wave
      // clears on the next step. Only a wave that stays empty-but-active for two steps is a bug.
      st.emptyActive = pending ? 0 : st.emptyActive + 1;
      if (st.emptyActive === 2) flag('WAVE_NOT_CLEARED', t, `wave ${w.number} has nothing pending but is still active`);
      if (!st.stallReported && t - st.waveStartedAt > WAVE_STALL_SECONDS) {
        st.stallReported = true;
        const alive = {};
        for (const e of game.enemies) if (e.alive && e.wave === w.number) alive[e.kind] = (alive[e.kind] ?? 0) + 1;
        flag('WAVE_STALL', t, `wave ${w.number} active ${r3(t - st.waveStartedAt)} s, queue ${w.queue.length}, alive ${JSON.stringify(alive)}`);
      }
    }

    // Events: known type, required fields present.
    let kills = [];
    let hurts = 0;
    let deflects = 0;
    let comboLostEv = null;
    for (const ev of events) {
      const fields = EVENT_FIELDS[ev.type];
      if (!fields) {
        flag('UNKNOWN_EVENT', t, String(ev.type));
        continue;
      }
      for (const f of fields) {
        if (ev[f] === undefined || (typeof ev[f] === 'number' && !finite(ev[f]))) flag('EVENT_MISSING_FIELD', t, `${ev.type}.${f}`);
      }
      switch (ev.type) {
        case 'kill':
          kills.push(ev);
          break;
        case 'comboLost':
          comboLostEv = ev;
          break;
        case 'hurt':
          hurts += 1;
          break;
        case 'deflect':
          deflects += 1;
          break;
        case 'waveStart':
          if (ev.wave !== st.wave + 1) flag('WAVE_NOT_SEQUENTIAL', t, `wave ${st.wave} -> ${ev.wave}`);
          st.wave = ev.wave;
          st.waveStartedAt = t;
          st.stallReported = false;
          break;
        case 'waveClear':
          if (ev.wave !== w.number) flag('WAVE_CLEAR_WRONG_WAVE', t, `cleared ${ev.wave}, current ${w.number}`);
          if (game.enemies.some((e) => e.alive && e.wave === ev.wave)) flag('WAVE_CLEARED_WITH_LIVE_ENEMIES', t, `wave ${ev.wave}`);
          break;
        default:
          break;
      }
    }

    // Combo and score: each kill adds one to the combo and its points; a lost combo resets to zero.
    if (comboLostEv && comboLostEv.count !== st.combo) {
      flag('COMBO_LOST_COUNT_MISMATCH', t, `lost ${comboLostEv.count}, had ${st.combo}`);
    }
    let running = comboLostEv ? 0 : st.combo;
    let killScore = 0;
    for (const k of kills) {
      running += 1;
      const def = ENEMY_KINDS[k.enemyType];
      if (!def) {
        flag('KILL_UNKNOWN_TYPE', t, String(k.enemyType));
        continue;
      }
      const mult = multiplierFor(running);
      const bonus = k.multi > 1 ? COMBO.multiBonus * mult : 0;
      if (k.combo !== running) flag('KILL_COMBO_FIELD', t, `${k.enemyType} says combo ${k.combo}, expected ${running}`);
      if (k.points !== def.points * mult + bonus || k.bonus !== bonus) {
        flag('KILL_POINTS_MISMATCH', t, `${k.enemyType} x${mult} multi ${k.multi}: points ${k.points} bonus ${k.bonus}`);
      }
      killScore += k.points;
    }
    // Score sources: kills, a flat bonus per bullet cut by a dash, and the bonus a heal converts to at full HP.
    let otherScore = 0;
    for (const ev of events) {
      if (ev.type === 'bulletCut') otherScore += DASH.bulletCutScore;
      if (ev.type === 'heal') {
        if (!(ev.bonus >= 0)) flag('HEAL_BONUS_INVALID', t, `bonus ${ev.bonus}`);
        if (ev.bonus > 0 && ev.hp !== PLAYER.maxHp) flag('HEAL_BONUS_BELOW_MAX', t, `bonus ${ev.bonus} at hp ${ev.hp}`);
        otherScore += ev.bonus;
      }
    }
    const expectedScore = st.score + killScore + otherScore;
    if (game.score !== expectedScore) {
      flag(game.score < st.score ? 'SCORE_WENT_BACKWARDS' : 'SCORE_CHANGE_NOT_FROM_KILLS', t, `score ${st.score} -> ${game.score}, expected ${expectedScore}`);
    }
    if (game.combo.count !== running) flag('COMBO_COUNT_MISMATCH', t, `combo ${game.combo.count}, expected ${running}`);
    if (kills.length > 0 && Math.abs(game.combo.timer - comboWindowFor(game.combo.count)) > 1e-9) {
      flag('COMBO_TIMER_NOT_RESET_ON_KILL', t, `timer ${r3(game.combo.timer)} at combo ${game.combo.count}`);
    }

    // Damage: exactly one hit point per hurt event, never inside invulnerability, never while dashing.
    if (hurts > 1) flag('MULTIPLE_HITS_IN_STEP', t, `${hurts} hurt events`);
    // HP: replay this step's hurt and heal events in order. A heal with no bonus restored HP.
    let hpExpect = st.hp;
    for (const ev of events) {
      if (ev.type === 'hurt') hpExpect = Math.max(0, hpExpect - 1);
      if (ev.type === 'heal' && ev.bonus === 0) hpExpect = Math.min(PLAYER.maxHp, hpExpect + PICKUP.heal.restore);
    }
    if (p.hp !== hpExpect) flag('HP_MISMATCH', t, `hp ${st.hp} -> ${p.hp}, expected ${hpExpect} (${hurts} hurt)`);
    if (hurts > 0 && t - st.lastHurtAt < PLAYER.invulnAfterHit - SIM_DT) {
      flag('HIT_INSIDE_INVULN', t, `hit ${r3(t - st.lastHurtAt)} s after the previous one`);
    }
    if (hurts > 0 && p.dash.active) flag('HIT_WHILE_DASHING', t, 'damage landed during a dash');
    if (hurts > 0) st.lastHurtAt = t;
    if (deflects > 0 && !p.bounce) flag('DEFLECT_WITHOUT_BOUNCE', t, 'deflect did not start a bounce');

    st.score = game.score;
    st.combo = game.combo.count;
    st.hp = p.hp;
  }

  return { afterStep, violations, observations };
}
