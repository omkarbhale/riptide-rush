import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, draw } from '../src/art.js';

const ENEMY_TYPES = [
  'drifter', 'spitter', 'charger', 'shellback', 'splitter', 'mini', 'mine',
  'puffer', 'shieldbearer', 'inksquid', 'phaseeel', 'warden',
];

// A permissive mock 2D context. Every unknown method is a no-op that counts as a
// draw op, and gradients accept addColorStop. Node has no canvas, so this is the test surface.
function mockCtx() {
  const counts = { ops: 0 };
  const gradient = { addColorStop() {} };
  const target = {
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    lineWidth: 1,
    lineDashOffset: 0,
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineJoin: 'miter',
    lineCap: 'butt',
  };
  const ctx = new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'createRadialGradient' || p === 'createLinearGradient') {
        return () => gradient;
      }
      return () => {
        counts.ops++;
        return undefined;
      };
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
  return { ctx, counts };
}

const OPTION_SETS = [
  {},
  { flash: 1 },
  { telegraph: 0.5 },
  { telegraph: 1, flash: 0.4, scale: 3 },
  { hp: 1, scale: 2 },
];

test('module imports cleanly under Node and exposes the interface', () => {
  assert.equal(typeof draw.background, 'function');
  assert.equal(typeof draw.player, 'function');
  assert.equal(typeof draw.enemy, 'function');
  assert.equal(typeof draw.bullet, 'function');
  assert.equal(typeof draw.pulse, 'function');
  for (const key of ['deepTop', 'deepBottom', 'player', 'dash', 'danger', 'bullet', 'gold']) {
    assert.match(PALETTE[key], /^#[0-9a-f]{6}$/i, `PALETTE.${key} is a hex colour`);
  }
  assert.equal(PALETTE.combo.length, 5);
});

test('every enemy type draws without throwing and issues draw ops', () => {
  for (const type of ENEMY_TYPES) {
    for (const opts of OPTION_SETS) {
      const { ctx, counts } = mockCtx();
      assert.doesNotThrow(() => draw.enemy(ctx, type, 100, 100, 0.7, 1.234, opts), `${type} ${JSON.stringify(opts)}`);
      assert.ok(counts.ops > 0, `${type} issued draw ops`);
    }
  }
});

test('unknown enemy type draws nothing and does not throw', () => {
  const { ctx, counts } = mockCtx();
  assert.doesNotThrow(() => draw.enemy(ctx, 'constructor', 0, 0, 0, 0, {}));
  assert.doesNotThrow(() => draw.enemy(ctx, 'no-such-type', 0, 0, 0, 0, {}));
  assert.equal(counts.ops, 0);
});

test('every enemy type has a distinct colour from the others and from the player', () => {
  const colours = ENEMY_TYPES.map((t) => PALETTE[t]);
  assert.equal(new Set(colours).size, ENEMY_TYPES.length, 'enemy colours are pairwise distinct');
  for (const c of colours) {
    assert.notEqual(c.toLowerCase(), PALETTE.player.toLowerCase(), 'no enemy shares the player cyan');
  }
});

test('player draws in every state without throwing', () => {
  const states = [
    {},
    { dashing: true },
    { invulnerable: true },
    { charges: 3 },
    { charges: 0 },
    { dashing: true, invulnerable: true, charges: 2, scale: 2 },
  ];
  for (const opts of states) {
    const { ctx, counts } = mockCtx();
    assert.doesNotThrow(() => draw.player(ctx, 400, 300, 1.1, 2.5, opts), JSON.stringify(opts));
    assert.ok(counts.ops > 0);
  }
});

test('bullet and reflected bullet draw without throwing', () => {
  for (const opts of [{}, { reflected: true }, { scale: 3 }]) {
    const { ctx, counts } = mockCtx();
    assert.doesNotThrow(() => draw.bullet(ctx, 50, 60, 0.5, opts));
    assert.ok(counts.ops > 0);
  }
});

// A mock context that records every colour the bullet paints: fillStyle, strokeStyle and gradient stops.
function colourRecorder() {
  const seen = [];
  const gradient = { addColorStop(_at, c) { seen.push(String(c)); } };
  const target = { globalAlpha: 1, globalCompositeOperation: 'source-over', lineWidth: 1, strokeStyle: '#000000', fillStyle: '#000000' };
  const ctx = new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => gradient;
      return () => {};
    },
    set(t, p, v) {
      if (p === 'fillStyle' || p === 'strokeStyle') seen.push(String(v));
      t[p] = v;
      return true;
    },
  });
  return { ctx, seen };
}

