// Feedback layer: turns simulation events into sound, particles, shake, hit-stop, flashes and
// score floaters. The mapping is one table, FEEDBACK, which follows the feedback matrix in
// docs/DESIGN.md section 5.
//
// Each row is keyed by a game.events type, or by a synthetic type this layer derives from state
// (chargeReady, spawnWarning, multiKill, multiKillEnd). Every field of a row is a function of the
// event and returns an effect, or null when the row has nothing to say for that event:
//   sound(ev)    -> { name, pitch?, volume?, pan? }       name must be in SOUND_NAMES (src/audio.js)
//   preset(ev)   -> { name, color?, angle? }              name must be a key of PRESET_BURSTS
//   shake(ev)    -> peak shake in px (DESIGN peak amplitude)
//   hitstop(ev)  -> peak hit-stop in ms
//   flash(ev)    -> [color, alpha]
//   slowmo(ev)   -> [timeScale, ms]
//   floater(ev)  -> { text, color, size?, life?, delay? (ms) }
//   ring(ev)     -> { life, perfect }                      pulse shockwave drawn with draw.pulse
//   music        -> 'stop'                                 stops the music bus
// Shake and hit-stop are peaks. Kills inside one dash form a batch, and a batch applies only the
// increase over its earlier kills, so a multi-kill reaches the matrix peak instead of stacking.
//
// Pure apart from the injected audio and fx objects: nothing here touches window or document, so
// the module runs under `node --test` with stubs.
import { FX_PRESETS, SHAKE_MAX_OFFSET } from './fx.js';
import { COMBO, LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H } from './config.js';
import { ENEMY_KINDS, multiplierFor, tierFor } from './game.js';
import { PALETTE } from './art.js';
import { PICKUP_KINDS } from './pickups.js'; // PICKUPS (#54): colours and labels for the pickup rows

// Every event type src/game.js can emit. test/feedback.test.js checks a fuzzed run against this.
export const GAME_EVENT_TYPES = Object.freeze([
  'dash',
  'pulse',
  'perfectPulse',
  'reflect',
  'kill',
  'comboTier',
  'comboLost',
  'hurt',
  'waveStart',
  'waveClear',
  'gameOver',
  // PICKUPS (#54): presentation for these lives in pickups-art.js; sounds are a follow-up.
  'pickupDrop',
  'pickup',
  'modifierEnd',
  'heal',
  'shieldBreak',
]);

const PAN_WIDTH = 0.8; // stereo pan at the arena edge; the centre is 0
const PITCH_PER_COMBO = 0.02; // kill chime: 1 + 0.02 * min(combo, 30)
const PITCH_COMBO_CAP = 30;
const MAX_KILL_PITCH = 2; // +12 semitones
const KILL_SHAKE_PX = [3, 6, 8, 10, 12]; // peak per dash batch, by kill count (1..5+)
const KILL_HITSTOP_MS = [40, 50, 60, 70]; // peak per dash batch, by kill count (1..4+)
const BIG_KILL_BASE = 150; // base score from which the kill burst is the large one
const REFLECT_KILL_FLOATER_DELAY_MS = 150; // REFLECT shows first, then the score
const TRAIL = Object.freeze({ length: 46, width: 24, alpha: 0.55, life: 0.2 });

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const killBase = (kind) => ENEMY_KINDS[kind]?.points ?? 0;
const enemyColor = (kind) => PALETTE[kind] ?? PALETTE.danger;
const tierColor = (count) => PALETTE.combo[tierFor(count)] ?? PALETTE.player;
const tierColorAt = (tier) => PALETTE.combo[tier] ?? PALETTE.player;

// Stereo pan from the x position: left edge -PAN_WIDTH, right edge +PAN_WIDTH.
export function panFor(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return 0;
  return clamp((x / W) * 2 - 1, -1, 1) * PAN_WIDTH;
}

