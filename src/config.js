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
  bounceDistance: 40,   // px Rip is pushed back when a dash runs into a Shellback's armour
  bounceTime: 0.1,      // seconds of bounce (invulnerable)
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
  window: 2.5,               // seconds the combo timer starts at (x1)
  windowMin: 1.6,            // the timer shrinks linearly with the multiplier and floors here at x10 (issue #11)
  multiplierStep: 5,         // multiplier = 1 + floor(combo / multiplierStep)
  multiplierCap: 10,
  tiers: [5, 10, 20, 30],    // combo counts where the colour tier steps up (placeholder)
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
  },
  spitter: {
    radius: 16,
    points: 20,
    speed: 120,
    minRange: 200,      // backs away inside this distance
    maxRange: 320,      // closes in beyond this distance
    fireRange: 620,     // only shoots inside this distance
    fireInterval: 2.2,  // seconds between shots
    firstShotDelay: 1.2,
    bulletSpeed: 240,   // px/s
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
    fuse: 0.8,              // seconds from arming to detonation
    blastRadius: 90,        // px; hurts Rip and kills other enemies inside it
  },
};

export const SPAWN = {
  warning: 0.9,           // seconds of spawn-warning marker before an enemy appears
  edgeInset: 40,          // spawns sit on the arena edge inset this far in
  minDistFromPlayer: 280, // never spawn this close to the player
  maxEntities: 200,       // live enemies + warnings + bullets; the wave script waits for room
  breather: 2.5,          // seconds between a wave clearing and the next one starting
  groupLeadIn: 0.6,       // seconds from a wave starting to its first spawn group
  drifterOnlyUntil: 30,   // run time (s) during which every spawn is a Drifter, to teach chaining
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
    baseChance: 0.02,     // per kill while hurt
    chancePerMissingHp: 0.02,
    pityKills: 40,        // guaranteed after this many hurt kills without one
    restore: 1,           // HP restored by one heal orb or a flawless wave
  },
  modifierChance: 0.05,   // per kill
  modifierPityKills: 30,  // guaranteed after this many kills without a modifier drop
  shield: {
    grace: 0.25,           // seconds of no contact damage after a shield absorbs a hit
    bounceKnockback: 0.6, // fraction of PLAYER.hitKnockback applied when a shield absorbs
  },
  undertowRadius: 90,     // px: shockwave radius released by every kill under Undertow
};

// Modifier durations and effects, one entry per kind. Stacking refreshes the timer.
export const MODIFIER = {
  sparkCoral: { duration: 8, extraCharges: 1 },           // +1 max dash charge, instant full recharge
  riptideCoal: { duration: 6, comboDrainScale: 0.5 },     // combo timer drains at half speed
  shieldScale: { duration: 6 },                           // absorbs the next hit
  frenzy: { duration: 6, rechargeScale: 3, dashDistanceBonus: 0.25 },
  undertow: { duration: 5 },                              // kills release a shockwave
};

export const HIGH_SCORE_KEY = 'riptide-rush.highScore';
