// Pure parts of input mapping: stick dead zones, aim vectors, gamepad edges and hot-plug reads, the
// unchanged action buffer, and the touch gesture state. Nothing here touches window or document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AIM_RANGE,
  PAD_ACTIONS,
  aimPoint,
  createActionBuffer,
  padEdges,
  padKeys,
  radialDeadZone,
  readPads,
  stableAimDirection,
  stickDirections,
} from '../src/input.js';
import { CURSOR_DEAD_ZONE } from '../src/player-vis.js';
import {
  TOUCH,
  createTouchState,
  isQuickTap,
  isTouchDevice,
  stickFromDrag,
  touchZoneAt,
  unitVector,
} from '../src/touch.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const pad = (axes = [], buttons = []) => ({ connected: true, axes, buttons: buttons.map((b) => (typeof b === 'number' ? { pressed: false, value: b } : b)) });
const button = (pressed, value = pressed ? 1 : 0) => ({ pressed, value });

// ---- stick dead zones ------------------------------------------------------------------------------

test('radial dead zone reads zero inside the zone', () => {
  assert.deepEqual(radialDeadZone(0.1, 0.1, 0.18), { x: 0, y: 0 });
  assert.deepEqual(radialDeadZone(0, 0, 0.18), { x: 0, y: 0 });
});

test('radial dead zone rescales from the edge to full deflection and keeps the direction', () => {
  // (0.6, 0) with a 0.2 zone: magnitude 0.6 maps to (0.6 - 0.2) / 0.8 = 0.5, direction unchanged.
  const v = radialDeadZone(0.6, 0, 0.2);
  assert.ok(close(v.x, 0.5));
  assert.ok(close(v.y, 0));
  // A diagonal keeps its 45 degree direction (no square-off), with magnitude just past the zone edge.
  const d = radialDeadZone(0.5, 0.5, 0.2);
  assert.ok(close(d.x, d.y));
  assert.ok(close(Math.hypot(d.x, d.y), (Math.hypot(0.5, 0.5) - 0.2) / 0.8));
});

test('radial dead zone clamps a full-deflection stick to unit magnitude', () => {
  for (const [x, y] of [[1, 0], [0, -1], [0.7071, 0.7071]]) {
    const v = radialDeadZone(x, y, 0.18);
    assert.ok(close(Math.hypot(v.x, v.y), 1, 1e-3), `magnitude of (${x}, ${y})`);
  }
  const over = radialDeadZone(1.4, 0, 0.18);
  assert.ok(close(over.x, 1));
});

test('radial dead zone treats NaN axes as centred', () => {
  assert.deepEqual(radialDeadZone(NaN, 0.5, 0.18), { x: 0, y: 0 });
});

// ---- aim vectors -----------------------------------------------------------------------------------

test('aim point sits range px from the origin along the direction', () => {
  assert.deepEqual(aimPoint({ x: 100, y: 100 }, { x: 0, y: 1 }, 200), { x: 100, y: 300 });
  const p = aimPoint({ x: 640, y: 360 }, { x: -1, y: 0 });
  assert.deepEqual(p, { x: 640 - AIM_RANGE, y: 360 });
});

test('unit vector normalises and rejects a zero vector', () => {
  const u = unitVector(3, 4);
  assert.ok(close(u.x, 0.6) && close(u.y, 0.8));
  assert.equal(unitVector(0, 0), null);
});

test('a right-stick deflection in the dead zone produces no aim', () => {
  const r = readPads([pad([0, 0, 0.1, 0.1])]);
  assert.equal(r.aim, null);
});

test('a right-stick deflection produces the unit aim direction', () => {
  const r = readPads([pad([0, 0, 0.9, 0])]);
  assert.ok(close(r.aim.x, 1) && close(r.aim.y, 0));
  const diag = readPads([pad([0, 0, -0.8, -0.8])]);
  assert.ok(close(diag.aim.x, -Math.SQRT1_2) && close(diag.aim.y, -Math.SQRT1_2));
});

// ---- stick menu steps and pad keys --------------------------------------------------------------------

