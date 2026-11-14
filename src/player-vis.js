// Player visibility and aim presentation (issue #131). Constants and pure helpers for the player's halo,
// spotlight, locator ring, dash ribbon, aim ray and crosshair. Also one shared presentation record: input.js
// writes the aim source, the raw cursor and whether the mouse has been seen, and render.js writes the player's
// position each frame (input reads it for the aim origin). The simulation never reads any of it.
// Nothing here touches window or document.

const TAU = Math.PI * 2;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Mouse aim: inside this distance (logical px) of the player, the cursor's direction is mostly jitter, so the
// last stable direction is kept. Only the aim direction is held; the dash itself is never delayed or blocked.
export const CURSOR_DEAD_ZONE = 28;

// The crosshair fades out as the cursor nears the player: invisible at `near` px, full at `far` px.
export const CROSSHAIR_FADE = Object.freeze({ near: 40, far: 60 });

// The displayed aim ray eases toward the true dash angle at this rate (1/s). Display only.
export const AIM_SMOOTH_RATE = 24;

export const HALO = Object.freeze({
  radius: 19, // px from the player's centre (the body is 14 px); the bright ring sits here
  width: 2, // the bright ring's stroke width
  rimOffset: 2.4, // the thin dark rim sits this far outside the ring...
  rimWidth: 1.4, // ...and is this thick, so the halo separates from bright water and bullets
  hurtTime: 1, // seconds the halo stays boosted after a hit (matches PLAYER.invulnAfterHit)
  crowd: 25, // enemies on screen above which the halo is boosted
  boostScale: 1.12, // the boosted halo is this much larger
  spotRadius: 64, // px: the soft dark spotlight disc under the player
  spotAlpha: 0.34, // how dark the spotlight is at its centre (it fades to nothing at the rim)
});

export const LOCATOR = Object.freeze({ time: 0.18, from: 44, to: HALO.radius }); // s, px: a ring that snaps in
export const RIBBON_FADE = 0.35; // seconds the dash ribbon takes to fade after the dash ends
export const AIM_RAY = Object.freeze({ startHalf: 2.2, endHalf: 0.4, reticle: 6.5 }); // ray half-widths and reticle (px)

// Written by input.js (source, cursor, mouseSeen) and render.js (player). `player` is null until the first frame.
export const aimPresence = { source: 'mouse', mouseSeen: false, cursor: { x: 0, y: 0 }, player: null };

// Halo look for one frame. It is boosted (a little larger, and brighter) after a hit and in a crowd. The size
// boost is not a flash, so reduced flashes keep it; the brightness boost is skipped under reduced flashes.
export function haloLook({ hurtAge, enemies, reducedFlashes = false }) {
  const hurt = hurtAge >= 0 && hurtAge < HALO.hurtTime;
  const boosted = hurt || enemies > HALO.crowd;
  return {
    radius: HALO.radius * (boosted ? HALO.boostScale : 1),
    glow: boosted && !reducedFlashes ? 1 : 0, // 0..1, extra brightness
  };
}

// The locator ring after a dash: it starts wide and contracts onto the dash end (ease-out) over LOCATOR.time.
// Null once it has finished, or before it has started.
export function locatorLook(age) {
  if (!(age >= 0) || age >= LOCATOR.time) return null;
  const k = age / LOCATOR.time;
  const e = 1 - (1 - k) ** 3;
  return { radius: LOCATOR.from + (LOCATOR.to - LOCATOR.from) * e, alpha: 0.95 * (1 - k * k) };
}

// The dash ribbon's alpha `age` seconds after the dash ended. It is full while the dash runs (age 0).
export function ribbonAlpha(age) {
  return clamp01(1 - age / RIBBON_FADE);
}

// The aim ray's look. It is bright and gold when the dash would kill, white when it would not, and faint
// when there is no dash charge to spend.
export function aimLook({ kills, charges }) {
  if (charges < 1) return { alpha: 0.22, gold: false };
  return kills ? { alpha: 1, gold: true } : { alpha: 0.6, gold: false };
}

// The angle from `origin` to `point`.
export function angleTo(origin, point) {
  return Math.atan2(point.y - origin.y, point.x - origin.x);
}

// The aim ray's end: from `origin` along `angle`, for the same distance as the dash end `previewEnd`.
// At the true dash angle this is exactly the dash preview point; the displayed angle eases toward it.
export function aimLineEnd(origin, previewEnd, angle) {
  const len = Math.hypot(previewEnd.x - origin.x, previewEnd.y - origin.y);
  return { x: origin.x + Math.cos(angle) * len, y: origin.y + Math.sin(angle) * len };
}

// Eases `current` toward `target` by the short way round. Frame-rate independent; dt 0 (paused) holds still.
export function smoothAngle(current, target, dt, rate = AIM_SMOOTH_RATE) {
  let d = (target - current) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  const k = 1 - Math.exp(-Math.max(0, Math.min(dt, 0.1)) * rate);
  return current + d * k;
}

// The crosshair's alpha for a cursor `dist` px from the player: 0 inside CROSSHAIR_FADE.near, 1 past .far.
export function crosshairAlpha(dist) {
  const k = clamp01((dist - CROSSHAIR_FADE.near) / (CROSSHAIR_FADE.far - CROSSHAIR_FADE.near));
  return k * k * (3 - 2 * k);
}
