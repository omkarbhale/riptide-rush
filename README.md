# Riptide Rush

A fast, skill-driven browser arcade game. You are **Rip**, a blade-fish in a neon abyss. You do not shoot:
you **dash through** enemies. Every kill refunds a dash charge immediately, so a good player chains dashes
across the arena while a new player can play slowly and safely.

Design and architecture live in the [game design issue](https://github.com/omkarbhale/riptide-rush/issues/1).

## Controls

| Action | Keyboard | Mouse |
| --- | --- | --- |
| Swim | WASD / arrow keys | |
| Aim | | Move the mouse |
| Dash-slash toward the cursor | Space | Left click |
| Pulse: reflect bullets, stagger enemies | Shift | Right click |
| Pause / resume | Esc or P | Click on the pause screen |
| Start / restart | Space, Enter or R | Click |

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
- `src/input.js`: keyboard and mouse to actions, aim in logical coordinates, 120 ms action buffer.
- `src/render.js`: placeholder shapes, HUD and menus in the design palette.
