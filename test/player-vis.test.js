// Pure parts of the player's visibility and aim presentation (issue #131): the halo look, the locator ring,
// the dash ribbon fade, the aim ray and its end point, the displayed-angle smoothing, and the crosshair fade.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGICAL_HEIGHT as H } from '../src/config.js';
import { createGame, dashPreview, spawnEnemy } from '../src/game.js';
import {
  AIM_RAY,
  CROSSHAIR_FADE,
  CURSOR_DEAD_ZONE,
  HALO,
  LOCATOR,
  RIBBON_FADE,
  aimLineEnd,
  aimLook,
  angleTo,
  crosshairAlpha,
  haloLook,
  locatorLook,
  ribbonAlpha,
  smoothAngle,
} from '../src/player-vis.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// A quiet game (no spawning) with the player at (x, y) and no enemies unless the test adds them.
function place(g, x, y) {
  const p = g.player;
  p.x = p.px = x;
  p.y = p.py = y;
  p.vx = 0;
  p.vy = 0;
  return g;
}
const quiet = (seed = 1) => createGame(seed, { spawning: false });
const freeze = (e) => {
  e.stagger = 100; // a staggered enemy does not move, so the geometry in the test holds
  e.grace = 0;
  return e;
};

// ---- aim line ---------------------------------------------------------------------------------------

test('aim line end point equals the dash preview, with and without lunge assist', () => {
  // Plain aim: no enemy in the way, so the end is the dash distance along the aim.
  const plain = place(quiet(), 300, H / 2);
  const pv1 = dashPreview(plain, 900, H / 2 + 200);
  const origin1 = { x: plain.player.x, y: plain.player.y };
  const end1 = aimLineEnd(origin1, pv1, angleTo(origin1, pv1));
  assert.ok(close(end1.x, pv1.x, 1e-6) && close(end1.y, pv1.y, 1e-6), 'plain aim ends on the preview');

  // Lunge-assisted: the drifter sits past the dash distance, so the preview is pushed out to it.
  const assisted = place(quiet(), 300, H / 2);
  freeze(spawnEnemy(assisted, 'drifter', 540, H / 2));
  const pv2 = dashPreview(assisted, 900, H / 2);
  assert.equal(pv2.kills, true);
  const origin2 = { x: assisted.player.x, y: assisted.player.y };
  const end2 = aimLineEnd(origin2, pv2, angleTo(origin2, pv2));
  assert.ok(close(end2.x, pv2.x, 1e-6) && close(end2.y, pv2.y, 1e-6), 'assisted aim ends on the preview');
});

test('aim line keeps the dash length at any displayed angle', () => {
  const origin = { x: 100, y: 100 };
  const pv = { x: 310, y: 100 }; // 210 px to the right
  const end = aimLineEnd(origin, pv, Math.PI / 2 + 0.3);
  assert.ok(close(Math.hypot(end.x - origin.x, end.y - origin.y), 210, 1e-9));
});

test('the aim ray is tapered and the reticle stays inside the arena', () => {
  assert.ok(AIM_RAY.startHalf > AIM_RAY.endHalf, 'the ray is wider at the player than at the reticle');
  assert.ok(AIM_RAY.reticle > AIM_RAY.endHalf);
});

test('aim look: gold and bright when the dash would kill, faint without a charge', () => {
  const kill = aimLook({ kills: true, charges: 2 });
  const miss = aimLook({ kills: false, charges: 2 });
  const empty = aimLook({ kills: true, charges: 0 });
  assert.equal(kill.gold, true);
  assert.equal(miss.gold, false);
  assert.ok(kill.alpha > miss.alpha, 'a killing dash reads brighter');
  assert.ok(empty.alpha < miss.alpha, 'no charge reads faintest');
  assert.equal(empty.gold, false, 'no charge is never gold');
});

// ---- displayed angle smoothing ----------------------------------------------------------------------

test('smoothing eases toward the target and converges', () => {
  let a = 0;
  for (let i = 0; i < 240; i++) a = smoothAngle(a, 1, 1 / 120);
  assert.ok(close(a, 1, 1e-3), `converged to ${a}`);
});

