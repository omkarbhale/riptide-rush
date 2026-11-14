// Riptide Rush effects layer ("juice"): particles, trails, floaters, screen shake,
// hit-stop / slow-mo, and full-screen flashes and vignettes.
//
// Simulation code is pure: nothing touches window/document at import time, so this
// module runs under `node --test`. Only drawWorld/drawScreen use a canvas context,
// and only the one they are passed. All pools are preallocated; nothing allocates
// per frame inside update() or the draw functions.

export const FX_MAX_PARTICLES = 1500;
export const FX_MAX_TRAILS = 360;
export const FX_MAX_FLOATERS = 96;
export const SHAKE_MAX_OFFSET = 14; // px at full trauma
export const SHAKE_DECAY_S = 0.3; // trauma goes 1 -> 0 in this many real seconds
export const HITSTOP_MAX_S = 0.12; // stacked hit-stop is capped at this
export const HITSTOP_RECOVER_S = 0.08; // time scale eases 0 -> 1 over this window
export const FX_MAX_POPS = 48; // enemies mid squash-and-pop at once
export const POP_LIFE_S = 0.26; // a death pop lasts this long (real time)
export const KICK_MAX_PX = 8; // camera kick is capped at this many px
export const KICK_DECAY = 22; // the kick falls by e every 1 / KICK_DECAY s (real time)
// Quality steps (see setQuality): the share of burst particles spawned at each level.
export const FX_QUALITY_BURST_SCALE = Object.freeze([1, 0.6, 0.35]);

const SLOW_RECOVER_S = 0.08;
const SHAKE_FREQ = 38; // noise samples per second
const FLASH_DECAY_S = 0.22;
const VIGNETTE_DECAY_S = 0.5;
const MAX_DT = 0.1; // clamp so a long stall cannot explode the simulation
const TAU = Math.PI * 2;

const SHAPE_DOT = 0;
const SHAPE_SPARK = 1;
const SHAPE_RING = 2;
const SHAPE_SHARD = 3;
const SHAPES = { dot: SHAPE_DOT, spark: SHAPE_SPARK, ring: SHAPE_RING, shard: SHAPE_SHARD };

