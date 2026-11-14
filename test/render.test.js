// Renderer hook-ups for the #114 enemies and their hazards (#129). These run the real drawFrame against a recording
// context: no canvas, no window. They check what reaches the art, what telegraphs, and that the Warden's intro and
// death draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENEMY } from '../src/config.js';
import { createGame, spawnEnemy } from '../src/game.js';
import { createFx } from '../src/fx.js';
import { drawFrame, lureNext, telegraphOf, typeOpts } from '../src/render.js';
import { DEFAULT_SETTINGS, computeLayout, createHud, hudUpdate } from '../src/hud.js';

// A canvas stub that records every drawing call, and every fillText string.
function stubCtx(w, h) {
  const calls = {};
  const texts = [];
  const target = { canvas: { width: w, height: h }, globalAlpha: 1, font: '', fillStyle: '', shadowBlur: 0 };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...args) => {
        (calls[key] ??= []).push(args);
        if (key === 'fillText') texts.push(String(args[0]));
      };
    },
    set(t, key, value) {
      t[key] = value;
      return true;
    },
  });
  return { ctx, calls, texts };
}

const L = computeLayout(1280, 720);

// A playing game with one enemy of `kind` at the arena centre, and nothing else on the field.
function gameWith(kind, wave = 10) {
  const game = createGame(3);
  game.enemies = [];
  game.warnings = [];
  game.bullets = [];
  game.player.x = 200;
  game.player.y = 360;
  game.player.px = 200;
  game.player.py = 360;
  const e = spawnEnemy(game, kind, 640, 360, wave);
  e.px = e.x;
  e.py = e.y;
  return { game, e };
}

function frame(game, { time = 1, hud = createHud() } = {}) {
  const { ctx, calls, texts } = stubCtx(1280, 720);
  const fx = createFx({ random: () => 0.5 });
  drawFrame(ctx, {
    screen: 'playing',
    game,
    alpha: 0,
    time,
    dt: 1 / 60,
    highScore: 0,
    newBest: false,
    overAge: 0,
    muted: false,
    fx,
    rings: [],
    layout: L,
    hud,
    settings: DEFAULT_SETTINGS,
    menuRow: 0,
  });
  return { calls, texts };
}

const NEW_KINDS = ['puffer', 'shieldbearer', 'inksquid', 'phaseeel', 'warden'];

test('every #114 kind draws its own art, not the ? fallback', () => {
  for (const kind of NEW_KINDS) {
    const { game } = gameWith(kind);
    const { texts } = frame(game);
    assert.ok(!texts.includes('?'), `${kind}: drew the ? fallback`);
  }
});

test('typeOpts: the puffer inflates with its swell, and flashes only while swelling', () => {
  const idle = typeOpts({ kind: 'puffer', swell: 0, swelling: false }, 1);
  assert.equal(idle.inflate, 0);
  assert.equal(idle.flash, 0);
  const swelling = typeOpts({ kind: 'puffer', swell: 0.5, swelling: true }, 1);
  assert.equal(swelling.inflate, 0.5);
  assert.ok(swelling.flash > 0, 'a swelling puffer flashes');
});

test('typeOpts: a shield bearer draws its aura only while it is up, at its own radius', () => {
  assert.equal(typeOpts({ kind: 'shieldbearer', aura: false, auraRadius: 120 }, 1).aura, 0);
  assert.equal(typeOpts({ kind: 'shieldbearer', aura: true, auraRadius: 120 }, 1).aura, 120);
  assert.equal(typeOpts({ kind: 'shieldbearer', aura: true }, 1).aura, ENEMY.shieldbearer.auraRadius);
});

test('typeOpts: a phase eel is hidden exactly when the sim says it is not visible', () => {
  assert.equal(typeOpts({ kind: 'phaseeel', visible: false }, 1).visibility, 0);
  assert.equal(typeOpts({ kind: 'phaseeel', visible: true }, 1).visibility, 1);
});

test('typeOpts: the Warden passes its phase, its hit points and its weak point', () => {
  const closed = typeOpts({ kind: 'warden', phase: 2, exposed: false, hp: 9, maxHp: 14 }, 1);
  assert.equal(closed.phase, 2);
  assert.equal(closed.hp, 9);
  assert.equal(closed.maxHp, 14);
  assert.equal(closed.vulnerable, 0, 'a closed weak point does not glow');
  // The core lights up over a short ramp from the frame it opens, so it is dim on that frame and bright after.
  const boss = { kind: 'warden', phase: 1, exposed: true, hp: 9, maxHp: 14 };
  assert.equal(typeOpts(boss, 1).vulnerable, 0, 'dim on the frame it opens');
  const open = typeOpts(boss, 1.5);
  assert.equal(open.phase, 1);
  assert.ok(open.vulnerable > 0.5, 'a little later the open weak point glows');
});

