// Riptide Rush visual identity: procedural Canvas 2D drawing, no image files.
//
// Pure drawing code. Nothing here touches `window` or `document` at import time,
// so the module loads under `node --test`. Browser-only helpers (offscreen caches)
// are looked up lazily at draw time and fall back to direct drawing when absent.
//
// Entities are drawn in local space with the nose toward +x, then rotated by `angle`.
// Glow is layered strokes and sprites composited with 'lighter', never shadowBlur.
// Enemy bodies are cached as sprites (one per type, plus flash and telegraph overlays);
// animated details such as tendrils, spikes, cores and aim lines are drawn live.

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
});

const ENEMY_COLOR = Object.freeze({
  drifter: PALETTE.drifter,
  spitter: PALETTE.spitter,
  charger: PALETTE.charger,
  shellback: PALETTE.shellback,
  splitter: PALETTE.splitter,
  mini: PALETTE.mini,
  mine: PALETTE.mine,
});

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
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
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
// Used by the live fallback path and by dynamic details.
function tint(base, o) {
  let c = base;
  if (o.telegraph > 0) c = mixHex(c, PALETTE.danger, o.telegraph * 0.5);
  if (o.flash > 0) c = mixHex(c, '#ffffff', o.flash * 0.9);
  return c;
}

// Neon body: additive halo strokes, a dark tinted fill, and a bright edge.
// `build` must add subpaths only; it is called three times for one shape.
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
function warnRing(ctx, t, tg) {
  const strobe = 0.5 + 0.5 * Math.sin(t * (14 + 24 * tg));
  const r = R * (2.0 - 0.7 * tg);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.setLineDash([3, 4]);
  ctx.lineDashOffset = -t * 40;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, TAU);
  ctx.strokeStyle = rgba(PALETTE.danger, tg * (0.25 + 0.6 * strobe));
  ctx.lineWidth = 1.5 + 1.5 * tg;
  ctx.stroke();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// background: static layers are cached, motes and caustics animate on top
// ---------------------------------------------------------------------------

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