// Named effect presets. Each entry lists burst specs plus side effects.
// `fx.preset(name, x, y, {angle, color, intensity})` plays one.
// `directional` bursts take `angle` from the preset call.
export const FX_PRESETS = Object.freeze({
  kill: {
    bursts: [
      { count: 14, shape: 'spark', color: ['#3cf2ff', '#eaffff'], speed: 440, life: 0.42, size: 3.6, drag: 3.4 },
      { count: 8, shape: 'dot', color: '#3cf2ff', speed: 170, life: 0.5, size: 3.4, drag: 4 },
      { count: 1, shape: 'ring', color: '#3cf2ff', speed: 260, life: 0.28, size: 4.5 },
    ],
    shake: 0.18,
    hitstop: 45,
  },
  multiKill: {
    bursts: [
      { count: 26, shape: 'spark', color: ['#ffe066', '#eaffff', '#3cf2ff'], speed: 540, life: 0.55, size: 4, drag: 3 },
      { count: 8, shape: 'shard', color: ['#ffe066', '#ff3d81'], speed: 340, life: 0.65, size: 8, drag: 2.6 },
      { count: 2, shape: 'ring', color: '#ffe066', speed: 340, life: 0.38, size: 6 },
    ],
    shake: 0.4,
    hitstop: 70,
    flash: ['#ffe066', 0.18],
  },
  dashStart: {
    bursts: [
      { count: 10, shape: 'spark', directional: true, spread: 1.1, color: ['#eaffff', '#3cf2ff'], speed: 300, life: 0.24, size: 2.2, drag: 6 },
    ],
    shake: 0.04,
  },
  hurt: {
    bursts: [
      { count: 24, shape: 'shard', color: ['#ff3d81', '#ffb347', '#ffffff'], speed: 420, life: 0.7, size: 8, drag: 2.2, gravity: 120 },
      { count: 1, shape: 'ring', color: '#ff3d81', speed: 360, life: 0.4, size: 5 },
    ],
    shake: 0.7,
    hitstop: 90,
    flash: ['#ff3d81', 0.32],
    vignette: ['#ff3d81', 0.7],
  },
  pulse: {
    bursts: [
      { count: 1, shape: 'ring', color: '#3cf2ff', speed: 330, life: 0.35, size: 4.5 },
      { count: 16, shape: 'spark', color: ['#3cf2ff', '#eaffff'], speed: 260, life: 0.36, size: 2.2, drag: 4 },
    ],
    shake: 0.12,
  },
  reflect: {
    bursts: [
      { count: 1, shape: 'ring', color: '#ffb347', speed: 300, life: 0.3, size: 4 },
      { count: 18, shape: 'spark', color: ['#ffb347', '#ffe066'], speed: 360, life: 0.4, size: 2.4, drag: 3.4 },
    ],
    shake: 0.12,
    hitstop: 35,
  },
  perfectPulse: {
    bursts: [
      { count: 2, shape: 'ring', color: ['#ffe066', '#eaffff'], speed: 440, life: 0.5, size: 6 },
      { count: 30, shape: 'spark', color: ['#ffe066', '#eaffff', '#ffffff'], speed: 460, life: 0.6, size: 2.8, drag: 2.6 },
      { count: 8, shape: 'shard', color: '#ffe066', speed: 260, life: 0.6, size: 5, drag: 3 },
    ],
    shake: 0.3,
    slowmo: [0.3, 220],
    flash: ['#eaffff', 0.2],
  },
  spawn: {
    bursts: [
      { count: 10, shape: 'dot', color: ['#5dff9b', '#eaffff'], speed: 110, life: 0.5, size: 2.6, drag: 3.5 },
      { count: 1, shape: 'ring', color: '#5dff9b', speed: 130, life: 0.35, size: 3 },
    ],
  },
  mineExplode: {
    bursts: [
      { count: 18, shape: 'shard', color: ['#ff3d81', '#ffb347', '#ffe066'], speed: 430, life: 0.75, size: 6, drag: 1.8, gravity: 140 },
      { count: 1, shape: 'ring', color: '#ffb347', speed: 380, life: 0.42, size: 5.5 },
      { count: 20, shape: 'spark', color: ['#ffb347', '#ffe066'], speed: 380, life: 0.45, size: 2.4, drag: 3 },
    ],
    shake: 0.6,
    hitstop: 60,
    flash: ['#ffb347', 0.25],
  },
  comboTierUp: {
    bursts: [
      { count: 2, shape: 'ring', color: ['#5dff9b', '#ffe066'], speed: 300, life: 0.55, size: 5 },
      { count: 24, shape: 'spark', color: ['#5dff9b', '#ffe066', '#ff3d81', '#ffffff'], speed: 380, life: 0.55, size: 2.6, drag: 2.8 },
    ],
    shake: 0.1,
    flash: ['#5dff9b', 0.14],
  },
});

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeParticle() {
  return {
    alive: false,
    shape: SHAPE_DOT,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    age: 0,
    life: 1,
    size: 1,
    gravity: 0,
    drag: 0,
    color: '#ffffff',
    rot: 0,
    spin: 0,
    r1: 0,
  };
}

function makePop() {
  return { alive: false, kind: '', x: 0, y: 0, angle: 0, age: 0, life: POP_LIFE_S };
}

function makeTrail() {
  return { alive: false, x: 0, y: 0, angle: 0, age: 0, life: 1, length: 40, width: 20, color: '#eaffff', alpha: 0.6 };
}

function makeFloater() {
  return { alive: false, x: 0, y: 0, text: '', color: '#ffe066', size: 28, font: '', age: 0, life: 1 };
}

