// Riptide Rush sound layer: fully synthesized with the Web Audio API (no audio files).
//
// Import-safe under Node: nothing here touches window, document or an AudioContext
// at import time. Every public method is a silent no-op until init() succeeds, and
// in environments without Web Audio.
//
// Signal chain:
//   voice gain (per play) -> [stereo panner] -> sfx bus -> limiter -> master -> destination
//   music layer gains -> music bus ----------^
//
// Every sound is a synth function (ctx, dest, when, params) -> duration in seconds, so the
// same code runs live and under OfflineAudioContext (see renderSound) for analysis.

export const SOUND_NAMES = Object.freeze([
  'dash',
  'dashReady',
  'kill',
  'multiKill',
  'pulse',
  'reflect',
  'perfectPulse',
  'hurt',
  'enemyShoot',
  'chargerTelegraph',
  'chargerLunge',
  'mineArm',
  'mineExplode',
  'comboTierUp',
  'comboLost',
  'waveStart',
  'gameOver',
  'uiClick',
  'uiStart',
  'spawnWarn',
]);

// ---------------------------------------------------------------- tunables
const MASTER_LEVEL = 0.8;
const SFX_LEVEL = 0.9;
const MUSIC_LEVEL = 0.3;
const KILL_DETUNE_CENTS = 14; // tiny per-play detune so repeated kills never sound identical
const DEFAULT_VOICE_LIMIT = 4;
const MAX_TOTAL_VOICES = 40;
const VOICE_LIMIT = {
  dash: 2,
  dashReady: 2,
  kill: 6,
  multiKill: 2,
  pulse: 2,
  reflect: 4,
  perfectPulse: 2,
  hurt: 2,
  enemyShoot: 4,
  chargerTelegraph: 2,
  chargerLunge: 2,
  mineArm: 3,
  mineExplode: 3,
  uiClick: 3,
  spawnWarn: 2,
};

const BPM = 128;
const STEP_S = 60 / BPM / 4; // one sixteenth note
const STEPS_PER_BAR = 16;
const LOOP_STEPS = STEPS_PER_BAR * 4; // four-bar loop
const LOOKAHEAD_S = 0.15;
const TICK_MS = 25;
const LAYER_FADE_S = 0.35;

// A minor loop: Am - F - C - G. root = bass pitch, tones = chord voicing in octave 4.
const CHORDS = [
  { root: 110.0, tones: [220.0, 261.63, 329.63] },
  { root: 87.31, tones: [174.61, 220.0, 261.63] },
  { root: 130.81, tones: [261.63, 329.63, 392.0] },
  { root: 98.0, tones: [196.0, 246.94, 293.66] },
];
const ARP_ORDER = [0, 1, 2, 1];

// Music layers fade in as intensity rises. from/full are intensity thresholds;
// full <= from means always on.
const LAYERS = [
  { id: 'bass', from: 0, full: 0 },
  { id: 'drums', from: 0.2, full: 0.4 },
  { id: 'arp', from: 0.45, full: 0.6 },
  { id: 'pad', from: 0.7, full: 0.85 },
];

// ---------------------------------------------------------------- state
const state = {
  ctx: null,
  sfx: null,
  limiter: null,
  master: null,
  music: null,
  muted: false,
  masterVolume: 1,
  voices: [], // { name, gain, end } in start order, oldest first
};

// ---------------------------------------------------------------- small helpers
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

// Deterministic white noise (LCG) so offline renders are repeatable.
const noiseCache = new WeakMap();
function noiseBuffer(ctx) {
  let buf = noiseCache.get(ctx);
  if (!buf) {
    const len = Math.floor(ctx.sampleRate);
    buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < len; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = seed / 2147483648 - 1;
    }
    noiseCache.set(ctx, buf);
  }
  return buf;
}

// Shared envelope + optional filter: src -> [filter] -> gain env -> dest.
function shape(ctx, src, dest, t, dur, peak, attack, filter) {
  let node = src;
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = filter.type;
    f.frequency.setValueAtTime(filter.freq, t);
    if (filter.sweepTo) f.frequency.exponentialRampToValueAtTime(filter.sweepTo, t + dur);
    f.Q.value = filter.q === undefined ? 0.7 : filter.q;
    node.connect(f);
    node = f;
  }
  const g = ctx.createGain();
  const a = Math.min(attack, dur * 0.5);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  node.connect(g);
  g.connect(dest);
  src.start(t);
  src.stop(t + dur + 0.05);
}

