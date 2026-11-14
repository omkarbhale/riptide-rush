// HUD, menus and the pause options panel: layout at the three checked window sizes, spawn markers kept off
// the HUD, the fade rule, the HUD event and animation state, saved options, the pause panel's mouse hit
// test, the game-over stack, the blink floor, and a stub-canvas run of every screen. Pure, so it runs under
// `node --test` with no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGICAL_WIDTH as W, LOGICAL_HEIGHT as H, SPAWN, ARENA } from '../src/config.js';
import { createGame } from '../src/game.js';
import { createFx } from '../src/fx.js';
import { drawFrame } from '../src/render.js';
import {
  DEFAULT_SETTINGS,
  OPTION_ROWS,
  SETTINGS_KEY,
  activateSetting,
  blinkAlpha,
  clampOutOfRects,
  computeLayout,
  coveredBlocks,
  countUp,
  createHud,
  drawHudLayer,
  formatTime,
  gameOverEntries,
  groupDigits,
  summaryPanels,
  howtoHit,
  howtoLayout,
  HOWTO_CARDS,
  hudBoxes,
  hudEvents,
  hudRectsLogical,
  hudUpdate,
  loadHowtoSeen,
  loadSettings,
  medalFor,
  normalizeSettings,
  pauseGeometry,
  pauseHit,
  runRecord,
  runStats,
  saveHowtoSeen,
  saveSettings,
  setVolume,
  stepSetting,
  SUMMARY_GATE,
  trackFraction,
} from '../src/hud.js';

// The three window sizes the playtest checks, plus the size the game is designed at.
const SIZES = [
  [1920, 1080],
  [1366, 768],
  [800, 900],
];

// A canvas stub that records every drawing call and every font it was given. Properties that the code
// reads back are stored on the target, so `ctx.globalAlpha * a` works.
function stubCtx(w, h) {
  const calls = {};
  const fonts = [];
  const alphas = [];
  const target = { canvas: { width: w, height: h }, globalAlpha: 1, font: '', fillStyle: '', shadowBlur: 0 };
  const ctx = new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      if (key === 'measureText') return (s) => ({ width: String(s).length * 8 });
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...args) => {
        (calls[key] ??= []).push(args);
      };
    },
    set(t, key, value) {
      if (key === 'font') fonts.push(String(value));
      if (key === 'globalAlpha') alphas.push(Number(value));
      t[key] = value;
      return true;
    },
  });
  return { ctx, calls, fonts, alphas };
}

// Makes a playing game with the player at a CSS point on the given layout.
function playingGame(L, cssX, cssY, seed = 3) {
  const game = createGame(seed);
  game.player.x = (cssX - L.px) / L.s;
  game.player.y = (cssY - L.py) / L.s;
  game.player.px = game.player.x;
  game.player.py = game.player.y;
  game.enemies = [];
  game.warnings = [];
  game.bullets = [];
  return game;
}

// ---- layout ------------------------------------------------------------------------------------------

test('layout: the arena keeps 16:9 and sits inside the window at each checked size', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    assert.ok(L.px >= 0 && L.py >= 0, `${w}x${h}: arena starts inside the window`);
    assert.ok(L.px + L.pw <= w + 1e-6 && L.py + L.ph <= h + 1e-6, `${w}x${h}: arena ends inside the window`);
    assert.ok(Math.abs(L.pw / L.ph - W / H) < 1e-6, `${w}x${h}: arena keeps 16:9`);
  }
});

test('layout: HUD text is never below 12 CSS px at 1920x1080, 1366x768 or 800x900', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    // The smallest HUD font is 12 logical px, so 12 * hs is its on-screen size.
    assert.ok(12 * L.hs >= 12, `${w}x${h}: smallest HUD text is ${12 * L.hs} CSS px`);
  }
});

test('layout: at 800x900 the HUD scales up from the letterboxed arena instead of shrinking with it', () => {
  const L = computeLayout(800, 900);
  assert.ok(L.s < 1, 'the arena is letterboxed small at this width');
  assert.equal(L.hs, 1, 'HUD scale holds at 1 CSS px per logical px');
  assert.ok(L.hs > L.s, 'HUD text is larger than the arena scale would give');
});