// Create one independent effects instance. `options.random` (default Math.random)
// makes the simulation deterministic under test.
export function createFx(options = {}) {
  const random = typeof options.random === 'function' ? options.random : Math.random;

  const particles = new Array(FX_MAX_PARTICLES);
  for (let i = 0; i < FX_MAX_PARTICLES; i++) particles[i] = makeParticle();
  let pHead = 0;
  let pLive = 0;

  const trails = new Array(FX_MAX_TRAILS);
  for (let i = 0; i < FX_MAX_TRAILS; i++) trails[i] = makeTrail();
  let tHead = 0;
  let tLive = 0;

  const floaters = new Array(FX_MAX_FLOATERS);
  for (let i = 0; i < FX_MAX_FLOATERS; i++) floaters[i] = makeFloater();
  let fHead = 0;
  let fLive = 0;

  // Hit-stop and slow-mo timers (seconds). Both use real time.
  let hold = 0;
  let recoverT = 0;
  let slowT = 0;
  let slowScale = 1;

  // Trauma shake. Two independent smooth-noise tables, one per axis.
  let trauma = 0;
  let shakeT = 0;
  const noiseX = new Float32Array(256);
  const noiseY = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    noiseX[i] = random() * 2 - 1;
    noiseY[i] = random() * 2 - 1;
  }
  const shakeOut = { x: 0, y: 0 };

  let flashColor = '#ffffff';
  let flashPeak = 0;
  let flashLeft = 0;
  let vigColor = '#000000';
  let vigPeak = 0;
  let vigLeft = 0;
  let vigDur = VIGNETTE_DECAY_S;

  // Presentation-only state (presets and the renderer never read it back into the simulation).
  let quality = 0; // index into FX_QUALITY_BURST_SCALE; 0 is full detail
  const pops = new Array(FX_MAX_POPS);
  for (let i = 0; i < FX_MAX_POPS; i++) pops[i] = makePop();
  let popHead = 0;
  const kickOut = { x: 0, y: 0 };
  let kickX = 0;
  let kickY = 0;
  const dark = { x: 0, y: 0, alpha: 0, life: 0, dur: 1 };

  function pick(color) {
    if (Array.isArray(color)) {
      if (color.length === 0) return '#ffffff';
      return color[Math.min(color.length - 1, Math.floor(random() * color.length))];
    }
    return color;
  }

  function allocParticle() {
    // Slots are handed out in ring order, so the slot reused here is always the oldest.
    const p = particles[pHead];
    pHead = (pHead + 1) % FX_MAX_PARTICLES;
    if (!p.alive) {
      p.alive = true;
      pLive++;
    }
    return p;
  }

  function burst(x, y, opts = {}) {
    // Quality lowers the count (never below one particle for a request of one or more).
    const want = Math.max(0, Math.floor(opts.count ?? 12));
    const count = want === 0 ? 0 : Math.max(1, Math.floor(want * FX_QUALITY_BURST_SCALE[quality]));
    const shape = SHAPES[opts.shape ?? 'dot'] ?? SHAPE_DOT;
    const speed = opts.speed ?? 240;
    const spread = opts.spread ?? TAU;
    const baseAngle = opts.angle ?? 0;
    const life = Math.max(0.01, opts.life ?? 0.5);
    const size = opts.size ?? 3;
    const gravity = opts.gravity ?? 0;
    const drag = opts.drag ?? 0;
    const color = opts.color ?? '#ffffff';
    for (let i = 0; i < count; i++) {
      const p = allocParticle();
      const a = spread >= TAU ? random() * TAU : baseAngle + (random() - 0.5) * spread;
      const pLife = life * (0.8 + 0.4 * random());
      p.shape = shape;
      p.x = x;
      p.y = y;
      p.age = 0;
      p.life = pLife;
      p.size = size * (0.75 + 0.5 * random());
      p.gravity = gravity;
      p.drag = drag;
      p.color = pick(color);
      p.rot = a;
      p.spin = (random() - 0.5) * 12;
      if (shape === SHAPE_RING) {
        // Rings hold position and expand: r1 is the final radius.
        p.vx = 0;
        p.vy = 0;
        p.r1 = speed * pLife * (0.85 + 0.3 * random());
      } else {
        const sp = speed * (0.45 + 0.55 * random());
        p.vx = Math.cos(a) * sp;
        p.vy = Math.sin(a) * sp;
        p.r1 = 0;
      }
    }
  }

  function trail(x, y, angle, opts = {}) {
    const p = trails[tHead];
    tHead = (tHead + 1) % FX_MAX_TRAILS;
    if (!p.alive) {
      p.alive = true;
      tLive++;
    }
    p.x = x;
    p.y = y;
    p.angle = angle;
    p.age = 0;
    p.life = Math.max(0.01, opts.life ?? 0.22);
    p.length = opts.length ?? 44;
    p.width = opts.width ?? 22;
    p.color = opts.color ?? '#eaffff';
    p.alpha = clamp(opts.alpha ?? 0.6, 0, 1);
  }

  function floater(x, y, text, opts = {}) {
    const p = floaters[fHead];
    fHead = (fHead + 1) % FX_MAX_FLOATERS;
    if (!p.alive) {
      p.alive = true;
      fLive++;
    }
    const size = opts.size ?? 28;
    p.x = x;
    p.y = y;
    p.text = String(text);
    p.color = opts.color ?? '#ffe066';
    p.size = size;
    p.font = `800 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    p.age = 0;
    p.life = Math.max(0.05, opts.life ?? 0.9);
  }

  function shake(amount) {
    const a = Number(amount) || 0;
    if (a <= 0) return;
    trauma = Math.min(1, trauma + a);
  }

  function hitstop(ms) {
    const s = Math.max(0, Number(ms) || 0) / 1000;
    hold = Math.min(HITSTOP_MAX_S, hold + s);
  }

  function slowmo(scale, ms) {
    const s = clamp(Number(scale) || 1, 0.05, 1);
    const dur = Math.max(0, Number(ms) || 0) / 1000;
    slowScale = slowT > 0 ? Math.min(slowScale, s) : s;
    slowT = Math.max(slowT, dur);
  }

  function flash(color, alpha = 0.5) {
    flashColor = color;
    flashPeak = clamp(Number(alpha) || 0, 0, 1);
    flashLeft = FLASH_DECAY_S;
  }

  function vignette(color, alpha = 0.6, life = VIGNETTE_DECAY_S) {
    vigColor = color;
    vigPeak = clamp(Number(alpha) || 0, 0, 1);
    vigLeft = Math.max(0.01, Number(life) || VIGNETTE_DECAY_S);
    vigDur = vigLeft;
  }

  // Adaptive quality: 0 full detail, 1 and 2 spawn fewer burst particles. Affects new bursts only.
  function setQuality(level) {
    const q = Math.floor(Number(level) || 0);
    quality = q < 0 ? 0 : q >= FX_QUALITY_BURST_SCALE.length ? FX_QUALITY_BURST_SCALE.length - 1 : q;
  }

  // A squash-and-pop where an enemy of `kind` died. The angle is the squash axis (the dash direction).
  // Runs on real time so it shows through hit-stop.
  function deathPop(kind, x, y, angle = 0) {
    const p = pops[popHead];
    popHead = (popHead + 1) % FX_MAX_POPS;
    p.alive = true;
    p.kind = String(kind);
    p.x = x;
    p.y = y;
    p.angle = Number(angle) || 0;
    p.age = 0;
    p.life = POP_LIFE_S;
  }

  // Live and recently dead pops. The renderer reads it and skips entries with alive === false.
  function getPops() {
    return pops;
  }

  // Camera kick in a direction (unit vector dx, dy) by `px` pixels, capped at KICK_MAX_PX in total.
  function kick(dx, dy, px) {
    const k = Number(px) || 0;
    if (k <= 0) return;
    kickX += dx * k;
    kickY += dy * k;
    const m = Math.hypot(kickX, kickY);
    if (m > KICK_MAX_PX) {
      kickX = (kickX * KICK_MAX_PX) / m;
      kickY = (kickY * KICK_MAX_PX) / m;
    }
  }

  // Camera kick offset in px. Shared object: read it, don't keep it.
  function getKickOffset() {
    kickOut.x = kickX;
    kickOut.y = kickY;
    return kickOut;
  }

  // A soft darkening centred on (x, y) that fades over `ms` of real time. Read with getDarken().
  function darkenAt(x, y, alpha = 0.3, ms = 120) {
    dark.x = x;
    dark.y = y;
    dark.alpha = clamp(Number(alpha) || 0, 0, 1);
    dark.dur = Math.max(0.02, (Number(ms) || 0) / 1000);
    dark.life = dark.dur;
  }

  // The live darkening, or null. Its strength is alpha * (life / dur)^2 at the moment.
  function getDarken() {
    return dark.life > 0 ? dark : null;
  }

  // Plays a named preset from FX_PRESETS. Returns false for an unknown name.
  function preset(name, x, y, extra = {}) {
    const spec = FX_PRESETS[name];
    if (!spec) return false;
    const list = spec.bursts;
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const o = Object.assign({}, b);
      if (extra.color !== undefined) o.color = extra.color;
      if (b.directional && extra.angle !== undefined) o.angle = extra.angle;
      burst(x, y, o);
    }
    const k = extra.intensity ?? 1;
    if (spec.shake) shake(spec.shake * k);
    if (spec.hitstop) hitstop(spec.hitstop);
    if (spec.slowmo) slowmo(spec.slowmo[0], spec.slowmo[1]);
    if (spec.flash) flash(spec.flash[0], spec.flash[1] * k);
    if (spec.vignette) vignette(spec.vignette[0], spec.vignette[1] * k);
    return true;
  }

  function clampDt(dt) {
    const d = Number(dt);
    if (!(d > 0)) return 0;
    return d > MAX_DT ? MAX_DT : d;
  }

  // Advances hit-stop and slow-mo timers. Returns the combined time scale.
  function computeScale(dt) {
    let hit = 1;
    if (hold > 0) {
      hold -= dt;
      hit = 0;
      if (hold <= 0) {
        hold = 0;
        recoverT = HITSTOP_RECOVER_S;
      }
    } else if (recoverT > 0) {
      recoverT -= dt;
      if (recoverT < 0) recoverT = 0;
      const k = 1 - recoverT / HITSTOP_RECOVER_S;
      hit = k * k * (3 - 2 * k); // smoothstep back to 1
    }

    let slow = 1;
    if (slowT > 0) {
      slowT -= dt;
      if (slowT <= 0) {
        slowT = 0;
      } else {
        slow = slowScale;
        if (slowT < SLOW_RECOVER_S) {
          const k = slowT / SLOW_RECOVER_S;
          slow = slowScale + (1 - slowScale) * (1 - k);
        }
      }
    }
    return clamp(hit * slow, 0, 1);
  }

  function valueNoise(tab, t) {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    const a = tab[i % 256];
    const b = tab[(i + 1) % 256];
    return a + (b - a) * u;
  }

  // Advances everything. Returns the simulation time scale (0..1) for this frame.
  function update(dt) {
    const d = clampDt(dt);
    const scale = computeScale(d);
    const sd = d * scale;

    // Shake, flash, and vignette run on real time, so they keep going through hit-stop.
    if (trauma > 0) {
      trauma = Math.max(0, trauma - d / SHAKE_DECAY_S);
      shakeT += d * SHAKE_FREQ;
      if (trauma === 0) shakeT = 0;
    }
    if (flashLeft > 0) flashLeft = Math.max(0, flashLeft - d);
    if (vigLeft > 0) vigLeft = Math.max(0, vigLeft - d);

    // World-space effects advance on the scaled clock, so they freeze in hit-stop.
    if (pLive > 0) {
      for (let i = 0; i < FX_MAX_PARTICLES; i++) {
        const p = particles[i];
        if (!p.alive) continue;
        p.age += sd;
        if (p.age >= p.life) {
          p.alive = false;
          pLive--;
          continue;
        }
        if (p.shape !== SHAPE_RING) {
          if (p.drag > 0) {
            const k = Math.exp(-p.drag * sd);
            p.vx *= k;
            p.vy *= k;
          }
          p.vy += p.gravity * sd;
          p.x += p.vx * sd;
          p.y += p.vy * sd;
          p.rot += p.spin * sd;
        }
      }
    }
    if (tLive > 0) {
      for (let i = 0; i < FX_MAX_TRAILS; i++) {
        const p = trails[i];
        if (!p.alive) continue;
        p.age += sd;
        if (p.age >= p.life) {
          p.alive = false;
          tLive--;
        }
      }
    }
    if (fLive > 0) {
      for (let i = 0; i < FX_MAX_FLOATERS; i++) {
        const p = floaters[i];
        if (!p.alive) continue;
        // Floaters run on real time so score pops show on the kill frame, not after hit-stop.
        p.age += d;
        if (p.age >= p.life) {
          p.alive = false;
          fLive--;
          continue;
        }
        p.y -= 70 * d * Math.max(0.2, 1 - p.age / p.life);
      }
    }
    // Presentation timers run on real time, so they keep going through hit-stop.
    if (kickX !== 0 || kickY !== 0) {
      const k = Math.exp(-KICK_DECAY * d);
      kickX *= k;
      kickY *= k;
      if (Math.abs(kickX) < 0.01 && Math.abs(kickY) < 0.01) {
        kickX = 0;
        kickY = 0;
      }
    }
    if (dark.life > 0) dark.life = Math.max(0, dark.life - d);
    for (let i = 0; i < FX_MAX_POPS; i++) {
      const p = pops[i];
      if (!p.alive) continue;
      p.age += d;
      if (p.age >= p.life) p.alive = false;
    }
    return scale;
  }

  // Shake offset in px. Returns a shared object: read it, don't keep or mutate it.
  function getShakeOffset() {
    if (trauma <= 0) {
      shakeOut.x = 0;
      shakeOut.y = 0;
      return shakeOut;
    }
    const m = trauma * trauma * SHAKE_MAX_OFFSET;
    shakeOut.x = m * valueNoise(noiseX, shakeT);
    shakeOut.y = m * valueNoise(noiseY, shakeT);
    return shakeOut;
  }

  // Draws trails, particles, and floaters in world space. Leaves ctx state as it found it.
  function drawWorld(ctx) {
    if (!ctx) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.globalCompositeOperation = 'lighter';

    if (tLive > 0) {
      for (let i = 0; i < FX_MAX_TRAILS; i++) {
        const p = trails[i];
        if (!p.alive) continue;
        const t = p.age / p.life;
        const c = Math.cos(p.angle);
        const s = Math.sin(p.angle);
        const tx = p.x - c * p.length;
        const ty = p.y - s * p.length;
        const fade = (1 - t) * (1 - t);
        ctx.globalAlpha = p.alpha * fade;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(0.5, p.width * (1 - 0.7 * t));
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(tx, ty);
        ctx.stroke();
      }
    }

    if (pLive > 0) {
      for (let i = 0; i < FX_MAX_PARTICLES; i++) {
        const p = particles[i];
        if (!p.alive) continue;
        const t = p.age / p.life;
        if (p.shape === SHAPE_DOT) {
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(0.3, p.size * (1 - 0.5 * t)), 0, TAU);
          ctx.fill();
        } else if (p.shape === SHAPE_SPARK) {
          const sp = Math.hypot(p.vx, p.vy);
          let nx = 1;
          let ny = 0;
          if (sp > 0.001) {
            nx = p.vx / sp;
            ny = p.vy / sp;
          }
          const len = Math.min(60, sp * 0.05 + p.size);
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.5, p.size * (1 - t));
          ctx.beginPath();
          ctx.moveTo(p.x - nx * len, p.y - ny * len);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
        } else if (p.shape === SHAPE_RING) {
          const e = 1 - (1 - t) * (1 - t);
          ctx.globalAlpha = 1 - t;
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(0.5, p.size * (1 - t));
          ctx.beginPath();
          ctx.arc(p.x, p.y, Math.max(1, p.r1 * e), 0, TAU);
          ctx.stroke();
        } else {
          // Shard: a triangle pointing along its rotation.
          const c = Math.cos(p.rot);
          const s = Math.sin(p.rot);
          const L = p.size * (1.6 - 0.6 * t);
          ctx.globalAlpha = 1 - t;
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(p.x + c * L, p.y + s * L);
          ctx.lineTo(p.x - c * L * 0.6 - s * L * 0.5, p.y - s * L * 0.6 + c * L * 0.5);
          ctx.lineTo(p.x - c * L * 0.6 + s * L * 0.5, p.y - s * L * 0.6 - c * L * 0.5);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    if (fLive > 0) {
      // Floaters use source-over so the dark outline keeps them legible on bright bursts.
      ctx.globalCompositeOperation = 'source-over';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (let i = 0; i < FX_MAX_FLOATERS; i++) {
        const p = floaters[i];
        if (!p.alive) continue;
        const t = p.age / p.life;
        let alpha = 1;
        if (t < 0.08) alpha = t / 0.08;
        else if (t > 0.6) alpha = Math.max(0, (1 - t) / 0.4);
        // easeOutBack pop: starts near 0, overshoots to ~1.2, settles at 1.
        const q = Math.min(1, t / 0.18) - 1;
        const C1 = 1.70158;
        const s = Math.max(0.05, 1 + (C1 + 1) * q * q * q + C1 * q * q);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.scale(s, s);
        ctx.globalAlpha = alpha;
        ctx.font = p.font;
        ctx.lineWidth = Math.max(1, p.size * 0.22);
        ctx.strokeStyle = 'rgba(3, 6, 16, 0.85)';
        ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
    }

    ctx.restore();
  }

  // Full-screen flash and vignette pulse, in screen space, drawn after the world.
  function drawScreen(ctx, w, h) {
    if (!ctx) return;
    if (flashLeft > 0 && flashPeak > 0) {
      const k = flashLeft / FLASH_DECAY_S;
      const a = flashPeak * k * k;
      if (a > 0.001) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = a;
        ctx.fillStyle = flashColor;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
    if (vigLeft > 0 && vigPeak > 0) {
      const k = vigLeft / vigDur;
      const a = vigPeak * k * k;
      if (a > 0.001) {
        const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.3, w / 2, h / 2, Math.hypot(w, h) * 0.5);
        g.addColorStop(0, 'rgba(0, 0, 0, 0)');
        g.addColorStop(1, vigColor);
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = a;
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
        ctx.restore();
      }
    }
  }

  return {
    burst,
    trail,
    floater,
    shake,
    hitstop,
    slowmo,
    flash,
    vignette,
    preset,
    update,
    getShakeOffset,
    setQuality,
    deathPop,
    getPops,
    kick,
    getKickOffset,
    darkenAt,
    getDarken,
    drawWorld,
    drawScreen,
    // Live burst particles only. Use stats() for everything.
    count() {
      return pLive;
    },
    stats() {
      return { particles: pLive, trails: tLive, floaters: fLive, trauma };
    },
  };
}
