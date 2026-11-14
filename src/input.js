// DOM adapter: keyboard and mouse become named actions plus a logical-space aim point.
// Importing this module touches no DOM; only createInput() attaches listeners.
import { LOGICAL_WIDTH, LOGICAL_HEIGHT, INPUT_BUFFER } from './config.js';

const MOVE_KEYS = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

// Actions: dash, pulse, pause, confirm (start, resume, restart), select (Enter: the option under the cursor
// on the pause screen), and up/down/left/right (menu navigation; the game ignores them).
const KEY_ACTIONS = {
  Space: ['dash', 'confirm'],
  ShiftLeft: ['pulse'],
  ShiftRight: ['pulse'],
  Escape: ['pause'],
  KeyP: ['pause'],
  Enter: ['select'],
  KeyR: ['confirm'],
  ArrowUp: ['up'],
  KeyW: ['up'],
  ArrowDown: ['down'],
  KeyS: ['down'],
  ArrowLeft: ['left'],
  KeyA: ['left'],
  ArrowRight: ['right'],
  KeyD: ['right'],
};

const MOUSE_ACTIONS = {
  0: ['dash', 'confirm'],
  2: ['pulse', 'confirm'],
};

const PREVENT_DEFAULT = new Set([...Object.keys(MOVE_KEYS), ...Object.keys(KEY_ACTIONS)]);

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Buffers an action press for `windowSeconds` of simulation time, so a press just before a
// charge is ready still fires once it is. Time only moves when tick() is called.
export function createActionBuffer(windowSeconds = INPUT_BUFFER) {
  const left = new Map();
  return {
    press(action) {
      left.set(action, windowSeconds);
    },
    tick(dt) {
      for (const [action, t] of left) {
        if (t > 0) left.set(action, Math.max(0, t - dt));
      }
    },
    has(action) {
      return (left.get(action) ?? 0) > 0;
    },
    consume(action) {
      const armed = (left.get(action) ?? 0) > 0;
      left.set(action, 0);
      return armed;
    },
    clear() {
      left.clear();
    },
  };
}

// options.mapPoint(clientX, clientY) -> { x, y } in logical arena space. Defaults to the canvas rectangle,
// which is right only when the canvas is the arena; main.js passes the letterbox mapping.
// options.claimPointer(button, clientX, clientY) -> true when a menu took the click, so no action is queued.
export function createInput(canvas, options = {}) {
  const held = new Set();
  const edges = [];
  const buffer = createActionBuffer();
  const aim = { x: LOGICAL_WIDTH / 2, y: LOGICAL_HEIGHT / 2 };
  const mapPoint =
    options.mapPoint ??
    ((clientX, clientY) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: ((clientX - r.left) * LOGICAL_WIDTH) / r.width,
        y: ((clientY - r.top) * LOGICAL_HEIGHT) / r.height,
      };
    });
  const claimPointer = options.claimPointer ?? (() => false);

  const onKeyDown = (e) => {
    if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
    held.add(e.code);
    if (!e.repeat && KEY_ACTIONS[e.code]) edges.push(...KEY_ACTIONS[e.code]);
  };
  const onKeyUp = (e) => {
    held.delete(e.code);
  };
  const onBlur = () => {
    held.clear();
  };
  const onMouseMove = (e) => {
    Object.assign(aim, mapPoint(e.clientX, e.clientY));
  };
  const onMouseDown = (e) => {
    Object.assign(aim, mapPoint(e.clientX, e.clientY));
    if (claimPointer(e.button, e.clientX, e.clientY)) return;
    const actions = MOUSE_ACTIONS[e.button];
    if (!actions) return;
    edges.push(...actions);
  };
  const onContextMenu = (e) => e.preventDefault();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);

  return {
    // Actions pressed since the last drain, in order. Drain once per simulation step.
    drain() {
      return edges.splice(0, edges.length);
    },
    press(action) {
      buffer.press(action);
    },
    tick(dt) {
      buffer.tick(dt);
    },
    consume(action) {
      return buffer.consume(action);
    },
    // Forget queued presses and buffered actions (used on every screen change).
    reset() {
      edges.length = 0;
      buffer.clear();
    },
    // The plain input object the simulation reads.
    snapshot() {
      let mx = 0;
      let my = 0;
      for (const code of held) {
        const m = MOVE_KEYS[code];
        if (m) {
          mx += m[0];
          my += m[1];
        }
      }
      return {
        moveX: clamp(mx, -1, 1),
        moveY: clamp(my, -1, 1),
        aimX: aim.x,
        aimY: aim.y,
        dash: buffer.has('dash'),
        pulse: buffer.has('pulse'),
      };
    },
    dispose() {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('contextmenu', onContextMenu);
    },
  };
}