// o: { type, freq, slideTo, t, dur, peak, attack, detune, filter }
function tone(ctx, dest, o) {
  const osc = ctx.createOscillator();
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(o.freq, o.t);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(o.slideTo, o.t + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  shape(ctx, osc, dest, o.t, o.dur, o.peak, o.attack === undefined ? 0.003 : o.attack, o.filter);
}

// o: { t, dur, peak, attack, filter }
function noise(ctx, dest, o) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  shape(ctx, src, dest, o.t, o.dur, o.peak, o.attack === undefined ? 0.002 : o.attack, o.filter);
}

// Soft clipper for grit. A fresh node per voice (a shared node would leak into old voices);
// only the transfer curve is cached.
const curveCache = new WeakMap();
function drive(ctx, amount) {
  let curve = curveCache.get(ctx);
  if (!curve) {
    const n = 1024;
    curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * amount) / Math.tanh(amount);
    }
    curveCache.set(ctx, curve);
  }
  const shaper = ctx.createWaveShaper();
  shaper.curve = curve;
  shaper.oversample = '4x';
  return shaper;
}

// ---------------------------------------------------------------- sound synths
// Each takes (ctx, dest, when, params) and returns its duration in seconds.
// params: { pitch (frequency multiplier), detune (cents) }.
const SYNTHS = {
  dash(ctx, dest, t, p) {
    const k = p.pitch;
    noise(ctx, dest, { t, dur: 0.16, peak: 0.5, attack: 0.012,
      filter: { type: 'bandpass', freq: 420 * k, sweepTo: 3200 * k, q: 1.4 } });
    tone(ctx, dest, { type: 'triangle', freq: 260 * k, slideTo: 980 * k, t, dur: 0.12, peak: 0.26, attack: 0.006 });
    return 0.16;
  },

  dashReady(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 1760 * k, t, dur: 0.05, peak: 0.16, attack: 0.002 });
    tone(ctx, dest, { type: 'sine', freq: 2640 * k, t, dur: 0.03, peak: 0.05, attack: 0.001 });
    return 0.05;
  },

  kill(ctx, dest, t, p) {
    const k = p.pitch;
    const d = p.detune || 0;
    tone(ctx, dest, { type: 'triangle', freq: 880 * k, slideTo: 1320 * k, t, dur: 0.11, peak: 0.45, attack: 0.002, detune: d });
    tone(ctx, dest, { type: 'sine', freq: 1760 * k, t, dur: 0.07, peak: 0.18, attack: 0.001, detune: d });
    noise(ctx, dest, { t, dur: 0.012, peak: 0.16, attack: 0.001, filter: { type: 'highpass', freq: 5000 } });
    return 0.12;
  },

  multiKill(ctx, dest, t, p) {
    const k = p.pitch;
    for (const f of [523.25, 659.25, 783.99]) {
      tone(ctx, dest, { type: 'sawtooth', freq: f * k, t, dur: 0.24, peak: 0.16, attack: 0.004,
        filter: { type: 'lowpass', freq: 3200, q: 0.5 } });
    }
    tone(ctx, dest, { type: 'sine', freq: 2093 * k, t: t + 0.04, dur: 0.2, peak: 0.12, attack: 0.002 });
    noise(ctx, dest, { t, dur: 0.06, peak: 0.2, attack: 0.001, filter: { type: 'highpass', freq: 6000 } });
    return 0.26;
  },

  pulse(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 170 * k, slideTo: 45 * k, t, dur: 0.35, peak: 0.6, attack: 0.005 });
    tone(ctx, dest, { type: 'triangle', freq: 340 * k, slideTo: 120 * k, t, dur: 0.2, peak: 0.14, attack: 0.004 });
    noise(ctx, dest, { t, dur: 0.3, peak: 0.3, attack: 0.003,
      filter: { type: 'lowpass', freq: 1400 * k, sweepTo: 180 * k, q: 0.8 } });
    return 0.35;
  },

  reflect(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 1480 * k, t, dur: 0.28, peak: 0.32, attack: 0.001 });
    tone(ctx, dest, { type: 'sine', freq: 2220 * k, t, dur: 0.18, peak: 0.18, attack: 0.001 });
    tone(ctx, dest, { type: 'sine', freq: 3150 * k, t, dur: 0.1, peak: 0.08, attack: 0.001 });
    noise(ctx, dest, { t, dur: 0.01, peak: 0.16, attack: 0.001, filter: { type: 'bandpass', freq: 3000 * k, q: 1 } });
    return 0.28;
  },

  perfectPulse(ctx, dest, t, p) {
    const k = p.pitch;
    [660, 990, 1320].forEach((f, i) => {
      tone(ctx, dest, { type: 'sine', freq: f * k, t: t + i * 0.045, dur: 0.22, peak: 0.26, attack: 0.002 });
    });
    tone(ctx, dest, { type: 'triangle', freq: 1980 * k, t, dur: 0.3, peak: 0.1, attack: 0.004 });
    noise(ctx, dest, { t, dur: 0.04, peak: 0.12, attack: 0.001, filter: { type: 'highpass', freq: 7000 } });
    return 0.3;
  },

  hurt(ctx, dest, t, p) {
    const k = p.pitch;
    // Low, harsh: a driven sawtooth dropping in pitch, plus a low noise thump.
    const sub = ctx.createOscillator();
    sub.type = 'sawtooth';
    sub.frequency.setValueAtTime(120 * k, t);
    sub.frequency.exponentialRampToValueAtTime(60 * k, t + 0.28);
    const shaper = drive(ctx, 3);
    shaper.connect(dest);
    shape(ctx, sub, shaper, t, 0.28, 0.5, 0.003, { type: 'lowpass', freq: 900, sweepTo: 300, q: 1.2 });
    noise(ctx, dest, { t, dur: 0.12, peak: 0.22, attack: 0.002, filter: { type: 'lowpass', freq: 700 } });
    return 0.28;
  },

  enemyShoot(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'square', freq: 880 * k, slideTo: 280 * k, t, dur: 0.12, peak: 0.14, attack: 0.002,
      filter: { type: 'lowpass', freq: 2600, q: 0.7 } });
    return 0.12;
  },

  chargerTelegraph(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 260 * k, slideTo: 740 * k, t, dur: 0.6, peak: 0.24, attack: 0.05 });
    tone(ctx, dest, { type: 'triangle', freq: 390 * k, slideTo: 1110 * k, t, dur: 0.6, peak: 0.09, attack: 0.05 });
    return 0.6;
  },

  chargerLunge(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sawtooth', freq: 520 * k, slideTo: 55 * k, t, dur: 0.26, peak: 0.4, attack: 0.003,
      filter: { type: 'lowpass', freq: 2400, sweepTo: 300, q: 1.0 } });
    noise(ctx, dest, { t, dur: 0.2, peak: 0.3, attack: 0.003,
      filter: { type: 'bandpass', freq: 1200 * k, sweepTo: 300 * k, q: 1.0 } });
    return 0.26;
  },

  mineArm(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 1046.5 * k, t, dur: 0.05, peak: 0.28, attack: 0.002 });
    tone(ctx, dest, { type: 'sine', freq: 1046.5 * k, t: t + 0.09, dur: 0.05, peak: 0.28, attack: 0.002 });
    return 0.15;
  },

  mineExplode(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 140 * k, slideTo: 28 * k, t, dur: 0.6, peak: 0.55, attack: 0.002 });
    tone(ctx, dest, { type: 'sawtooth', freq: 70 * k, slideTo: 35 * k, t, dur: 0.35, peak: 0.12, attack: 0.002,
      filter: { type: 'lowpass', freq: 400, q: 0.7 } });
    noise(ctx, dest, { t, dur: 0.55, peak: 0.36, attack: 0.002,
      filter: { type: 'lowpass', freq: 2200 * k, sweepTo: 120 * k, q: 0.7 } });
    return 0.6;
  },

  comboTierUp(ctx, dest, t, p) {
    const k = p.pitch;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      tone(ctx, dest, { type: 'triangle', freq: f * k, t: t + i * 0.06, dur: 0.18, peak: 0.26, attack: 0.003 });
    });
    tone(ctx, dest, { type: 'sine', freq: 2093 * k, t: t + 0.18, dur: 0.24, peak: 0.1, attack: 0.003 });
    return 0.42;
  },

  comboLost(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'triangle', freq: 660 * k, slideTo: 160 * k, t, dur: 0.45, peak: 0.36, attack: 0.01,
      filter: { type: 'lowpass', freq: 1800, q: 0.7 } });
    tone(ctx, dest, { type: 'sine', freq: 330 * k, slideTo: 80 * k, t, dur: 0.45, peak: 0.18, attack: 0.01 });
    return 0.45;
  },

  waveStart(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 180 * k, slideTo: 880 * k, t, dur: 0.32, peak: 0.28, attack: 0.03 });
    [440, 523.25, 659.25].forEach((f) => {
      tone(ctx, dest, { type: 'triangle', freq: f * k, t: t + 0.32, dur: 0.45, peak: 0.16, attack: 0.005 });
    });
    return 0.77;
  },

  gameOver(ctx, dest, t, p) {
    const k = p.pitch;
    [440, 349.23, 293.66, 220].forEach((f, i) => {
      tone(ctx, dest, { type: 'triangle', freq: f * k, t: t + i * 0.25, dur: 0.6, peak: 0.3, attack: 0.01,
        filter: { type: 'lowpass', freq: 1600, q: 0.6 } });
    });
    tone(ctx, dest, { type: 'sine', freq: 110 * k, slideTo: 55 * k, t, dur: 1.4, peak: 0.22, attack: 0.05 });
    return 1.4;
  },

  uiClick(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 1400 * k, t, dur: 0.025, peak: 0.2, attack: 0.001 });
    noise(ctx, dest, { t, dur: 0.008, peak: 0.1, attack: 0.001, filter: { type: 'highpass', freq: 6000 } });
    return 0.03;
  },

  uiStart(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'triangle', freq: 659.25 * k, t, dur: 0.12, peak: 0.26, attack: 0.003 });
    tone(ctx, dest, { type: 'triangle', freq: 987.77 * k, t: t + 0.07, dur: 0.2, peak: 0.28, attack: 0.003 });
    return 0.27;
  },

  spawnWarn(ctx, dest, t, p) {
    const k = p.pitch;
    for (const dt of [0, 0.12]) {
      tone(ctx, dest, { type: 'sine', freq: 880 * k, t: t + dt, dur: 0.08, peak: 0.26, attack: 0.003 });
      tone(ctx, dest, { type: 'triangle', freq: 1760 * k, t: t + dt, dur: 0.08, peak: 0.05, attack: 0.003 });
    }
    return 0.2;
  },
};