test('stick directions pick each axis past the threshold', () => {
  assert.deepEqual(stickDirections(0, 0), []);
  assert.deepEqual(stickDirections(0, -0.9), ['up']);
  assert.deepEqual(stickDirections(0.9, 0.9), ['down', 'right']);
  assert.deepEqual(stickDirections(-0.5, 0), [], 'below the menu threshold');
});

test('pad keys read A and the triggers as the standard mapping defines them', () => {
  const none = { x: 0, y: 0 };
  const keys = padKeys(
    pad([], [button(true), button(false), button(false), button(false), button(false), button(false), button(false, 0.4), button(false, 0.9)]),
    none,
  );
  assert.ok(keys.has('b0'), 'A is pressed');
  assert.ok(!keys.has('b1'));
  assert.ok(!keys.has('b6'), 'left trigger at 0.4 is below the 0.5 threshold');
  assert.ok(keys.has('b7'), 'right trigger at 0.9 is pressed');
});

test('a held trigger on an analog-only pad is read by value, not by the pressed flag', () => {
  const pads = [pad([], [null, null, null, null, null, null, button(false, 0.3), button(false, 0.8)])];
  const keys = readPads(pads).keys;
  assert.ok(!keys.has('b6'));
  assert.ok(keys.has('b7'));
});

// ---- edges: a press fires once, a hold does not repeat --------------------------------------------------

test('padEdges fires actions only for keys that are newly held', () => {
  const prev = new Set();
  const now = new Set(['b0']);
  assert.deepEqual(padEdges(prev, now), ['dash', 'confirm']);
  // Still held next poll: no new action.
  assert.deepEqual(padEdges(now, now), []);
  // Released then pressed again: fires again.
  assert.deepEqual(padEdges(new Set(), now), ['dash', 'confirm']);
});

test('the Start button pauses and the d-pad and left stick navigate menus', () => {
  assert.deepEqual(padEdges(new Set(), new Set(['b9'])), ['pause']);
  assert.deepEqual(padEdges(new Set(), new Set(['b12'])), ['up']);
  assert.deepEqual(padEdges(new Set(), new Set(['ls-left'])), ['left']);
  assert.deepEqual(padEdges(new Set(), new Set(['b1'])), ['pulse']);
  assert.deepEqual(padEdges(new Set(), new Set(['b6'])), ['pulse']);
  assert.deepEqual(padEdges(new Set(), new Set(['b7'])), ['dash']);
});

test('every mapped pad key has at least one action', () => {
  for (const [key, actions] of Object.entries(PAD_ACTIONS)) {
    assert.ok(actions.length > 0, key);
  }
});

// ---- hot-plug and summing --------------------------------------------------------------------------------

test('readPads skips missing and disconnected pads', () => {
  const r = readPads([null, { connected: false, axes: [1, 0, 0, 0], buttons: [button(true)] }, pad([0.5, 0, 0, 0])]);
  // Only the connected pad counts: 0.5 past a 0.18 zone rescales to (0.5 - 0.18) / 0.82.
  assert.ok(close(r.move.x, (0.5 - 0.18) / (1 - 0.18)));
  assert.equal(r.keys.has('b0'), false);
});

test('readPads sums sticks across pads and clamps to unit range', () => {
  // Pad one pushes fully right; pad two pushes diagonally down-right. The x sum clamps at 1, y keeps pad two's 0.707.
  const r = readPads([pad([1, 0, 0, 0]), pad([1, 1, 0, 0])]);
  assert.ok(close(r.move.x, 1));
  assert.ok(close(r.move.y, Math.SQRT1_2, 1e-6));
});

test('a pad that is unplugged mid-hold produces no phantom edge', () => {
  const held = readPads([pad([], [button(true)])]).keys;
  // Unplugged: no pads at all. No keys held, so nothing new.
  assert.deepEqual(padEdges(held, readPads([]).keys), []);
});

test('stick menu steps count as a new key once per push', () => {
  const up = readPads([pad([0, -0.9])]).keys;
  assert.deepEqual(padEdges(new Set(), up), ['up']);
  assert.deepEqual(padEdges(up, up), []);
});

// ---- action buffer (unchanged behaviour) -----------------------------------------------------------------

