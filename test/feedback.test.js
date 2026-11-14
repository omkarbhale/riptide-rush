// Feedback layer: every sim event type has a mapping row, every row runs without throwing against stub
// audio and effects, and the multi-kill, pitch, pan, floater and music rules hold. Also checks that the renderer
// gives an unknown enemy type a visible fallback. Everything here is pure, so it runs under `node --test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGICAL_WIDTH as W, SIM_DT, SIM_HZ } from '../src/config.js';
import { createGame, update, drainEvents, mulberry32 } from '../src/game.js';
import { createFx } from '../src/fx.js';
import { SOUND_NAMES } from '../src/audio.js';
import { PALETTE } from '../src/art.js';
import { drawFrame } from '../src/render.js';
import {
  FEEDBACK,
  GAME_EVENT_TYPES,
  KILL_PITCH_CAP,
  PRESET_BURSTS,
  createFeedback,
  killPitch,
  panFor,
} from '../src/feedback.js';

// Synthetic types the feedback layer derives from state, not sim events.
const DERIVED_TYPES = ['chargeReady', 'spawnWarning', 'multiKill', 'multiKillEnd', 'uiStart', 'uiClick'];

// Sound names that two different event types may share on purpose. Empty: every event has its own sound (#128).
const SHARED_ON_PURPOSE = Object.freeze({});

// Recording stubs for the audio and effects modules. Every method the feedback layer calls is here.
function recorder() {
  const calls = {
    sounds: [],
    bursts: 0,
    collapses: 0,
    trails: 0,
    floaters: [],
    floaterAt: [],
    shake: 0,
    hitstop: [],
    slowmo: [],
    flashes: [],
    music: [],
    intensity: [],
    danger: [],
    paused: [],
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
    setMusicDanger(b) {
      calls.danger.push(!!b);
    },
    setMusicPaused(b) {
      calls.paused.push(!!b);
    },
  };
  const fx = {
    burst() {
      calls.bursts += 1;
    },
    collapse() {
      calls.collapses += 1;
    },
    trail() {
      calls.trails += 1;
    },
    floater(x, y, text) {
      calls.floaters.push(text);
      calls.floaterAt.push({ text, x, y });
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
    for (const field of ['sound', 'soundLayer', 'preset', 'shake', 'hitstop', 'flash', 'slowmo', 'floater', 'ring']) {
      if (typeof row[field] === 'function') row[field](ev);
    }
    for (const sound of [row.sound?.(ev), row.soundLayer?.(ev)]) {
      if (sound) assert.ok(SOUND_NAMES.includes(sound.name), `${type}: unknown sound "${sound.name}"`);
    }
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

test('no two different event types map to the same sound name unless listed as intentional (#128)', () => {
  const byName = new Map(); // sound name -> the event types that play it
  for (const kind of ['drifter', 'heal']) {
    for (const [type, row] of Object.entries(FEEDBACK)) {
      const ev = { ...GENERIC, type, kind, first: true };
      for (const field of ['sound', 'soundLayer']) {
        const s = row[field]?.(ev);
        if (!s) continue;
        if (!byName.has(s.name)) byName.set(s.name, new Set());
        byName.get(s.name).add(type);
      }
    }
  }
  for (const [name, types] of byName) {
    if (types.size < 2) continue;
    const allowed = SHARED_ON_PURPOSE[name] ?? [];
    const intentional = allowed.length === types.size && allowed.every((t) => types.has(t));
    assert.ok(intentional, `sound "${name}" is shared by ${[...types].join(', ')} without being listed as intentional`);
  }
});

test('the rows renamed in #121 play the sound pass 2 names', () => {
  const expected = {
    deflect: 'deflect',
    stagger: 'stagger',
    waveClear: 'waveClear',
    pickup: 'pickup',
    heal: 'heal',
    shieldBreak: 'shieldBreak',
    modifierEnd: 'modifierEnd',
    bulletCut: 'bulletCut',
    dashWhiff: 'dashWhiff',
    spitWindup: 'spitterWindup',
    hint: 'hint',
  };
  for (const [type, name] of Object.entries(expected)) {
    const ev = { ...GENERIC, type, kind: 'drifter' };
    assert.equal(FEEDBACK[type].sound(ev).name, name, `${type} should play ${name}`);
  }
});

// What counts as feedback for one event: its sound, or else its first visible effect. Null means silent.
function feedbackOf(row, ev) {
  if (row.sound?.(ev)) return 'sound';
  if (row.soundLayer?.(ev)) return 'sound';
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
  assert.ok(calls.sounds.some((s) => s.name === 'deflect'), 'clang');
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

test('a stagger is a knock and a white ring: not the kill, with no sparks, floater or flash (#17)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'stagger', x: 400, y: 300 }], createGame(1));
  assert.deepEqual(calls.sounds.map((s) => s.name), ['stagger']);
  assert.equal(calls.bursts, 1, 'the ring is the only burst');
  assert.deepEqual(calls.floaters, [], 'no score or label on a stagger');
  assert.equal(calls.flashes.length, 0, 'no flash on a stagger');
});

test('the stagger ring is white: not the danger magenta, not an enemy hue, and it lasts 0.4 s (#17)', () => {
  const [ring] = PRESET_BURSTS.staggerRing();
  assert.equal(ring.shape, 'ring');
  assert.equal(ring.life, 0.4);
  assert.equal(ring.color, '#ffffff');
  assert.notEqual(ring.color, PALETTE.danger);
  for (const hue of ['drifter', 'spitter', 'charger', 'shellback', 'shellbackCore', 'splitter', 'mini', 'mine']) {
    assert.notEqual(ring.color, PALETTE[hue], `stagger ring matches the ${hue} hue`);
  }
});

test('a wave clear chimes with its own stinger, a gold flash and a WAVE CLEAR floater (#70)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'waveClear', wave: 2 }], createGame(1));
  assert.deepEqual(calls.sounds.map((s) => s.name), ['waveClear'], 'the stinger, not the combo chime');
  assert.equal(calls.flashes.length, 1, 'the wave clear flashes gold');
  assert.ok(calls.floaters.includes('WAVE CLEAR'));
});

test('a perfect pulse floater shows the points it awards (#78)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'perfectPulse', x: 400, y: 300, points: 150 }], createGame(1));
  assert.deepEqual(calls.floaters, ['PERFECT PULSE +150']);
});

test('a perfect pulse adds no slow-motion of its own: the sim owns it, so there is one time scale (#104)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'perfectPulse', x: 400, y: 300, points: 150 }], createGame(1));
  assert.deepEqual(calls.slowmo, [], 'no fx.slowmo from the feedback row');
  assert.equal(PRESET_BURSTS.perfectShatter().length > 0, true);
});