// Plankton drifts left. Nearer motes (larger d) move faster and look brighter.
function drawMotes(ctx, w, h, t) {
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < MOTES.length; i++) {
    const m = MOTES[i];
    const sx = m.x * w - t * (5 + 24 * m.d);
    const x = ((sx % w) + w) % w;
    const y = m.y * h + Math.sin(t * 0.5 + m.p) * 5 * m.d;
    ctx.fillStyle = rgba('#bff6ff', 0.12 + 0.35 * m.d * (0.75 + 0.25 * Math.sin(t * 1.7 + m.p * 3)));
    ctx.beginPath();
    ctx.arc(x, y, 0.6 + 1.5 * m.d, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// sprites
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

// Static bodies, drawn in colour `c`. These are the parts that get cached as sprites.
const BODY = {
  // Jellyfish bell. Its tendrils are live.
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

  // Diamond with a snout. The muzzle glow is live.
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

  // Full disc. The armour and the teal weak spot are live.
  shellback(g, c) {
    neonBody(g, (p) => p.arc(0, 0, R, 0, TAU), c, 1);
  },

  // Hexagonal cell. The caller rotates it. The division lines are live.
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

  // Core disc. The spikes and the strobing core are live.
  mine(g, c) {
    neonBody(g, (p) => p.arc(0, 0, R * 0.66, 0, TAU), c, 1);
  },
};

// Sprites cover [-SPRITE_HALF, SPRITE_HALF] in local units, at SPRITE_RES px per unit.
const SPRITE_RES = 3;
const SPRITE_HALF = 2 * R;
const SPRITE_PX = Math.ceil(SPRITE_HALF * 2 * SPRITE_RES);

// Base sprite for a type, or an overlay: 'flash' is white, 'tele' is danger magenta.
// Overlays are the base silhouette recoloured with source-in, so they match exactly.
function spriteOf(type, variant) {
  return cachedLayer('enemy:' + type + ':' + variant, SPRITE_PX, SPRITE_PX, (g) => {
    if (variant === 'base') {
      g.setTransform(SPRITE_RES, 0, 0, SPRITE_RES, SPRITE_PX / 2, SPRITE_PX / 2);
      BODY[type](g, ENEMY_COLOR[type]);
      return;
    }
    const base = spriteOf(type, 'base');
    if (!base) return;
    g.drawImage(base, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = variant === 'flash' ? '#ffffff' : PALETTE.danger;
    g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  });
}

// Draws the static body with flash and telegraph applied. Falls back to live drawing
// where offscreen canvases are unavailable.
function drawBody(ctx, type, o) {
  const base = spriteOf(type, 'base');
  if (!base) {
    BODY[type](ctx, tint(ENEMY_COLOR[type], o));
    return;
  }
  const prev = ctx.globalAlpha;
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(base, -SPRITE_HALF, -SPRITE_HALF, 2 * SPRITE_HALF, 2 * SPRITE_HALF);
  if (o.flash > 0) {
    ctx.globalAlpha = prev * o.flash * 0.9;
    ctx.drawImage(spriteOf(type, 'flash'), -SPRITE_HALF, -SPRITE_HALF, 2 * SPRITE_HALF, 2 * SPRITE_HALF);
  }
  if (o.telegraph > 0) {
    ctx.globalAlpha = prev * o.telegraph * 0.5;
    ctx.drawImage(spriteOf(type, 'tele'), -SPRITE_HALF, -SPRITE_HALF, 2 * SPRITE_HALF, 2 * SPRITE_HALF);
  }
  ctx.globalAlpha = prev;
}

// Drifter: tendrils behind the bell, then the bell body.
function drawDrifter(ctx, t, o) {
  const c = tint(ENEMY_COLOR.drifter, o);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const oy = (i - 1) * R * 0.5;
    ctx.beginPath();
    ctx.moveTo(-R * 0.2, oy);
    ctx.quadraticCurveTo(-R * 0.9, oy + Math.sin(t * 4 + i * 2 + 1) * R * 0.25, -R * 1.6, oy + Math.sin(t * 4 + i * 2) * R * 0.35);
    ctx.strokeStyle = rgba(c, 0.85);
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.restore();
  drawBody(ctx, 'drifter', o);
}

// Spitter: body, then a muzzle that glows as it winds up.
function drawSpitter(ctx, t, o) {
  const c = tint(ENEMY_COLOR.spitter, o);
  drawBody(ctx, 'spitter', o);
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
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.setLineDash([6, 6]);
    ctx.lineDashOffset = -t * 60;
    ctx.beginPath();
    ctx.moveTo(R * 1.6, 0);
    ctx.lineTo(R * (1.6 + 4.5 * tg), 0);
    ctx.strokeStyle = rgba(PALETTE.danger, 0.2 + 0.7 * tg);
    ctx.lineWidth = 1.2 + 1.2 * tg;
    ctx.stroke();
    ctx.restore();
  }
  ctx.save();
  ctx.translate(-tg * R * 0.35, 0);
  drawBody(ctx, 'charger', o);
  ctx.restore();
}

// Shellback: a bright armoured front half and a dark back with a teal weak spot.
// opts.hp below 3 shows cracks in the armour.
function drawShellback(ctx, t, o) {
  const c = tint(ENEMY_COLOR.shellback, o);
  const armour = tint('#c4d8ff', o);
  const core = PALETTE.shellbackCore;

  drawBody(ctx, 'shellback', o);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const beat = 0.6 + 0.4 * Math.sin(t * 4);
  ctx.fillStyle = rgba(core, 0.3 + 0.25 * beat);
  ctx.beginPath();
  ctx.arc(-R * 0.45, 0, R * 0.42, 0, TAU);
  ctx.fill();
  ctx.fillStyle = rgba(core, 0.95);
  ctx.beginPath();
  ctx.arc(-R * 0.45, 0, R * 0.16, 0, TAU);
  ctx.fill();
  ctx.restore();

  // Armoured front: a half-disc closed across its diameter.
  ctx.beginPath();
  ctx.arc(0, 0, R * 1.02, -Math.PI / 2, Math.PI / 2);
  ctx.closePath();
  ctx.fillStyle = armour;
  ctx.fill();
  ctx.strokeStyle = rgba('#ffffff', 0.9);
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // Armour plate ribs.
  ctx.strokeStyle = rgba(c, 0.6);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = -2; i <= 2; i++) {
    const a = i * 0.45;
    ctx.moveTo(R * 0.15 * Math.cos(a), R * 0.15 * Math.sin(a));
    ctx.lineTo(R * 0.98 * Math.cos(a), R * 0.98 * Math.sin(a));
  }
  ctx.stroke();

  const cracks = Math.max(0, Math.min(2, 3 - num(o.hp, 3)));
  if (cracks > 0) {
    ctx.strokeStyle = rgba(PALETTE.deepTop, 0.85);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(R * 0.3, -R * 0.8);
    ctx.lineTo(R * 0.55, -R * 0.35);
    ctx.lineTo(R * 0.4, -R * 0.05);
    if (cracks > 1) {
      ctx.moveTo(R * 0.55, -R * 0.35);
      ctx.lineTo(R * 0.8, -R * 0.2);
      ctx.moveTo(R * 0.4, R * 0.05);
      ctx.lineTo(R * 0.7, R * 0.5);
    }
    ctx.stroke();
  }
}

// Splitter: a hexagonal cell with three division lines. The halves pull apart as it readies.
function drawSplitter(ctx, t, o) {
  const c = tint(ENEMY_COLOR.splitter, o);
  const spin = t * 0.6;
  const sep = o.telegraph * R * 0.25;

  ctx.save();
  ctx.rotate(spin);
  drawBody(ctx, 'splitter', o);
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
  drawBody(ctx, 'mini', o);
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rgba('#ffffff', 0.4 + 0.3 * Math.sin(t * 10));
  ctx.beginPath();
  ctx.arc(-R * 0.1, 0, R * 0.12, 0, TAU);
  ctx.fill();
  ctx.restore();
}

// Mine: spikes behind the core, then the core body and a strobing centre that speeds up as it arms.
function drawMine(ctx, t, o) {
  const c = tint(ENEMY_COLOR.mine, o);
  const spin = t * 0.8;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.strokeStyle = rgba(c, 0.9);
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = spin + (i * TAU) / 8;
    ctx.moveTo(Math.cos(a) * R * 0.62, Math.sin(a) * R * 0.62);
    ctx.lineTo(Math.cos(a) * R * 1.15, Math.sin(a) * R * 1.15);
  }
  ctx.stroke();
  ctx.restore();

  drawBody(ctx, 'mine', o);

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

const ENEMY_DRAW = new Map([
  ['drifter', drawDrifter],
  ['spitter', drawSpitter],
  ['charger', drawCharger],
  ['shellback', drawShellback],
  ['splitter', drawSplitter],
  ['mini', drawMini],
  ['mine', drawMine],
]);

// ---------------------------------------------------------------------------
// public interface
// ---------------------------------------------------------------------------

export const draw = {
  // Deep-sea gradient, vignette and arena border are cached. Motes and current lines animate.
  background(ctx, w, h, t) {
    const time = num(t, 0);
    const stat = cachedLayer('bg:' + w + 'x' + h, w, h, (g) => paintStaticBackground(g, w, h));
    ctx.save();
    if (stat) {
      ctx.drawImage(stat, 0, 0, w, h);
    } else {
      paintStaticBackground(ctx, w, h);
    }

    // Current lines: the cached layer carries a 40 px margin, so the shift stays inside it.
    const caustic = cachedLayer('caustic:' + w + 'x' + h, w + 80, h + 40, (g) => {
      g.translate(40, 20);
      paintCaustics(g, w, h, 0);
    });
    if (caustic) {
      const ox = Math.sin(time * 0.09) * 24;
      const oy = Math.cos(time * 0.07) * 10;
      ctx.globalAlpha = 0.6;
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(caustic, -40 + ox, -20 + oy);
      ctx.globalAlpha = 1;
    } else {
      paintCaustics(ctx, w, h, time * 0.2);
    }

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
    ctx.save();
    ctx.translate(num(x, 0), num(y, 0));
    ctx.rotate(num(angle, 0));
    ctx.scale(o.scale, o.scale);
    fn(ctx, time, o);
    if (o.telegraph > 0) warnRing(ctx, time, o.telegraph);
    ctx.restore();
  },

  // Amber by default, cyan when reflected. Both use a cached glow sprite.
  bullet(ctx, x, y, t, opts) {
    const o = readOpts(opts);
    const time = num(t, 0);
    const color = o.reflected ? PALETTE.player : PALETTE.bullet;
    const breathe = 1 + 0.1 * Math.sin(time * 18 + num(x, 0) * 0.1);
    const size = 26 * o.scale * breathe;
    const sprite = glowSprite(o.reflected ? 'cyan' : 'amber', color);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (sprite) {
      ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
    } else {
      const r = size / 2;
      const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, rgba(color, 1));
      grad.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = o.reflected ? PALETTE.dash : '#fff4d6';
    ctx.beginPath();
    ctx.arc(x, y, 2.4 * o.scale, 0, TAU);
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