test('a press stays armed for the buffer window and then expires', () => {
  const b = createActionBuffer(0.12);
  b.press('dash');
  assert.equal(b.has('dash'), true);
  b.tick(0.05);
  assert.equal(b.has('dash'), true, 'still armed at 50 ms');
  b.tick(0.08);
  assert.equal(b.has('dash'), false, 'expired after 130 ms');
});

test('consume returns a press once and disarms it', () => {
  const b = createActionBuffer(0.12);
  b.press('pulse');
  assert.equal(b.consume('pulse'), true);
  assert.equal(b.consume('pulse'), false);
  assert.equal(b.has('pulse'), false);
});

test('clear disarms everything', () => {
  const b = createActionBuffer(0.12);
  b.press('dash');
  b.press('pulse');
  b.clear();
  assert.equal(b.has('dash') || b.has('pulse'), false);
});

test('the default buffer window is the 120 ms from config', () => {
  const b = createActionBuffer();
  b.press('dash');
  b.tick(0.119);
  assert.equal(b.has('dash'), true);
  b.tick(0.002);
  assert.equal(b.has('dash'), false);
});

// ---- touch geometry and detection ------------------------------------------------------------------------

test('stick drag is scaled to the radius and clamped at the rim', () => {
  const half = stickFromDrag(100, 100, 100 + TOUCH.stickRadius / 2, 100);
  assert.ok(close(half.x, 0.5) && close(half.y, 0));
  const far = stickFromDrag(100, 100, 100 + TOUCH.stickRadius * 3, 100);
  assert.ok(close(far.x, 1) && close(far.y, 0));
});

test('quick tap needs both a short time and a small move', () => {
  assert.equal(isQuickTap(100, 2), true);
  assert.equal(isQuickTap(400, 2), false, 'too long');
  assert.equal(isQuickTap(100, 40), false, 'moved too far');
});

test('touch zones split the screen and claim the two corner buttons', () => {
  const W = 800;
  const H = 400;
  assert.equal(touchZoneAt(100, 200, W, H), 'stick');
  assert.equal(touchZoneAt(600, 200, W, H), 'aim');
  const pulseX = W - TOUCH.margin - TOUCH.pulseSize / 2;
  const pulseY = H - TOUCH.margin - TOUCH.pulseSize / 2;
  assert.equal(touchZoneAt(pulseX, pulseY, W, H), 'pulse');
  const pauseX = W - TOUCH.margin - TOUCH.pauseSize / 2;
  const pauseY = TOUCH.margin + TOUCH.pauseSize / 2;
  assert.equal(touchZoneAt(pauseX, pauseY, W, H), 'pause');
});

test('touch device detection needs a coarse primary pointer', () => {
  assert.equal(isTouchDevice({ matchMedia: () => ({ matches: true }) }), true);
  assert.equal(isTouchDevice({ matchMedia: () => ({ matches: false }) }), false);
  assert.equal(isTouchDevice({}), false, 'no matchMedia: desktop');
});

// ---- touch gesture state ----------------------------------------------------------------------------------

test('the left thumb drives the stick and lifting it stops the move', () => {
  const t = createTouchState();
  t.down(1, 100, 300, 0, 'stick');
  t.move(1, 100 + TOUCH.stickRadius, 300);
  assert.ok(close(t.read().move.x, 1));
  t.up(1, 100 + TOUCH.stickRadius, 300, 500);
  assert.deepEqual(t.read().move, { x: 0, y: 0 });
});

test('a still quick tap on the left half confirms, and a drag does not', () => {
  const t = createTouchState();
  t.down(1, 100, 300, 0, 'stick');
  t.up(1, 101, 301, 100);
  assert.deepEqual(t.drain(), ['confirm']);
  t.down(2, 100, 300, 0, 'stick');
  t.move(2, 200, 300);
  t.up(2, 200, 300, 100);
  assert.deepEqual(t.drain(), []);
});

test('a second thumb in the same zone is ignored', () => {
  const t = createTouchState();
  t.down(1, 100, 300, 0, 'stick');
  t.down(2, 300, 300, 0, 'stick');
  t.move(2, 400, 300);
  assert.deepEqual(t.read().move, { x: 0, y: 0 }, 'the first thumb keeps the stick, not the second');
});

