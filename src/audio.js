// Riptide Rush sound layer: fully synthesized with the Web Audio API (no audio files).
//
// Import-safe under Node: nothing here touches window, document or an AudioContext
// at import time. Every public method is a silent no-op until init() succeeds, and
// in environments without Web Audio.
//
// Signal chain:
//   voice gain (per play) -> [stereo panner] -> sfx bus -> limiter -> master -> destination
//   music layer gains -> music bus -> danger filter -> limiter ----^
//   heartbeat (danger only) -> music bus ----------------------------^
//
// Every sound is a synth function (ctx, dest, when, params) -> duration in seconds, so the
// same code runs live and under OfflineAudioContext (see renderSound / renderMix) for analysis.
//
// Music is a 16-bar loop (four 4-bar phrases) at 128 BPM. Changes that the game asks for
// (layer intensity, danger) are latched at the next bar line, so nothing changes mid-bar.

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
  // Sound pass 2 (#108): each event gets its own sound, so no two different events share one.
  'deflect',
  'stagger',
  'waveClear',
  'pickup',
  'heal',
  'shieldBreak',
  'modifierEnd',
  'bulletCut',
  'dashWhiff',
  'spitterWindup',
  'hint',
  'bossRoar',
  'bossHit',
  'pufferPop',
  'inkSplat',
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
  deflect: 3,
  stagger: 2,
  waveClear: 1,
  pickup: 3,
  heal: 2,
  shieldBreak: 2,
  modifierEnd: 2,
  bulletCut: 4,
  dashWhiff: 2,
  spitterWindup: 2,
  hint: 1,
  bossRoar: 1,
  bossHit: 2,
  pufferPop: 4,
  inkSplat: 3,
};

const BPM = 128;
const STEP_S = 60 / BPM / 4; // one sixteenth note
const STEPS_PER_BAR = 16;
const BAR_S = STEP_S * STEPS_PER_BAR;
const BARS = 16; // four 4-bar phrases
const LOOP_STEPS = STEPS_PER_BAR * BARS;
const LOOKAHEAD_S = 0.15;
const TICK_MS = 25;
const LAYER_FADE_S = 0.35;
const DANGER_FADE_S = 0.25;
const DANGER_CUTOFF = 650; // Hz, low-health filter on the whole music bus
const OPEN_CUTOFF = 20000; // Hz, transparent
const DANGER_Q = 1.2;
const PAUSE_DUCK_S = 0.03;
const RESUME_FADE_S = 0.06;
const START_FADE_S = 0.15;
const STOP_FADE_S = 0.12;
const FILL_STEPS = [8, 10, 12, 13, 14, 15]; // snare ratchet at the end of each phrase

// Chords (root = bass pitch, tones = voicing in octave 4).
const CH = {
  Am: { root: 110.0, tones: [220.0, 261.63, 329.63] },
  F: { root: 87.31, tones: [174.61, 220.0, 261.63] },
  C: { root: 130.81, tones: [261.63, 329.63, 392.0] },
  G: { root: 98.0, tones: [196.0, 246.94, 293.66] },
  Dm: { root: 73.42, tones: [146.83, 174.61, 220.0] },
  E: { root: 82.41, tones: [164.81, 207.65, 246.94] },
  Em: { root: 82.41, tones: [164.81, 196.0, 246.94] },
};
// 16 bars: Am F C G | Am F Dm E | F G Em Am | C G Am E. The last chord leads back into Am.
const PROGRESSION = [
  CH.Am, CH.F, CH.C, CH.G,
  CH.Am, CH.F, CH.Dm, CH.E,
  CH.F, CH.G, CH.Em, CH.Am,
  CH.C, CH.G, CH.Am, CH.E,
];
const ARP_ORDER = [0, 1, 2, 1];

// Lead melody: one entry per bar, four beats each (steps 0, 4, 8, 12). 0 is a rest.
const LEAD = [
  [880, 659.25, 880, 1046.5], [698.46, 880, 1046.5, 880], [659.25, 783.99, 1046.5, 0], [783.99, 987.77, 1174.66, 987.77],
  [1046.5, 880, 659.25, 880], [880, 698.46, 880, 1046.5], [587.33, 698.46, 880, 1174.66], [659.25, 830.61, 987.77, 830.61],
  [1046.5, 880, 698.46, 880], [783.99, 987.77, 1174.66, 0], [987.77, 783.99, 659.25, 783.99], [880, 1046.5, 1318.5, 1046.5],
  [1046.5, 783.99, 659.25, 523.25], [587.33, 783.99, 987.77, 1174.66], [1318.5, 1046.5, 880, 0], [830.61, 987.77, 1318.5, 987.77],
];