test('HUD panels stay inside the window for every modifier count', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    for (let mods = 0; mods <= 5; mods++) {
      const boxes = hudBoxes(L, mods);
      for (const [name, b] of Object.entries(boxes)) {
        assert.ok(b.x >= 0 && b.y >= 0, `${w}x${h} ${name} (${mods} mods) starts inside the window`);
        assert.ok(b.x + b.w <= w + 1e-6 && b.y + b.h <= h + 1e-6, `${w}x${h} ${name} (${mods} mods) ends inside the window`);
      }
    }
  }
});

// ---- spawn markers -----------------------------------------------------------------------------------

test('spawn markers: no marker on any edge is left under a HUD panel, at each checked size', () => {
  const inset = SPAWN.edgeInset;
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    for (let mods = 0; mods <= 3; mods++) {
      const rects = hudRectsLogical(L, mods);
      const r = 13 * 0.8;
      // Spawn points along all four edges, every 20 logical px.
      const points = [];
      for (let u = inset; u <= W - inset; u += 20) {
        points.push([u, inset], [u, H - inset]);
      }
      for (let v = inset; v <= H - inset; v += 20) {
        points.push([inset, v], [W - inset, v]);
      }
      for (const [x, y] of points) {
        const at = clampOutOfRects(x, y, r, rects);
        for (const q of rects) {
          const under = at.x + r > q.x && at.x - r < q.x + q.w && at.y + r > q.y && at.y - r < q.y + q.h;
          assert.ok(!under, `${w}x${h} (${mods} mods): marker from (${x},${y}) lands under ${q.name} at (${at.x.toFixed(1)},${at.y.toFixed(1)})`);
        }
        assert.ok(at.x >= ARENA.inset - 1e-6 && at.x <= W - ARENA.inset + 1e-6, 'x stays in the arena');
        assert.ok(at.y >= ARENA.inset - 1e-6 && at.y <= H - ARENA.inset + 1e-6, 'y stays in the arena');
      }
    }
  }
});

test('clampOutOfRects: a marker inside a rectangle moves to the nearest free edge; a free one stays put', () => {
  const rects = [{ name: 'box', x: 400, y: 600, w: 200, h: 60 }];
  const free = clampOutOfRects(100, 100, 10, rects);
  assert.deepEqual(free, { x: 100, y: 100 });
  const moved = clampOutOfRects(500, 640, 10, rects);
  // Nearest exit from y = 640 is below the box (660 + 10 = 670, 30 px away); above would be 50 px away.
  assert.equal(moved.x, 500);
  assert.equal(moved.y, 670);
  const above = clampOutOfRects(500, 610, 10, rects);
  assert.equal(above.y, 590, 'a marker near the top edge exits upward');
});

// ---- fade --------------------------------------------------------------------------------------------

test('fade: a HUD block is covered only while the player or an enemy is beneath it', () => {
  const L = computeLayout(1920, 1080);
  const score = hudBoxes(L, 0).score;
  const under = playingGame(L, score.x + score.w / 2, score.y + score.h / 2);
  assert.equal(coveredBlocks(L, under).score, true, 'the player under the score panel covers it');
  const clear = playingGame(L, 960, 540);
  assert.equal(coveredBlocks(L, clear).score, false, 'the player in the middle of the arena covers nothing');
});

