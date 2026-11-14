import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAnnouncement, drawModesLayer } from '../src/modes-ui.js';
import { MODES, MODE_IDS, formatScore } from '../src/modes.js';

const ID = MODE_IDS[0];
const NAME = MODES[ID].name;
const modes = { mode: ID, bests: {}, dayKey: '2026-11-14', daily: null, official: false, share: null };

test('the live region says the title, not the start prompt of the old pill', () => {
  const t = liveAnnouncement({ screen: 'title', modes });
  assert.ok(t.includes('Title'));
  assert.ok(t.includes(`Mode: ${NAME}`));
  assert.ok(!t.includes('Click or press a key to start'));
});

test('game over names the score and the dive-again prompt', () => {
  const text = liveAnnouncement({ screen: 'over', modes, game: { score: 1234 } });
  assert.ok(text.startsWith('Game over.'));
  assert.ok(text.includes(`Score ${formatScore(1234)}`));
  assert.ok(text.includes('dive again'));
  assert.ok(!text.includes('start'), 'the game-over line never tells the player to start a game');
});

test('playing, paused and how-to each say their own state', () => {
  assert.equal(liveAnnouncement({ screen: 'playing', modes }), `Playing ${NAME}.`);
  assert.ok(liveAnnouncement({ screen: 'paused', modes }).startsWith('Paused.'));
  assert.ok(liveAnnouncement({ screen: 'howto', modes }).startsWith('How to play.'));
});

test('an unknown screen or a missing view announces nothing, and a missing mode does not throw', () => {
  assert.equal(liveAnnouncement({ screen: 'nope', modes }), '');
  assert.equal(liveAnnouncement(undefined), '');
  assert.doesNotThrow(() => liveAnnouncement({ screen: 'paused' }));
});

// A permissive context, enough for drawModesLayer on each screen.
function permissiveCtx() {
  const target = {};
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 10 });
      return () => {};
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}

test('drawModesLayer writes the live region only when the announcement changes', () => {
  const writes = [];
  const el = {};
  Object.defineProperty(el, 'textContent', {
    get() { return this._t ?? ''; },
    set(v) { writes.push(v); this._t = v; },
  });
  const previous = globalThis.document;
  globalThis.document = { getElementById: (id) => (id === 'sr-status' ? el : null) };
  try {
    const L = { winW: 800, winH: 900, hs: 1, s: 1, px: 0, py: 0, pw: 800, ph: 450 };
    drawModesLayer(permissiveCtx(), L, { screen: 'title', modes });
    drawModesLayer(permissiveCtx(), L, { screen: 'title', modes });
    drawModesLayer(permissiveCtx(), L, { screen: 'over', modes, game: { score: 50 } });
    drawModesLayer(permissiveCtx(), L, { screen: 'over', modes, game: { score: 50 } });
    assert.equal(writes.length, 2, 'one write per screen change, not per frame');
    assert.ok(writes[1].startsWith('Game over.'));
  } finally {
    globalThis.document = previous;
  }
});
