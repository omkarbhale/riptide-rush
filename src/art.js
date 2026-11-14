// Riptide Rush visual identity: procedural Canvas 2D drawing, no image files.
//
// Pure drawing code. Nothing here touches `window` or `document` at import time,
// so the module loads under `node --test`. Browser-only helpers (offscreen caches)
// are looked up lazily at draw time and fall back to direct drawing when absent.
//
// Entities are drawn in local space with the nose toward +x, then rotated by `angle`.
// Glow is layered strokes and sprites composited with 'lighter', never shadowBlur.
//
// Performance (#74): every enemy body is one cached sprite per type and state (normal,
// flash, telegraph), with its static detail baked in. Drifter tendrils are baked for 16
// animation phases. Per frame an enemy costs one or two drawImage calls plus a few
// small fills. The background is cached at device resolution, so it blits 1:1, and the
// plankton is batched into a few paths. No shadowBlur and no per-frame gradients in hot paths.

const TAU = Math.PI * 2;

// Nominal enemy radius in local units. At scale 1 a standard enemy is ~28 px across.
const R = 14;

// Pulse reach from issue #1 (~110 px). Used only to fade the ring as it expands.
const PULSE_MAX_RADIUS = 110;

export const PALETTE = Object.freeze({
  deepTop: '#050a18',
  deepBottom: '#0a1830',
  player: '#3cf2ff',
  dash: '#eaffff',
  danger: '#ff3d81',
  bullet: '#ffb347',
  gold: '#ffe066',
  // Combo tiers: cyan -> green -> gold -> magenta -> white.
  combo: Object.freeze(['#3cf2ff', '#5dff9b', '#ffe066', '#ff3d81', '#ffffff']),
  // Enemy identities. Each is a distinct hue, and each type also has its own silhouette.
  drifter: '#a77bff',
  spitter: '#9dff3c',
  charger: '#ff4d5e',
  shellback: '#5b8cff',
  shellbackCore: '#3ef0c8',
  splitter: '#ffe066',
  mini: '#ff9a4a',
  mine: '#ff3d81',
  puffer: '#ff9ed8',
  shieldbearer: '#3ee6b0',
  inksquid: '#8a4dff',
  phaseeel: '#ffd6a0',
  warden: '#a8233f',
  wardenPhase2: '#ff5a2a',
  wardenLure: '#ffe066',
  // Ink puddles and lob shadows: near-black violet with a light rim, unlike the Tidal Current arrows.
  ink: '#1c0b38',
  inkRim: '#c79bff',
  barrier: '#f2fbff',
});

const ENEMY_COLOR = Object.freeze({
  drifter: PALETTE.drifter,
  spitter: PALETTE.spitter,
  charger: PALETTE.charger,
  shellback: PALETTE.shellback,
  splitter: PALETTE.splitter,
  mini: PALETTE.mini,
  mine: PALETTE.mine,
  puffer: PALETTE.puffer,
  shieldbearer: PALETTE.shieldbearer,
  inksquid: PALETTE.inksquid,
  phaseeel: PALETTE.phaseeel,
  warden: PALETTE.warden,
});