// Kill chime pitch rises with the combo and never exceeds +12 semitones.
export function killPitch(combo) {
  return Math.min(MAX_KILL_PITCH, 1 + PITCH_PER_COMBO * Math.min(Math.max(0, combo), PITCH_COMBO_CAP));
}

const killShakePx = (n) => KILL_SHAKE_PX[Math.min(n, KILL_SHAKE_PX.length) - 1];
const killHitstopMs = (n) => KILL_HITSTOP_MS[Math.min(n, KILL_HITSTOP_MS.length) - 1];

// fx.shake takes trauma; the shake offset is trauma^2 * SHAKE_MAX_OFFSET, so a peak of P px needs sqrt(P / max).
const traumaFor = (px) => Math.sqrt(Math.max(0, px) / SHAKE_MAX_OFFSET);

// ---- particle presets ------------------------------------------------------------------------
// Burst lists for fx.burst. Built from FX_PRESETS where the matrix names an existing preset, and
// approximated otherwise (noted per entry). A colour override recolours everything except sparks.
function recolor(list, color) {
  if (color === undefined) return list;
  return list.map((b) => (b.shape === 'spark' ? b : { ...b, color }));
}

export const PRESET_BURSTS = Object.freeze({
  dashStart: (o) => FX_PRESETS.dashStart.bursts.map((b) => ({ ...b, angle: o.angle ?? 0 })),
  killSmall: (o) => recolor(FX_PRESETS.kill.bursts, o.color),
  killLarge: (o) =>
    recolor(
      FX_PRESETS.kill.bursts.map((b) => ({ ...b, count: Math.round(b.count * 1.6), speed: b.speed * 1.2 })),
      o.color,
    ),
  multiKillNova: () => FX_PRESETS.multiKill.bursts,
  hurtSpark: () => FX_PRESETS.hurt.bursts,
  pulseRing: () => FX_PRESETS.pulse.bursts,
  reflectSpark: () => FX_PRESETS.reflect.bursts,
  perfectShatter: () => FX_PRESETS.perfectPulse.bursts,
  comboTierBloom: (o) => recolor(FX_PRESETS.comboTierUp.bursts, o.color),
  // Approximation: fx has no inward-moving burst, so dots scatter and fade instead of drawing toward the HUD.
  comboDrain: (o) => [{ count: 14, shape: 'dot', color: o.color, speed: 200, life: 0.5, size: 3, drag: 2.5 }],
  // The arena sweep: one ring that crosses the whole arena.
  waveSweep: () => [{ count: 1, shape: 'ring', color: PALETTE.player, speed: 820, life: 0.9, size: 6 }],
  // Approximation: fx has no implode primitive, so this is an outward shockwave plus shards (see the issue filed with this PR).
  gameOverImplode: () => [
    { count: 1, shape: 'ring', color: PALETTE.danger, speed: 520, life: 0.8, size: 8 },
    { count: 22, shape: 'shard', color: [PALETTE.danger, PALETTE.bullet], speed: 260, life: 0.9, size: 6, drag: 2.2 },
  ],
  chargeGlint: () => [{ count: 6, shape: 'spark', color: [PALETTE.dash, PALETTE.player], speed: 200, life: 0.3, size: 2, drag: 5 }],
  spawnMotes: (o) => [{ count: 8, shape: 'dot', color: o.color, speed: 90, life: 0.45, size: 2.4, drag: 3 }],
});

