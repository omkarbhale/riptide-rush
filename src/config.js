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
  bounceDistance: 80,   // px Rip is pushed back when a dash runs into a Shellback's armour (#85: readable bounce)
  bounceTime: 0.4,      // seconds of bounce, invulnerable; the dash's charge is refunded (#85)
};

export const PULSE = {
  radius: 110,          // px
  cooldown: 2.5,        // seconds
  stagger: 0.7,         // seconds an enemy is stunned by a pulse (placeholder)
  perfectWindow: 0.12,  // a bullet this close (seconds) to impact makes the pulse perfect
  perfectBonus: 150,    // points awarded by a perfect pulse (flat, not multiplied by the combo)
  reflectSpeedScale: 2, // reflected bullets fly back at this multiple of their speed (placeholder)
  reflectLife: 2.5,     // seconds a reflected bullet stays alive
  slowmoDuration: 0.35, // seconds of world slow-motion after a perfect pulse (placeholder)
  slowmoScale: 0.3,     // world time scale during slow-motion (placeholder)
};

export const COMBO = {
  window: 2.5,               // seconds the combo timer starts at (x1)
  windowMin: 1.6,            // the timer shrinks linearly with the multiplier and floors here at x10 (issue #11)
  multiplierStep: 5,         // multiplier = 1 + floor(combo / multiplierStep)
  multiplierCap: 10,
  tiers: [10, 20, 30, 40],   // combo counts where the colour tier steps up: cyan 0-9, green 10-19, gold 20-29, magenta 30-39, white 40+ (DESIGN §3.7, #58)
  multiBonus: 25,            // bonus points per kill after the first in one slash, before multiplier (placeholder)
};

// Hit-stop numbers for presentation (issue #9). The sim only attaches them to kill events.
export const HITSTOP = {
  single: 40,                // ms for a single kill
  perExtraKill: 10,          // ms added for each further kill in the same dash or pulse
  max: 100,                  // ms cap
};

// Enemy data. Each kind's behaviour lives in ENEMY_KINDS in game.js; adding a kind is one entry here
// plus one entry there. Which kinds appear, and when, is the wave script in waves.js.
// Scores use the same scale as drifter (10). docs/DESIGN.md §7.3 is on a 10x scale (drifter 100);
// the new kinds below are that table divided by 10 so the ratios hold.
export const ENEMY = {
  drifter: {
    radius: 13,
    points: 10,
    speed: 95,          // px/s chase speed
    steer: 3,           // velocity blend rate per second (placeholder)
    schoolSpeed: 0.8,   // a school's anchor swims at this fraction of chase speed (#97: schools)
    slotSpeed: 1.3,     // a member closing on its formation slot may move at this multiple of chase speed
    chaseRange: 120,    // px: inside this a member breaks formation and chases Rip directly
  },
  spitter: {
    radius: 16,
    points: 20,
    speed: 120,
    minRange: 200,      // backs away inside this distance
    maxRange: 320,      // closes in beyond this distance
    fireRange: 620,     // only shoots inside this distance
    fireInterval: 2.2,  // seconds between shots
    firstShotDelay: 2.0,  // first shot waits this long after the wind-up of the first spawn (#97 beginner ramp)
    windup: 0.35,       // seconds of visible aim line before a shot is released (aim locks at wind-up start)
    aimLength: 300,     // px of the wind-up aim line drawn along the locked direction
    postDashQuiet: 0.15, // no wind-up starts during a dash or this long after one (it simply waits)
    bulletSpeed: 150,   // px/s at wave 2; bullets speed up by bulletSpeedPerWave each wave, up to bulletSpeedMax
    bulletSpeedPerWave: 6,
    bulletSpeedMax: 260,
    bulletRadius: 6,
    bulletLife: 4,      // seconds
  },
  charger: {
    radius: 15,
    points: 25,
    idleSpeed: 60,
    triggerRange: 460,      // starts a charge inside this distance
    cooldown: 2.4,          // seconds between charges
    firstCooldownMin: 1.0,  // first charge comes after a random delay in this range
    firstCooldownMax: 2.0,
    telegraph: 0.6,         // seconds of flash and aim line before the lunge
    lungeTime: 0.55,        // seconds
    lungeSpeed: 640,        // px/s, about 350 px per lunge
  },
  shellback: {
    radius: 22,
    points: 25,             // design 250
    speed: 55,              // px/s advance along its facing
    turnRate: 1.5,          // rad/s, how fast it turns toward Rip
    armorHalfAngle: Math.PI / 3, // armour covers the front arc, facing ±60°
    staggerTime: 1.5,       // seconds of armour off (and no movement) after a Pulse
  },
  splitter: {
    radius: 20,
    points: 12,             // design 120
    speed: 80,
    steer: 3,
    splitOffset: 24,        // px from the splitter's centre to each mini it spawns
    splitAngles: [0, (2 * Math.PI) / 3, (4 * Math.PI) / 3], // radians, 0 / 120 / 240 degrees
  },
  mini: {
    radius: 9,
    points: 4,              // design 40
    speed: 200,
    steer: 6,
    lifetime: 6,            // seconds, then it fades with no score
    graceTime: 0.3,         // seconds after spawn during which it cannot hurt Rip
  },
  mine: {
    radius: 12,
    points: 8,              // design 75, the defuse bonus
    armRange: 130,          // Rip this close arms the mine
    selfArmTime: 12,        // an idle mine arms itself after this long, so it cannot stall a wave (#83)
    fuse: 0.8,              // seconds from arming to detonation
    blastRadius: 90,        // px; hurts Rip and kills other enemies inside it
  },
};