// Music layers fade in as intensity rises. from/full are intensity thresholds;
// full <= from means always on. Pad and bass are the resting bed.
const LAYERS = [
  { id: 'pad', from: 0, full: 0 },
  { id: 'bass', from: 0, full: 0 },
  { id: 'drums', from: 0.2, full: 0.4 },
  { id: 'arp', from: 0.45, full: 0.6 },
  { id: 'lead', from: 0.7, full: 0.85 },
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

  // ---- sound pass 2 (#108). Each one has its own character; see tools/soundboard.html for the intent.

  // A Shellback's armour turning the dash: an inharmonic metal bar clang with a bright click.
  deflect(ctx, dest, t, p) {
    const k = p.pitch;
    for (const [f, peak, dur] of [[1180, 0.22, 0.22], [1873, 0.16, 0.16], [2906, 0.08, 0.1], [4410, 0.04, 0.06]]) {
      tone(ctx, dest, { type: 'triangle', freq: f * k, t, dur, peak, attack: 0.001 });
    }
    noise(ctx, dest, { t, dur: 0.015, peak: 0.22, attack: 0.001, filter: { type: 'bandpass', freq: 3600 * k, q: 2 } });
    return 0.22;
  },

  // A pulse staggering an enemy: a short wooden knock that falls in pitch.
  stagger(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'triangle', freq: 420 * k, slideTo: 210 * k, t, dur: 0.12, peak: 0.34, attack: 0.002,
      filter: { type: 'lowpass', freq: 1800, q: 0.8 } });
    noise(ctx, dest, { t, dur: 0.03, peak: 0.2, attack: 0.001, filter: { type: 'bandpass', freq: 1500 * k, q: 2.5 } });
    return 0.12;
  },

  // The wave-clear stinger: a bright A minor arpeggio that rings out into a shimmering top note.
  waveClear(ctx, dest, t, p) {
    const k = p.pitch;
    [440, 523.25, 659.25].forEach((f, i) => {
      tone(ctx, dest, { type: 'sawtooth', freq: f * k, t: t + i * 0.05, dur: 0.22, peak: 0.1, attack: 0.003,
        filter: { type: 'lowpass', freq: 2600, sweepTo: 1400, q: 0.6 } });
    });
    tone(ctx, dest, { type: 'sine', freq: 880 * k, t: t + 0.15, dur: 0.5, peak: 0.2, attack: 0.01 });
    tone(ctx, dest, { type: 'sine', freq: 1318.5 * k, t: t + 0.15, dur: 0.5, peak: 0.12, attack: 0.01 });
    tone(ctx, dest, { type: 'sine', freq: 1760 * k, t: t + 0.2, dur: 0.45, peak: 0.08, attack: 0.02 });
    return 0.65;
  },

  // A pickup collected: a quick upward bloop with a bright tick on top.
  pickup(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 620 * k, slideTo: 1240 * k, t, dur: 0.09, peak: 0.3, attack: 0.002 });
    tone(ctx, dest, { type: 'triangle', freq: 1860 * k, t: t + 0.05, dur: 0.1, peak: 0.14, attack: 0.002 });
    return 0.15;
  },

  // A heal: a warm major triad that swells in slowly, so it reads as restoring rather than hitting.
  heal(ctx, dest, t, p) {
    const k = p.pitch;
    for (const f of [392, 493.88, 587.33]) {
      tone(ctx, dest, { type: 'sine', freq: f * k, t, dur: 0.45, peak: 0.16, attack: 0.07,
        filter: { type: 'lowpass', freq: 2400, q: 0.5 } });
    }
    tone(ctx, dest, { type: 'triangle', freq: 784 * k, t: t + 0.08, dur: 0.35, peak: 0.07, attack: 0.05 });
    return 0.45;
  },

  // The Shield Scale absorbing a hit: glass breaking, a bright noise burst and two falling partials.
  shieldBreak(ctx, dest, t, p) {
    const k = p.pitch;
    noise(ctx, dest, { t, dur: 0.12, peak: 0.3, attack: 0.001, filter: { type: 'highpass', freq: 2600 * k, q: 0.7 } });
    tone(ctx, dest, { type: 'sine', freq: 3100 * k, slideTo: 2100 * k, t, dur: 0.3, peak: 0.14, attack: 0.001 });
    tone(ctx, dest, { type: 'sine', freq: 4650 * k, slideTo: 3000 * k, t, dur: 0.18, peak: 0.07, attack: 0.001 });
    return 0.3;
  },

  // A modifier running out: a power-down tick, two short falling notes.
  modifierEnd(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'square', freq: 520 * k, t, dur: 0.06, peak: 0.12, attack: 0.002,
      filter: { type: 'lowpass', freq: 1600, q: 0.7 } });
    tone(ctx, dest, { type: 'square', freq: 330 * k, t: t + 0.07, dur: 0.09, peak: 0.1, attack: 0.002,
      filter: { type: 'lowpass', freq: 1600, q: 0.7 } });
    return 0.16;
  },

  // A dash cutting an enemy bullet: a quick downward air slice with a short falling tone.
  bulletCut(ctx, dest, t, p) {
    const k = p.pitch;
    noise(ctx, dest, { t, dur: 0.09, peak: 0.28, attack: 0.002,
      filter: { type: 'bandpass', freq: 3200 * k, sweepTo: 900 * k, q: 1.8 } });
    tone(ctx, dest, { type: 'triangle', freq: 1500 * k, slideTo: 600 * k, t, dur: 0.07, peak: 0.16, attack: 0.001 });
    return 0.09;
  },

  // A dash that passed close to an enemy and killed nothing: a faint air puff, no tone.
  dashWhiff(ctx, dest, t, p) {
    const k = p.pitch;
    noise(ctx, dest, { t, dur: 0.1, peak: 0.5, attack: 0.01, filter: { type: 'bandpass', freq: 1400 * k, q: 2 } });
    return 0.1;
  },

  // A spitter winding up: two close sines beat against each other while they rise, then a few bubbles.
  spitterWindup(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 300 * k, slideTo: 520 * k, t, dur: 0.42, peak: 0.16, attack: 0.04 });
    tone(ctx, dest, { type: 'sine', freq: 309 * k, slideTo: 530 * k, t, dur: 0.42, peak: 0.16, attack: 0.04 });
    [0.12, 0.2, 0.3].forEach((dt, i) => {
      tone(ctx, dest, { type: 'sine', freq: (620 + i * 110) * k, slideTo: (900 + i * 110) * k, t: t + dt, dur: 0.07, peak: 0.08, attack: 0.002 });
    });
    return 0.42;
  },

  // The one-time lesson hint: two soft bells a fifth apart. A gentle "remember this", not a warning.
  hint(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 1046.5 * k, t, dur: 0.32, peak: 0.16, attack: 0.002 });
    tone(ctx, dest, { type: 'sine', freq: 1568 * k, t: t + 0.1, dur: 0.4, peak: 0.12, attack: 0.002 });
    return 0.5;
  },

  // The boss roaring: a vowel-like growl. Two narrow formant bands on a slow-falling saw, over breath
  // noise. Formant peaks make it spectrally unlike the hurt sound (a plain low-passed saw).
  bossRoar(ctx, dest, t, p) {
    const k = p.pitch;
    for (const formant of [420, 980]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(58 * k, t);
      osc.frequency.linearRampToValueAtTime(74 * k, t + 0.4);
      osc.frequency.exponentialRampToValueAtTime(52 * k, t + 1.1);
      shape(ctx, osc, dest, t, 1.1, 0.9, 0.12, { type: 'bandpass', freq: formant * k, sweepTo: formant * 0.7 * k, q: 4 });
    }
    noise(ctx, dest, { t, dur: 1.0, peak: 0.2, attack: 0.25, filter: { type: 'lowpass', freq: 900, q: 0.7 } });
    return 1.1;
  },

  // A landed boss hit: a short heavy thump with a hard click on top.
  bossHit(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 230 * k, slideTo: 80 * k, t, dur: 0.26, peak: 0.6, attack: 0.002 });
    tone(ctx, dest, { type: 'triangle', freq: 470 * k, slideTo: 300 * k, t, dur: 0.12, peak: 0.16, attack: 0.001 });
    noise(ctx, dest, { t, dur: 0.1, peak: 0.34, attack: 0.001, filter: { type: 'lowpass', freq: 1300 * k, q: 0.8 } });
    return 0.26;
  },

  // A puffer popping: a quick upward bubble pop.
  pufferPop(ctx, dest, t, p) {
    const k = p.pitch;
    tone(ctx, dest, { type: 'sine', freq: 420 * k, slideTo: 1400 * k, t, dur: 0.07, peak: 0.4, attack: 0.001 });
    tone(ctx, dest, { type: 'sine', freq: 1200 * k, slideTo: 2000 * k, t: t + 0.02, dur: 0.08, peak: 0.1, attack: 0.001 });
    noise(ctx, dest, { t, dur: 0.02, peak: 0.12, attack: 0.001, filter: { type: 'highpass', freq: 4000 * k } });
    return 0.1;
  },

  // Ink splatting: a wet noise smear that falls in pitch, a low thud and two small droplets.
  inkSplat(ctx, dest, t, p) {
    const k = p.pitch;
    noise(ctx, dest, { t, dur: 0.22, peak: 0.36, attack: 0.002,
      filter: { type: 'bandpass', freq: 900 * k, sweepTo: 260 * k, q: 3 } });
    tone(ctx, dest, { type: 'sine', freq: 130 * k, slideTo: 50 * k, t, dur: 0.18, peak: 0.22, attack: 0.002 });
    tone(ctx, dest, { type: 'sine', freq: 1320 * k, slideTo: 880 * k, t: t + 0.04, dur: 0.05, peak: 0.1, attack: 0.001 });
    tone(ctx, dest, { type: 'sine', freq: 990 * k, t: t + 0.1, dur: 0.05, peak: 0.08, attack: 0.001 });
    return 0.22;
  },
};