test('fade: an enemy under a HUD block fades it toward 35% and it recovers when the enemy moves off', () => {
  const L = computeLayout(1920, 1080);
  const dash = hudBoxes(L, 0).dash;
  const game = playingGame(L, 960, 540);
  game.enemies.push({ id: 1, kind: 'drifter', x: (dash.x + dash.w / 2 - L.px) / L.s, y: (dash.y + 8 - L.py) / L.s, px: 0, py: 0, r: 13, alive: true });
  game.enemies[0].px = game.enemies[0].x;
  game.enemies[0].py = game.enemies[0].y;
  const hud = createHud();
  for (let i = 0; i < 120; i++) hudUpdate(hud, 1 / 60, game, L);
  assert.ok(Math.abs(hud.alpha.dash - 0.35) < 0.02, `dash block settles near 0.35, was ${hud.alpha.dash}`);
  assert.equal(hud.alpha.score, 1, 'a block nothing is beneath stays at full alpha');
  game.enemies = [];
  for (let i = 0; i < 120; i++) hudUpdate(hud, 1 / 60, game, L);
  assert.ok(hud.alpha.dash > 0.95, 'the block comes back once the enemy moves off');
});

// ---- score, pulses and banners -----------------------------------------------------------------------

test('score counts up toward the real score and pops when it gains', () => {
  const L = computeLayout(1280, 720);
  const game = playingGame(L, 640, 360);
  const hud = createHud();
  hudUpdate(hud, 1 / 60, game, L);
  game.score = 500;
  hudUpdate(hud, 1 / 60, game, L);
  assert.ok(hud.popT > 0, 'a gain starts the pop');
  assert.ok(hud.shown > 0 && hud.shown < 500, 'the displayed score eases up, not in one jump');
  for (let i = 0; i < 300; i++) hudUpdate(hud, 1 / 60, game, L);
  assert.equal(Math.round(hud.shown), 500, 'it reaches the real score');
  assert.equal(hud.popT, 0, 'the pop ends');
});

test('hud events: a wave start shows WAVE n, a flawless heal shows FLAWLESS +1, and peak combo is kept', () => {
  const game = createGame(4);
  const hud = createHud();
  game.combo.count = 9;
  hudEvents(hud, [{ type: 'waveStart', wave: 3 }], game);
  assert.equal(hud.banners.at(-1).text, 'WAVE 3');
  hudEvents(hud, [{ type: 'heal', source: 'flawless', hp: 3, bonus: 0 }], game);
  assert.equal(hud.banners.at(-1).text, 'FLAWLESS +1');
  hudEvents(hud, [{ type: 'heal', source: 'flawless', hp: 3, bonus: 200 }], game);
  assert.equal(hud.banners.at(-1).text, 'FLAWLESS +200', 'at full HP the flawless heal pays points');
  game.combo.count = 4;
  hudEvents(hud, [], game);
  assert.equal(hud.peakCombo, 9, 'peak combo keeps the highest count seen');
});

test('banners expire after their life', () => {
  const L = computeLayout(1280, 720);
  const game = playingGame(L, 640, 360);
  const hud = createHud();
  hudEvents(hud, [{ type: 'waveStart', wave: 1 }], game);
  for (let i = 0; i < 200; i++) hudUpdate(hud, 1 / 60, game, L);
  assert.equal(hud.banners.length, 0);
});

// ---- blink -------------------------------------------------------------------------------------------

test('blink: the restart prompt pulse never drops below 60% opacity', () => {
  let min = 1;
  for (let i = 0; i <= 2000; i++) min = Math.min(min, blinkAlpha(i * 0.01, 5, 0.6));
  assert.ok(min >= 0.6 - 1e-9, `lowest alpha ${min}`);
  assert.ok(min < 0.61, 'and it does reach the floor');
});

// ---- saved options -----------------------------------------------------------------------------------

function fakeStorage(initial = {}, { throws = false } = {}) {
  const data = { ...initial };
  return {
    getItem(k) {
      if (throws) throw new Error('blocked');
      return k in data ? data[k] : null;
    },
    setItem(k, v) {
      if (throws) throw new Error('blocked');
      data[k] = String(v);
    },
    data,
  };
}

test('options: defaults when nothing is saved, and a corrupt record falls back to defaults', () => {
  assert.deepEqual(loadSettings(fakeStorage()), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(fakeStorage({ [SETTINGS_KEY]: '{not json' })), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(null), DEFAULT_SETTINGS, 'no storage at all gives the defaults');
  assert.deepEqual(loadSettings(fakeStorage({}, { throws: true })), DEFAULT_SETTINGS, 'blocked storage gives the defaults');
});