// #143: a reflected bullet is lime in its core, glow and trail, never the player's cyan or enemy amber.
test('a reflected bullet is lime everywhere, never the player cyan or the enemy amber', () => {
  const LIME = '141,255,60';   // #8dff3c
  const CYAN = '60,242,255';   // PALETTE.player
  const AMBER = '255,179,71';  // PALETTE.bullet
  const reflected = colourRecorder();
  draw.bullet(reflected.ctx, 50, 60, 0.5, { reflected: true, vx: -200, vy: 0 });
  const all = reflected.seen.join(' ');
  assert.ok(all.includes(LIME), 'lime appears in the glow, ring or trail');
  assert.ok(!all.includes(CYAN), 'no player cyan');
  assert.ok(!all.includes(AMBER), 'no enemy amber');
  assert.ok(!all.includes('234,255,255'), 'the old reflected core (PALETTE.dash) is gone');

  const plain = colourRecorder();
  draw.bullet(plain.ctx, 50, 60, 0.5, { vx: -200, vy: 0 });
  const plainAll = plain.seen.join(' ');
  assert.ok(plainAll.includes(AMBER), 'an enemy bullet stays amber');
  assert.ok(!plainAll.includes(LIME), 'an enemy bullet is not lime');
  assert.ok(PALETTE.bullet !== '#8dff3c' && PALETTE.player !== '#8dff3c');
});

test('a bullet draws a trail only when its velocity is given', () => {
  const plain = mockCtx();
  draw.bullet(plain.ctx, 50, 60, 0.5, {});
  const moving = mockCtx();
  draw.bullet(moving.ctx, 50, 60, 0.5, { vx: 200, vy: 0 });
  assert.ok(moving.counts.ops > plain.counts.ops, 'velocity adds trail draw ops');
  const still = mockCtx();
  draw.bullet(still.ctx, 50, 60, 0.5, { vx: 0.2, vy: 0 });
  assert.equal(still.counts.ops, plain.counts.ops, 'a near-zero velocity draws no trail');
});

// Under Node the live fallback path runs (no offscreen canvas), which issues more ops than the
// cached sprite path in a browser. This bound catches a regression in the fallback.
test('an enemy costs a bounded number of draw ops, so 200 stay cheap', () => {
  // The new types are built from more path points (spines, teeth, eel segments), so they get a wider bound.
  // Browsers draw them from one cached sprite; this count is the Node live path only.
  for (const type of ENEMY_TYPES) {
    const { ctx, counts } = mockCtx();
    draw.enemy(ctx, type, 100, 100, 0.7, 1.234, { flash: 0.6, telegraph: 0.5 });
    const bound = ['puffer', 'shieldbearer', 'inksquid', 'phaseeel', 'warden'].includes(type) ? 150 : 60;
    assert.ok(counts.ops <= bound, `${type} issued ${counts.ops} ops`);
  }
});

test('pulse draws at any radius and is a no-op when fully transparent', () => {
  for (const r of [0, 1, 30, 110, 200]) {
    const { ctx } = mockCtx();
    assert.doesNotThrow(() => draw.pulse(ctx, 640, 360, r, 1));
  }
  const { ctx, counts } = mockCtx();
  draw.pulse(ctx, 640, 360, 50, 0);
  assert.equal(counts.ops, 0, 'alpha 0 draws nothing');
});

test('background draws without offscreen canvas support (Node path)', () => {
  const { ctx, counts } = mockCtx();
  assert.doesNotThrow(() => draw.background(ctx, 1280, 720, 3.2));
  assert.ok(counts.ops > 0);
});

test('draw calls tolerate missing or non-finite numeric inputs', () => {
  const { ctx } = mockCtx();
  assert.doesNotThrow(() => draw.enemy(ctx, 'mine', NaN, undefined, null, 'x', { flash: NaN, telegraph: 'high' }));
  assert.doesNotThrow(() => draw.player(ctx, 0, 0, undefined, undefined, undefined));
  assert.doesNotThrow(() => draw.pulse(ctx, 0, 0, NaN, NaN));
});

// ---- new enemies (#19, #20, #22, #24, #38) and the ink hazards (#22) ----

