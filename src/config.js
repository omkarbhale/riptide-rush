// Every tuning number for Riptide Rush lives here, as named constants.
// Units: logical pixels, seconds, pixels per second. Values follow issue #1 unless
// noted "placeholder" (numbers the design left open; tune them in playtesting).

export const LOGICAL_WIDTH = 1280;
export const LOGICAL_HEIGHT = 720;

export const SIM_HZ = 120;
export const SIM_DT = 1 / SIM_HZ;
// Frames longer than this (tab stalls, debugger pauses) are clamped so the sim never spirals.
export const MAX_FRAME_DT = 0.25;
// Dash and pulse presses stay armed for this long, so a press just before a charge is ready still fires.
export const INPUT_BUFFER = 0.12;
// Delay after a death before a press restarts the run (guards against a click burst restarting by accident).
export const RESTART_GATE = 0.2;

// Entities are kept this far inside the logical screen.
export const ARENA = { inset: 24 };

export const PLAYER = {
  radius: 14,
  coreRadius: 8,        // contact with a non-lunging enemy hurts only inside enemy radius + this (grazes are safe)
  maxHp: 3,
  accel: 2600,          // px/s^2 while steering
  maxSpeed: 330,        // px/s, top speed while steering
  friction: 5,          // per-second velocity decay when not steering (placeholder)
  invulnAfterHit: 1.0,  // seconds of invulnerability after taking a hit
  hitKnockback: 240,    // px/s impulse away from whatever hit the player
};

export const DASH = {
  distance: 210,        // px
  duration: 0.12,       // seconds; 210 px in 0.12 s
  maxCharges: 3,
  rechargeTime: 0.9,    // seconds per charge
  exitSpeed: 180,       // px/s momentum carried out of a dash (placeholder)
  bladeRadius: 26,      // px: the blade reaches this far from the path, the body is only PLAYER.radius
  finalArcRadius: 46,   // px: the closing slash arc kills within this of the end point, forward half only
  lungeConeDegrees: 12, // lunge assist considers enemies within this angle of the aim line
  lungeMaxDistance: 275, // px: lunge assist extends a dash to an enemy up to this far out
  exitGrace: 0.18,      // seconds of invulnerability after a dash that killed nothing
  killGrace: 0.25,      // seconds of invulnerability after a dash that killed something (refreshed by each kill)
  whiffRadius: 60,      // px: a dash that kills nothing but passes this close to an enemy emits dashWhiff
  bulletCutScore: 5,    // points for destroying an enemy bullet with the dash (no combo, no charge refund)
};

export const PULSE = {
  radius: 110,          // px
  cooldown: 2.5,        // seconds
  stagger: 0.7,         // seconds an enemy is stunned by a pulse (placeholder)
  perfectWindow: 0.12,  // a bullet this close (seconds) to impact makes the pulse perfect
  reflectSpeedScale: 2, // reflected bullets fly back at this multiple of their speed (placeholder)
  reflectLife: 2.5,     // seconds a reflected bullet stays alive
  slowmoDuration: 0.35, // seconds of world slow-motion after a perfect pulse (placeholder)
  slowmoScale: 0.3,     // world time scale during slow-motion (placeholder)
};

export const COMBO = {
  window: 2.5,               // seconds the combo timer starts at
  windowMin: 1.6,            // floor for the shrinking timer at high combo (placeholder)
  windowShrinkPerCombo: 0.03,
  multiplierStep: 5,         // multiplier = 1 + floor(combo / multiplierStep)
  multiplierCap: 10,
  tiers: [5, 10, 20, 30],    // combo counts where the colour tier steps up (placeholder)
  multiBonus: 25,            // bonus points per kill after the first in one slash, before multiplier (placeholder)
};

// Enemy data. Each kind's behaviour lives in ENEMY_KINDS in game.js; adding a kind is one entry here
// plus one entry there. minWave/weight control how often the spawner picks the kind.
export const ENEMY = {
  drifter: {
    radius: 13,
    points: 10,
    minWave: 1,
    weight: 6,
    speed: 95,          // px/s chase speed
    steer: 3,           // velocity blend rate per second (placeholder)
  },
  spitter: {
    radius: 16,
    points: 20,
    minWave: 2,
    weight: 3,
    speed: 120,
    minRange: 200,      // backs away inside this distance
    maxRange: 320,      // closes in beyond this distance
    fireRange: 620,     // only shoots inside this distance
    fireInterval: 2.2,  // seconds between shots
    firstShotDelay: 1.2,
    windup: 0.35,       // seconds of visible aim line before a shot is released (aim locks at wind-up start)
    postDashQuiet: 0.15, // no wind-up starts during a dash or this long after one (it simply waits)
    bulletSpeed: 240,   // px/s
    bulletRadius: 6,
    bulletLife: 4,      // seconds
  },
  charger: {
    radius: 15,
    points: 25,
    minWave: 3,
    weight: 2,
    idleSpeed: 60,
    triggerRange: 460,      // starts a charge inside this distance
    cooldown: 2.4,          // seconds between charges
    firstCooldownMin: 1.0,  // first charge comes after a random delay in this range
    firstCooldownMax: 2.0,
    telegraph: 0.6,         // seconds of flash and aim line before the lunge
    lungeTime: 0.55,        // seconds
    lungeSpeed: 640,        // px/s, about 350 px per lunge
  },
};

export const SPAWN = {
  warning: 0.9,           // seconds of spawn-warning marker before an enemy appears
  firstSpawnDelay: 1.0,
  edgeInset: 40,          // spawns sit on the arena edge inset this far in
  minDistFromPlayer: 280, // never spawn this close to the player
  maxAlive: 45,           // enemies plus warnings
  waveDuration: 14,       // seconds per wave (placeholder)
  baseInterval: 1.6,      // seconds between spawn bursts in wave 1
  intervalStep: 0.08,     // interval shrinks by this much per wave
  minInterval: 0.35,
  safeTime: 0.4,          // newly spawned enemies cannot hurt for this long
};

export const HIGH_SCORE_KEY = 'riptide-rush.highScore';
