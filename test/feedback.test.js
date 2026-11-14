// Feedback layer: every sim event type has a mapping row, every row runs without throwing against stub
// audio and effects, and the multi-kill, pitch, pan and music rules hold. Also checks that the renderer
// gives an unknown enemy type a visible fallback. Everything here is pure, so it runs under `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGICAL_WIDTH as W, SIM_DT, SIM_HZ } from '../src/config.js';
import { createGame, update, drainEvents, mulberry32 } from '../src/game.js';
import { createFx } from '../src/fx.js';
import { SOUND_NAMES } from '../src/audio.js';
import { drawFrame } from '../src/render.js';
import {
  FEEDBACK,
  GAME_EVENT_TYPES,
  PRESET_BURSTS,
  createFeedback,
  killPitch,
  panFor,
} from '../src/feedback.js';

// Synthetic types the feedback layer derives from state, not sim events.
const DERIVED_TYPES = ['chargeReady', 'spawnWarning', 'multiKill', 'multiKillEnd', 'uiStart', 'uiClick'];

// Recording stubs for the audio and effects modules. Every method the feedback layer calls is here.
function recorder() {
  const calls = {
    sounds: [],
    bursts: 0,
    trails: 0,
    floaters: [],
    shake: 0,
    hitstop: [],
    slowmo: [],
    flashes: [],
    music: [],
    intensity: [],
  };
  const audio = {
    play(name, opts) {
      calls.sounds.push({ name, ...opts });
    },
    startMusic() {
      calls.music.push('start');
    },
    stopMusic() {
      calls.music.push('stop');
    },
    setMusicIntensity(x) {
      calls.intensity.push(x);
    },
  };
  const fx = {
    burst() {
      calls.bursts += 1;
    },
    trail() {
      calls.trails += 1;
    },
    floater(x, y, text) {
      calls.floaters.push(text);
    },
    shake(amount) {
      calls.shake += amount;
    },
    hitstop(ms) {
      calls.hitstop.push(ms);
    },
    slowmo(scale, ms) {
      calls.slowmo.push([scale, ms]);
    },
    flash(color, alpha) {
      calls.flashes.push([color, alpha]);
    },
  };
  return { audio, fx, calls };
}

// Plays a seeded game with seeded random input and yields each step's events. Random dashes and
// pulses reach every sim event type within a few simulated minutes across seeds.
function* simulate(seed, seconds) {
  const game = createGame(seed);
  const rng = mulberry32(seed * 7919 + 1);
  const steps = Math.round(seconds * SIM_HZ);
  for (let i = 0; i < steps && !game.over; i++) {
    const input = {
      moveX: rng() * 2 - 1,
      moveY: rng() * 2 - 1,
      aimX: rng() * W,
      aimY: 360,
      dash: rng() < 0.03,
      pulse: rng() < 0.02,
    };
    update(game, input, SIM_DT);
    yield { events: drainEvents(game), game };
  }
}

// One object carrying every field any row reads, so each row can be exercised directly.
const GENERIC = Object.freeze({
  x: 400,
  y: 300,
  angle: 0.5,
  enemyType: 'drifter',
  kind: 'drifter',
  combo: 12,
  points: 30,
  n: 2,
  bonus: 50,
  tier: 2,
  wave: 3,
  count: 2,
  batched: true,
});

test('every event type the game can emit has a mapping row', () => {
  for (const type of GAME_EVENT_TYPES) {
    assert.equal(typeof FEEDBACK[type], 'object', `no mapping row for "${type}"`);
  }
  for (const type of Object.keys(FEEDBACK)) {
    assert.ok(GAME_EVENT_TYPES.includes(type) || DERIVED_TYPES.includes(type), `unexpected row "${type}"`);
  }
});

test('table contract: sounds are known, presets build, and every row runs without throwing', () => {
  for (const [type, row] of Object.entries(FEEDBACK)) {
    const ev = { ...GENERIC, type };
    for (const field of ['sound', 'preset', 'shake', 'hitstop', 'flash', 'slowmo', 'floater', 'ring']) {
      if (typeof row[field] === 'function') row[field](ev);
    }
    const sound = row.sound?.(ev);
    if (sound) assert.ok(SOUND_NAMES.includes(sound.name), `${type}: unknown sound "${sound.name}"`);
    const preset = row.preset?.(ev);
    if (preset) {
      assert.ok(Object.prototype.hasOwnProperty.call(PRESET_BURSTS, preset.name), `${type}: unknown preset "${preset.name}"`);
      const bursts = PRESET_BURSTS[preset.name](preset);
      assert.ok(Array.isArray(bursts) && bursts.length > 0, `${type}: preset "${preset.name}" has no bursts`);
    }
    if (row.music !== undefined) assert.equal(row.music, 'stop');
  }
});