// ---- the mapping table --------------------------------------------------------------------------
// Matrix rows are cited inline. Values are the matrix's; the only deviation is noted where it occurs.
export const FEEDBACK = Object.freeze({
  // A wave cleared (the sim emits it when the last enemy of a wave dies). A cyan flash only: no new sound.
  waveClear: {
    flash: () => [PALETTE.player, 0.08],
  },

  // PICKUPS (#54). Sounds and presets are existing names; the pickup's own colour is passed through.
  // A drop is a soft burst at the kill point. Nothing plays for the drop itself, so it stays quiet in a fight.
  pickupDrop: {
    preset: (ev) => ({ name: 'comboTierBloom', color: PICKUP_KINDS[ev.kind]?.color }),
  },

  // Collecting a pickup: chime, burst in its colour, a flash, and its name. Heal floaters come from pickups-art.js.
  pickup: {
    sound: (ev) => ({ name: 'comboTierUp', pitch: ev.kind === 'heal' ? 1.25 : 1, pan: panFor(ev.x) }),
    preset: (ev) => ({ name: 'comboTierBloom', color: PICKUP_KINDS[ev.kind]?.color }),
    flash: (ev) => [PICKUP_KINDS[ev.kind]?.color ?? '#ffffff', 0.1],
    floater: (ev) => (ev.kind === 'heal' ? undefined : { text: PICKUP_KINDS[ev.kind]?.label ?? '', color: PICKUP_KINDS[ev.kind]?.color, life: 0.9, size: 20 }),
  },

  // A modifier running out: a soft tick, no burst.
  modifierEnd: {
    sound: () => ({ name: 'uiClick', pitch: 1, pan: 0 }),
  },

  // A heal: a green burst and a light shake. The +HP floater is drawn by pickups-art.js.
  heal: {
    sound: (ev) => ({ name: 'comboTierUp', pitch: 1.4, pan: panFor(ev.x) }),
    preset: () => ({ name: 'comboTierBloom', color: PICKUP_KINDS.heal.color }),
    shake: () => 2,
    flash: () => [PICKUP_KINDS.heal.color, 0.12],
  },

  // The Shield Scale absorbs a hit: the reflect clang, a white flash and a small shake. The white ring is drawn by pickups-art.js.
  shieldBreak: {
    sound: (ev) => ({ name: 'reflect', pan: panFor(ev.x) }),
    preset: () => ({ name: 'reflectSpark' }),
    shake: () => 3,
    flash: () => ['#ffffff', 0.12],
  },

  // Dash start: whoosh, directional burst, white-hot flash. The trail runs per step in handleStep.
  dash: {
    sound: (ev) => ({ name: 'dash', pan: panFor(ev.x) }),
    preset: (ev) => ({ name: 'dashStart', angle: ev.angle }),
    flash: () => ['#eaffff', 0.12],
  },

  // Single kill row. Used for every kill; a dash batch adds the multi-kill rows on top.
  kill: {
    sound: (ev) => ({ name: 'kill', pitch: killPitch(ev.combo), pan: panFor(ev.x) }),
    preset: (ev) => ({ name: killBase(ev.enemyType) < BIG_KILL_BASE ? 'killSmall' : 'killLarge', color: enemyColor(ev.enemyType) }),
    shake: (ev) => killShakePx(ev.n),
    hitstop: (ev) => killHitstopMs(ev.n),
    flash: (ev) => [enemyColor(ev.enemyType), 0.1],
    floater: (ev) => ({
      text: `+${ev.points}`,
      color: tierColor(ev.combo),
      life: 0.7,
      // A kill outside a dash is a reflected bullet: its score follows the REFLECT floater.
      delay: ev.batched ? 0 : REFLECT_KILL_FLOATER_DELAY_MS,
    }),
  },

  // Synthetic: the second kill of a dash. Chord and nova once; the peaks are handled by the kill row.
  multiKill: {
    sound: (ev) => ({ name: 'multiKill', pan: panFor(ev.x) }),
    preset: () => ({ name: 'multiKillNova' }),
    flash: () => ['#ffe066', 0.2],
  },

  // Synthetic: the dash batch ends with two or more kills. Shows the total bonus.
  multiKillEnd: {
    floater: (ev) => ({ text: `x${ev.n} +${ev.bonus}`, color: PALETTE.gold, size: 32, life: 1.0 }),
  },

  // Pulse fired: pop, cyan ring, light shake, cyan flash. No floater.
  pulse: {
    sound: (ev) => ({ name: 'pulse', pan: panFor(ev.x) }),
    preset: () => ({ name: 'pulseRing' }),
    shake: () => 2,
    flash: () => [PALETTE.player, 0.08],
    ring: () => ({ life: 0.3, perfect: false }),
  },

  // Perfect pulse: time scale 0.35 for 200 ms instead of hit-stop. The floater says PERFECT PULSE, not +150:
  // src/game.js does not award the 150 yet (see the issue filed with this PR).
  perfectPulse: {
    sound: () => ({ name: 'perfectPulse' }),
    preset: () => ({ name: 'perfectShatter' }),
    shake: () => 5,
    slowmo: () => [0.35, 200],
    flash: () => ['#ffffff', 0.25],
    floater: () => ({ text: 'PERFECT PULSE', color: PALETTE.gold, size: 26, life: 0.9 }),
    ring: () => ({ life: 0.45, perfect: true }),
  },

  // Reflected bullet: clang, sparks, light shake and hit-stop, REFLECT floater.
  reflect: {
    sound: (ev) => ({ name: 'reflect', pan: panFor(ev.x) }),
    preset: () => ({ name: 'reflectSpark' }),
    shake: () => 1,
    hitstop: () => 20,
    floater: () => ({ text: 'REFLECT', color: PALETTE.dash, size: 22, life: 0.6 }),
  },

  // Combo tier up (tier > 0). A drop to tier 0 comes with comboLost, which has its own row.
  comboTier: {
    sound: (ev) => (ev.tier > 0 ? { name: 'comboTierUp' } : null),
    preset: (ev) => (ev.tier > 0 ? { name: 'comboTierBloom', color: tierColorAt(ev.tier) } : null),
    shake: (ev) => (ev.tier > 0 ? 4 : 0),
    flash: (ev) => (ev.tier > 0 ? [tierColorAt(ev.tier), 0.15] : null),
    floater: (ev) => (ev.tier > 0 ? { text: `COMBO ${ev.combo}`, color: tierColorAt(ev.tier), size: 30, life: 1.0 } : null),
  },

  comboLost: {
    sound: () => ({ name: 'comboLost' }),
    preset: () => ({ name: 'comboDrain', color: PALETTE.danger }),
    shake: () => 2,
    floater: () => ({ text: 'COMBO LOST', color: PALETTE.danger, size: 26, life: 0.9 }),
  },

  // Wave banner: a sweep across the arena, a cyan flash and the wave number.
  waveStart: {
    sound: () => ({ name: 'waveStart' }),
    preset: () => ({ name: 'waveSweep' }),
    shake: () => 3,
    flash: () => [PALETTE.player, 0.1],
    floater: (ev) => ({ text: `WAVE ${ev.wave}`, color: PALETTE.player, size: 40, life: 1.4 }),
  },

  // Hurt: thud, magenta spark burst, the strongest shake and hit-stop, a magenta flash, -1 HP.
  hurt: {
    sound: (ev) => ({ name: 'hurt', pan: panFor(ev.x) }),
    preset: () => ({ name: 'hurtSpark' }),
    shake: () => 10,
    hitstop: () => 70,
    flash: () => [PALETTE.danger, 0.35],
    floater: () => ({ text: '-1 HP', color: PALETTE.danger, size: 26, life: 0.8 }),
  },

  // Game over: the sink sound, the implode burst, a dark flash, and the music stops.
  gameOver: {
    sound: () => ({ name: 'gameOver' }),
    preset: () => ({ name: 'gameOverImplode' }),
    flash: () => ['#050a18', 0.6],
    floater: () => ({ text: 'GAME OVER', color: PALETTE.danger, size: 48, life: 1.6 }),
    music: 'stop',
  },

  // Synthetic: a charge refills (the count rises with no kill in the step). Not a kill refund.
  chargeReady: {
    sound: (ev) => ({ name: 'dashReady', pitch: 1 + 0.1 * ev.count }),
    preset: () => ({ name: 'chargeGlint' }),
  },

  // Synthetic: a spawn marker appears, 0.8 s before its enemy.
  spawnWarning: {
    sound: (ev) => ({ name: 'spawnWarn', volume: 0.4, pan: panFor(ev.x) }),
    preset: (ev) => ({ name: 'spawnMotes', color: PALETTE.danger }),
    floater: () => ({ text: '!', color: PALETTE.danger, size: 30, life: 0.6 }),
  },
});