// The boss is four enemy sizes across (issue #38: radius 60 px against 14 px nominal).
const WARDEN_SIZE = 4;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function num(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readOpts(o) {
  o = o || {};
  return {
    scale: num(o.scale, 1),
    flash: clamp01(num(o.flash, 0)),
    telegraph: clamp01(num(o.telegraph, 0)),
    hp: o.hp,
    dashing: !!o.dashing,
    invulnerable: !!o.invulnerable,
    charges: o.charges,
    reflected: !!o.reflected,
    // Per-type state (all optional, with safe defaults):
    inflate: clamp01(num(o.inflate, 0)), // puffer swell, 0..1
    aura: Math.max(0, num(o.aura, 120)), // shield bearer aura radius, local units
    barrier: clamp01(num(o.barrier, 0)), // barrier ring on a protected enemy, 0..1
    visibility: clamp01(num(o.visibility, 1)), // phase eel, 0 hidden .. 1 visible
    phase: o.phase === 2 ? 2 : 1, // warden phase
    vulnerable: clamp01(num(o.vulnerable, 0)), // warden weak-point glow, 0..1
  };
}

const rgbCache = new Map();
function rgbOf(hex) {
  let c = rgbCache.get(hex);
  if (c === undefined) {
    const n = parseInt(hex.slice(1), 16);
    c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    rgbCache.set(hex, c);
  }
  return c;
}

function rgba(hex, a) {
  const c = rgbOf(hex);
  return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + clamp01(a).toFixed(3) + ')';
}

// Linear mix of two hex colours. `k` is quantised to 1/32 so the cache stays bounded.
const mixCache = new Map();
function mixHex(a, b, k) {
  const q = Math.round(clamp01(k) * 32);
  if (q === 0) return a;
  if (q === 32) return b;
  const key = a + b + q;
  let out = mixCache.get(key);
  if (out === undefined) {
    const A = rgbOf(a);
    const B = rgbOf(b);
    const f = q / 32;
    const r = Math.round(A[0] + (B[0] - A[0]) * f);
    const g = Math.round(A[1] + (B[1] - A[1]) * f);
    const bl = Math.round(A[2] + (B[2] - A[2]) * f);
    out = '#' + ((1 << 24) | (r << 16) | (g << 8) | bl).toString(16).slice(1);
    mixCache.set(key, out);
  }
  return out;
}

// Offscreen layers. Returns a canvas, or null where OffscreenCanvas and
// document.createElement are both unavailable (Node, very old browsers).
const layerCache = new Map();
function makeCanvas(w, h) {
  if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  return null;
}

function cachedLayer(key, w, h, paint) {
  let c = layerCache.get(key);
  if (c === undefined) {
    c = makeCanvas(w, h);
    if (c) paint(c.getContext('2d'));
    layerCache.set(key, c);
  }
  return c;
}

// Tint an enemy colour toward danger (telegraph) and toward white (hit flash).
// Used by the live fallback path.
function tint(base, o) {
  let c = base;
  if (o.telegraph > 0) c = mixHex(c, PALETTE.danger, o.telegraph * 0.5);
  if (o.flash > 0) c = mixHex(c, '#ffffff', o.flash * 0.9);
  return c;
}

// Neon body: additive halo strokes, a dark tinted fill, and a bright edge.
// `build` must add subpaths only; it is called twice for one shape.
function neonBody(ctx, build, color, glow) {
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalCompositeOperation = 'lighter';
  ctx.beginPath();
  build(ctx);
  ctx.strokeStyle = rgba(color, 0.1 * glow);
  ctx.lineWidth = 9;
  ctx.stroke();
  ctx.strokeStyle = rgba(color, 0.22 * glow);
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  build(ctx);
  ctx.fillStyle = mixHex(color, PALETTE.deepTop, 0.72);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.6;
  ctx.stroke();
}

// Wind-up ring for any enemy. It contracts toward the body as the telegraph completes.
// Dashed strokes are costly on the canvas, so the ring is a cached sprite per telegraph level
// (8 levels), rotated to animate the dashes and faded by alpha for the strobe.
const WARN_LEVELS = 8;
const WARN_HALF = 30; // sprite covers [-30, 30] local units
const WARN_RES = 3;
function warnRingSprite(level) {
  return cachedLayer('warn:' + level, WARN_HALF * 2 * WARN_RES, WARN_HALF * 2 * WARN_RES, (g) => {
    const tg = level / WARN_LEVELS;
    const r = R * (2.0 - 0.7 * tg);
    g.setTransform(WARN_RES, 0, 0, WARN_RES, WARN_HALF * WARN_RES, WARN_HALF * WARN_RES);
    g.setLineDash([3, 4]);
    g.beginPath();
    g.arc(0, 0, r, 0, TAU);
    g.strokeStyle = PALETTE.danger;
    g.lineWidth = 1.5 + 1.5 * tg;
    g.stroke();
  });
}

// `size` is the enemy's size multiple. Anything bigger than a standard enemy gets a live ring at its own radius.
function warnRing(ctx, t, tg, size) {
  const level = Math.max(1, Math.min(WARN_LEVELS, Math.round(tg * WARN_LEVELS)));
  const strobe = 0.5 + 0.5 * Math.sin(t * (14 + 24 * tg));
  if (size !== undefined && size !== 1) {
    const big = R * size * (2.0 - 0.7 * tg);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.setLineDash([6, 8]);
    ctx.lineDashOffset = -t * 40;
    ctx.beginPath();
    ctx.arc(0, 0, big, 0, TAU);
    ctx.strokeStyle = rgba(PALETTE.danger, tg * (0.25 + 0.6 * strobe));
    ctx.lineWidth = 2 + 2 * tg;
    ctx.stroke();
    ctx.restore();
    return;
  }
  const r = R * (2.0 - 0.7 * (level / WARN_LEVELS));
  const sprite = warnRingSprite(level);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  if (sprite) {
    // Rotating the ring by offset / radius moves its dashes the same way as a dash offset would.
    ctx.rotate((-t * 40) / r);
    ctx.globalAlpha = Math.min(1, tg * (0.25 + 0.6 * strobe));
    ctx.drawImage(sprite, -WARN_HALF, -WARN_HALF, WARN_HALF * 2, WARN_HALF * 2);
  } else {
    ctx.setLineDash([3, 4]);
    ctx.lineDashOffset = -t * 40;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.strokeStyle = rgba(PALETTE.danger, tg * (0.25 + 0.6 * strobe));
    ctx.lineWidth = 1.5 + 1.5 * tg;
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// background: device-resolution layers, plus batched plankton
// ---------------------------------------------------------------------------

// Scale of the current transform, so cached layers match device pixels and blit 1:1.
// Falls back to 1 when the context cannot report its transform (Node mock contexts).
function scaleOf(ctx) {
  if (typeof ctx.getTransform === 'function') {
    const m = ctx.getTransform();
    if (m && m.b === 0 && m.c === 0 && m.a > 0 && m.d > 0 && Number.isFinite(m.a) && Number.isFinite(m.d)) {
      return { sx: Math.min(4, Math.max(0.25, m.a)), sy: Math.min(4, Math.max(0.25, m.d)) };
    }
  }
  return { sx: 1, sy: 1 };
}

// Background layers are few (one per arena size and scale), so the cache stays small.
const bgCache = new Map();
const BG_LAYER_LIMIT = 6;
function bgLayer(name, w, h, sx, sy, logicalW, logicalH, ox, oy, paint) {
  const key = name + ':' + w + 'x' + h + '@' + sx.toFixed(2) + ',' + sy.toFixed(2);
  let c = bgCache.get(key);
  if (c === undefined) {
    if (bgCache.size >= BG_LAYER_LIMIT) bgCache.delete(bgCache.keys().next().value);
    const cw = Math.max(1, Math.round(logicalW * sx));
    const ch = Math.max(1, Math.round(logicalH * sy));
    c = makeCanvas(cw, ch);
    if (c) {
      const g = c.getContext('2d');
      const kx = cw / logicalW;
      const ky = ch / logicalH;
      g.setTransform(kx, 0, 0, ky, ox * kx, oy * ky);
      paint(g);
    }
    bgCache.set(key, c);
  }
  return c;
}

function paintStaticBackground(g, w, h) {
  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, PALETTE.deepTop);
  grad.addColorStop(1, PALETTE.deepBottom);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Faint light shaft falling from the surface.
  const shaft = g.createRadialGradient(w * 0.5, -h * 0.2, 0, w * 0.5, -h * 0.2, h * 1.1);
  shaft.addColorStop(0, rgba(PALETTE.player, 0.1));
  shaft.addColorStop(1, rgba(PALETTE.player, 0));
  g.fillStyle = shaft;
  g.fillRect(0, 0, w, h);

  const vg = g.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.42, w * 0.5, h * 0.5, Math.hypot(w, h) * 0.5);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.65)');
  g.fillStyle = vg;
  g.fillRect(0, 0, w, h);

  // Arena border glow: wide faint strokes, then a crisp inner edge.
  g.save();
  g.globalCompositeOperation = 'lighter';
  const borders = [
    [26, 0.03],
    [16, 0.05],
    [8, 0.09],
    [2.5, 0.35],
  ];
  for (let i = 0; i < borders.length; i++) {
    g.lineWidth = borders[i][0];
    g.strokeStyle = rgba(PALETTE.player, borders[i][1]);
    g.strokeRect(borders[i][0] / 2, borders[i][0] / 2, w - borders[i][0], h - borders[i][0]);
  }
  g.restore();
}

const CAUSTIC_LINES = 12;