test('fuzzed simulation: every emitted event maps, nothing throws, and sounds and presets are known', () => {
  const seen = new Set();
  for (let seed = 1; seed <= 8; seed++) {
    const { audio, fx, calls } = recorder();
    const feedback = createFeedback({ audio, fx });
    feedback.startRun();
    for (const { events, game } of simulate(seed, 60)) {
      for (const ev of events) {
        seen.add(ev.type);
        assert.ok(GAME_EVENT_TYPES.includes(ev.type), `sim emitted unexpected type "${ev.type}"`);
      }
      feedback.handleStep(events, game);
      feedback.frame(SIM_DT, game);
    }
    for (const s of calls.sounds) {
      assert.ok(SOUND_NAMES.includes(s.name), `unknown sound "${s.name}"`);
      assert.ok(s.pitch >= 0.25 && s.pitch <= 4, `pitch ${s.pitch} outside audio.play's 0.25..4 clamp`);
      assert.ok(s.pan >= -0.8 - 1e-9 && s.pan <= 0.8 + 1e-9, `pan ${s.pan} outside ±0.8`);
    }
  }
  for (const must of ['dash', 'kill', 'hurt', 'waveStart', 'gameOver']) {
    assert.ok(seen.has(must), `fuzzing never produced a "${must}" event, so the coverage claim is weak`);
  }
});

// What counts as feedback for one event: its sound, or else its first visible effect. Null means silent.
function feedbackOf(row, ev) {
  if (row.sound?.(ev)) return 'sound';
  if (row.preset?.(ev)) return 'preset';
  if ((row.shake?.(ev) ?? 0) > 0) return 'shake';
  if ((row.hitstop?.(ev) ?? 0) > 0) return 'hitstop';
  if (row.flash?.(ev)) return 'flash';
  if (row.slowmo?.(ev)) return 'slowmo';
  if (row.floater?.(ev)) return 'floater';
  if (row.ring?.(ev)) return 'ring';
  return null;
}

test('no event is silent: every type the game emits has a sound or an effect, and so does every synthetic one (#91)', () => {
  const types = [...GAME_EVENT_TYPES, 'chargeReady', 'multiKill', 'multiKillEnd', 'spawnWarning', 'uiStart', 'uiClick'];
  for (const type of types) {
    const ev = { ...GENERIC, type, first: true };
    assert.ok(feedbackOf(FEEDBACK[type], ev), `"${type}" has neither a sound nor an effect`);
  }
});

test('a Shellback deflect is a clang with a jolt, a white flash and an ARMOUR floater (#67)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'deflect', x: 400, y: 300 }], createGame(1));
  assert.ok(calls.sounds.some((s) => s.name === 'reflect'), 'clang');
  assert.ok(calls.shake > 0, 'jolt');
  assert.deepEqual(calls.hitstop, [35]);
  assert.equal(calls.flashes.length, 1, 'white flash');
  assert.deepEqual(calls.floaters, ['ARMOUR']);
});

test('a mine arms with a tone, then detonates with a boom, a burst, a shake and a hit-stop (#66)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  feedback.handleStep([{ type: 'mineArm', x: 400, y: 300 }], game);
  assert.ok(calls.sounds.some((s) => s.name === 'mineArm'), 'arming tone');
  feedback.handleStep([{ type: 'mineExplode', x: 400, y: 300 }], game);
  assert.ok(calls.sounds.some((s) => s.name === 'mineExplode'), 'boom');
  assert.ok(calls.bursts >= 2, 'the mine burst (arming motes, then the blast)');
  assert.ok(calls.shake > 0, 'shake');
  assert.deepEqual(calls.hitstop, [40]);
});