test('options: an earlier mute choice survives the move to the settings record', () => {
  const s = loadSettings(fakeStorage({ 'riptide-rush.muted': '1' }));
  assert.equal(s.muted, true);
});

test('options: saved values round-trip, and out-of-range values are clamped or reset', () => {
  const store = fakeStorage();
  saveSettings(store, { volume: 0.4, muted: true, shake: 0.5, reducedFlashes: true });
  assert.deepEqual(loadSettings(store), { volume: 0.4, muted: true, shake: 0.5, reducedFlashes: true });
  assert.deepEqual(normalizeSettings({ volume: 9, shake: 0.7, muted: 'yes' }), {
    volume: 1,
    muted: false,
    shake: 1,
    reducedFlashes: false,
  });
  saveSettings(fakeStorage({}, { throws: true }), DEFAULT_SETTINGS); // must not throw
});

test('options: keys step volume in tenths, cycle shake without wrapping, and flip toggles', () => {
  let s = { ...DEFAULT_SETTINGS };
  s = stepSetting(s, 'volume', -1);
  assert.equal(s.volume, 0.9);
  for (let i = 0; i < 20; i++) s = stepSetting(s, 'volume', -1);
  assert.equal(s.volume, 0, 'volume stops at 0');
  for (let i = 0; i < 20; i++) s = stepSetting(s, 'volume', 1);
  assert.equal(s.volume, 1, 'volume stops at 100%');

  s = { ...DEFAULT_SETTINGS };
  s = stepSetting(s, 'shake', 1);
  assert.equal(s.shake, 1, 'shake does not wrap past 100%');
  s = stepSetting(s, 'shake', -1);
  assert.equal(s.shake, 0.5);
  s = stepSetting(s, 'shake', -1);
  assert.equal(s.shake, 0);
  s = stepSetting(s, 'shake', -1);
  assert.equal(s.shake, 0, 'shake stops at 0%');

  assert.equal(stepSetting(DEFAULT_SETTINGS, 'muted', 1).muted, true);
  assert.equal(stepSetting(DEFAULT_SETTINGS, 'reducedFlashes', -1).reducedFlashes, true);
});

test('options: Enter cycles shake 100 -> 50 -> 0 -> 100, flips toggles, and leaves volume alone', () => {
  let s = { ...DEFAULT_SETTINGS };
  s = activateSetting(s, 'shake');
  assert.equal(s.shake, 0.5);
  s = activateSetting(s, 'shake');
  assert.equal(s.shake, 0);
  s = activateSetting(s, 'shake');
  assert.equal(s.shake, 1, 'Enter wraps back to 100%');
  assert.equal(activateSetting(DEFAULT_SETTINGS, 'volume').volume, 1);
  assert.equal(activateSetting(DEFAULT_SETTINGS, 'muted').muted, true);
});

test('options: a volume set from the track is a 0..1 fraction in tenths', () => {
  assert.equal(setVolume(DEFAULT_SETTINGS, 0.34).volume, 0.35);
  assert.equal(setVolume(DEFAULT_SETTINGS, 2).volume, 1);
  assert.equal(setVolume(DEFAULT_SETTINGS, -1).volume, 0);
});

// ---- pause panel mouse ------------------------------------------------------------------------------

test('pause panel: clicks land on the right row, the volume track, or nothing', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    const g = pauseGeometry(L);
    OPTION_ROWS.forEach((id, i) => {
      const row = g.rows[i];
      const hit = pauseHit(L, row.x + row.w * 0.8, row.cy);
      assert.equal(hit.row, i, `${w}x${h}: centre of ${id} row hits row ${i}`);
    });
    const tr = g.rows[0].track;
    assert.deepEqual(pauseHit(L, tr.x + tr.w / 2, tr.y + tr.h / 2), { row: 0, part: 'track' }, `${w}x${h}: volume track`);
    assert.equal(pauseHit(L, 2, 2), null, 'outside the panel is not claimed');
    assert.equal(pauseHit(L, g.panel.x + g.panel.w / 2, g.panel.y + 4 * g.k).part, 'panel', 'the header is the panel');
    assert.ok(Math.abs(trackFraction(L, tr.x) - 0) < 1e-9, 'track left end is 0');
    assert.ok(Math.abs(trackFraction(L, tr.x + tr.w) - 1) < 1e-9, 'track right end is 1');
  }
});

