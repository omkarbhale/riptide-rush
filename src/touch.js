// Touch controls: a floating left-thumb stick, right-thumb drag-to-aim with release-to-dash, and pulse and
// pause buttons. The gesture logic is a plain state object (createTouchState) so it runs under node --test.
// Only mountTouchControls() touches the DOM, and it is called only on touch devices.
//
// Coordinates are window CSS pixels. Touches are read on the window, so the canvas never sees the synthetic
// mouse events a tap would otherwise produce, and every gesture is prevented from scrolling or zooming the page.

export const TOUCH = {
  stickRadius: 64,   // px the stick knob can travel from where the left thumb landed
  aimSlop: 10,       // px a right thumb must travel before it counts as an aim drag
  tapMs: 260,        // a left-thumb touch this short and this still is a tap (confirms on title and pause)
  tapSlop: 14,       // px a tap may wander
  pulseSize: 104,    // px, the pulse button's diameter
  pauseSize: 56,     // px, the pause button's diameter
  margin: 22,        // px from the window edge to the buttons
  buttonSlop: 14,    // px of extra hit area around each button
};

// True only for devices whose primary pointer is a finger (or a stylus-like coarse pointer).
export function isTouchDevice(win) {
  try {
    return !!win?.matchMedia?.('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

// Unit vector for (x, y), or null when the vector is (almost) zero.
export function unitVector(x, y) {
  const m = Math.hypot(x, y);
  return m > 1e-9 ? { x: x / m, y: y / m } : null;
}

// Stick vector for a drag from the touch-down point (ax, ay) to (x, y): scaled to the stick radius and
// clamped to unit length, so a thumb past the rim holds full deflection.
export function stickFromDrag(ax, ay, x, y, radius = TOUCH.stickRadius) {
  const dx = (x - ax) / radius;
  const dy = (y - ay) / radius;
  const m = Math.hypot(dx, dy);
  return m > 1 ? { x: dx / m, y: dy / m } : { x: dx, y: dy };
}

// A left-thumb touch that was short and still: a tap.
export function isQuickTap(ms, distance) {
  return ms <= TOUCH.tapMs && distance <= TOUCH.tapSlop;
}

// Which control a touch at window point (x, y) starts on. The buttons sit in the right-hand corners,
// the stick takes the left half and aim takes the right half.
export function touchZoneAt(x, y, W, H) {
  const m = TOUCH.margin;
  const pulseR = TOUCH.pulseSize / 2 + TOUCH.buttonSlop;
  const pulseX = W - m - TOUCH.pulseSize / 2;
  const pulseY = H - m - TOUCH.pulseSize / 2;
  if (Math.hypot(x - pulseX, y - pulseY) <= pulseR) return 'pulse';
  const pauseR = TOUCH.pauseSize / 2 + TOUCH.buttonSlop;
  const pauseX = W - m - TOUCH.pauseSize / 2;
  const pauseY = m + TOUCH.pauseSize / 2;
  if (Math.hypot(x - pauseX, y - pauseY) <= pauseR) return 'pause';
  return x < W / 2 ? 'stick' : 'aim';
}

// The gesture state. Touch-down, move and up/cancel are fed in by the DOM layer (or a test); read() gives
// the current stick and aim, and drain() gives the actions the gestures produced since the last drain.
//
//   left thumb:   the stick. A quick still tap emits 'confirm' (starts the title, resumes the pause screen).
//   right thumb:  drag to aim. The direction of the drag from where the thumb landed becomes the aim
//                 direction. Lifting the thumb emits 'dash' and 'confirm', so a tap dashes along the last aim.
//   pulse, pause: emit 'pulse' and 'pause' on touch-down.
export function createTouchState() {
  const slots = { stick: null, aim: null, pulse: null, pause: null }; // zone -> { id, ax, ay, x, y, t }
  const edges = [];
  let move = { x: 0, y: 0 };
  let aimDir = null;      // last aim direction, kept after the thumb lifts
  let aimActive = false;  // true while an aim drag is past the slop

  const zoneOf = (id) => Object.keys(slots).find((k) => slots[k] && slots[k].id === id);

  function end(id, x, y, t, emit) {
    const zone = zoneOf(id);
    if (!zone) return;
    const s = slots[zone];
    slots[zone] = null;
    if (zone === 'stick') {
      move = { x: 0, y: 0 };
      if (emit && isQuickTap(t - s.t, Math.hypot(x - s.ax, y - s.ay))) edges.push('confirm');
    } else if (zone === 'aim') {
      aimActive = false;
      if (emit) edges.push('dash', 'confirm');
    }
  }

  return {
    down(id, x, y, t, zone) {
      if (!(zone in slots) || slots[zone]) return;
      slots[zone] = { id, ax: x, ay: y, x, y, t };
      if (zone === 'pulse') edges.push('pulse');
      else if (zone === 'pause') edges.push('pause');
    },
    move(id, x, y) {
      const zone = zoneOf(id);
      if (!zone) return;
      const s = slots[zone];
      s.x = x;
      s.y = y;
      if (zone === 'stick') {
        move = stickFromDrag(s.ax, s.ay, x, y);
      } else if (zone === 'aim') {
        const dx = x - s.ax;
        const dy = y - s.ay;
        if (Math.hypot(dx, dy) > TOUCH.aimSlop) {
          aimActive = true;
          aimDir = unitVector(dx, dy) ?? aimDir;
        }
      }
    },
    up(id, x, y, t) {
      end(id, x, y, t, true);
    },
    cancel(id) {
      end(id, 0, 0, 0, false);
    },
    read() {
      return {
        move: { ...move },
        aimDir: aimDir ? { ...aimDir } : null,
        aimActive,
        stick: slots.stick && { ...slots.stick },
        aim: slots.aim && { ...slots.aim },
        pulse: !!slots.pulse,
        pause: !!slots.pause,
      };
    },
    drain() {
      return edges.splice(0, edges.length);
    },
    reset() {
      for (const k of Object.keys(slots)) slots[k] = null;
      move = { x: 0, y: 0 };
      aimActive = false;
      edges.length = 0;
    },
  };
}

// ---- DOM layer ---------------------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const CYAN = '#3cf2ff';
const WHITE = '#eaffff';

const STYLE = `
.rr-touch-layer { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 5; overflow: visible; }
.rr-touch-layer * { pointer-events: none; }
`;

// Mounts the overlay and the window-level touch listeners. Returns dispose(). The overlay draws the stick,
// the aim line and the two buttons, and it never takes pointer events itself, so the canvas and the page
// controls keep their own. Touches that start on an element marked data-ui (the fullscreen button) are left
// alone so those controls still click.
export function mountTouchControls(win, state) {
  const doc = win.document;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  doc.head.append(style);

  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'rr-touch-layer');
  svg.setAttribute('aria-hidden', 'true');
  doc.body.append(svg);

  const make = (tag, attrs) => {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.append(el);
    return el;
  };
  const stickBase = make('circle', { r: TOUCH.stickRadius, fill: 'rgba(60,242,255,0.06)', stroke: CYAN, 'stroke-width': 2, opacity: 0 });
  const stickKnob = make('circle', { r: 26, fill: CYAN, 'fill-opacity': 0.45, stroke: CYAN, 'stroke-width': 2, opacity: 0 });
  const aimRing = make('circle', { r: 34, fill: 'none', stroke: WHITE, 'stroke-width': 2, 'stroke-opacity': 0.6, opacity: 0 });
  const aimLine = make('line', { stroke: WHITE, 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0 });
  const aimTip = make('circle', { r: 8, fill: WHITE, opacity: 0 });
  const pulseDisc = make('circle', { fill: 'rgba(5,10,24,0.5)', stroke: CYAN, 'stroke-width': 2, 'stroke-opacity': 0.7 });
  const pulseLabel = make('text', {
    'font-family': 'system-ui, sans-serif', 'font-size': 14, 'font-weight': 700, 'letter-spacing': 1,
    fill: CYAN, 'text-anchor': 'middle', 'dominant-baseline': 'central',
  });
  pulseLabel.textContent = 'PULSE';
  const pauseDisc = make('circle', { fill: 'rgba(5,10,24,0.5)', stroke: WHITE, 'stroke-width': 2, 'stroke-opacity': 0.5 });
  const pauseBarL = make('rect', { width: 5, height: 18, rx: 2, fill: WHITE, 'fill-opacity': 0.85 });
  const pauseBarR = make('rect', { width: 5, height: 18, rx: 2, fill: WHITE, 'fill-opacity': 0.85 });

  const place = (el, cx, cy) => {
    el.setAttribute('cx', cx);
    el.setAttribute('cy', cy);
  };

  let raf = 0;
  function draw() {
    const v = state.read();
    const W = win.innerWidth;
    const H = win.innerHeight;
    const m = TOUCH.margin;

    if (v.stick) {
      const { ax, ay } = v.stick;
      place(stickBase, ax, ay);
      stickBase.setAttribute('opacity', 1);
      place(stickKnob, ax + v.move.x * TOUCH.stickRadius, ay + v.move.y * TOUCH.stickRadius);
      stickKnob.setAttribute('opacity', 1);
    } else {
      stickBase.setAttribute('opacity', 0);
      stickKnob.setAttribute('opacity', 0);
    }

    if (v.aim) {
      place(aimRing, v.aim.ax, v.aim.ay);
      aimRing.setAttribute('opacity', 1);
      if (v.aimActive) {
        aimLine.setAttribute('x1', v.aim.ax);
        aimLine.setAttribute('y1', v.aim.ay);
        aimLine.setAttribute('x2', v.aim.x);
        aimLine.setAttribute('y2', v.aim.y);
        aimLine.setAttribute('opacity', 0.9);
        place(aimTip, v.aim.x, v.aim.y);
        aimTip.setAttribute('opacity', 0.9);
      } else {
        aimLine.setAttribute('opacity', 0);
        aimTip.setAttribute('opacity', 0);
      }
    } else {
      aimRing.setAttribute('opacity', 0);
      aimLine.setAttribute('opacity', 0);
      aimTip.setAttribute('opacity', 0);
    }

    const pulseX = W - m - TOUCH.pulseSize / 2;
    const pulseY = H - m - TOUCH.pulseSize / 2;
    place(pulseDisc, pulseX, pulseY);
    pulseDisc.setAttribute('r', TOUCH.pulseSize / 2);
    pulseDisc.setAttribute('fill', v.pulse ? 'rgba(60,242,255,0.35)' : 'rgba(5,10,24,0.5)');
    // <text> is positioned by x and y, not cx and cy.
    pulseLabel.setAttribute('x', pulseX);
    pulseLabel.setAttribute('y', pulseY);

    const pauseX = W - m - TOUCH.pauseSize / 2;
    const pauseY = m + TOUCH.pauseSize / 2;
    place(pauseDisc, pauseX, pauseY);
    pauseDisc.setAttribute('r', TOUCH.pauseSize / 2);
    pauseDisc.setAttribute('fill', v.pause ? 'rgba(234,255,255,0.3)' : 'rgba(5,10,24,0.5)');
    pauseBarL.setAttribute('x', pauseX - 8);
    pauseBarL.setAttribute('y', pauseY - 9);
    pauseBarR.setAttribute('x', pauseX + 3);
    pauseBarR.setAttribute('y', pauseY - 9);

    raf = win.requestAnimationFrame(draw);
  }

  const now = () => win.performance.now();
  const onStart = (e) => {
    if (e.target?.closest?.('[data-ui]')) return;
    e.preventDefault();
    const W = win.innerWidth;
    const H = win.innerHeight;
    for (const t of e.changedTouches) {
      state.down(t.identifier, t.clientX, t.clientY, now(), touchZoneAt(t.clientX, t.clientY, W, H));
    }
  };
  const onMove = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) state.move(t.identifier, t.clientX, t.clientY);
  };
  const onEnd = (e) => {
    e.preventDefault();
    for (const t of e.changedTouches) state.up(t.identifier, t.clientX, t.clientY, now());
  };
  const onCancel = (e) => {
    for (const t of e.changedTouches) state.cancel(t.identifier);
  };
  // iPadOS and iOS pinch-zoom through gesture events, which touch-action does not cover.
  const onGesture = (e) => e.preventDefault();

  const passive = { passive: false };
  win.addEventListener('touchstart', onStart, passive);
  win.addEventListener('touchmove', onMove, passive);
  win.addEventListener('touchend', onEnd, passive);
  win.addEventListener('touchcancel', onCancel, passive);
  win.addEventListener('gesturestart', onGesture, passive);
  win.addEventListener('gesturechange', onGesture, passive);

  raf = win.requestAnimationFrame(draw);

  return {
    dispose() {
      win.cancelAnimationFrame(raf);
      win.removeEventListener('touchstart', onStart, passive);
      win.removeEventListener('touchmove', onMove, passive);
      win.removeEventListener('touchend', onEnd, passive);
      win.removeEventListener('touchcancel', onCancel, passive);
      win.removeEventListener('gesturestart', onGesture, passive);
      win.removeEventListener('gesturechange', onGesture, passive);
      svg.remove();
      style.remove();
      state.reset();
    },
  };
}