// ---------------------------------------------------------------- output chain
function buildOutputChain(ctx) {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -4;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  const master = ctx.createGain();
  master.gain.value = MASTER_LEVEL;
  limiter.connect(master);
  master.connect(ctx.destination);
  const sfx = ctx.createGain();
  sfx.gain.value = SFX_LEVEL;
  sfx.connect(limiter);
  return { sfx, limiter, master };
}

// Per-sound input: volume gain -> optional stereo panner -> sfx bus.
function routeVoice(ctx, sfxBus, volume, pan) {
  const gain = ctx.createGain();
  gain.gain.value = volume;
  if (pan !== 0 && ctx.createStereoPanner) {
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    gain.connect(panner);
    panner.connect(sfxBus);
  } else {
    gain.connect(sfxBus);
  }
  return gain;
}

function pruneVoices(now) {
  state.voices = state.voices.filter((v) => v.end > now);
}

function stealVoice(voice, now) {
  try {
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setTargetAtTime(0, now, 0.004);
  } catch (_) {
    /* ignore */
  }
}

// ---------------------------------------------------------------- music
function layerLevel(def, x) {
  if (def.full <= def.from) return 1;
  if (x <= def.from) return 0;
  if (x >= def.full) return 1;
  const u = (x - def.from) / (def.full - def.from);
  return u * u * (3 - 2 * u); // smoothstep
}