test('pause panel: the whole panel sits inside the window and clear of the pause title', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    const g = pauseGeometry(L);
    assert.ok(g.panel.y >= 0 && g.panel.y + g.panel.h <= h, `${w}x${h}: panel fits`);
    const titleBottom = L.winH / 2 + (300 - H / 2) * L.hs + 14 * L.hs;
    assert.ok(g.panel.y > titleBottom, `${w}x${h}: panel sits under the hint line`);
  }
});

// ---- game over ---------------------------------------------------------------------------------------

// Width is approximated at 0.6 em per character; the anchor follows the line's alignment.
function entryRect(e) {
  const approxW = e.text.length * e.size * 0.6;
  const left = e.align === 'left' ? e.x : e.align === 'right' ? e.x - approxW : e.x - approxW / 2;
  return { id: e.id, x: left, y: e.y - e.size / 2, w: approxW, h: e.size };
}

// A summary with every stat present and a full five-row table, as the game would show it.
function summaryInput(over = {}) {
  return {
    score: 123456,
    highScore: 999999,
    newBest: false,
    overAge: 5,
    time: 2,
    stats: [
      { label: 'WAVE REACHED', value: 14 },
      { label: 'PEAK COMBO', value: 27 },
      { label: 'BEST MULTI', value: 'x4' },
      { label: 'KILLS', value: 312 },
      { label: 'ACCURACY', value: '41%' },
      { label: 'TIME', value: '3:12' },
    ],
    scores: [
      { score: 999999, wave: 30, seconds: 500 },
      { score: 400000, wave: 20, seconds: 300 },
      { score: 200000, wave: 16, seconds: 210 },
      { score: 90000, wave: null, seconds: null },
      { score: 1500, wave: 3, seconds: 40 },
    ],
    runRank: 2,
    ...over,
  };
}

test('run summary: no two lines of text overlap, at each checked size, with and without NEW BEST', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    for (const newBest of [false, true]) {
      const entries = gameOverEntries(L, summaryInput({ newBest }));
      const rects = entries.map(entryRect);
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i];
          const b = rects[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          assert.ok(!overlap, `${w}x${h} newBest=${newBest}: ${a.id} overlaps ${b.id}`);
        }
        const r = rects[i];
        assert.ok(r.x >= 0 && r.x + r.w <= w && r.y >= 0 && r.y + r.h <= h, `${w}x${h}: ${r.id} is inside the window`);
      }
    }
  }
});

// ---- drawing -----------------------------------------------------------------------------------------

function px(font) {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? Number(m[1]) : Infinity;
}

test('draw: every HUD and menu font is at least 12 CSS px at each checked size', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    const game = playingGame(L, w / 2, h / 2);
    game.modifiers = { sparkCoral: 6, frenzy: 3 };
    game.combo.count = 12;
    game.combo.tier = 1;
    const hud = createHud();
    hudEvents(hud, [{ type: 'waveStart', wave: 2 }], game);
    hudUpdate(hud, 0.05, game, L);
    for (const screen of ['playing', 'paused', 'title', 'over']) {
      const { ctx, fonts } = stubCtx(w, h);
      drawHudLayer(ctx, L, {
        screen,
        game,
        time: 1,
        highScore: 4200,
        newBest: false,
        overAge: 1,
        hud,
        settings: { ...DEFAULT_SETTINGS, muted: true },
        menuRow: 1,
      });
      for (const f of fonts) {
        assert.ok(px(f) >= 12, `${w}x${h} ${screen}: font "${f}" is under 12 CSS px`);
      }
    }
  }
});

