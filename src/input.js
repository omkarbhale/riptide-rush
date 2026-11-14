// DOM adapter: keyboard, mouse, touch and gamepad become named actions plus one plain input snapshot,
// { moveX, moveY, aimX, aimY, dash, pulse }, which is the only thing the simulation reads.
// Importing this module touches no DOM; only createInput() attaches listeners.
import { LOGICAL_WIDTH, LOGICAL_HEIGHT, INPUT_BUFFER } from './config.js';
import { createTouchState, isTouchDevice, mountTouchControls, unitVector } from './touch.js';

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

// Gamepad, on the standard mapping. Keys are button indices ('b0' is A) or stick directions ('ls-up').
// Right stick is aim, left stick is move, and the left stick also steps through menus like the d-pad.
export const PAD_ACTIONS = {
  b0: ['dash', 'confirm'],  // A
  b1: ['pulse'],            // B
  b2: ['select'],           // X: the Enter of the pad, for the pause options
  b6: ['pulse'],            // left trigger
  b7: ['dash'],             // right trigger
  b9: ['pause'],            // Start
  b12: ['up'],
  b13: ['down'],
  b14: ['left'],
  b15: ['right'],
  'ls-up': ['up'],
  'ls-down': ['down'],
  'ls-left': ['left'],
  'ls-right': ['right'],
};
const PAD_TRIGGERS = new Set([6, 7]);
const PAD_TRIGGER_THRESHOLD = 0.5;

const PREVENT_DEFAULT = new Set([...Object.keys(MOVE_KEYS), ...Object.keys(KEY_ACTIONS)]);

export const STICK_DEAD_ZONE = 0.18;  // left stick: radial dead zone, fraction of full deflection
export const AIM_DEAD_ZONE = 0.22;    // right stick
export const STICK_MENU_THRESHOLD = 0.6; // left stick past this on one axis counts as a menu step
// Touch and gamepad aim are a direction from the player. The aim point sits this far out along it.
// Only the direction reaches the sim (dash and facing use unit vectors), so this is just the aim preview's reach.
export const AIM_RANGE = 200;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Radial dead zone: inside `deadZone` the stick reads zero; outside it, the magnitude rescales from 0 at the
// edge to 1 at full deflection and the direction is kept (so diagonals do not square off).
export function radialDeadZone(x, y, deadZone) {
  const m = Math.hypot(x, y);
  if (!(m > deadZone)) return { x: 0, y: 0 };
  const k = Math.min(1, (m - deadZone) / (1 - deadZone)) / m;
  return { x: x * k, y: y * k };
}

// The aim point `range` px from `origin` along the unit direction `dir`.
export function aimPoint(origin, dir, range = AIM_RANGE) {
  return { x: origin.x + dir.x * range, y: origin.y + dir.y * range };
}

// The four menu directions a stick vector is past. A stick pushed up pins 'up' as long as it is held there.
export function stickDirections(x, y, threshold = STICK_MENU_THRESHOLD) {
  const dirs = [];
  if (y < -threshold) dirs.push('up');
  if (y > threshold) dirs.push('down');
  if (x < -threshold) dirs.push('left');
  if (x > threshold) dirs.push('right');
  return dirs;
}

// The keys held down on one gamepad. `left` is its dead-zoned left stick, read once by the caller.
export function padKeys(pad, left) {
  const keys = new Set();
  const buttons = pad.buttons ?? [];
  buttons.forEach((b, i) => {
    if (!b) return;
    const on = PAD_TRIGGERS.has(i) ? b.value > PAD_TRIGGER_THRESHOLD : !!b.pressed;
    if (on) keys.add(`b${i}`);
  });
  for (const d of stickDirections(left.x, left.y)) keys.add(`ls-${d}`);
  return keys;
}

// Actions for keys that are held now but were not held last poll. Held keys do not repeat.
export function padEdges(prev, now) {
  const actions = [];
  for (const key of now) {
    if (!prev.has(key) && PAD_ACTIONS[key]) actions.push(...PAD_ACTIONS[key]);
  }
  return actions;
}