test('enemy warnings and wind-ups are sounds, panned to the enemy (#68, #69)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  feedback.handleStep([{ type: 'spitWindup', x: W, y: 300 }], game);
  feedback.handleStep([{ type: 'chargerTelegraph', x: W, y: 300 }], game);
  feedback.handleStep([{ type: 'chargerLunge', x: W, y: 300 }], game);
  const names = calls.sounds.map((s) => s.name);
  assert.deepEqual(names, ['spitterWindup', 'chargerTelegraph', 'chargerLunge']);
  for (const s of calls.sounds) assert.ok(Math.abs(s.pan - 0.8) < 1e-9, `${s.name} pan ${s.pan}, want the right edge`);
});

test('a heal collect is announced once: the pickup row is silent for heal, and the heal row plays heal (#121)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  // The sim emits both events for one heal collect, in the same step.
  feedback.handleStep(
    [
      { type: 'pickup', kind: 'heal', x: 400, y: 300 },
      { type: 'heal', x: 400, y: 300, source: 'drop', hp: 3, bonus: 0 },
    ],
    createGame(1),
  );
  assert.deepEqual(calls.sounds.map((s) => s.name), ['heal']);
});

test('a non-heal pickup chimes with its own pickup sound, and a modifier end has its own sound (#65, #121)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  feedback.handleStep([{ type: 'pickup', kind: 'sparkCoral', x: 400, y: 300 }], createGame(1));
  feedback.handleStep([{ type: 'modifierEnd', kind: 'sparkCoral' }], createGame(1));
  assert.deepEqual(calls.sounds.map((s) => s.name), ['pickup', 'modifierEnd']);
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

test('kill pitch: one semitone per combo step, held at +12 from combo 12, and monotonic (#14)', () => {
  assert.equal(killPitch(0), 1);
  assert.ok(Math.abs(12 * Math.log2(killPitch(1)) - 1) < 1e-9, 'one semitone at combo 1');
  assert.equal(KILL_PITCH_CAP, 2, '+12 semitones is 2x');
  assert.ok(Math.abs(killPitch(12) - KILL_PITCH_CAP) < 1e-12, 'the cap is reached at combo 12, so it engages');
  assert.equal(killPitch(30), KILL_PITCH_CAP);
  assert.equal(killPitch(200), KILL_PITCH_CAP);
  let prev = 0;
  for (let combo = 0; combo <= 200; combo++) {
    const p = killPitch(combo);
    assert.ok(p >= prev, `pitch fell at combo ${combo}`);
    assert.ok(12 * Math.log2(p) <= 12 + 1e-9, `pitch ${p} passes +12 semitones at combo ${combo}`);
    prev = p;
  }
});

test('past the pitch cap a kill layers a second, quieter voice at the cap pitch (#14)', () => {
  const kill = (combo) => ({ type: 'kill', x: 400, y: 300, enemyType: 'drifter', combo, multi: 1, points: 10 });

  const low = recorder();
  createFeedback({ audio: low.audio, fx: low.fx }).handleStep([kill(5)], createGame(1));
  assert.equal(low.calls.sounds.length, 1, 'below the cap: one kill voice');
  assert.ok(Math.abs(low.calls.sounds[0].pitch - 2 ** (5 / 12)) < 1e-9, 'pitch climbs one semitone per step');

  const high = recorder();
  createFeedback({ audio: high.audio, fx: high.fx }).handleStep([kill(12)], createGame(1));
  const voices = high.calls.sounds;
  assert.equal(voices.length, 2, 'at the cap: the kill and its layer');
  assert.ok(voices.every((s) => s.name === 'kill' && Math.abs(s.pitch - KILL_PITCH_CAP) < 1e-12), 'both held at the cap pitch');
  assert.ok(voices[1].volume < voices[0].volume, 'the layer is quieter, so it adds weight rather than a new pitch');
});

test('stereo pan follows x across the arena and stays within ±0.8', () => {
  assert.ok(Math.abs(panFor(0) + 0.8) < 1e-9);
  assert.ok(Math.abs(panFor(W / 2)) < 1e-9);
  assert.ok(Math.abs(panFor(W) - 0.8) < 1e-9);
  assert.equal(panFor(undefined), 0);
  assert.equal(panFor(Number.NaN), 0);
});

test('player-centred floaters start above Rip, and the GAME OVER and WAVE floaters are gone (#77, #98)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(1);
  feedback.handleStep([{ type: 'hurt', x: 400, y: 300 }], game);
  const hurt = calls.floaterAt.find((f) => f.text === '-1 HP');
  assert.ok(hurt, 'the -1 HP floater still shows');
  assert.ok(hurt.y < 300, `-1 HP drawn at y ${hurt.y}, want it above Rip at y 300`);
  feedback.handleStep([{ type: 'waveStart', wave: 3 }], game);
  feedback.handleStep([{ type: 'gameOver', score: 1 }], game);
  assert.ok(!calls.floaters.includes('GAME OVER'), 'the game-over screen already says WRECKED');
  assert.ok(!calls.floaters.some((t) => t.startsWith('WAVE')), 'the HUD owns the WAVE banner');
});