test('draw: the pause screen with the options panel draws, and every screen draws with the real renderer', () => {
  for (const [w, h] of SIZES) {
    for (const screen of ['title', 'playing', 'paused', 'over']) {
      const L = computeLayout(w, h);
      const game = playingGame(L, w / 2, h / 2);
      game.over = screen === 'over';
      const { ctx, calls } = stubCtx(w, h);
      const fx = createFx({ random: () => 0.5 });
      drawFrame(ctx, {
        screen,
        game,
        alpha: 0,
        time: 1,
        dt: 1 / 60,
        highScore: 10,
        newBest: false,
        overAge: 1,
        muted: false,
        fx,
        rings: [],
        layout: L,
        hud: createHud(),
        settings: DEFAULT_SETTINGS,
        menuRow: 0,
      });
      assert.ok(calls.fillText && calls.fillText.length > 0, `${w}x${h} ${screen}: draws text`);
    }
  }
});

test('draw: Reduced flashes skips the full-screen flash and vignette; the shake option scales the offset', () => {
  const L = computeLayout(1280, 720);
  const game = playingGame(L, 640, 360);
  const base = {
    screen: 'playing',
    game,
    alpha: 0,
    time: 1,
    dt: 1 / 60,
    highScore: 0,
    newBest: false,
    overAge: 0,
    muted: false,
    rings: [],
    layout: L,
    hud: createHud(),
    menuRow: 0,
  };
  const fxWith = () => {
    const seen = { screen: 0, translate: [] };
    const fx = {
      update: () => 1,
      getShakeOffset: () => ({ x: 10, y: -4 }),
      drawWorld() {},
      drawScreen() {
        seen.screen++;
      },
    };
    return { fx, seen };
  };

  let { ctx, calls } = stubCtx(1280, 720);
  let rig = fxWith();
  drawFrame(ctx, { ...base, fx: rig.fx, settings: { ...DEFAULT_SETTINGS, shake: 0.5, reducedFlashes: false } });
  assert.equal(rig.seen.screen, 1, 'flashes are drawn when reduced flashes is off');
  const t = (calls.translate ?? []).find((a) => a[0] === 5 && a[1] === -2);
  assert.ok(t, 'a 50% shake halves the world offset');

  ({ ctx } = stubCtx(1280, 720));
  rig = fxWith();
  drawFrame(ctx, { ...base, fx: rig.fx, settings: { ...DEFAULT_SETTINGS, reducedFlashes: true } });
  assert.equal(rig.seen.screen, 0, 'reduced flashes skips the full-screen overlay');
});

test('game-over: the prompt is only shown after the restart gate', () => {
  const L = computeLayout(1280, 720);
  const early = gameOverEntries(L, { score: 1, highScore: 1, newBest: false, wave: 1, peakCombo: 0, overAge: 0.05, time: 0 });
  const late = gameOverEntries(L, { score: 1, highScore: 1, newBest: false, wave: 1, peakCombo: 0, overAge: 0.5, time: 0 });
  assert.equal(early.some((e) => e.id === 'prompt'), false);
  assert.equal(late.some((e) => e.id === 'prompt'), true);
  assert.ok(late.find((e) => e.id === 'prompt').alpha >= 0.6);
});

// ---- run summary, first-run how-to and title (#110) ------------------------------------------------

test('run summary: a stat the game does not expose is left out, not shown blank', () => {
  const game = createGame(7);
  game.wave.number = 4;
  const hud = createHud();
  const labels = runStats(game, hud).map((s) => s.label);
  assert.ok(labels.includes('WAVE REACHED'));
  assert.ok(!labels.includes('ACCURACY'), 'no dashes yet, so no accuracy');
  assert.ok(!labels.includes('BEST MULTI'), 'no kills yet, so no best multi');
  hud.dashes = 4;
  hud.killDashes = 1;
  hud.bestChain = 3;
  const full = runStats(game, hud);
  assert.equal(full.find((s) => s.label === 'ACCURACY').value, '25%');
  assert.equal(full.find((s) => s.label === 'BEST MULTI').value, 'x3');
  const bare = runStats({ score: 0, kills: 2, time: 61 }, hud);
  assert.ok(!bare.some((s) => s.label === 'WAVE REACHED'), 'a game with no wave omits the wave stat');
  assert.equal(bare.find((s) => s.label === 'TIME').value, '1:01');
});