// One read of every connected gamepad. Sticks are summed across pads and clamped; the first pad whose right
// stick is past its dead zone sets the aim direction. Disconnected or missing pads (hot-plug) are skipped.
export function readPads(pads) {
  const move = { x: 0, y: 0 };
  let aim = null;
  const keys = new Set();
  for (const pad of pads) {
    if (!pad || pad.connected === false) continue;
    const axes = pad.axes ?? [];
    const left = radialDeadZone(axes[0] ?? 0, axes[1] ?? 0, STICK_DEAD_ZONE);
    move.x += left.x;
    move.y += left.y;
    if (!aim) {
      const right = radialDeadZone(axes[2] ?? 0, axes[3] ?? 0, AIM_DEAD_ZONE);
      aim = unitVector(right.x, right.y);
    }
    for (const k of padKeys(pad, left)) keys.add(k);
  }
  move.x = clamp(move.x, -1, 1);
  move.y = clamp(move.y, -1, 1);
  return { move, aim, keys };
}

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
// options.playerPosition() -> { x, y } of the player in logical space. Touch and gamepad aim are a direction
// from the player, so without it they aim from the centre of the arena.
// options.touch: true to mount the touch overlay. Defaults to on for touch-first devices only.
export function createInput(canvas, options = {}) {
  const held = new Set();
  const edges = [];
  const buffer = createActionBuffer();
  const aim = { x: LOGICAL_WIDTH / 2, y: LOGICAL_HEIGHT / 2 }; // mouse aim, absolute logical point
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
  const playerPosition = options.playerPosition ?? null;

  // Relative aim (touch and gamepad): a unit direction from the player. aimSource says which aim the
  // snapshot uses. 'mouse' is the absolute desktop aim and the default; touch-first devices start 'relative'.
  const touchState = createTouchState();
  const useTouch = options.touch ?? isTouchDevice(window);
  let aimSource = useTouch ? 'relative' : 'mouse';
  const relDir = { x: 1, y: 0 };
  let relExplicit = false; // false until a thumb or stick aims: until then, facing follows movement
  const setRelDir = (v) => {
    relDir.x = v.x;
    relDir.y = v.y;
  };
  const touchLayer = useTouch ? mountTouchControls(window, touchState) : null;

  const getPads = () =>
    typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
      ? Array.from(navigator.getGamepads() ?? [])
      : [];
  let padPrev = new Set();

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
    aimSource = 'mouse';
  };
  const onMouseDown = (e) => {
    Object.assign(aim, mapPoint(e.clientX, e.clientY));
    aimSource = 'mouse';
    if (claimPointer(e.button, e.clientX, e.clientY)) return;
    const actions = MOUSE_ACTIONS[e.button];
    if (!actions) return;
    edges.push(...actions);
  };
  const onContextMenu = (e) => e.preventDefault();
  // A pad that is plugged in or pulled out must not fire the buttons already held. Re-read the held set.
  const onPadChange = () => {
    padPrev = readPads(getPads()).keys;
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  window.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('gamepadconnected', onPadChange);
  window.addEventListener('gamepaddisconnected', onPadChange);
  padPrev = readPads(getPads()).keys;

  return {
    // Actions pressed since the last drain, in order. Drain once per simulation step.
    drain() {
      const pads = readPads(getPads());
      edges.push(...padEdges(padPrev, pads.keys));
      padPrev = pads.keys;
      edges.push(...touchState.drain());
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
      const pads = readPads(getPads());
      const t = touchState.read();
      mx = clamp(mx + pads.move.x + t.move.x, -1, 1);
      my = clamp(my + pads.move.y + t.move.y, -1, 1);

      if (t.aimActive && t.aimDir) {
        setRelDir(t.aimDir);
        relExplicit = true;
        aimSource = 'relative';
      }
      if (pads.aim) {
        setRelDir(pads.aim);
        relExplicit = true;
        aimSource = 'relative';
      }
      if (!relExplicit) {
        const dir = unitVector(mx, my);
        if (dir) setRelDir(dir);
      }

      let aimX = aim.x;
      let aimY = aim.y;
      if (aimSource === 'relative') {
        const origin = (playerPosition && playerPosition()) || {
          x: LOGICAL_WIDTH / 2,
          y: LOGICAL_HEIGHT / 2,
        };
        const p = aimPoint(origin, relDir);
        aimX = p.x;
        aimY = p.y;
      }
      return {
        moveX: mx,
        moveY: my,
        aimX,
        aimY,
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
      window.removeEventListener('gamepadconnected', onPadChange);
      window.removeEventListener('gamepaddisconnected', onPadChange);
      touchLayer?.dispose();
    },
  };
}
