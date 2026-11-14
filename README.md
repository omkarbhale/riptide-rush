# Riptide Rush

A fast, skill-driven browser arcade game. You are **Rip**, a blade-fish in a neon abyss. You do not shoot:
you **dash through** enemies. Every kill refunds a dash charge immediately, so a good player chains dashes
across the arena while a new player can play slowly and safely.

Design and architecture live in the [game design issue](https://github.com/omkarbhale/riptide-rush/issues/1).

## Controls

| Action | Keyboard | Mouse | Touch | Gamepad |
| --- | --- | --- | --- | --- |
| Swim | WASD / arrow keys | | Left thumb: floating stick | Left stick |
| Aim | | Move the mouse | Right thumb: drag to aim | Right stick |
| Dash-slash toward the aim | Space | Left click | Release the right thumb (a quick tap dashes along the last aim) | A or right trigger |
| Pulse: reflect bullets, stagger enemies | Shift | Right click | PULSE button (bottom right) | B or left trigger |
| Pause / resume | Esc or P | Click on the pause screen | Pause button (top right) | Start |
| Start / restart | Space, Enter or R | Click | Tap | A |
| Menu: move / choose | Arrows, Enter | | Tap on the pause screen | D-pad or left stick, X |
| Fullscreen | F | Corner button | Corner button (top left) | |

Touch controls appear only on touch-first devices and never scroll or zoom the page. The stick and the aim
both use dead zones on the gamepad, and a pad can be plugged in or pulled out at any time.
Touch and gamepad aim are a direction from Rip, so the dash goes the way the thumb or stick points.

Dash has 3 charges, each recharging in 0.9 s; every kill refunds one. Pulse has a 2.5 s cooldown.
A pulse that reflects a bullet within 0.12 s of impact is a *perfect pulse*: brief slow-motion and a reset cooldown.
Dash and pulse presses are buffered for 120 ms, so an early press still fires.

Enemies: **Drifter** (chases), **Spitter** (keeps range and fires aimed bullets; reflected bullets kill),
**Charger** (telegraphs for 0.6 s, then lunges in a straight line).

## Play online

**[Play Riptide Rush in your browser](https://omkarbhale.github.io/riptide-rush/)**, deployed from `main` by GitHub Pages.

## Run locally

No build step and no dependencies. Serve the folder with any static server and open it in a browser:

```sh
npm run serve        # python3 -m http.server 8080
# then open http://localhost:8080/
```

The game uses relative URLs only, so it also works under a sub-path (for example GitHub Pages).

## Test

```sh
npm test             # node --test
```

Tests need Node 20 or newer and use only the built-in runner. CI runs them on Node 20, 22 and 24. `test/game.test.js` covers dash charges and refunds,
swept dash kills, combo and score math, combo expiry, damage and invulnerability, pulse reflection and the perfect
window, wave escalation, determinism, and a 60-simulated-second soak with random input.

## Layout

- `index.html`: letterboxed full-window canvas (1280x720 logical).
- `src/main.js`: boot, fixed 120 Hz loop with interpolated render, screens, sim-event to effect bridge.
- `src/game.js`: pure simulation (no DOM). `createGame(seed)`, `update(game, input, dt)`, and the `game.events` queue.
- `src/config.js`: every tuning number as a named constant.
- `src/input.js`: keyboard, mouse, gamepad and touch to actions and one input snapshot; dead zones; 120 ms action buffer.
- `src/touch.js`: touch gesture state (stick, aim drag, taps, buttons) and the on-screen overlay, mounted only on touch-first devices.
- `assets/`: SVG favicon and the social preview image.
- `src/render.js`: placeholder shapes, HUD and menus in the design palette.