// Lone enemies and waves. A lone enemy (the last of its wave, with nothing else pending) turns aggressive
// after AGGRO.loneTime, so a stalled fight is forced (#83).
export const AGGRO = {
  loneTime: 8,            // seconds an enemy must be the last of its wave before it turns aggressive
  speedMul: 1.6,          // movement speed multiple once aggressive
};

export const SPAWN = {
  warning: 0.9,           // seconds of spawn-warning marker before an enemy appears
  minDistFromPlayer: 280, // never spawn this close to the player
  safeTime: 0.4,          // newly spawned enemies cannot hurt for this long
  maxEntities: 200,       // live enemies + warnings + bullets; the wave script waits for room
  breather: 2.5,          // seconds between a release wave clearing and the next one starting
  groupLeadIn: 0.6,       // seconds from a wave starting to its first spawn
  drifterOnlyUntil: 30,   // run time (s) during which every spawn is a Drifter, to teach chaining
  stragglers: 0.15,       // the next wave starts when the current one is down to this fraction of its count
  waveTimeLimit: 14,      // seconds after which the next wave starts even if the current one has many left
  releaseTimeLimit: 24,   // a release wave waits for a clear, but never longer than this: progress cannot stop (#83)
  spitterGateDrifters: 2, // the first Spitter is released once this many Drifters or fewer are alive (#84)
  spitterGateTime: 12,    // ...and never waits longer than this many seconds after it first became due
  speedPerWave: 0.035,    // enemy movement speed grows by this fraction per wave, past wave 1, with no cap (#97)
  schoolMin: 4,           // drifter schools hold at least this many (a smaller remainder is a school of its own)
  schoolMax: 8,           // ...and at most this many, the upper bound for the school cap
  schoolCapGrowEvery: 4,  // the school cap grows by one every this many waves, from 4 at wave 1 to schoolMax
  schoolSpacing: 20,      // px between neighbours in a school's formation (tight: a dash through a school kills several)
};

// Health recovery and modifier drops (#54). Logic lives in src/pickups.js.
export const PICKUP = {
  radius: 10,             // px, touch radius of a pickup (drawn about 20 px across)
  lifetime: 7,            // seconds on the field before it despawns
  blinkWindow: 2,         // it blinks during the final seconds
  popSpeed: 150,          // px/s outward kick when dropped
  popFriction: 6,         // per-second decay of the pop
  magnetRadius: 120,      // px: pickups inside this are pulled toward the player
  magnetSpeed: 420,       // px/s pull speed
  dashCollectRadius: 60,  // px: a dash path passing this close collects a pickup
  maxOnField: 3,          // heal and modifier pickups combined
  dropSpacing: 4,         // seconds between any two drops
  overflowScore: 200,     // base points when a heal lands at full HP (x multiplier)
  heal: {
    baseChance: 0.005,    // per kill while hurt (#87: was 2%; heal orbs are rare, so recovery is earned)
    chancePerMissingHp: 0.005, // was 2% per missing hit point
    pityKills: 150,       // guaranteed after this many hurt kills without one (was 40)
    restore: 1,           // HP restored by one heal orb or a flawless wave
  },
  modifierChance: 0.015,  // per kill (#87: was 5%; recovery and power-ups are earned, not every few seconds)
  modifierPityKills: 90,  // guaranteed after this many kills without a modifier drop
  shield: {
    grace: 0.25,           // seconds of no contact damage after a shield absorbs a hit
    bounceKnockback: 0.6, // fraction of PLAYER.hitKnockback applied when a shield absorbs
  },
  undertowRadius: 90,     // px: shockwave radius released by every kill under Undertow
};

// Modifier durations and effects, one entry per kind. Stacking refreshes the timer.
export const MODIFIER = {
  sparkCoral: { duration: 5, extraCharges: 1 },           // +1 max dash charge, instant full recharge (was 8 s)
  riptideCoal: { duration: 5, comboDrainScale: 0.5 },     // combo timer drains at half speed (was 6 s)
  shieldScale: { duration: 5 },                           // absorbs the next hit (was 6 s)
  frenzy: { duration: 4, rechargeScale: 2, dashDistanceBonus: 0.25 }, // was 6 s at 3x recharge: too much sustain (#87)
  undertow: { duration: 4 },                              // kills release a shockwave (was 5 s)
};

export const HIGH_SCORE_KEY = 'riptide-rush.highScore';