test('stagger ticks, and a wave clear chimes with a gold flash and a WAVE CLEAR floater (#70)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  feedback.handleStep([{ type: 'stagger', x: 400, y: 300 }], game);
  assert.ok(calls.sounds.some((s) => s.name === 'reflect'), 'stagger tick');
  feedback.handleStep([{ type: 'waveClear', wave: 2 }], game);
  assert.ok(calls.sounds.some((s) => s.name === 'comboTierUp'), 'chime');
  assert.equal(calls.flashes.length, 1, 'the wave clear flashes gold (stagger is a tick and sparks, no flash)');
  assert.ok(calls.floaters.includes('WAVE CLEAR'));
});

test('a perfect pulse floater shows the points it awards (#78)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'perfectPulse', x: 400, y: 300, points: 150 }], createGame(1));
  assert.deepEqual(calls.floaters, ['PERFECT PULSE +150']);
});

test('enemy warnings and wind-ups are sounds, panned to the enemy (#68, #69)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  feedback.handleStep([{ type: 'spitWindup', x: W, y: 300 }], game);
  feedback.handleStep([{ type: 'chargerTelegraph', x: W, y: 300 }], game);
  feedback.handleStep([{ type: 'chargerLunge', x: W, y: 300 }], game);
  const names = calls.sounds.map((s) => s.name);
  assert.deepEqual(names, ['chargerTelegraph', 'chargerTelegraph', 'chargerLunge']);
  for (const s of calls.sounds) assert.ok(Math.abs(s.pan - 0.8) < 1e-9, `${s.name} pan ${s.pan}, want the right edge`);
});

test('menus and pause have sounds: start and restart play uiStart, pause and resume play uiClick (#71)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.startRun();
  assert.equal(calls.sounds.at(-1).name, 'uiStart');
  feedback.setPaused(true);
  assert.equal(calls.sounds.at(-1).name, 'uiClick');
  feedback.setPaused(false);
  assert.equal(calls.sounds.at(-1).name, 'uiClick');
});

test('a spawn burst makes one soft cue and no floater, and the next burst makes its own cue (#79)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1, { spawning: false });
  const marker = (x) => ({ kind: 'drifter', x, y: 100, t: 0.9, wave: 1 });
  // A burst: three markers, one per sim step, 25 ms apart.
  for (let i = 0; i < 3; i++) {
    game.time = i * SIM_DT;
    game.warnings.push(marker(200 + 100 * i));
    feedback.handleStep([], game);
  }
  // The next burst, 0.6 s later.
  game.time = 0.6;
  game.warnings.push(marker(600));
  feedback.handleStep([], game);
  const cues = calls.sounds.filter((s) => s.name === 'spawnWarn');
  assert.equal(cues.length, 2, `want one cue per burst, got ${cues.length}`);
  assert.equal(calls.bursts, 2, 'one motes burst per burst');
  assert.deepEqual(calls.floaters, [], 'spawn markers have no floater');
});

test('a dash that kills three enemies peaks at the matrix hit-stop (60 ms) and shake (8 px)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  const kill = (combo, points) => ({ type: 'kill', x: 500, y: 300, enemyType: 'drifter', combo, multi: 0, points });

  game.player.dash.active = { dirX: 1, dirY: 0, t: 0, dur: 0.12, sx: 0, sy: 0, ex: 0, ey: 0, lastX: 0, lastY: 0, kills: 0 };
  feedback.handleStep([{ type: 'dash', x: 300, y: 300, angle: 0 }], game);
  feedback.handleStep([kill(1, 10)], game);
  feedback.handleStep([kill(2, 35)], game);
  game.player.dash.active = null;
  feedback.handleStep([kill(3, 35)], game); // the dash ends on this step, so the batch closes

  const hitstopTotal = calls.hitstop.reduce((a, b) => a + b, 0);
  assert.equal(hitstopTotal, 60, `hit-stop total ${hitstopTotal} ms, want 60`);
  assert.ok(Math.abs(calls.shake - Math.sqrt(8 / 14)) < 1e-9, `shake trauma ${calls.shake}, want sqrt(8/14)`);
  assert.ok(calls.floaters.includes('x3 +50'), `multi-kill floater missing, got ${calls.floaters.join(', ')}`);
  const nova = calls.sounds.filter((s) => s.name === 'multiKill');
  assert.equal(nova.length, 1, 'the multi-kill chord plays once per batch');
});

