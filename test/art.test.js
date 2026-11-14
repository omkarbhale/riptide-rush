import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE, draw } from '../src/art.js';

const ENEMY_TYPES = ['drifter', 'spitter', 'charger', 'shellback', 'splitter', 'mini', 'mine'];

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
  for (const type of ENEMY_TYPES) {
    const { ctx, counts } = mockCtx();
    draw.enemy(ctx, type, 100, 100, 0.7, 1.234, { flash: 0.6, telegraph: 0.5 });
    assert.ok(counts.ops <= 60, `${type} issued ${counts.ops} ops`);
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
