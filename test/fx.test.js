import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFx,
  FX_PRESETS,
  FX_MAX_PARTICLES,
  SHAKE_MAX_OFFSET,
  SHAKE_DECAY_S,
  HITSTOP_MAX_S,
} from '../src/fx.js';

// Seeded PRNG so every run is repeatable.
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// Canvas stand-in: any method call is a no-op, any property write is kept.
function stubCtx() {
  const store = {};
  const calls = { n: 0 };
  return new Proxy(store, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'createRadialGradient') {
        return () => ({ addColorStop() {} });
      }
      calls.n++;
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

test('pool cap is respected and oldest particles are recycled', () => {
  const fx = createFx({ random: seeded(7) });
  for (let i = 0; i < 100; i++) fx.burst(100 + i, 100, { count: 50, life: 5 });
  assert.equal(fx.count(), FX_MAX_PARTICLES);
  assert.equal(FX_MAX_PARTICLES, 1500);
  // Still at the cap after more spawning, never above it.
  fx.burst(0, 0, { count: 400, life: 5 });
  assert.equal(fx.count(), FX_MAX_PARTICLES);
});

test('particles expire after their lifetime', () => {
  const fx = createFx({ random: seeded(3) });
  fx.burst(640, 360, { count: 40, life: 0.3, shape: 'spark' });
  fx.burst(640, 360, { count: 10, life: 0.3, shape: 'ring', speed: 200 });
  assert.ok(fx.count() > 0);
  for (let i = 0; i < 60; i++) fx.update(1 / 60); // 1 simulated second
  assert.equal(fx.count(), 0);
  assert.equal(fx.stats().trails, 0);
});

test('hit-stop returns 0 then recovers back to 1', () => {
  const fx = createFx({ random: seeded(11) });
  fx.hitstop(50);
  assert.equal(fx.update(1 / 120), 0);
  assert.equal(fx.update(1 / 120), 0);
  const seen = [];
  for (let i = 0; i < 60; i++) seen.push(fx.update(1 / 120));
  // Recovery is monotonic and lands on 1.
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1] - 1e-12);
  assert.equal(seen[seen.length - 1], 1);
  assert.ok(seen.some((v) => v > 0 && v < 1), 'eases through intermediate values');
});

test('stacked hit-stop is capped near 120 ms', () => {
  const fx = createFx({ random: seeded(5) });
  fx.hitstop(1000);
  fx.hitstop(1000);
  fx.hitstop(1000);
  let zeroFrames = 0;
  for (let i = 0; i < 100; i++) {
    if (fx.update(0.01) === 0) zeroFrames++;
  }
  // 120 ms of 10 ms frames is about 12 zero frames, not the 300 a raw stack would give.
  assert.ok(zeroFrames >= 11 && zeroFrames <= 14, `zeroFrames=${zeroFrames}`);
  assert.equal(HITSTOP_MAX_S, 0.12);
});

test('slow-mo scales the simulation and eases back to 1', () => {
  const fx = createFx({ random: seeded(9) });
  fx.slowmo(0.3, 220);
  assert.ok(Math.abs(fx.update(1 / 60) - 0.3) < 1e-9);
  let last = 0;
  for (let i = 0; i < 60; i++) last = fx.update(1 / 60);
  assert.equal(last, 1);
});

test('shake decays to zero within about 0.3 s', () => {
  const fx = createFx({ random: seeded(13) });
  fx.shake(1);
  const first = fx.getShakeOffset();
  assert.ok(Math.hypot(first.x, first.y) > 0, 'shake produces an offset');
  let maxSeen = 0;
  for (let i = 0; i < 40; i++) {
    fx.update(1 / 120);
    const o = fx.getShakeOffset();
    maxSeen = Math.max(maxSeen, Math.abs(o.x), Math.abs(o.y));
  }
  assert.ok(maxSeen <= SHAKE_MAX_OFFSET + 1e-9, 'offset is bounded by the cap');
  // 40 steps of 1/120 s is 0.333 s, past SHAKE_DECAY_S.
  assert.ok(0.333 > SHAKE_DECAY_S);
  const after = fx.getShakeOffset();
  assert.equal(after.x, 0);
  assert.equal(after.y, 0);
});