test('the five new enemy types each draw their own silhouette, with flash, telegraph and state variants', () => {
  const NEW = ['puffer', 'shieldbearer', 'inksquid', 'phaseeel', 'warden'];
  const variants = [
    {},
    { flash: 1 },
    { telegraph: 1 },
    { inflate: 1, aura: 90, barrier: 0.5, visibility: 0.5, phase: 2, vulnerable: 1 },
  ];
  for (const type of NEW) {
    for (const opts of variants) {
      const { ctx, counts } = mockCtx();
      assert.doesNotThrow(() => draw.enemy(ctx, type, 100, 100, 0.7, 1.234, opts), `${type} ${JSON.stringify(opts)}`);
      assert.ok(counts.ops > 0, `${type} ${JSON.stringify(opts)} draws`);
    }
  }
});

test('the phase eel draws no body while hidden, but its ripple still shows', () => {
  // The mock counts every call, transform calls included, so compare against a visible eel rather than zero.
  const hidden = mockCtx();
  draw.enemy(hidden.ctx, 'phaseeel', 0, 0, 0, 1, { visibility: 0 });
  const visibleRef = mockCtx();
  draw.enemy(visibleRef.ctx, 'phaseeel', 0, 0, 0, 1, { visibility: 1 });
  assert.ok(hidden.counts.ops < visibleRef.counts.ops, 'a hidden eel draws fewer ops than a visible one');
  const ripple = mockCtx();
  draw.enemy(ripple.ctx, 'phaseeel', 0, 0, 0, 1, { visibility: 0, telegraph: 0.8 });
  assert.ok(ripple.counts.ops > 0, 'the surfacing ripple draws while hidden');
  const visible = mockCtx();
  draw.enemy(visible.ctx, 'phaseeel', 0, 0, 0, 1, { visibility: 1 });
  assert.ok(visible.counts.ops > 0, 'a visible eel draws');
});

test('the barrier ring draws on any enemy, and a zero barrier adds nothing', () => {
  const plain = mockCtx();
  draw.enemy(plain.ctx, 'drifter', 0, 0, 0, 1, {});
  const shielded = mockCtx();
  draw.enemy(shielded.ctx, 'drifter', 0, 0, 0, 1, { barrier: 1 });
  assert.ok(shielded.counts.ops > plain.counts.ops, 'a barrier adds ring draw ops');
  const zero = mockCtx();
  draw.enemy(zero.ctx, 'drifter', 0, 0, 0, 1, { barrier: 0 });
  assert.equal(zero.counts.ops, plain.counts.ops, 'barrier 0 is no barrier');
});

test('the shield bearer aura is drawn, and an aura of 0 is not', () => {
  const withAura = mockCtx();
  draw.enemy(withAura.ctx, 'shieldbearer', 0, 0, 0, 1, { aura: 120 });
  const noAura = mockCtx();
  draw.enemy(noAura.ctx, 'shieldbearer', 0, 0, 0, 1, { aura: 0 });
  assert.ok(withAura.counts.ops > noAura.counts.ops, 'the aura adds draw ops');
});

test('hazards draw for each kind, fade with life, and unknown kinds draw nothing', () => {
  for (const kind of ['puddle', 'shadow', 'lob']) {
    const { ctx, counts } = mockCtx();
    assert.doesNotThrow(() => draw.hazard(ctx, kind, 200, 150, 60, 1.5, { life: 0.5, progress: 0.4, height: 0.7 }));
    assert.ok(counts.ops > 0, `${kind} draws`);
  }
  const unknown = mockCtx();
  assert.doesNotThrow(() => draw.hazard(unknown.ctx, 'no-such-kind', 0, 0, 60, 0, {}));
  assert.equal(unknown.counts.ops, 0);
  const zero = mockCtx();
  draw.hazard(zero.ctx, 'puddle', 0, 0, 0, 0, {});
  assert.equal(zero.counts.ops, 0, 'a zero radius draws nothing');
});

test('new enemy and hazard calls tolerate missing or non-finite inputs', () => {
  const { ctx } = mockCtx();
  assert.doesNotThrow(() => draw.enemy(ctx, 'warden', NaN, undefined, null, 'x', { phase: 9, vulnerable: 'high', aura: -5 }));
  assert.doesNotThrow(() => draw.enemy(ctx, 'phaseeel', 0, 0, 0, 0, { visibility: NaN, telegraph: 'x' }));
  assert.doesNotThrow(() => draw.hazard(ctx, 'shadow', NaN, NaN, NaN, NaN, { progress: NaN }));
});