test('telegraphs: a swell, a ripple and a Warden telegraph run 0 to 1 over their own timers', () => {
  assert.equal(telegraphOf({ kind: 'puffer', swell: 0.5, swelling: true }), 0.5);
  assert.equal(telegraphOf({ kind: 'puffer', swell: 0, swelling: false }), 0);
  const rip = ENEMY.phaseeel.rippleTime;
  assert.ok(Math.abs(telegraphOf({ kind: 'phaseeel', state: 'ripple', stateT: rip }) - 0.4) < 1e-9, 'readable on its first frame');
  assert.ok(Math.abs(telegraphOf({ kind: 'phaseeel', state: 'ripple', stateT: 0 }) - 1) < 1e-9, 'full at the surfacing');
  assert.equal(telegraphOf({ kind: 'phaseeel', state: 'hidden', stateT: 1 }), 0);
  const w1 = ENEMY.warden.telegraph;
  assert.ok(Math.abs(telegraphOf({ kind: 'warden', state: 'telegraph', phase: 1, stateT: w1 / 4 }) - 0.75) < 1e-9);
  const w2 = ENEMY.warden.phase2Telegraph;
  assert.ok(Math.abs(telegraphOf({ kind: 'warden', state: 'telegraph', phase: 2, stateT: w2 / 2 }) - 0.5) < 1e-9);
  assert.equal(telegraphOf({ kind: 'warden', state: 'expose', phase: 1, stateT: 0.3 }), 0);
});

test('lureNext: the telegraph announces the lure on the same snap the sim spawns it', () => {
  // Phase 1: a lure every 6 s over 3 s cycles, so every second snap.
  assert.equal(lureNext({ phase: 1, snaps: 0 }), false);
  assert.equal(lureNext({ phase: 1, snaps: 1 }), true);
  // Phase 2: 2 s cycles, so every third snap.
  assert.equal(lureNext({ phase: 2, snaps: 1 }), false);
  assert.equal(lureNext({ phase: 2, snaps: 2 }), true);
});

test('a Puffer swelling, arcs in flight, puddles and shards all draw without the fallback', () => {
  const { game } = gameWith('puffer');
  game.enemies[0].swelling = true;
  game.enemies[0].swell = 0.6;
  game.extras.puddles.push({ id: 900, x: 300, y: 300, r: 60, t: 0.5, dur: 3, alive: true });
  game.extras.shells.push({
    id: 901, from: 1, sx: 500, sy: 300, lx: 600, ly: 360, x: 550, y: 330, t: 0.4, dur: 1, state: 'flight', alive: true,
  });
  game.extras.shells.push({
    id: 902, from: 1, sx: 500, sy: 300, lx: 600, ly: 360, x: 580, y: 350, t: 0.9, dur: 1, state: 'reflect', alive: true,
  });
  game.extras.shards.push({ id: 903, x: 400, y: 400, vx: 200, vy: 0, travelled: 10, chain: { n: 1 }, alive: true });
  const { texts, calls } = frame(game);
  assert.ok(!texts.includes('?'));
  assert.ok(calls.arc && calls.arc.length > 0, 'the arena draws arcs');
  assert.ok(calls.fill && calls.fill.length > 0);
});

test("the Warden's intro shows its name over the arena on arrival, and the banner clears", () => {
  const { game } = gameWith('warden');
  const hud = createHud();
  const arrival = frame(game, { time: 5, hud });
  assert.ok(arrival.texts.filter((s) => s === 'ANGLERFISH WARDEN').length >= 2, 'the banner and the bar both name it');
  const later = frame(game, { time: 9, hud });
  assert.equal(later.texts.filter((s) => s === 'ANGLERFISH WARDEN').length, 1, 'only the bar is left');
});

test('the Warden fall: DEFEATED shows on the bar and the death rings draw', () => {
  const { game, e } = gameWith('warden');
  const hud = createHud();
  hudUpdate(hud, 1 / 60, game, L);
  frame(game, { time: 5, hud });
  e.alive = false;
  game.enemies = [];
  hudUpdate(hud, 1 / 60, game, L);
  const fallen = frame(game, { time: 5.1, hud });
  assert.ok(fallen.texts.includes('DEFEATED'), 'the bar reads DEFEATED for a moment');
  assert.ok(fallen.calls.arc && fallen.calls.arc.length > 0, 'the death rings draw');
});

test('the Warden telegraph shows the lure ring only on a lure snap', () => {
  const { game, e } = gameWith('warden');
  e.state = 'telegraph';
  e.phase = 1;
  e.snaps = 1; // the next snap is the lure one
  e.stateT = ENEMY.warden.telegraph / 2;
  const withLure = frame(game, { time: 2 });
  e.snaps = 0; // the next snap is not
  const withoutLure = frame(game, { time: 2 });
  const dashed = (r) => (r.calls.setLineDash ?? []).filter((c) => c[0].length === 2 && c[0][0] === 8).length;
  assert.ok(dashed(withLure) > dashed(withoutLure), 'a lure snap draws the dashed lure ring');
});