test('dragging the right thumb sets the aim direction and release dashes', () => {
  const t = createTouchState();
  t.down(3, 600, 300, 0, 'aim');
  t.move(3, 600, 300 - 60);
  let v = t.read();
  assert.equal(v.aimActive, true);
  assert.ok(close(v.aimDir.x, 0) && close(v.aimDir.y, -1));
  t.up(3, 600, 240, 300);
  assert.deepEqual(t.drain(), ['dash', 'confirm']);
  v = t.read();
  assert.equal(v.aimActive, false, 'aim ends with the thumb');
  assert.ok(close(v.aimDir.y, -1), 'the released direction is kept as the facing');
});

test('a tap in the aim zone dashes along the last aim direction', () => {
  const t = createTouchState();
  t.down(3, 600, 300, 0, 'aim');
  t.move(3, 600, 300 + 40);  // establish a downward aim
  t.up(3, 600, 340, 100);
  t.drain();
  t.down(4, 600, 300, 200, 'aim');
  t.up(4, 600, 300, 250);
  assert.deepEqual(t.drain(), ['dash', 'confirm']);
  assert.ok(close(t.read().aimDir.y, 1), 'the tap keeps the earlier aim');
});

test('a small wobble inside the aim slop does not start an aim', () => {
  const t = createTouchState();
  t.down(3, 600, 300, 0, 'aim');
  t.move(3, 600 + TOUCH.aimSlop / 2, 300);
  assert.equal(t.read().aimActive, false);
  assert.equal(t.read().aimDir, null);
});

test('the pulse and pause buttons act on touch-down', () => {
  const t = createTouchState();
  t.down(5, 10, 10, 0, 'pulse');
  t.down(6, 10, 10, 0, 'pause');
  assert.deepEqual(t.drain(), ['pulse', 'pause']);
  assert.equal(t.read().pulse, true);
  t.up(5, 10, 10, 50);
  assert.equal(t.read().pulse, false);
});

test('cancelling a thumb emits nothing and clears its control', () => {
  const t = createTouchState();
  t.down(3, 600, 300, 0, 'aim');
  t.move(3, 600, 200);
  t.cancel(3);
  assert.deepEqual(t.drain(), []);
  assert.equal(t.read().aimActive, false);
  assert.equal(t.read().aim, null);
});

test('an unknown touch id is ignored', () => {
  const t = createTouchState();
  t.move(99, 0, 0);
  t.up(99, 0, 0, 0);
  assert.deepEqual(t.drain(), []);
});

// ---- mouse aim dead zone (issue #131) ----------------------------------------------------------------

test('mouse aim inside the dead zone keeps the last stable direction, whatever the jitter', () => {
  const prev = { x: 0, y: 1 };
  // The cursor wobbles left and right of the player, and each wobble is well inside 28 px.
  for (const [dx, dy] of [[5, 0], [-5, 0], [0, -20], [12, 12], [0, 0], [NaN, 0]]) {
    const s = stableAimDirection(prev, dx, dy);
    assert.equal(s.held, true, `held for offset (${dx}, ${dy})`);
    assert.equal(s.x, 0);
    assert.equal(s.y, 1);
  }
});

test('mouse aim releases to the cursor direction just outside the dead zone', () => {
  const prev = { x: 0, y: 1 };
  const outside = stableAimDirection(prev, CURSOR_DEAD_ZONE + 0.5, 0);
  assert.equal(outside.held, false);
  assert.ok(close(outside.x, 1) && close(outside.y, 0), 'the cursor direction, not the held one');
  const diag = stableAimDirection(prev, -60, 80);
  assert.equal(diag.held, false);
  assert.ok(close(Math.hypot(diag.x, diag.y), 1, 1e-9), 'a unit vector');
  assert.ok(close(diag.x, -0.6) && close(diag.y, 0.8));
});

test('the dead zone edge is inclusive at 28 px and the radius is a parameter', () => {
  const prev = { x: 1, y: 0 };
  assert.equal(stableAimDirection(prev, 0, CURSOR_DEAD_ZONE).held, true, 'exactly 28 px is still held');
  assert.equal(stableAimDirection(prev, 0, CURSOR_DEAD_ZONE + 0.01).held, false);
  assert.equal(stableAimDirection(prev, 0, 10, 5).held, false, 'a 5 px zone releases at 10 px');
});
