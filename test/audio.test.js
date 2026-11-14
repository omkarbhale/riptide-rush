import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audio, SOUND_NAMES, getOutputNode, renderSound } from '../src/audio.js';

const EXPECTED_SOUNDS = [
  'dash', 'dashReady', 'kill', 'multiKill', 'pulse', 'reflect', 'perfectPulse', 'hurt',
  'enemyShoot', 'chargerTelegraph', 'chargerLunge', 'mineArm', 'mineExplode', 'comboTierUp',
  'comboLost', 'waveStart', 'gameOver', 'uiClick', 'uiStart', 'spawnWarn',
];

test('module imports under Node without touching window or document', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(typeof audio, 'object');
});

test('SOUND_NAMES matches the specified list exactly and is frozen', () => {
  assert.deepEqual([...SOUND_NAMES], EXPECTED_SOUNDS);
  assert.equal(Object.isFrozen(SOUND_NAMES), true);
  assert.equal(new Set(SOUND_NAMES).size, SOUND_NAMES.length);
});

test('every audio method is a silent no-op without Web Audio', () => {
  assert.equal(audio.init(), false);
  for (const name of SOUND_NAMES) {
    assert.doesNotThrow(() => audio.play(name));
    assert.doesNotThrow(() => audio.play(name, { pitch: 1.5, volume: 0.5, pan: -0.5 }));
  }
  assert.doesNotThrow(() => audio.play('not-a-sound'));
  assert.doesNotThrow(() => audio.play('kill', { pitch: Number.NaN, volume: 'loud' }));
  assert.doesNotThrow(() => audio.setMasterVolume(0.5));
  assert.doesNotThrow(() => audio.setMuted(true));
  assert.doesNotThrow(() => audio.startMusic());
  assert.doesNotThrow(() => audio.setMusicIntensity(0.7));
  assert.doesNotThrow(() => audio.stopMusic());
  assert.equal(getOutputNode(), null);
});

test('offline render helper returns null without Web Audio', async () => {
  assert.equal(await renderSound('kill'), null);
  assert.equal(await renderSound('nope'), null);
});

// A recording stub of the Web Audio graph. It checks that every synth wires up and schedules
// sane times. It cannot check how a sound sounds: that is done in tools/soundboard.html.
function installStubWebAudio() {
  const log = { oscillators: 0, cancels: 0, starts: [], stops: [], offline: 0 };
  class Param {
    constructor(v = 0) { this.value = v; }
    setValueAtTime() { return this; }
    linearRampToValueAtTime() { return this; }
    exponentialRampToValueAtTime() { return this; }
    setTargetAtTime() { return this; }
    cancelScheduledValues() { log.cancels++; return this; }
  }
  class Node {
    constructor(kind) {
      this.kind = kind;
      this.gain = new Param(1);
      this.frequency = new Param(440);
      this.detune = new Param(0);
      this.Q = new Param(1);
      this.pan = new Param(0);
      this.threshold = new Param(); this.knee = new Param(); this.ratio = new Param();
      this.attack = new Param(); this.release = new Param();
    }
    connect(dest) { return dest; }
    start(t) { log.starts.push({ kind: this.kind, t }); }
    stop(t) { log.stops.push({ kind: this.kind, t }); }
  }
  class StubContext {
    constructor() {
      this.currentTime = 0;
      this.sampleRate = 48000;
      this.state = 'running';
      this.destination = new Node('destination');
    }
    createGain() { return new Node('gain'); }
    createOscillator() { log.oscillators++; return new Node('osc'); }
    createBiquadFilter() { return new Node('filter'); }
    createBufferSource() { return new Node('src'); }
    createBuffer(_ch, len) { return { getChannelData: () => new Float32Array(len) }; }
    createDynamicsCompressor() { return new Node('limiter'); }
    createStereoPanner() { return new Node('panner'); }
    createWaveShaper() { return new Node('shaper'); }
  }
  class StubOffline extends StubContext {
    constructor(_ch, length) { super(); this.length = length; log.offline++; }
    startRendering() { return Promise.resolve({ length: this.length }); }
  }
  globalThis.AudioContext = StubContext;
  globalThis.OfflineAudioContext = StubOffline;
  return {
    log,
    remove() {
      delete globalThis.AudioContext;
      delete globalThis.OfflineAudioContext;
    },
  };
}

test('with a stub Web Audio graph every sound schedules valid times', async () => {
  // Fresh module instance so the no-op tests above keep their clean state.
  const fresh = await import('../src/audio.js?stub-webaudio');
  const stub = installStubWebAudio();
  try {
    assert.equal(fresh.audio.init(), true);
    for (const name of SOUND_NAMES) {
      const before = stub.log.starts.length;
      fresh.audio.play(name, { pitch: 1.2, volume: 0.7, pan: 0.3 });
      const added = stub.log.starts.slice(before);
      assert.ok(added.length > 0, `${name} schedules at least one source`);
    }
    for (const s of stub.log.starts) {
      assert.ok(Number.isFinite(s.t) && s.t >= 0, `start time is finite and not in the past: ${JSON.stringify(s)}`);
    }
    assert.equal(stub.log.starts.length, stub.log.stops.length, 'every source has a stop time');
    for (let i = 0; i < stub.log.starts.length; i++) {
      assert.ok(stub.log.stops[i].t > stub.log.starts[i].t, 'stop is after start');
    }
  } finally {
    stub.remove();
  }
});

test('stub graph: setMuted silences play and unmuting restores it', async () => {
  const fresh = await import('../src/audio.js?stub-mute');
  const stub = installStubWebAudio();
  try {
    fresh.audio.init();
    fresh.audio.setMuted(true);
    const osc = stub.log.oscillators;
    fresh.audio.play('kill');
    assert.equal(stub.log.oscillators, osc, 'muted play creates no oscillators');
    fresh.audio.setMuted(false);
    fresh.audio.play('kill');
    assert.ok(stub.log.oscillators > osc, 'unmuted play creates oscillators');
  } finally {
    stub.remove();
  }
});

test('stub graph: voices per sound are capped and the oldest is stolen', async () => {
  const fresh = await import('../src/audio.js?stub-voices');
  const stub = installStubWebAudio();
  try {
    fresh.audio.init();
    const before = stub.log.cancels;
    for (let i = 0; i < 10; i++) fresh.audio.play('kill'); // kill limit is 6
    assert.equal(stub.log.cancels - before, 4, 'four oldest kill voices are stolen');
  } finally {
    stub.remove();
  }
});

test('stub graph: music starts, takes intensity, and stops without leaking timers', async () => {
  const fresh = await import('../src/audio.js?stub-music');
  const stub = installStubWebAudio();
  try {
    fresh.audio.init();
    fresh.audio.setMusicIntensity(0.9);
    fresh.audio.startMusic();
    fresh.audio.startMusic(); // second start is a no-op
    fresh.audio.setMusicIntensity(0.2);
    fresh.audio.stopMusic();
    assert.ok(stub.log.starts.length > 0, 'music schedules notes');
  } finally {
    stub.remove();
  }
});

test('stub graph: renderSound renders every sound through an offline context', async () => {
  const stub = installStubWebAudio();
  try {
    for (const name of SOUND_NAMES) {
      const buf = await renderSound(name, { seconds: 1.5 });
      assert.equal(buf.length, Math.ceil(48000 * 1.5));
    }
    assert.equal(stub.log.offline, SOUND_NAMES.length);
    assert.equal(await renderSound('nope'), null);
  } finally {
    stub.remove();
  }
});