// ---------------------------------------------------------------- output chain
// Static soft limiter: transparent below LIMIT_KNEE, then bends smoothly toward a ceiling
// of about 0.94 (never above 1.0). A DynamicsCompressorNode was tried first, but its envelope
// follower cut 0.1 s transients by about 16 dB even below threshold, so output levels were
// unpredictable. A static curve keeps every sound's measured level what the synth set.
// Being memoryless, it cannot pump: its gain at any instant depends only on that instant's level.
const LIMIT_KNEE = 0.75;
function limiterCurve(n = 4096) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= LIMIT_KNEE ? a : LIMIT_KNEE + (1 - LIMIT_KNEE) * Math.tanh((a - LIMIT_KNEE) / (1 - LIMIT_KNEE));
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

// bypassLimiter is tooling only: it replaces the limiter with a unity gain so the analysis can
// measure how much the limiter changes a mix.
function buildOutputChain(ctx, { bypassLimiter = false } = {}) {
  let limiter;
  if (bypassLimiter) {
    limiter = ctx.createGain();
  } else {
    limiter = ctx.createWaveShaper();
    limiter.curve = limiterCurve();
    limiter.oversample = '4x';
  }
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

// Retargets a param from its current value. `when` is when the new ramp starts (a bar line for
// resumes); `now` is where the old automation is cut. Keeps the level continuous when interrupted.
function rampParam(param, target, when, tau, now) {
  const cur = param.value;
  param.cancelScheduledValues(now);
  param.setValueAtTime(cur, now);
  param.setTargetAtTime(target, when, tau);
}

function createMusic(ctx, limiter) {
  const bus = ctx.createGain();
  bus.gain.value = 0;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = OPEN_CUTOFF;
  filter.Q.value = DANGER_Q;
  bus.connect(filter);
  filter.connect(limiter);
  const layers = LAYERS.map((def) => {
    const gain = ctx.createGain();
    gain.gain.value = layerLevel(def, 0);
    gain.connect(bus);
    return { def, gain };
  });
  const out = {};
  for (const l of layers) out[l.def.id] = l.gain;
  const heart = ctx.createGain();
  heart.connect(bus);
  return {
    ctx, bus, filter, layers, out, heart,
    intensity: 0,
    pendingDanger: false, // what the game asked for
    barDanger: false, // what the current bar uses (latched on bar lines)
    paused: false,
    running: false,
    timer: null,
    nextTime: 0,
    nextBarTime: 0,
    step: 0,
  };
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

// Phrase-end fill: a snare ratchet that gets louder and higher toward the end of the phrase.
function fillHit(ctx, dest, t, i) {
  noise(ctx, dest, { t, dur: 0.08, peak: 0.12 + 0.025 * i, attack: 0.001,
    filter: { type: 'bandpass', freq: 1500 + 180 * i, q: 1.0 } });
}

// Phrase start: a crash on the first beat of every phrase.
function crash(ctx, dest, t) {
  noise(ctx, dest, { t, dur: 0.7, peak: 0.16, attack: 0.004, filter: { type: 'highpass', freq: 4200, q: 0.6 } });
}

function hatTick(ctx, dest, t) {
  noise(ctx, dest, { t, dur: 0.03, peak: 0.09, attack: 0.001, filter: { type: 'highpass', freq: 7500, q: 0.7 } });
}

function arpNote(ctx, dest, t, freq) {
  tone(ctx, dest, { type: 'triangle', freq, t, dur: STEP_S * 0.9, peak: 0.09, attack: 0.002 });
}

function leadNote(ctx, dest, t, freq) {
  for (const d of [-5, 5]) {
    tone(ctx, dest, { type: 'sawtooth', freq, t, dur: STEP_S * 3.2, peak: 0.035, attack: 0.008, detune: d,
      filter: { type: 'lowpass', freq: 2600, q: 0.8 } });
  }
}

function padNote(ctx, dest, t, freq, dur) {
  tone(ctx, dest, { type: 'sawtooth', freq, t, dur, peak: 0.045, attack: 0.3, detune: -6,
    filter: { type: 'lowpass', freq: 1100, q: 0.7 } });
  tone(ctx, dest, { type: 'sawtooth', freq, t, dur, peak: 0.045, attack: 0.3, detune: 6,
    filter: { type: 'lowpass', freq: 1100, q: 0.7 } });
}

// Low-health heartbeat: a lub-dub on beats 1 and 1.75 of each bar, only while danger is latched.
function heartbeat(ctx, dest, t, level) {
  tone(ctx, dest, { type: 'sine', freq: 70, slideTo: 42, t, dur: 0.16, peak: 0.55 * level, attack: 0.004 });
  tone(ctx, dest, { type: 'sine', freq: 140, slideTo: 80, t, dur: 0.05, peak: 0.08 * level, attack: 0.002 });
}

// Bar line: latches the requested danger and intensity for this bar, so changes land on bar lines.
function startBar(m, t) {
  m.nextBarTime = t + BAR_S;
  m.barDanger = m.pendingDanger;
  m.filter.frequency.setTargetAtTime(m.barDanger ? DANGER_CUTOFF : OPEN_CUTOFF, t, DANGER_FADE_S);
  for (const l of m.layers) {
    l.gain.gain.setTargetAtTime(layerLevel(l.def, m.intensity), t, LAYER_FADE_S);
  }
}

function scheduleStep(m, step, t) {
  const ctx = m.ctx;
  const bar = Math.floor(step / STEPS_PER_BAR);
  const s = step % STEPS_PER_BAR;
  const chord = PROGRESSION[bar];
  const out = m.out;
  const phraseEnd = bar % 4 === 3;
  if (s === 0) startBar(m, t);
  if (s % 2 === 0) bassNote(ctx, out.bass, t, chord.root * (s === 6 || s === 14 ? 2 : 1));
  if (s % 4 === 0) kickDrum(ctx, out.drums, t);
  if (s === 4 || (s === 12 && !phraseEnd)) snareDrum(ctx, out.drums, t);
  if (s % 4 === 2) hatTick(ctx, out.drums, t);
  if (phraseEnd && FILL_STEPS.includes(s)) fillHit(ctx, out.drums, t, FILL_STEPS.indexOf(s));
  if (s === 0 && bar % 4 === 0) crash(ctx, out.drums, t);
  arpNote(ctx, out.arp, t, chord.tones[ARP_ORDER[s % 4]] * 2);
  if (s % 4 === 0) {
    const f = LEAD[bar][s / 4];
    if (f) leadNote(ctx, out.lead, t, f);
  }
  if (s === 0) {
    for (const f of chord.tones) padNote(ctx, out.pad, t, f, BAR_S);
  }
  if (m.barDanger && (s === 0 || s === 3)) heartbeat(ctx, m.heart, t, s === 0 ? 1 : 0.7);
}

// Schedules every step that starts before endT, on the AudioContext clock.
function scheduleUntil(m, endT) {
  while (m.nextTime < endT) {
    scheduleStep(m, m.step, m.nextTime);
    m.nextTime += STEP_S;
    m.step = (m.step + 1) % LOOP_STEPS;
  }
}

// Lookahead scheduler: a short timer only wakes it; note times come from the AudioContext clock.
function scheduleMusic(m) {
  if (!m.running) return;
  const now = m.ctx.currentTime;
  if (m.nextTime < now) m.nextTime = now + 0.02;
  scheduleUntil(m, now + LOOKAHEAD_S);
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
    rampParam(m.bus.gain, m.paused ? 0 : MUSIC_LEVEL, now, START_FADE_S, now);
    m.timer = setInterval(() => scheduleMusic(m), TICK_MS);
    scheduleMusic(m);
  },

  // Intensity 0..1 picks the layers (see LAYERS). While the music runs the change lands on the next bar line.
  setMusicIntensity(x) {
    const m = state.music;
    if (!state.ctx || !m) return;
    m.intensity = clamp(num(x, 0), 0, 1);
    if (m.running) return; // startBar applies it on the next bar line
    const now = m.ctx.currentTime;
    for (const l of m.layers) {
      l.gain.gain.cancelScheduledValues(now);
      l.gain.gain.setTargetAtTime(layerLevel(l.def, m.intensity), now, LAYER_FADE_S);
    }
  },

  // Low-health variation: a low-pass on the music and a heartbeat under it. Lands on the next bar line.
  setMusicDanger(b) {
    const m = state.music;
    if (!state.ctx || !m) return;
    m.pendingDanger = !!b;
    if (m.running) return;
    m.barDanger = m.pendingDanger;
    const now = m.ctx.currentTime;
    m.filter.frequency.cancelScheduledValues(now);
    m.filter.frequency.setValueAtTime(m.barDanger ? DANGER_CUTOFF : OPEN_CUTOFF, now);
  },

  // Pause ducks the music at once and keeps the clock running; resume comes back on the next bar line.
  setMusicPaused(b) {
    const m = state.music;
    if (!state.ctx || !m) return;
    const paused = !!b;
    if (paused === m.paused) return;
    m.paused = paused;
    const now = m.ctx.currentTime;
    if (paused) {
      rampParam(m.bus.gain, 0, now, PAUSE_DUCK_S, now);
    } else if (m.running) {
      let at = m.nextBarTime;
      while (at < now + 0.02) at += BAR_S;
      rampParam(m.bus.gain, MUSIC_LEVEL, at, RESUME_FADE_S, now);
    }
  },

  // Clean stop (game over): a short fade, and the scheduler stops.
  stopMusic() {
    const m = state.music;
    if (!state.ctx || !m || !m.running) return;
    m.running = false;
    clearInterval(m.timer);
    m.timer = null;
    const now = m.ctx.currentTime;
    rampParam(m.bus.gain, 0, now, STOP_FADE_S, now);
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

// Tooling hook: renders a whole mix offline through the same chain, for the stacking and level checks.
// opts: { seconds, music (bool), intensity (0..1), danger (bool), bypassLimiter (bool),
//         events: [{ name, t, pitch?, volume?, pan? }] } where t is seconds from the start.
// Returns an AudioBuffer, or null without Web Audio. Voice limits are not applied here: callers
// pass only events whose overlap the limits would already allow.
export async function renderMix(opts = {}) {
  const Off = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (typeof Off !== 'function') return null;
  const sampleRate = 48000;
  const seconds = clamp(num(opts.seconds, 2), 0.1, 30);
  const ctx = new Off(1, Math.ceil(sampleRate * seconds), sampleRate);
  const chain = buildOutputChain(ctx, { bypassLimiter: !!opts.bypassLimiter });
  if (opts.music) {
    const m = createMusic(ctx, chain.limiter);
    m.intensity = clamp(num(opts.intensity, 0), 0, 1);
    m.pendingDanger = !!opts.danger;
    m.barDanger = m.pendingDanger;
    m.filter.frequency.value = m.barDanger ? DANGER_CUTOFF : OPEN_CUTOFF;
    m.bus.gain.value = MUSIC_LEVEL;
    m.running = true;
    m.nextTime = 0.02;
    m.step = 0;
    scheduleUntil(m, seconds);
  }
  for (const e of opts.events || []) {
    if (!Object.prototype.hasOwnProperty.call(SYNTHS, e.name)) continue;
    const pitch = clamp(num(e.pitch, 1), 0.25, 4);
    const volume = clamp(num(e.volume, 1), 0, 2);
    const pan = clamp(num(e.pan, 0), -1, 1);
    const input = routeVoice(ctx, chain.sfx, volume, pan);
    SYNTHS[e.name](ctx, input, Math.max(0, num(e.t, 0)), { pitch, detune: 0 });
  }
  return ctx.startRendering();
}