test('run summary: the medal follows the score thresholds, with none below bronze', () => {
  assert.equal(medalFor(999), null);
  assert.equal(medalFor(1000).id, 'bronze');
  assert.equal(medalFor(4999).id, 'bronze');
  assert.equal(medalFor(5000).id, 'silver');
  assert.equal(medalFor(15000).id, 'gold');
  assert.equal(medalFor(30000).id, 'abyssal');
});

test('run summary: the count-up starts at zero, never passes the score, and lands on it', () => {
  assert.equal(countUp(5000, 0), 0);
  let last = 0;
  for (let age = 0; age <= 2; age += 0.05) {
    const v = countUp(5000, age);
    assert.ok(v >= last && v <= 5000, `age ${age}: ${v}`);
    last = v;
  }
  assert.equal(countUp(5000, 2), 5000);
});

test('run summary: this run is highlighted by its rank, and a run off the table is shown beside it', () => {
  const L = computeLayout(1280, 720);
  const onTable = gameOverEntries(L, summaryInput({ runRank: 2 }));
  assert.equal(onTable.find((e) => e.id === 'tscore2').weight, 'bold');
  assert.equal(onTable.find((e) => e.id === 'tscore0').weight, '600');
  assert.equal(onTable.some((e) => e.id === 'thisRun'), false, 'a run on the table needs no side note');
  const off = gameOverEntries(L, summaryInput({ runRank: -1, score: 777 }));
  assert.equal(off.find((e) => e.id === 'thisRun').text, 'This run  777');
  const empty = gameOverEntries(L, summaryInput({ scores: [], runRank: 0 }));
  assert.equal(empty.find((e) => e.id === 'tscore0').text, '—', 'an empty table row shows a dash');
});

test('run summary: best multi-kill and accuracy come from the kill and dash events', () => {
  const game = createGame(3);
  const hud = createHud();
  hudEvents(
    hud,
    [
      { type: 'dash' },
      { type: 'kill', multi: 1, cause: 'dash' },
      { type: 'kill', multi: 2, cause: 'dash' },
      { type: 'kill', multi: 3, cause: 'dash' },
      { type: 'dash' },
      { type: 'bulletCut' },
      { type: 'dash' },
      { type: 'kill', multi: 1, cause: 'shockwave' },
      { type: 'dash' },
      { type: 'kill', multi: 1, cause: 'defuse' },
    ],
    game,
  );
  assert.equal(hud.bestChain, 3);
  assert.equal(hud.dashes, 4);
  assert.equal(hud.killDashes, 2, 'the first dash and the mine it defused count; the pulse and the miss do not');
});

test('run record: carries the score, wave, kills, peak combo, best multi and time the list stores', () => {
  const game = createGame(3);
  game.score = 4200;
  game.kills = 17;
  game.time = 61.4;
  game.wave.number = 6;
  const hud = createHud();
  hud.peakCombo = 9;
  hud.bestChain = 4;
  assert.deepEqual(runRecord(game, hud, 1000), { score: 4200, wave: 6, kills: 17, peakCombo: 9, chain: 4, seconds: 61.4, at: 1000 });
});

test('run summary: the restart gate is 300 ms, and the prompt waits for it', () => {
  assert.equal(SUMMARY_GATE, 0.3);
  const L = computeLayout(1280, 720);
  assert.equal(gameOverEntries(L, summaryInput({ overAge: 0.29 })).some((e) => e.id === 'prompt'), false);
  assert.equal(gameOverEntries(L, summaryInput({ overAge: 0.3 })).some((e) => e.id === 'prompt'), true);
});