function createMusic(ctx, limiter) {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(limiter);
  const layers = LAYERS.map((def) => {
    const gain = ctx.createGain();
    gain.gain.value = layerLevel(def, 0);
    gain.connect(bus);
    return { def, gain };
  });
  const out = {};
  for (const l of layers) out[l.def.id] = l.gain;
  return { ctx, bus, layers, out, intensity: 0, running: false, timer: null, nextTime: 0, step: 0 };
}

function bassNote(ctx, dest, t, freq) {
  tone(ctx, dest, { type: 'sawtooth', freq, t, dur: STEP_S * 1.7, peak: 0.2, attack: 0.006,
    filter: { type: 'lowpass', freq: 700, sweepTo: 220, q: 3 } });
}

function kickDrum(ctx, dest, t) {
  tone(ctx, dest, { type: 'sine', freq: 150, slideTo: 40, t, dur: 0.22, peak: 0.8, attack: 0.002 });
}

function snareDrum(ctx, dest, t) {
  noise(ctx, dest, { t, dur: 0.14, peak: 0.36, attack: 0.002, filter: { type: 'bandpass', freq: 1900, q: 1.1 } });
  tone(ctx, dest, { type: 'triangle', freq: 200, slideTo: 140, t, dur: 0.09, peak: 0.16, attack: 0.002 });
}