test('smoothing takes the short way round the circle', () => {
  // From +170 degrees to -170 degrees is 20 degrees through 180, not 340 degrees back through 0.
  const from = (170 * Math.PI) / 180;
  const to = (-170 * Math.PI) / 180;
  const next = smoothAngle(from, to, 1 / 60);
  assert.ok(next > from, 'moves forward through 180 degrees, not backward');
});

test('smoothing holds still when paused (dt 0) and never overshoots', () => {
  assert.equal(smoothAngle(0.4, 2, 0), 0.4);
  const next = smoothAngle(0, 1, 10); // a huge frame is clamped, so one step cannot pass the target
  assert.ok(next >= 0 && next <= 1);
});

// ---- crosshair fade ---------------------------------------------------------------------------------

test('the crosshair is invisible within 40 px of the player and full from 60 px out', () => {
  assert.equal(crosshairAlpha(20), 0);
  assert.equal(crosshairAlpha(CROSSHAIR_FADE.near), 0);
  assert.equal(crosshairAlpha(CROSSHAIR_FADE.far), 1);
  assert.equal(crosshairAlpha(60), 1);
  assert.equal(crosshairAlpha(300), 1);
  const mid = crosshairAlpha(50);
  assert.ok(mid > 0 && mid < 1, 'it fades rather than snapping');
});

// ---- halo -------------------------------------------------------------------------------------------

test('the halo is its normal size and brightness when nothing is wrong', () => {
  const look = haloLook({ hurtAge: Infinity, enemies: 10 });
  assert.equal(look.radius, HALO.radius);
  assert.equal(look.glow, 0);
});

test('the halo is larger and brighter just after a hit, and quiet again after the hit time', () => {
  const hit = haloLook({ hurtAge: 0.2, enemies: 3 });
  assert.ok(hit.radius > HALO.radius);
  assert.equal(hit.glow, 1);
  const later = haloLook({ hurtAge: HALO.hurtTime + 0.01, enemies: 3 });
  assert.equal(later.glow, 0);
  assert.equal(later.radius, HALO.radius);
});

test('the halo boosts above the crowd threshold, not at it', () => {
  assert.equal(haloLook({ hurtAge: Infinity, enemies: HALO.crowd }).glow, 0);
  const crowded = haloLook({ hurtAge: Infinity, enemies: HALO.crowd + 1 });
  assert.equal(crowded.glow, 1);
  assert.ok(crowded.radius > HALO.radius);
});

test('reduced flashes keep the halo size boost but skip the brightness boost', () => {
  const look = haloLook({ hurtAge: 0.1, enemies: 40, reducedFlashes: true });
  assert.equal(look.glow, 0, 'no brightness flash');
  assert.ok(look.radius > HALO.radius, 'the size boost is not a flash');
});

// ---- locator ring and ribbon ------------------------------------------------------------------------

test('the locator ring contracts from wide onto the halo over about 180 ms, then is gone', () => {
  assert.equal(locatorLook(-1), null, 'before the dash ends');
  const start = locatorLook(0);
  assert.ok(close(start.radius, LOCATOR.from, 1e-9));
  const mid = locatorLook(LOCATOR.time / 2);
  assert.ok(mid.radius < start.radius && mid.radius > HALO.radius);
  const end = locatorLook(LOCATOR.time - 1e-6);
  assert.ok(close(end.radius, HALO.radius, 0.05), 'lands on the halo');
  assert.equal(locatorLook(LOCATOR.time), null, 'done at the end of its time');
  assert.ok(close(LOCATOR.time, 0.18, 1e-9), 'about 180 ms');
});

test('the dash ribbon is full while the dash runs and fades out after it ends', () => {
  assert.equal(ribbonAlpha(0), 1);
  assert.ok(ribbonAlpha(RIBBON_FADE / 2) > 0 && ribbonAlpha(RIBBON_FADE / 2) < 1);
  assert.equal(ribbonAlpha(RIBBON_FADE), 0);
  assert.equal(ribbonAlpha(Infinity), 0);
});

test('the cursor dead zone is 28 px, the number the issue asks for', () => {
  assert.equal(CURSOR_DEAD_ZONE, 28);
});