// ---- the runtime ----------------------------------------------------------------------------------
// `audio` needs play, startMusic, stopMusic and setMusicIntensity. `fx` needs burst, trail, floater,
// shake, hitstop, slowmo and flash. Both are the real modules in the game and stubs in tests.
export function createFeedback({ audio, fx }) {
  const rings = []; // pulse shockwaves: { x, y, age, life, perfect }, aged by frame()
  const later = []; // delayed floaters: { at, run }, on the frame clock
  let clock = 0;
  let batch = null; // the open dash batch: { n, x, y, bonus, trauma, hit }
  let curGame = null;
  let prevCharges = 0;
  const seenWarnings = new WeakSet();
  let runActive = false;
  let musicOn = false;
  let musicLevel = 0;
  let sentLevel = -1;

  // Adds the fields rows need: a position (the player for events without one), the batch count,
  // and the combo count, which comboTier rows show and which the sim does not put on the event.
  function enrich(ev, game) {
    const p = game.player;
    const centred = ev.type === 'waveStart' || ev.type === 'gameOver';
    return {
      ...ev,
      x: centred ? W / 2 : (ev.x ?? p.x),
      y: centred ? H / 2 : (ev.y ?? p.y),
      combo: ev.combo ?? game.combo.count,
      n: 1,
      batched: false,
    };
  }

  function shakeTo(px, scope) {
    const want = traumaFor(px);
    const have = scope ? scope.trauma : 0;
    if (want <= have) return;
    fx.shake(want - have);
    if (scope) scope.trauma = want;
  }

  function hitstopTo(ms, scope) {
    const have = scope ? scope.hit : 0;
    if (ms <= have) return;
    fx.hitstop(ms - have);
    if (scope) scope.hit = ms;
  }

  function addFloater(f, ev) {
    const spawn = () => fx.floater(ev.x, ev.y, f.text, { color: f.color, size: f.size, life: f.life });
    if (f.delay > 0) later.push({ at: clock + f.delay / 1000, run: spawn });
    else spawn();
  }

  function burstPreset(p, x, y) {
    const make = PRESET_BURSTS[p.name];
    if (!make) return;
    for (const b of make(p)) fx.burst(x, y, b);
  }

  function startMusic() {
    if (!runActive || musicOn) return;
    musicOn = true;
    audio.startMusic();
  }

  function stopMusic() {
    if (!musicOn) return;
    musicOn = false;
    audio.stopMusic();
  }

  // Applies one table row to one event. `scope` is the dash batch for kill rows, null otherwise.
  function play(type, ev, scope) {
    const row = FEEDBACK[type];
    if (!row) return;

    const s = row.sound?.(ev);
    if (s) audio.play(s.name, { pitch: s.pitch ?? 1, volume: s.volume ?? 1, pan: s.pan ?? 0 });

    const p = row.preset?.(ev);
    if (p) burstPreset(p, ev.x, ev.y);

    const px = row.shake?.(ev) ?? 0;
    if (px > 0) shakeTo(px, scope);

    const ms = row.hitstop?.(ev) ?? 0;
    if (ms > 0) hitstopTo(ms, scope);

    const fl = row.flash?.(ev);
    if (fl) fx.flash(fl[0], fl[1]);

    const sm = row.slowmo?.(ev);
    if (sm) fx.slowmo(sm[0], sm[1]);

    const f = row.floater?.(ev);
    if (f) addFloater(f, ev);

    const r = row.ring?.(ev);
    if (r) rings.push({ x: ev.x, y: ev.y, age: 0, life: r.life, perfect: r.perfect });

    if (row.music === 'stop') stopMusic();
  }

  function flushBatch() {
    if (!batch) return;
    if (batch.n >= 2) {
      play('multiKillEnd', { x: batch.x, y: batch.y, n: batch.n, bonus: batch.bonus }, null);
    }
    batch = null;
  }

  function handleKill(ev, game) {
    const e = enrich(ev, game);
    if (!batch) {
      play('kill', e, null);
      return;
    }
    batch.n += 1;
    batch.x = e.x;
    batch.y = e.y;
    batch.bonus += e.points - killBase(e.enemyType) * multiplierFor(e.combo);
    e.n = batch.n;
    e.batched = true;
    play('kill', e, batch);
    if (batch.n === 2) play('multiKill', e, null);
  }

  function handleEvent(ev, game) {
    if (ev.type === 'dash') {
      flushBatch();
      batch = { n: 0, x: ev.x, y: ev.y, bonus: 0, trauma: 0, hit: 0 };
    }
    if (ev.type === 'kill') {
      handleKill(ev, game);
      return;
    }
    play(ev.type, enrich(ev, game), null);
  }

  function resetFor(game) {
    curGame = game;
    batch = null;
    later.length = 0;
    rings.length = 0;
    prevCharges = game.player.dash.charges;
  }

  // Called once per simulation step with that step's drained events. Derives the synthetic
  // events from state, draws the dash trail, and closes the dash batch when the dash is over.
  function handleStep(events, game) {
    if (game !== curGame) resetFor(game);
    const hadKill = events.some((ev) => ev.type === 'kill');
    for (const ev of events) handleEvent(ev, game);

    const p = game.player;
    const d = p.dash;
    if (d.charges > prevCharges && !hadKill) {
      play('chargeReady', { x: p.x, y: p.y, count: d.charges }, null);
    }
    prevCharges = d.charges;

    for (const wn of game.warnings) {
      if (seenWarnings.has(wn)) continue;
      seenWarnings.add(wn);
      play('spawnWarning', { x: wn.x, y: wn.y, kind: wn.kind }, null);
    }

    if (d.active) fx.trail(p.x, p.y, Math.atan2(d.active.dirY, d.active.dirX), TRAIL);
    if (batch && (game.over || !d.active)) flushBatch();
  }

  // Once per real frame. `dt` is 0 while paused, so delayed floaters, rings and music smoothing freeze too.
  function frame(dt, game) {
    clock += dt;
    for (let i = later.length - 1; i >= 0; i--) {
      if (later[i].at <= clock) {
        later[i].run();
        later.splice(i, 1);
      }
    }
    for (let i = rings.length - 1; i >= 0; i--) {
      rings[i].age += dt;
      if (rings[i].age >= rings[i].life) rings.splice(i, 1);
    }

    // Music intensity follows the multiplier: 0 at x1, 1 at the cap, eased so layers never snap.
    const live = game && runActive && !game.over;
    const mult = live ? multiplierFor(game.combo.count) : 1;
    const target = (mult - 1) / (COMBO.multiplierCap - 1);
    musicLevel += (target - musicLevel) * (1 - Math.exp(-dt * 4));
    if (Math.abs(musicLevel - sentLevel) > 0.002) {
      sentLevel = musicLevel;
      audio.setMusicIntensity(musicLevel);
    }
  }

  return {
    handleStep,
    frame,
    rings,
    startRun() {
      runActive = true;
      musicLevel = 0;
      sentLevel = -1;
      startMusic();
    },
    setPaused(paused) {
      if (paused) stopMusic();
      else startMusic();
    },
  };
}