function hatTick(ctx, dest, t) {
  noise(ctx, dest, { t, dur: 0.03, peak: 0.09, attack: 0.001, filter: { type: 'highpass', freq: 7500, q: 0.7 } });
}

function arpNote(ctx, dest, t, freq) {
  tone(ctx, dest, { type: 'triangle', freq, t, dur: STEP_S * 0.9, peak: 0.09, attack: 0.002 });
}

function padNote(ctx, dest, t, freq, dur) {
  tone(ctx, dest, { type: 'sawtooth', freq, t, dur, peak: 0.045, attack: 0.3, detune: -6,
    filter: { type: 'lowpass', freq: 1100, q: 0.7 } });
  tone(ctx, dest, { type: 'sawtooth', freq, t, dur, peak: 0.045, attack: 0.3, detune: 6,
    filter: { type: 'lowpass', freq: 1100, q: 0.7 } });
}

function scheduleStep(m, step, t) {
  const ctx = m.ctx;
  const bar = Math.floor(step / STEPS_PER_BAR);
  const s = step % STEPS_PER_BAR;
  const chord = CHORDS[bar];
  const out = m.out;
  if (s % 2 === 0) bassNote(ctx, out.bass, t, chord.root * (s === 6 || s === 14 ? 2 : 1));
  if (s % 4 === 0) kickDrum(ctx, out.drums, t);
  if (s === 4 || s === 12) snareDrum(ctx, out.drums, t);
  if (s % 4 === 2) hatTick(ctx, out.drums, t);
  arpNote(ctx, out.arp, t, chord.tones[ARP_ORDER[s % 4]] * 2);
  if (s === 0) {
    for (const f of chord.tones) padNote(ctx, out.pad, t, f, STEP_S * STEPS_PER_BAR);
  }
}

// Lookahead scheduler: a short timer only wakes it; note times come from the AudioContext clock.
function scheduleMusic(m) {
  if (!m.running) return;
  const now = m.ctx.currentTime;
  if (m.nextTime < now) m.nextTime = now + 0.02;
  while (m.nextTime < now + LOOKAHEAD_S) {
    scheduleStep(m, m.step, m.nextTime);
    m.nextTime += STEP_S;
    m.step = (m.step + 1) % LOOP_STEPS;
  }
}

// ---------------------------------------------------------------- public API
function applyMaster() {
  const target = state.muted ? 0 : MASTER_LEVEL * state.masterVolume;
  const now = state.ctx.currentTime;
  state.master.gain.cancelScheduledValues(now);
  state.master.gain.setTargetAtTime(target, now, 0.02);
}