test('a kill outside a dash shows its score after the REFLECT floater, not on the kill frame', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  feedback.handleStep([{ type: 'reflect', x: 400, y: 300 }], game);
  feedback.handleStep([{ type: 'kill', x: 420, y: 300, enemyType: 'drifter', combo: 1, multi: 1, points: 10 }], game);
  assert.deepEqual(calls.floaters, ['REFLECT'], 'the score waits for its delay');
  for (let i = 0; i < 20; i++) feedback.frame(1 / 60, game); // 0.33 s of real time
  assert.ok(calls.floaters.includes('+10'), `score floater never appeared, got ${calls.floaters.join(', ')}`);
});

test('kill pitch rises with combo, never passes +12 semitones, and the table is monotonic', () => {
  assert.equal(killPitch(0), 1);
  let prev = 0;
  for (let combo = 0; combo <= 200; combo++) {
    const p = killPitch(combo);
    assert.ok(p >= prev, `pitch fell at combo ${combo}`);
    assert.ok(12 * Math.log2(p) <= 12 + 1e-9, `pitch ${p} passes +12 semitones at combo ${combo}`);
    prev = p;
  }
});

test('stereo pan follows x across the arena and stays within ±0.8', () => {
  assert.ok(Math.abs(panFor(0) + 0.8) < 1e-9);
  assert.ok(Math.abs(panFor(W / 2)) < 1e-9);
  assert.ok(Math.abs(panFor(W) - 0.8) < 1e-9);
  assert.equal(panFor(undefined), 0);
  assert.equal(panFor(Number.NaN), 0);
});

test('music starts with the run, stops on game over and pause, and its intensity follows the multiplier', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(2);

  feedback.startRun();
  feedback.setPaused(true);
  feedback.setPaused(false);
  feedback.handleStep([{ type: 'gameOver', score: 5 }], game);
  assert.deepEqual(calls.music, ['start', 'stop', 'start', 'stop']);

  const hot = createGame(3);
  hot.combo.count = 45; // multiplier 10, the cap
  feedback.startRun();
  for (let i = 0; i < 300; i++) feedback.frame(1 / 60, hot);
  const last = calls.intensity[calls.intensity.length - 1];
  assert.ok(last > 0.95, `intensity ${last} did not reach the cap`);
});

test('the real effects layer runs under feedback without throwing and spawns particles', () => {
  const fx = createFx({ random: mulberry32(7) });
  const audio = recorder().audio;
  const feedback = createFeedback({ audio, fx });
  feedback.startRun();
  let peak = 0;
  for (const { events, game } of simulate(4, 30)) {
    feedback.handleStep(events, game);
    feedback.frame(SIM_DT, game);
    fx.update(SIM_DT);
    peak = Math.max(peak, fx.stats().particles);
  }
  assert.ok(peak > 0, 'no particles were ever live');
});

// A context that records every paint call and answers the few reads the renderer makes.
function recordingContext(width, height) {
  const calls = {};
  const target = { canvas: { width, height } };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...args) => {
        (calls[key] ??= []).push(args);
      };
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  });
  return { ctx, calls };
}

test('render: an enemy type art.js does not draw gets a visible "?" fallback, and known types do not', () => {
  const { ctx, calls } = recordingContext(1280, 720);
  const game = createGame(5);
  const base = { px: 300, py: 300, x: 300, y: 300, vx: 0, vy: 0, alive: true, stagger: 0, age: 1, hitWall: false,
    state: 'idle', stateT: 0, cooldown: 0, shotCd: 0, dirX: 0, dirY: 0, strafe: 1 };
  game.enemies.push({ ...base, id: 900, kind: 'drifter', r: 13 });
  game.enemies.push({ ...base, id: 901, kind: 'boss', x: 500, y: 300, px: 500, py: 300, r: 20 });
  const fx = createFx({ random: mulberry32(9) });
  drawFrame(ctx, {
    screen: 'playing', game, alpha: 0, time: 1, dt: 1 / 60, highScore: 0, newBest: false, overAge: 0,
    muted: false, fx, rings: [],
  });
  const questionMarks = (calls.fillText ?? []).filter((args) => args[0] === '?');
  assert.equal(questionMarks.length, 1, 'exactly the unknown type should get the fallback glyph');
});