test('the game-over implode is inward: it uses fx.collapse, and no outward shockwave ring (#56)', () => {
  const bursts = PRESET_BURSTS.gameOverImplode();
  assert.ok(bursts.length > 0);
  for (const b of bursts) {
    assert.ok(b.collapse > 0, 'every game-over burst collapses');
    assert.notEqual(b.shape, 'ring', 'no outward ring');
  }
  const { audio, fx, calls } = recorder();
  createFeedback({ audio, fx }).handleStep([{ type: 'gameOver', score: 1 }], createGame(1));
  assert.equal(calls.collapses, bursts.length, 'one collapse call per implode burst');
});

test('music starts with the run, ducks on pause without stopping, and stops on game over (#108)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(2);

  feedback.startRun();
  feedback.setPaused(true);
  feedback.setPaused(false);
  assert.deepEqual(calls.paused, [false, true, false], 'a run starts un-ducked; pause ducks; resume un-ducks');
  assert.deepEqual(calls.music, ['start'], 'pause does not stop the music');
  feedback.handleStep([{ type: 'gameOver', score: 5 }], game);
  assert.deepEqual(calls.music, ['start', 'stop'], 'game over stops it');

  feedback.startRun();
  assert.deepEqual(calls.music, ['start', 'stop', 'start'], 'a new run starts it again');
});

test('music layers: intensity is the combo tier over four, so four layers step at 10, 20, 30 and 40 (Q9, #108)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(3);
  feedback.startRun();
  const levels = [0, 10, 20, 30, 40].map((count) => {
    game.combo.count = count;
    feedback.frame(1 / 60, game);
    return calls.intensity.at(-1);
  });
  assert.deepEqual(levels, [0, 0.25, 0.5, 0.75, 1]);
  // Below a tier boundary the layer does not move.
  game.combo.count = 45;
  feedback.frame(1 / 60, game);
  assert.equal(calls.intensity.at(-1), 1, 'no change within the top tier');
});

test('low health: the music enters its danger variation at one hit point and leaves it on a new run (#108)', () => {
  const { audio, fx, calls } = recorder();
  const feedback = createFeedback({ audio, fx });
  const game = createGame(4);
  feedback.startRun();
  feedback.frame(1 / 60, game); // 3 hp
  game.player.hp = 2;
  feedback.frame(1 / 60, game);
  game.player.hp = 1;
  feedback.frame(1 / 60, game);
  feedback.frame(1 / 60, game); // no change, nothing new sent
  assert.deepEqual(calls.danger, [false, true], 'danger on at one hit point, sent once');
  game.over = true;
  feedback.frame(1 / 60, game);
  assert.deepEqual(calls.danger, [false, true, false], 'danger ends with the run');
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