export const audio = {
  // Call from a user gesture. Returns true when Web Audio is live.
  init() {
    if (state.ctx) return true;
    try {
      const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (typeof Ctor !== 'function') return false;
      const ctx = new Ctor({ latencyHint: 'interactive' });
      const chain = buildOutputChain(ctx);
      const music = createMusic(ctx, chain.limiter);
      state.ctx = ctx;
      state.sfx = chain.sfx;
      state.limiter = chain.limiter;
      state.master = chain.master;
      state.music = music;
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume().catch(() => {});
      }
      return true;
    } catch (_) {
      return false;
    }
  },

  play(name, opts = {}) {
    try {
      const ctx = state.ctx;
      if (!ctx || state.muted || !Object.prototype.hasOwnProperty.call(SYNTHS, name)) return;
      const now = ctx.currentTime;
      const pitch = clamp(num(opts.pitch, 1), 0.25, 4);
      const volume = clamp(num(opts.volume, 1), 0, 2);
      const pan = clamp(num(opts.pan, 0), -1, 1);
      const detune = name === 'kill' ? (Math.random() * 2 - 1) * KILL_DETUNE_CENTS : 0;

      // Voice limiting: steal the oldest voice of this sound, then the oldest overall.
      pruneVoices(now);
      const limit = VOICE_LIMIT[name] === undefined ? DEFAULT_VOICE_LIMIT : VOICE_LIMIT[name];
      let same = state.voices.filter((v) => v.name === name);
      while (same.length >= limit) {
        const old = same.shift();
        stealVoice(old, now);
        state.voices.splice(state.voices.indexOf(old), 1);
      }
      while (state.voices.length >= MAX_TOTAL_VOICES) {
        stealVoice(state.voices.shift(), now);
      }

      const when = now + 0.005;
      const input = routeVoice(ctx, state.sfx, volume, pan);
      const dur = SYNTHS[name](ctx, input, when, { pitch, detune });
      state.voices.push({ name, gain: input, end: when + dur });
    } catch (_) {
      // Audio must never take the game down.
    }
  },

  setMasterVolume(v) {
    if (!state.ctx) return;
    state.masterVolume = clamp(num(v, 1), 0, 1);
    applyMaster();
  },

  setMuted(b) {
    if (!state.ctx) return;
    state.muted = !!b;
    applyMaster();
  },

  startMusic() {
    const m = state.music;
    if (!state.ctx || !m || m.running) return;
    const now = m.ctx.currentTime;
    m.running = true;
    m.step = 0;
    m.nextTime = now + 0.08;
    m.bus.gain.cancelScheduledValues(now);
    m.bus.gain.setTargetAtTime(MUSIC_LEVEL, now, 0.15);
    m.timer = setInterval(() => scheduleMusic(m), TICK_MS);
    scheduleMusic(m);
  },

  setMusicIntensity(x) {
    const m = state.music;
    if (!state.ctx || !m) return;
    m.intensity = clamp(num(x, 0), 0, 1);
    const now = m.ctx.currentTime;
    for (const l of m.layers) {
      l.gain.gain.cancelScheduledValues(now);
      l.gain.gain.setTargetAtTime(layerLevel(l.def, m.intensity), now, LAYER_FADE_S);
    }
  },

  stopMusic() {
    const m = state.music;
    if (!state.ctx || !m || !m.running) return;
    m.running = false;
    clearInterval(m.timer);
    m.timer = null;
    const now = m.ctx.currentTime;
    m.bus.gain.cancelScheduledValues(now);
    m.bus.gain.setTargetAtTime(0, now, 0.12);
  },
};

// Tooling hook for the soundboard analyser: the live output node, or null before init().
export function getOutputNode() {
  if (!state.ctx) return null;
  return { context: state.ctx, node: state.master };
}

// Tooling hook: renders one sound offline through the same chain and returns an AudioBuffer,
// or null without Web Audio. Used by tools/soundboard.html to analyse every sound.
export async function renderSound(name, opts = {}) {
  const Off = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (typeof Off !== 'function' || !Object.prototype.hasOwnProperty.call(SYNTHS, name)) return null;
  const sampleRate = 48000;
  const seconds = num(opts.seconds, 2);
  const ctx = new Off(1, Math.ceil(sampleRate * seconds), sampleRate);
  const chain = buildOutputChain(ctx);
  const pitch = clamp(num(opts.pitch, 1), 0.25, 4);
  const volume = clamp(num(opts.volume, 1), 0, 2);
  const pan = clamp(num(opts.pan, 0), -1, 1);
  const input = routeVoice(ctx, chain.sfx, volume, pan);
  SYNTHS[name](ctx, input, 0, { pitch, detune: 0 });
  return ctx.startRendering();
}