// Wavy current lines. `shift` moves their phase. Drawn in local space, with no offset.
function paintCaustics(g, w, h, shift) {
  g.save();
  g.globalCompositeOperation = 'lighter';
  g.lineWidth = 1.4;
  g.strokeStyle = rgba(PALETTE.player, 0.06);
  for (let i = 0; i < CAUSTIC_LINES; i++) {
    const yBase = h * (0.05 + 0.9 * ((i + 0.5) / CAUSTIC_LINES));
    const freq = 0.006 + 0.002 * (i % 3);
    const amp = 10 + (i % 4) * 6;
    const ph = i * 1.7 + shift;
    g.beginPath();
    for (let x = -40; x <= w + 40; x += 20) {
      const y = yBase + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 2.3 - ph) * amp * 0.35;
      if (x === -40) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  g.restore();
}

function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MOTE_COUNT = 110;
const MOTES = (function () {
  const rnd = mulberry32(0x5eed);
  const list = [];
  for (let i = 0; i < MOTE_COUNT; i++) {
    list.push({ x: rnd(), y: rnd(), d: 0.2 + 0.8 * rnd(), p: rnd() * TAU });
  }
  return list;
})();

// Motes are grouped by brightness (1/32 steps), so each frame is one fill per group, not one per mote.
const MOTE_STEPS = 32;
const MOTE_FILL = Array.from({ length: MOTE_STEPS + 1 }, (_, i) => rgba('#bff6ff', i / MOTE_STEPS));
const moteGroups = Array.from({ length: MOTE_STEPS + 1 }, () => []);

// Plankton drifts left. Nearer motes (larger d) move faster and look brighter.
function drawMotes(ctx, w, h, t) {
  for (let q = 0; q <= MOTE_STEPS; q++) moteGroups[q].length = 0;
  for (let i = 0; i < MOTES.length; i++) {
    const m = MOTES[i];
    const a = 0.12 + 0.35 * m.d * (0.75 + 0.25 * Math.sin(t * 1.7 + m.p * 3));
    moteGroups[Math.round(clamp01(a) * MOTE_STEPS)].push(i);
  }
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let q = 0; q <= MOTE_STEPS; q++) {
    const group = moteGroups[q];
    if (group.length === 0) continue;
    ctx.fillStyle = MOTE_FILL[q];
    ctx.beginPath();
    for (let j = 0; j < group.length; j++) {
      const m = MOTES[group[j]];
      const sx = m.x * w - t * (5 + 24 * m.d);
      const x = ((sx % w) + w) % w;
      const y = m.y * h + Math.sin(t * 0.5 + m.p) * 5 * m.d;
      const r = 0.6 + 1.5 * m.d;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, TAU);
    }
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// glow sprites
// ---------------------------------------------------------------------------

function glowSprite(key, color) {
  return cachedLayer('sprite:' + key, 64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, rgba('#ffffff', 1));
    grad.addColorStop(0.14, rgba(color, 1));
    grad.addColorStop(0.4, rgba(color, 0.35));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
}

// Thin ring used as the bullet's pulsing outline.
function ringSprite(key, color) {
  return cachedLayer('ring:' + key, 64, 64, (g) => {
    g.strokeStyle = color;
    g.lineWidth = 4;
    g.beginPath();
    g.arc(32, 32, 26, 0, TAU);
    g.stroke();
  });
}

// ---------------------------------------------------------------------------
// player: Rip the blade-fish
// ---------------------------------------------------------------------------

function drawPlayer(ctx, x, y, angle, t, opts) {
  const o = readOpts(opts);
  const dashing = o.dashing;
  const k = o.scale;
  // Tail beat: fast and tight in a dash, slow and wide otherwise.
  const beat = Math.sin(t * (dashing ? 30 : 14)) * (dashing ? 0.6 : 2.6);
  const fin = Math.sin(t * 12);
  const color = dashing ? PALETTE.dash : PALETTE.player;

  ctx.save();
  ctx.translate(num(x, 0), num(y, 0));
  ctx.rotate(num(angle, 0));
  if (o.invulnerable && Math.floor(t * 16) % 2 === 1) ctx.globalAlpha = 0.3;

  if (dashing) {
    // Motion streaks trail behind the stretched body.
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (let i = -1; i <= 1; i++) {
      const side = Math.abs(i);
      ctx.beginPath();
      ctx.moveTo(-18 * k, i * 4 * k);
      ctx.lineTo(-58 * k, i * 5 * k);
      ctx.strokeStyle = rgba(PALETTE.player, 0.35 - side * 0.1);
      ctx.lineWidth = (2.2 - side * 0.6) * k;
      ctx.stroke();
    }
  }

  ctx.scale(k * (dashing ? 1.4 : 1), k * (dashing ? 0.72 : 1));

  neonBody(
    ctx,
    (g) => {
      g.moveTo(22, 0);
      g.quadraticCurveTo(10, -9, -6, -6.5);
      g.lineTo(-14, -2.5 + beat * 0.4);
      g.lineTo(-25, -11 + beat);
      g.lineTo(-18, beat * 0.5);
      g.lineTo(-25, 11 + beat);
      g.lineTo(-14, 2.5 + beat * 0.4);
      g.lineTo(-6, 6.5);
      g.quadraticCurveTo(10, 9, 22, 0);
      g.closePath();
    },
    color,
    dashing ? 1.9 : 1.2
  );

  // Pectoral fins flap in antiphase.
  const pectoral = (sy) => (g) => {
    g.moveTo(7, 4 * sy);
    g.quadraticCurveTo(1, (13 + fin * 2.5) * sy, -5, 5.5 * sy);
    g.closePath();
  };
  neonBody(ctx, pectoral(1), color, 0.8);
  neonBody(ctx, pectoral(-1), color, 0.8);

  // Dorsal fin.
  neonBody(
    ctx,
    (g) => {
      g.moveTo(4, -6.5);
      g.quadraticCurveTo(-2, -13, -12, -5.5);
      g.closePath();
    },
    color,
    0.8
  );

  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rgba('#ffffff', 0.35);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(15, -0.2);
  ctx.lineTo(-8, beat * 0.3);
  ctx.stroke();
  ctx.fillStyle = rgba('#ffffff', 0.95);
  ctx.beginPath();
  ctx.arc(13, -1.8, 1.9, 0, TAU);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = PALETTE.deepTop;
  ctx.beginPath();
  ctx.arc(13.6, -1.8, 0.9, 0, TAU);
  ctx.fill();

  // Charge pips along the spine: filled when ready, hollow when spent.
  if (o.charges !== undefined) {
    const n = Math.max(0, Math.min(3, Math.floor(num(o.charges, 0))));
    for (let i = 0; i < 3; i++) {
      const px = -3 + i * 4.2;
      ctx.beginPath();
      ctx.arc(px, 0, i < n ? 1.7 : 1.5, 0, TAU);
      if (i < n) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = rgba(PALETTE.player, 0.95);
        ctx.fill();
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = rgba(color, 0.35);
        ctx.lineWidth = 0.8;
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// enemies: each type has its own silhouette and colour, drawn in local space
// ---------------------------------------------------------------------------

// Sprites cover [-SPRITE_HX, SPRITE_HX] x [-SPRITE_HY, SPRITE_HY] in local units. The box is tight
// around every silhouette (widest: drifter tendrils and the spitter snout). Each sprite is rendered at
// the resolution it will be drawn at (`res` pixels per local unit, from the on-screen scale), so it
// is never downsampled per draw. Flash and telegraph states are baked in at quantised levels.
const SPRITE_HX = 1.7 * R;
const SPRITE_HY = 1.2 * R;
const DEFAULT_BOX = Object.freeze({ hx: SPRITE_HX, hy: SPRITE_HY });
const W = R * WARDEN_SIZE; // warden geometry unit (its body is drawn at this size)
// Longer or larger types get their own box, so their baked sprite still covers the whole silhouette.
const BOX = new Map([
  ['phaseeel', Object.freeze({ hx: 2.4 * R, hy: 1.2 * R })],
  ['warden', Object.freeze({ hx: 1.6 * W, hy: 1.2 * W })],
]);
const SPRITE_MAX_RES = 4;
const FLASH_LEVELS = 2; // flash 0, 0.5, 1
const TELE_LEVELS = 4; // telegraph 0, 0.25, ... 1

function spriteRes(v) {
  return Math.min(SPRITE_MAX_RES, Math.max(1, Math.ceil(v - 1e-6)));
}

// Drifter tendrils are baked for this many phases of their sin(4t) wobble.
const TENDRIL_PHASES = 16;

// Static bodies, drawn in colour `c`. Every static detail is baked into the body sprite.
const BODY = {
  // Jellyfish bell with its eye.
  drifter(g, c) {
    neonBody(
      g,
      (p) => {
        p.arc(-R * 0.1, 0, R * 0.95, -Math.PI / 2, Math.PI / 2);
        p.quadraticCurveTo(-R * 0.6, R * 0.9, -R * 0.95, 0);
        p.quadraticCurveTo(-R * 0.6, -R * 0.9, -R * 0.1, -R * 0.95);
        p.closePath();
      },
      c,
      1
    );
    g.fillStyle = rgba(mixHex(c, '#ffffff', 0.5), 0.8);
    g.beginPath();
    g.arc(R * 0.3, 0, R * 0.2, 0, TAU);
    g.fill();
  },

  // Diamond with a snout and a pale muzzle spot.
  spitter(g, c) {
    neonBody(
      g,
      (p) => {
        p.moveTo(-R * 0.9, 0);
        p.lineTo(0, -R * 0.8);
        p.lineTo(R * 0.5, -R * 0.45);
        p.lineTo(R * 1.55, -R * 0.2);
        p.lineTo(R * 1.55, R * 0.2);
        p.lineTo(R * 0.5, R * 0.45);
        p.lineTo(0, R * 0.8);
        p.closePath();
      },
      c,
      1
    );
    g.fillStyle = rgba('#ffffff', 0.45);
    g.beginPath();
    g.arc(-R * 0.1, 0, R * 0.2, 0, TAU);
    g.fill();
  },

  // Long swept dart. Sharp and narrow, unlike the mini's round teardrop.
  charger(g, c) {
    neonBody(
      g,
      (p) => {
        p.moveTo(R * 1.5, 0);
        p.lineTo(-R * 0.6, -R * 0.62);
        p.lineTo(-R * 0.25, 0);
        p.lineTo(-R * 0.6, R * 0.62);
        p.closePath();
      },
      c,
      1
    );
    g.strokeStyle = rgba(mixHex(c, '#ffffff', 0.4), 0.7);
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(R * 0.9, 0);
    g.lineTo(-R * 0.2, 0);
    g.stroke();
  },

  // Full disc, then the armoured front half, its ribs, and any cracks (`cracks` 0..2).
  shellback(g, c, cracks) {
    neonBody(g, (p) => p.arc(0, 0, R, 0, TAU), c, 1);

    // Armoured front: a half-disc closed across its diameter.
    g.beginPath();
    g.arc(0, 0, R * 1.02, -Math.PI / 2, Math.PI / 2);
    g.closePath();
    g.fillStyle = '#c4d8ff';
    g.fill();
    g.strokeStyle = rgba('#ffffff', 0.9);
    g.lineWidth = 1.4;
    g.stroke();

    // Armour plate ribs.
    g.strokeStyle = rgba(c, 0.6);
    g.lineWidth = 1;
    g.beginPath();
    for (let i = -2; i <= 2; i++) {
      const a = i * 0.45;
      g.moveTo(R * 0.15 * Math.cos(a), R * 0.15 * Math.sin(a));
      g.lineTo(R * 0.98 * Math.cos(a), R * 0.98 * Math.sin(a));
    }
    g.stroke();

    if (cracks > 0) {
      g.strokeStyle = rgba(PALETTE.deepTop, 0.85);
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(R * 0.3, -R * 0.8);
      g.lineTo(R * 0.55, -R * 0.35);
      g.lineTo(R * 0.4, -R * 0.05);
      if (cracks > 1) {
        g.moveTo(R * 0.55, -R * 0.35);
        g.lineTo(R * 0.8, -R * 0.2);
        g.moveTo(R * 0.4, R * 0.05);
        g.lineTo(R * 0.7, R * 0.5);
      }
      g.stroke();
    }
  },

  // Hexagonal cell. Its division lines and centre are drawn live, so they can pull apart.
  splitter(g, c) {
    neonBody(
      g,
      (p) => {
        for (let k = 0; k < 6; k++) {
          const a = (k * TAU) / 6;
          const px = R * 0.95 * Math.cos(a);
          const py = R * 0.95 * Math.sin(a);
          if (k === 0) p.moveTo(px, py);
          else p.lineTo(px, py);
        }
        p.closePath();
      },
      c,
      1
    );
  },

  // Round teardrop, pointed forward.
  mini(g, c) {
    neonBody(
      g,
      (p) => {
        p.moveTo(R * 0.95, 0);
        p.quadraticCurveTo(R * 0.45, -R * 0.75, -R * 0.45, -R * 0.6);
        p.quadraticCurveTo(-R * 0.7, 0, -R * 0.45, R * 0.6);
        p.quadraticCurveTo(R * 0.45, R * 0.75, R * 0.95, 0);
        p.closePath();
      },
      c,
      1
    );
  },

  // Spikes (drawn first, behind the core), then the core disc. The whole sprite spins.
  mine(g, c) {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    g.strokeStyle = rgba(c, 0.9);
    g.lineWidth = 1.8;
    g.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * TAU) / 8;
      g.moveTo(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62);
      g.lineTo(Math.cos(a) * R * 1.15, Math.sin(a) * R * 1.15);
    }
    g.stroke();
    g.restore();
    neonBody(g, (p) => p.arc(0, 0, R * 0.66, 0, TAU), c, 1);
  },
};

// Drifter tendrils for one phase of their wobble. `a` is the phase angle (sin(4t) in radians).
function tendrilsPaint(a) {
  return (g, c) => {
    g.save();
    g.globalCompositeOperation = 'lighter';
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const oy = (i - 1) * R * 0.5;
      g.beginPath();
      g.moveTo(-R * 0.2, oy);
      g.quadraticCurveTo(-R * 0.9, oy + Math.sin(a + i * 2 + 1) * R * 0.25, -R * 1.6, oy + Math.sin(a + i * 2) * R * 0.35);
      g.strokeStyle = rgba(c, 0.85);
      g.lineWidth = 1.6;
      g.stroke();
    }
    g.restore();
  };
}

// Resolution of the enemy currently being drawn (set by draw.enemy before its type function runs).
let curRes = 1;
// Sprite box of the enemy currently being drawn (set by draw.enemy alongside curRes).
let curBox = DEFAULT_BOX;

// Sprite for one paint at resolution `res`, with flash level `f` and telegraph level `g` baked in.
// Level 0 is the plain paint. Overlays recolour the plain sprite (white for flash, danger for telegraph)
// and draw it over, in the same order the live path used. Each combination is built once, lazily.
function variantLayer(id, colour, paint, res, f, g) {
  const w = Math.ceil(2 * curBox.hx * res);
  const h = Math.ceil(2 * curBox.hy * res);
  return cachedLayer('enemy:' + id + ':' + res + ':' + f + ':' + g, w, h, (out) => {
    if (f === 0 && g === 0) {
      out.setTransform(res, 0, 0, res, w / 2, h / 2);
      paint(out, colour);
      return;
    }
    const plain = variantLayer(id, colour, paint, res, 0, 0);
    if (!plain) return;
    out.drawImage(plain, 0, 0);
    const overlay = (fill, alpha) => {
      const tmp = makeCanvas(w, h);
      if (!tmp) return;
      const tg = tmp.getContext('2d');
      tg.drawImage(plain, 0, 0);
      tg.globalCompositeOperation = 'source-in';
      tg.fillStyle = fill;
      tg.fillRect(0, 0, w, h);
      out.globalAlpha = alpha;
      out.drawImage(tmp, 0, 0);
      out.globalAlpha = 1;
    };
    if (f > 0) overlay('#ffffff', 0.9 * (f / FLASH_LEVELS));
    if (g > 0) overlay(PALETTE.danger, 0.5 * (g / TELE_LEVELS));
  });
}

// Draws a sprite centred on the enemy origin, in the enemy's local units.
function blitSprite(ctx, layer, res) {
  const dw = Math.ceil(2 * curBox.hx * res) / res;
  const dh = Math.ceil(2 * curBox.hy * res) / res;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(layer, -dw / 2, -dh / 2, dw, dh);
}

// Draws one baked layer for the enemy's current flash and telegraph levels.
// Where offscreen canvases are unavailable, it paints the same geometry directly (live, unquantised).
function drawLayer(ctx, id, colour, paint, o) {
  const f = Math.round(o.flash * FLASH_LEVELS);
  const g = Math.round(o.telegraph * TELE_LEVELS);
  const layer = variantLayer(id, colour, paint, curRes, f, g);
  if (!layer) {
    ctx.save();
    paint(ctx, tint(colour, o));
    ctx.restore();
    return;
  }
  blitSprite(ctx, layer, curRes);
}

// Draws a layer with no flash or telegraph state (used for parts that stay in their own colour).
function drawPlainLayer(ctx, id, colour, paint) {
  const layer = variantLayer(id, colour, paint, curRes, 0, 0);
  if (!layer) {
    ctx.save();
    paint(ctx, colour);
    ctx.restore();
    return;
  }
  blitSprite(ctx, layer, curRes);
}

// Drifter: tendrils behind the bell, then the bell. Tendrils use the nearest baked phase.
function drawDrifter(ctx, t, o) {
  const c = ENEMY_COLOR.drifter;
  const cycle = ((t * 4) % TAU + TAU) % TAU;
  const p = Math.round((cycle / TAU) * TENDRIL_PHASES) % TENDRIL_PHASES;
  drawPlainLayer(ctx, 'drifter.tendrils.' + p, c, tendrilsPaint((p / TENDRIL_PHASES) * TAU));
  drawLayer(ctx, 'drifter.body', c, BODY.drifter, o);
}

// Spitter: body, then a muzzle that glows as it winds up.
function drawSpitter(ctx, t, o) {
  const c = tint(ENEMY_COLOR.spitter, o);
  drawLayer(ctx, 'spitter', ENEMY_COLOR.spitter, BODY.spitter, o);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba(c, 0.25 + 0.6 * o.telegraph + 0.1 * Math.sin(t * 6));
  ctx.beginPath();
  ctx.arc(R * 1.5, 0, R * (0.2 + 0.25 * o.telegraph), 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Charger: aim line, then the dart, pulled back during the wind-up.
function drawCharger(ctx, t, o) {
  const tg = o.telegraph;
  if (tg > 0) {
    // Dashed aim line as filled rectangles: dash paths are costly on the canvas.
    const x0 = R * 1.6;
    const len = R * 4.5 * tg;
    const h = 1.2 + 1.2 * tg;
    const period = 12; // 6 on, 6 off
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgba(PALETTE.danger, 0.2 + 0.7 * tg);
    const phase = ((t * 60) % period + period) % period;
    for (let d = -phase; d < len; d += period) {
      const from = Math.max(0, d);
      const to = Math.min(len, d + 6);
      if (to > from) ctx.fillRect(x0 + from, -h / 2, to - from, h);
    }
    ctx.restore();
  }
  ctx.save();
  ctx.translate(-tg * R * 0.35, 0);
  drawLayer(ctx, 'charger', ENEMY_COLOR.charger, BODY.charger, o);
  ctx.restore();
}

// Shellback: a bright armoured front half and a dark back with a teal weak spot.
// opts.hp below 3 shows cracks in the armour (one sprite per crack level).
function drawShellback(ctx, t, o) {
  const cracks = Math.max(0, Math.min(2, 3 - num(o.hp, 3)));
  drawLayer(ctx, 'shellback.' + cracks, ENEMY_COLOR.shellback, (g, c) => BODY.shellback(g, c, cracks), o);

  // The core sits on the back half, behind the armour, so it can be drawn after the body.
  const core = PALETTE.shellbackCore;
  const beat = 0.6 + 0.4 * Math.sin(t * 4);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba(core, 0.3 + 0.25 * beat);
  ctx.beginPath();
  ctx.arc(-R * 0.45, 0, R * 0.42, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(core, 0.95);
  ctx.beginPath();
  ctx.arc(-R * 0.45, 0, R * 0.16, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Splitter: a hexagonal cell with three division lines. The halves pull apart as it readies.
function drawSplitter(ctx, t, o) {
  const c = tint(ENEMY_COLOR.splitter, o);
  const sep = o.telegraph * R * 0.25;

  ctx.save();
  ctx.rotate(t * 0.6);
  drawLayer(ctx, 'splitter', ENEMY_COLOR.splitter, BODY.splitter, o);
  ctx.strokeStyle = rgba(mixHex(c, '#ffffff', 0.3), 0.9);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const a = (k * TAU) / 3;
    ctx.moveTo(sep * Math.cos(a), sep * Math.sin(a));
    ctx.lineTo(R * 0.85 * Math.cos(a), R * 0.85 * Math.sin(a));
  }
  ctx.stroke();
  ctx.fillStyle = rgba(mixHex(c, '#ffffff', 0.6), 0.9);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.16, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Mini: a small teardrop with a sparkle at its core.
function drawMini(ctx, t, o) {
  drawLayer(ctx, 'mini', ENEMY_COLOR.mini, BODY.mini, o);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba('#ffffff', 0.4 + 0.3 * Math.sin(t * 10));
  ctx.beginPath();
  ctx.arc(-R * 0.1, 0, R * 0.12, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Mine: a spinning spiked core (the whole sprite rotates), and a strobing centre that speeds up as it arms.
function drawMine(ctx, t, o) {
  ctx.save();
  ctx.rotate(t * 0.8);
  drawLayer(ctx, 'mine', ENEMY_COLOR.mine, BODY.mine, o);
  ctx.restore();

  const rate = 4 + 26 * o.telegraph;
  const on = 0.5 + 0.5 * Math.sin(t * rate);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba('#ffffff', 0.25 + 0.7 * on);
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.22, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Puffer (#19): a round body with twelve spines. `lv` 0..3 is the swell level: the body grows,
// the spines spread and the body lightens. Each level is its own baked sprite.
function pufferPaint(lv) {
  return (g, c) => {
    const k = lv / 3;
    // A fuller balloon with nine short, broad spines: told apart from the mine's thin radial spikes.
    const rb = R * (1.0 + 0.3 * k);
    const len = R * (0.3 + 0.22 * k);
    neonBody(
      g,
      (p) => {
        for (let i = 0; i < 9; i++) {
          const a = (i * TAU) / 9;
          const half = 0.2;
          p.moveTo(Math.cos(a - half) * rb * 0.95, Math.sin(a - half) * rb * 0.95);
          p.lineTo(Math.cos(a) * (rb + len), Math.sin(a) * (rb + len));
          p.lineTo(Math.cos(a + half) * rb * 0.95, Math.sin(a + half) * rb * 0.95);
          p.closePath();
        }
      },
      c,
      1
    );
    neonBody(g, (p) => p.arc(0, 0, rb, 0, TAU), mixHex(c, '#ffffff', 0.25 * k), 1);
    g.fillStyle = PALETTE.deepTop;
    g.beginPath();
    g.arc(rb * 0.42, -rb * 0.2, R * 0.24, 0, TAU);
    g.fill();
    g.fillStyle = rgba('#ffffff', 0.95);
    g.beginPath();
    g.arc(rb * 0.5, -rb * 0.28, R * 0.09, 0, TAU);
    g.fill();
  };
}

function drawPuffer(ctx, t, o) {
  const lv = Math.round(o.inflate * 3);
  drawLayer(ctx, 'puffer.' + lv, ENEMY_COLOR.puffer, pufferPaint(lv), o);
}

// Shield Bearer (#20): a heater-shield hull, pointed forward, with a bright plate across its front.
function shieldBearerPaint(g, c) {
  neonBody(
    g,
    (p) => {
      p.moveTo(-R * 1.25, -R * 1.05);
      p.lineTo(R * 0.8, -R * 1.05);
      p.quadraticCurveTo(R * 1.6, -R * 0.9, R * 1.65, 0);
      p.quadraticCurveTo(R * 1.6, R * 0.9, R * 0.8, R * 1.05);
      p.lineTo(-R * 1.25, R * 1.05);
      p.quadraticCurveTo(-R * 1.55, 0, -R * 1.25, -R * 1.05);
      p.closePath();
    },
    c,
    1
  );
  g.strokeStyle = rgba('#ffffff', 0.85);
  g.lineWidth = 2.2;
  g.beginPath();
  g.arc(R * 0.55, 0, R * 1.05, -0.8, 0.8);
  g.stroke();
  g.fillStyle = PALETTE.deepTop;
  g.beginPath();
  g.arc(-R * 0.2, 0, R * 0.3, 0, TAU);
  g.fill();
  g.fillStyle = rgba('#ffffff', 0.8);
  g.beginPath();
  g.arc(-R * 0.2, 0, R * 0.1, 0, TAU);
  g.fill();
}

function drawShieldBearer(ctx, t, o) {
  drawLayer(ctx, 'shieldbearer', ENEMY_COLOR.shieldbearer, shieldBearerPaint, o);
}

// Aura (#20): a faint disc and ring at opts.aura radius, drawn under the Bearer. Live, not baked, since the radius varies.
function drawAura(ctx, o) {
  if (o.aura <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba(ENEMY_COLOR.shieldbearer, 0.05);
  ctx.beginPath();
  ctx.arc(0, 0, o.aura, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(ENEMY_COLOR.shieldbearer, 0.35);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// Barrier (#20): four bright arcs on a ring outside any enemy it protects. Turns slowly.
// Its colour and broken segments keep it apart from the Shellback's solid plate.
function drawBarrier(ctx, t, b, size) {
  const r = R * (size || 1) * 1.9;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = rgba(PALETTE.barrier, 0.35 + 0.55 * b);
  for (let i = 0; i < 4; i++) {
    const a0 = t * 1.2 + (i * TAU) / 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a0 + TAU / 4 - 0.35);
    ctx.stroke();
  }
  ctx.restore();
}

// Ink Squid (#22): a pointed mantle with fins, a trailing set of tentacles at the head, and a glowing ink sac.
function inkSquidPaint(g, c) {
  const tail = (sign) => (p) => {
    p.moveTo(-R * 0.7, sign * R * 0.35);
    p.lineTo(-R * 1.5, sign * R * 1.05);
    p.lineTo(-R * 1.2, sign * R * 0.05);
    p.closePath();
  };
  neonBody(
    g,
    (p) => {
      p.moveTo(R * 1.0, 0);
      p.quadraticCurveTo(R * 0.7, -R * 0.75, -R * 0.2, -R * 0.6);
      p.lineTo(-R * 1.6, 0);
      p.lineTo(-R * 0.2, R * 0.6);
      p.quadraticCurveTo(R * 0.7, R * 0.75, R * 1.0, 0);
      p.closePath();
    },
    c,
    1
  );
  neonBody(g, tail(-1), c, 0.8);
  neonBody(g, tail(1), c, 0.8);

  g.strokeStyle = rgba(mixHex(c, '#ffffff', 0.4), 0.85);
  g.lineWidth = 1.2;
  g.lineCap = 'round';
  g.beginPath();
  for (let i = -2; i <= 1; i++) {
    const oy = (i + 0.5) * R * 0.3;
    g.moveTo(R * 0.7, oy);
    g.quadraticCurveTo(R * 1.1, oy * 0.6, R * 1.5, oy + (i < 0 ? -1 : 1) * R * 0.25);
  }
  g.stroke();

  g.fillStyle = PALETTE.deepTop;
  g.beginPath();
  g.arc(R * 0.3, -R * 0.22, R * 0.2, 0, TAU);
  g.fill();
  g.fillStyle = rgba('#ffffff', 0.9);
  g.beginPath();
  g.arc(R * 0.36, -R * 0.27, R * 0.07, 0, TAU);
  g.fill();

  g.globalCompositeOperation = 'lighter';
  g.fillStyle = rgba(PALETTE.inkRim, 0.7);
  g.beginPath();
  g.arc(-R * 0.3, 0, R * 0.22, 0, TAU);
  g.fill();
}

function drawInkSquid(ctx, t, o) {
  drawLayer(ctx, 'inksquid', ENEMY_COLOR.inksquid, inkSquidPaint, o);
}

// Phase Eel (#24): a tapering serpent with a head at +x. `p8` is one of eight wiggle phases, baked per phase.
const EEL_SAMPLES = 16;
function eelCentre(s, ph) {
  return [-2.0 * R + 3.6 * R * s, Math.sin(s * 5.2 - ph) * R * 0.42 * (1 - 0.5 * s)];
}

function eelPaint(p8) {
  const ph = (p8 / 8) * TAU;
  return (g, c) => {
    const top = [];
    const bot = [];
    for (let i = 0; i <= EEL_SAMPLES; i++) {
      const s = i / EEL_SAMPLES;
      const [x, y] = eelCentre(s, ph);
      const [xa, ya] = eelCentre(Math.max(0, s - 0.02), ph);
      const [xb, yb] = eelCentre(Math.min(1, s + 0.02), ph);
      const dx = xb - xa;
      const dy = yb - ya;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len;
      const ny = dx / len;
      const w = R * (0.16 + 0.3 * Math.pow(s, 0.8));
      top.push([x + nx * w, y + ny * w]);
      bot.push([x - nx * w, y - ny * w]);
    }
    neonBody(
      g,
      (p) => {
        p.moveTo(top[0][0], top[0][1]);
        for (let i = 1; i < top.length; i++) p.lineTo(top[i][0], top[i][1]);
        for (let i = bot.length - 1; i >= 0; i--) p.lineTo(bot[i][0], bot[i][1]);
        p.closePath();
      },
      c,
      1
    );
    // Dorsal ridge: a row of small fins along the back.
    g.strokeStyle = rgba(mixHex(c, '#ffffff', 0.5), 0.8);
    g.lineWidth = 1;
    g.beginPath();
    for (let i = 4; i < EEL_SAMPLES; i += 2) {
      g.moveTo(top[i][0], top[i][1]);
      g.lineTo((top[i][0] + top[i + 1][0]) / 2 - R * 0.05, (top[i][1] + top[i + 1][1]) / 2 - R * 0.35);
      g.lineTo(top[i + 1][0], top[i + 1][1]);
    }
    g.stroke();
    const [hx, hy] = eelCentre(0.86, ph);
    g.fillStyle = PALETTE.deepTop;
    g.beginPath();
    g.arc(hx + R * 0.12, hy - R * 0.1, R * 0.16, 0, TAU);
    g.fill();
  };
}

function drawPhaseEel(ctx, t, o) {
  // Hidden eels (visibility 0) are not drawn; their ripple is.
  if (o.visibility > 0) {
    const cycle = ((t * 5) % TAU + TAU) % TAU;
    const p = Math.round((cycle / TAU) * 8) % 8;
    ctx.save();
    ctx.globalAlpha = o.visibility;
    drawLayer(ctx, 'phaseeel.' + p, ENEMY_COLOR.phaseeel, eelPaint(p), o);
    ctx.restore();
  }
  if (o.telegraph > 0) {
    // The surfacing ripple: two rings widening out of the eel's position, and a faint splash at its centre.
    const tg = o.telegraph;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineWidth = 1.5;
    const f = (t * 2) % 1;
    for (let j = 0; j < 2; j++) {
      const frac = (f + j * 0.5) % 1;
      ctx.strokeStyle = rgba(PALETTE.phaseeel, (1 - frac) * tg * 0.9);
      ctx.beginPath();
      ctx.arc(0, 0, R * (1.2 + 2.0 * frac), 0, TAU);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(PALETTE.phaseeel, 0.3 * tg);
    ctx.beginPath();
    ctx.arc(0, 0, R * 0.7, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
}

// Anglerfish Warden (#38): a four-size boss. Its geometry is in units of W (4R), facing +x.
// `ph` 1 is a dark crimson body; `ph` 2 adds a dorsal crest, a crack pattern and a hotter colour.
function wardenPaint(ph) {
  return (g, c) => {
    neonBody(
      g,
      (p) => {
        p.moveTo(W * 1.0, 0);
        p.quadraticCurveTo(W * 0.9, -W * 0.85, 0, -W * 0.85);
        p.quadraticCurveTo(-W * 0.9, -W * 0.6, -W * 1.45, -W * 0.1);
        p.lineTo(-W * 1.5, W * 0.1);
        p.quadraticCurveTo(-W * 0.9, W * 0.6, 0, W * 0.85);
        p.quadraticCurveTo(W * 0.9, W * 0.85, W * 1.0, 0);
        p.closePath();
      },
      c,
      1.4
    );
    if (ph === 2) {
      // Dorsal crest: long spikes along the back.
      neonBody(
        g,
        (p) => {
          const xs = [0.3, 0.0, -0.3, -0.6, -0.9];
          for (const x of xs) {
            const base = x > 0 ? -0.8 : -0.62;
            p.moveTo(W * (x - 0.08), W * base);
            p.lineTo(W * x, W * (base - 0.34));
            p.lineTo(W * (x + 0.08), W * base);
            p.closePath();
          }
        },
        c,
        1
      );
      g.strokeStyle = rgba(PALETTE.deepTop, 0.6);
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(-W * 0.3, -W * 0.5);
      g.lineTo(-W * 0.1, -W * 0.2);
      g.lineTo(-W * 0.45, W * 0.1);
      g.moveTo(-W * 0.1, -W * 0.2);
      g.lineTo(W * 0.15, -W * 0.45);
      g.stroke();
    }
    // Jaw: a light mouth line with teeth.
    g.strokeStyle = rgba('#fff4e0', 0.8);
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(W * 0.1, W * 0.1);
    g.lineTo(W * 0.98, W * 0.04);
    g.stroke();
    g.fillStyle = rgba('#fff4e0', 0.95);
    g.beginPath();
    for (const x of [0.42, 0.57, 0.72, 0.87]) {
      g.moveTo(W * (x - 0.05), W * 0.1);
      g.lineTo(W * x, W * 0.02);
      g.lineTo(W * (x + 0.05), W * 0.1);
      g.closePath();
    }
    g.fill();
    // Eye, with a dark pupil.
    g.fillStyle = PALETTE.wardenLure;
    g.beginPath();
    g.arc(W * 0.42, -W * 0.3, W * 0.13, 0, TAU);
    g.fill();
    g.fillStyle = PALETTE.deepTop;
    g.beginPath();
    g.arc(W * 0.45, -W * 0.3, W * 0.05, 0, TAU);
    g.fill();
    // Lure: a stalk arcing forward to a bulb. The glow over the bulb is drawn live in drawWarden.
    g.strokeStyle = rgba(mixHex(c, '#ffffff', 0.3), 0.9);
    g.lineWidth = 2.2;
    g.beginPath();
    g.moveTo(W * 0.55, -W * 0.75);
    g.quadraticCurveTo(W * 0.9, -W * 1.1, W * 1.22, -W * 1.02);
    g.stroke();
    g.fillStyle = PALETTE.wardenLure;
    g.beginPath();
    g.arc(W * 1.28, -W * 1.0, W * 0.1, 0, TAU);
    g.fill();
  };
}

function drawWarden(ctx, t, o) {
  const ph = o.phase;
  const color = ph === 2 ? PALETTE.wardenPhase2 : ENEMY_COLOR.warden;
  drawLayer(ctx, 'warden.' + ph, color, wardenPaint(ph), o);

  // Lure glow: pulses over the bulb, always on.
  const pulse = 0.5 + 0.5 * Math.sin(t * 4);
  const lx = W * 1.28;
  const ly = -W * 1.0;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba(PALETTE.wardenLure, 0.1 + 0.08 * pulse);
  ctx.beginPath();
  ctx.arc(lx, ly, W * (0.42 + 0.06 * pulse), 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(PALETTE.wardenLure, 0.22 + 0.12 * pulse);
  ctx.beginPath();
  ctx.arc(lx, ly, W * 0.24, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba('#ffffff', 0.7 + 0.3 * pulse);
  ctx.beginPath();
  ctx.arc(lx, ly, W * 0.09, 0, TAU);
  ctx.fill();

  // Weak point: a dim core, which flares during the 0.6 s window when `vulnerable` rises toward 1.
  const v = o.vulnerable;
  const wx = -W * 0.25;
  ctx.fillStyle = rgba(PALETTE.wardenLure, 0.12 + 0.6 * v);
  ctx.beginPath();
  ctx.arc(wx, 0, W * (0.2 + 0.12 * v), 0, TAU);
  ctx.fill();
  ctx.strokeStyle = rgba(PALETTE.wardenLure, 0.25 + 0.7 * v);
  ctx.lineWidth = 1.5 + 2 * v;
  ctx.beginPath();
  ctx.arc(wx, 0, W * (0.3 + 0.08 * v), 0, TAU);
  ctx.stroke();
  ctx.fillStyle = rgba('#ffffff', 0.15 + 0.7 * v);
  ctx.beginPath();
  ctx.arc(wx, 0, W * 0.07, 0, TAU);
  ctx.fill();
  ctx.restore();
}

const ENEMY_DRAW = new Map([
  ['drifter', drawDrifter],
  ['spitter', drawSpitter],
  ['charger', drawCharger],
  ['shellback', drawShellback],
  ['splitter', drawSplitter],
  ['mini', drawMini],
  ['mine', drawMine],
  ['puffer', drawPuffer],
  ['shieldbearer', drawShieldBearer],
  ['inksquid', drawInkSquid],
  ['phaseeel', drawPhaseEel],
  ['warden', drawWarden],
]);

// Types that draw their own telegraph instead of the generic dashed ring.
const OWN_TELEGRAPH = new Set(['phaseeel']);
// Size multiples for types drawn larger than a standard enemy.
const ENEMY_SIZE = new Map([['warden', WARDEN_SIZE]]);

// Ink hazards (#22), drawn by draw.hazard. Puddle: a wobbling dark pool with a light rim.
function drawPuddle(ctx, x, y, r, t, life) {
  const a = clamp01(life);
  const N = 20;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const ang = (i / N) * TAU;
    const k = 1 + 0.09 * Math.sin(ang * 3 + t * 1.3) + 0.05 * Math.sin(ang * 5 - t * 0.9);
    const px = Math.cos(ang) * r * k;
    const py = Math.sin(ang) * r * k;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.fillStyle = rgba(PALETTE.ink, 0.62 * a);
  ctx.fill();
  ctx.strokeStyle = rgba(PALETTE.inkRim, 0.55 * a);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = rgba('#ffffff', 0.08 * a);
  ctx.beginPath();
  for (let i = 0; i < 3; i++) {
    const ang = t * 0.4 + (i * TAU) / 3;
    ctx.moveTo(Math.cos(ang) * r * 0.45 + r * 0.12, Math.sin(ang) * r * 0.35);
    ctx.arc(Math.cos(ang) * r * 0.45, Math.sin(ang) * r * 0.35, r * 0.1, 0, TAU);
  }
  ctx.fill();
  ctx.restore();
}

// Lob shadow: a faint landing disc that fills in over the flight, inside a dashed-looking outer ring at the full radius.
function drawLobShadow(ctx, x, y, r, progress) {
  const k = clamp01(progress);
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, r * (0.35 + 0.65 * k), 0, TAU);
  ctx.fillStyle = rgba(PALETTE.ink, 0.35 + 0.3 * k);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.strokeStyle = rgba(PALETTE.inkRim, 0.35 + 0.5 * k);
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// The lob in flight: a dark blob with a light rim. It grows with its height above the ground.
function drawInkBlob(ctx, x, y, r, t, height) {
  const size = r * (1 + 0.35 * clamp01(height)) * (1 + 0.05 * Math.sin(t * 10));
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, TAU);
  ctx.fillStyle = PALETTE.ink;
  ctx.fill();
  ctx.strokeStyle = PALETTE.inkRim;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(-size * 0.3, -size * 0.3, size * 0.25, 0, TAU);
  ctx.fillStyle = rgba('#ffffff', 0.35);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// public interface
// ---------------------------------------------------------------------------

export const draw = {
  // Deep-sea gradient, vignette and arena border are cached at device resolution.
  // Current lines are cached with a 40 px margin so their shift stays inside the layer.
  // Plankton is batched and animates every frame.
  background(ctx, w, h, t) {
    const time = num(t, 0);
    const { sx, sy } = scaleOf(ctx);
    ctx.save();

    const stat = bgLayer('static', w, h, sx, sy, w, h, 0, 0, (g) => paintStaticBackground(g, w, h));
    if (stat) {
      ctx.drawImage(stat, 0, 0, w, h);
    } else {
      paintStaticBackground(ctx, w, h);
    }

    // Current lines drift as a whole, as before. They are drawn live: a few thin strokes cost
    // far less than a full-screen blend, and the cached layer was the main background cost.
    ctx.globalAlpha = 0.6;
    ctx.translate(Math.sin(time * 0.09) * 24, Math.cos(time * 0.07) * 10);
    paintCaustics(ctx, w, h, 0);
    ctx.globalAlpha = 1;

    drawMotes(ctx, w, h, time);
    ctx.restore();
  },

  player(ctx, x, y, angle, t, opts) {
    drawPlayer(ctx, x, y, angle, num(t, 0), opts);
  },

  // Unknown types draw nothing rather than throw.
  enemy(ctx, type, x, y, angle, t, opts) {
    const fn = ENEMY_DRAW.get(type);
    if (fn === undefined) return;
    const o = readOpts(opts);
    const time = num(t, 0);
    curRes = spriteRes(scaleOf(ctx).sx * o.scale);
    curBox = BOX.get(type) || DEFAULT_BOX;
    const size = ENEMY_SIZE.get(type);
    ctx.save();
    ctx.translate(num(x, 0), num(y, 0));
    ctx.rotate(num(angle, 0));
    ctx.scale(o.scale, o.scale);
    if (type === 'shieldbearer') drawAura(ctx, o);
    fn(ctx, time, o);
    if (o.telegraph > 0 && !OWN_TELEGRAPH.has(type)) warnRing(ctx, time, o.telegraph, size);
    if (o.barrier > 0) drawBarrier(ctx, time, o.barrier, size);
    ctx.restore();
  },

  // Ink hazards (#22). kind: 'puddle' (opts.life 0..1 fades it), 'shadow' (a lob's landing disc,
  // opts.progress 0..1 grows it over the flight), or 'lob' (the blob in flight, opts.height 0..1).
  // Unknown kinds draw nothing.
  hazard(ctx, kind, x, y, radius, t, opts) {
    if (kind !== 'puddle' && kind !== 'shadow' && kind !== 'lob') return;
    const r = Math.max(0, num(radius, 0));
    if (!(r > 0)) return;
    const px = num(x, 0);
    const py = num(y, 0);
    const time = num(t, 0);
    const o = opts || {};
    ctx.save();
    if (kind === 'puddle') drawPuddle(ctx, px, py, r, time, num(o.life, 1));
    else if (kind === 'shadow') drawLobShadow(ctx, px, py, r, num(o.progress, 1));
    else drawInkBlob(ctx, px, py, r, time, num(o.height, 0));
    ctx.restore();
  },

  // Enemy bullet: amber by default, cyan when reflected.
  // A bright white-hot core, a strong glow, a pulsing outline, and a short trail.
  // The trail needs opts.vx and opts.vy (the velocity); without them the bullet has no trail.
  bullet(ctx, x, y, t, opts) {
    const o = readOpts(opts);
    const time = num(t, 0);
    const px = num(x, 0);
    const py = num(y, 0);
    const reflected = o.reflected;
    const color = reflected ? PALETTE.player : PALETTE.bullet;
    const key = reflected ? 'cyan' : 'amber';
    const breathe = 1 + 0.08 * Math.sin(time * 18 + px * 0.1);
    const pulse = 0.5 + 0.5 * Math.sin(time * 9 + px * 0.05 + py * 0.07);
    const size = 36 * o.scale * breathe; // glow diameter
    const glow = glowSprite(key, color);
    const ring = ringSprite(key, color);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';

    // Trail: three fading glow dots behind the bullet, against its velocity.
    const vx = num(opts && opts.vx, 0);
    const vy = num(opts && opts.vy, 0);
    const speed = Math.hypot(vx, vy);
    if (speed > 1) {
      const ux = vx / speed;
      const uy = vy / speed;
      for (let i = 1; i <= 3; i++) {
        const d = i * 4.5 * o.scale;
        const s = size * (0.72 - 0.16 * i);
        ctx.globalAlpha = 0.55 - 0.15 * i;
        if (glow) {
          ctx.drawImage(glow, px - ux * d - s / 2, py - uy * d - s / 2, s, s);
        } else {
          ctx.fillStyle = rgba(color, 1);
          ctx.beginPath();
          ctx.arc(px - ux * d, py - uy * d, s / 2, 0, TAU);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }

    // Strong glow, then the pulsing outline, then the bright core.
    if (glow) {
      ctx.drawImage(glow, px - size / 2, py - size / 2, size, size);
    } else {
      const r = size / 2;
      const grad = ctx.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, rgba(color, 1));
      grad.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, TAU);
      ctx.fill();
    }

    const ringSize = size * (0.62 + 0.08 * pulse);
    ctx.globalAlpha = 0.45 + 0.55 * pulse;
    if (ring) {
      ctx.drawImage(ring, px - ringSize / 2, py - ringSize / 2, ringSize, ringSize);
    } else {
      ctx.strokeStyle = rgba(color, 1);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, ringSize / 2, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = reflected ? PALETTE.dash : '#fff8e6';
    ctx.beginPath();
    ctx.arc(px, py, 3.4 * o.scale, 0, TAU);
    ctx.fill();
    ctx.restore();
  },

  // Expanding shockwave: soft fill, glow ring, and a bright inner edge. Fades as it grows.
  pulse(ctx, x, y, radius, alpha) {
    const a = clamp01(num(alpha, 1));
    const r = num(radius, 0);
    if (a <= 0 || r <= 0.5) return;
    const k = clamp01(r / PULSE_MAX_RADIUS);
    const edge = Math.max(1.2, 9 * (1 - k) + 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const fill = ctx.createRadialGradient(x, y, r * 0.55, x, y, r);
    fill.addColorStop(0, rgba(PALETTE.player, 0));
    fill.addColorStop(0.9, rgba(PALETTE.player, 0.1 * a * (1 - k)));
    fill.addColorStop(1, rgba(PALETTE.player, 0));
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.strokeStyle = rgba(PALETTE.player, 0.18 * a);
    ctx.lineWidth = edge * 3.2;
    ctx.stroke();
    ctx.strokeStyle = rgba(PALETTE.player, 0.5 * a);
    ctx.lineWidth = edge * 1.4;
    ctx.stroke();
    ctx.strokeStyle = rgba(PALETTE.dash, 0.95 * a);
    ctx.lineWidth = Math.max(1, edge * 0.45);
    ctx.stroke();
    ctx.restore();
  },
};