test('shake trauma is capped at 1', () => {
  const fx = createFx({ random: seeded(17) });
  fx.shake(5);
  fx.shake(5);
  assert.equal(fx.stats().trauma, 1);
  const o = fx.getShakeOffset();
  assert.ok(Math.abs(o.x) <= SHAKE_MAX_OFFSET + 1e-9);
  assert.ok(Math.abs(o.y) <= SHAKE_MAX_OFFSET + 1e-9);
});

test('no NaN after 10 simulated seconds of random calls', () => {
  const rnd = seeded(42);
  const fx = createFx({ random: rnd });
  const ctx = stubCtx();
  const presetNames = Object.keys(FX_PRESETS);
  const dt = 1 / 120;
  for (let step = 0; step < 1200; step++) {
    const roll = rnd();
    const x = rnd() * 1280;
    const y = rnd() * 720;
    if (roll < 0.25) fx.burst(x, y, { count: Math.floor(rnd() * 30), life: rnd() * 1.5, speed: rnd() * 500, shape: ['spark', 'dot', 'ring', 'shard'][Math.floor(rnd() * 4)] });
    else if (roll < 0.4) fx.trail(x, y, rnd() * 6.3, { length: rnd() * 60 });
    else if (roll < 0.5) fx.floater(x, y, String(Math.floor(rnd() * 1000)), { size: 12 + rnd() * 40, life: rnd() * 1.2 });
    else if (roll < 0.55) fx.shake(rnd());
    else if (roll < 0.6) fx.hitstop(rnd() * 150);
    else if (roll < 0.63) fx.slowmo(rnd(), rnd() * 300);
    else if (roll < 0.66) fx.flash('#ffffff', rnd());
    else if (roll < 0.69) fx.vignette('#ff3d81', rnd());
    else if (roll < 0.8) fx.preset(presetNames[Math.floor(rnd() * presetNames.length)], x, y, { angle: rnd() * 6.3 });

    const scale = fx.update(dt);
    assert.ok(Number.isFinite(scale), `scale finite at step ${step}`);
    assert.ok(scale >= 0 && scale <= 1, `scale in [0,1] at step ${step}`);
    const o = fx.getShakeOffset();
    assert.ok(Number.isFinite(o.x) && Number.isFinite(o.y), `offset finite at step ${step}`);
    assert.ok(fx.count() <= FX_MAX_PARTICLES);
    if (step % 20 === 0) {
      fx.drawWorld(ctx);
      fx.drawScreen(ctx, 1280, 720);
    }
  }
  const s = fx.stats();
  assert.ok(Number.isFinite(s.trauma));
  assert.ok(s.particles >= 0 && s.particles <= FX_MAX_PARTICLES);
});

test('every preset plays and returns true, unknown names return false', () => {
  const fx = createFx({ random: seeded(21) });
  for (const name of Object.keys(FX_PRESETS)) {
    assert.equal(fx.preset(name, 320, 240, { angle: 0.5 }), true, name);
  }
  assert.equal(fx.preset('nope', 0, 0), false);
  for (const name of ['kill', 'multiKill', 'dashStart', 'hurt', 'pulse', 'reflect', 'perfectPulse', 'spawn', 'mineExplode', 'comboTierUp']) {
    assert.ok(FX_PRESETS[name], `preset ${name} exported`);
  }
});

test('drawWorld and drawScreen run against a canvas context', () => {
  const fx = createFx({ random: seeded(31) });
  fx.preset('multiKill', 400, 300);
  fx.trail(400, 300, 0.3);
  fx.floater(400, 260, '+120', { color: '#ffe066' });
  fx.flash('#ffffff', 0.5);
  fx.vignette('#ff3d81', 0.5);
  const ctx = stubCtx();
  fx.update(1 / 60);
  assert.doesNotThrow(() => fx.drawWorld(ctx));
  assert.doesNotThrow(() => fx.drawScreen(ctx, 1280, 720));
  // Missing ctx is a no-op, not a throw.
  assert.doesNotThrow(() => fx.drawWorld(undefined));
});

test('simulation never touches window or document at import time', async () => {
  const savedWindow = globalThis.window;
  const savedDocument = globalThis.document;
  assert.equal(typeof savedWindow, 'undefined');
  assert.equal(typeof savedDocument, 'undefined');
  const mod = await import('../src/fx.js');
  assert.equal(typeof mod.createFx, 'function');
});