test('how-to: three cards, and only the skip button counts as a skip click', () => {
  assert.equal(HOWTO_CARDS.length, 3);
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    const g = howtoLayout(L);
    assert.equal(howtoHit(L, g.skip.x + g.skip.w / 2, g.skip.y + g.skip.h / 2), 'skip', `${w}x${h}`);
    assert.equal(howtoHit(L, g.card.x + g.card.w / 2, g.card.y + g.card.h / 2), null, `${w}x${h}: the card body is not skip`);
  }
});

test('how-to: the seen flag is saved and read back, and blocked storage reads as not seen', () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
  assert.equal(loadHowtoSeen(storage), false);
  saveHowtoSeen(storage);
  assert.equal(loadHowtoSeen(storage), true);
  const blocked = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(loadHowtoSeen(blocked), false);
  assert.doesNotThrow(() => saveHowtoSeen(blocked));
});

test('pause menu: the how-to row is last, sits inside the panel, and is clickable at each size', () => {
  assert.ok(OPTION_ROWS.includes('howto'));
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    const g = pauseGeometry(L);
    const last = g.rows[g.rows.length - 1];
    assert.equal(last.id, 'howto');
    assert.ok(last.y + last.h <= g.panel.y + g.panel.h, `${w}x${h}: the how-to row is inside the panel`);
    assert.ok(g.panel.y + g.panel.h <= h, `${w}x${h}: the panel is inside the window`);
    assert.deepEqual(pauseHit(L, g.panel.x + g.panel.w / 2, last.cy), { row: OPTION_ROWS.length - 1, part: 'row' });
  }
});

test('draw: the title draws at each checked size with a best score and with none', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    for (const highScore of [0, 4200]) {
      const { ctx, fonts } = stubCtx(w, h);
      drawHudLayer(ctx, L, { screen: 'title', game: null, time: 1.3, highScore, settings: DEFAULT_SETTINGS, menuRow: 0 });
      assert.ok(fonts.length > 0, `${w}x${h}: the title drew text`);
      for (const f of fonts) assert.ok(px(f) >= 12, `${w}x${h} title: font "${f}" is under 12 CSS px`);
    }
  }
});

test('draw: every how-to card draws at each checked size, with the animations at several times', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    for (let i = 0; i < HOWTO_CARDS.length; i++) {
      for (const time of [0.2, 1.1, 2.4]) {
        const { ctx, fonts } = stubCtx(w, h);
        drawHudLayer(ctx, L, { screen: 'howto', howtoIndex: i, time, game: null, settings: DEFAULT_SETTINGS, menuRow: 0 });
        assert.ok(fonts.length > 0, `${w}x${h} card ${i}: drew text`);
        for (const f of fonts) assert.ok(px(f) >= 12, `${w}x${h} card ${i}: font "${f}" is under 12 CSS px`);
      }
    }
  }
});

test('run summary: every stat and table line sits inside its own panel, at each checked size', () => {
  for (const [w, h] of SIZES) {
    const L = computeLayout(w, h);
    const panels = summaryPanels(L);
    for (const e of gameOverEntries(L, summaryInput())) {
      // Upper-case labels run wider than the 0.6 em estimate, so this check uses 0.75 em per character.
      const wide = e.text.length * e.size * 0.75;
      const left0 = e.align === 'left' ? e.x : e.align === 'right' ? e.x - wide : e.x - wide / 2;
      const r = { x: left0, w: wide };
      const inLeft = e.id.startsWith('stat') || e.id === 'score' || e.id === 'scoreLabel' || e.id === 'medal';
      const inRight = /^(rank|tscore|twave|ttime|hScore|hWave|hTime)/.test(e.id) || e.id === 'thisRun' || e.id === 'tableHead';
      if (!inLeft && !inRight) continue;
      const p = inLeft ? panels.left : panels.right;
      assert.ok(r.x >= p.x && r.x + r.w <= p.x + p.w, `${w}x${h}: ${e.id} "${e.text}" spills out of its panel`);
    }
  }
});
