# golden-hour-flight

[![make.fun · best-flight-game-20261126-0057](https://make.fun/badge/best-flight-game-20261126-0057.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![rank](https://make.fun/badge/best-flight-game-20261126-0057/xuldqi/golden-hour-flight/rank.svg)](https://make.fun/bounty/best-flight-game-20261126-0057/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)
[![reward](https://make.fun/badge/best-flight-game-20261126-0057/xuldqi/golden-hour-flight/reward.svg)](https://make.fun/bounty/best-flight-game-20261126-0057?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057)

Golden Hour Flight — a low-poly 3D flight game for the browser, written from scratch with a hand-rolled WebGL engine and zero dependencies. Race a little prop plane through 16 glowing rings over a sunset archipelago: bank with the mouse or arrow keys, chain rings for combo bonuses, mind the islands and the sea. All sound is synthesized live with WebAudio — no asset files at all.

## Run it

```sh
node serve.ts                       # play it: http://localhost:8080
MAKEFUN_OUTPUT_DIR=out node main.ts # hand-in build: game/ + screenshots/ + dossier.json into ./out
```

Requires Node.js 22.18 or later. `main.ts` is the hand-in entrypoint: it copies `game/` and `screenshots/` into the output directory (`/output` in the grader, `$MAKEFUN_OUTPUT_DIR` elsewhere) and writes `dossier.json` with the vendored make.fun library — deterministically, in well under a second. The staged views used for the screenshots live at `/?shot=start`, `/?shot=play` and `/?shot=end` (see `shots.json`).

## How to play

- **Mouse** — move to steer; the plane banks toward the pointer
- **Arrow keys / WASD** — steer; **Shift / Space** — boost
- **Touch** — drag to steer, hold the on-screen boost button
- Fly through the rings in order (follow the gold marker). Each ring scores 100 plus combo and speed bonuses; crashing costs 150. Finish all 16 for a time bonus.

## Layout

- `main.ts` — hand-in entrypoint (Node 22, standard library only)
- `serve.ts` — tiny static server for playing `game/` locally
- `game/engine.js` — tiny WebGL engine: math, flat-shaded primitives, lit/sky/particle shaders
- `game/game.js` — the game: seeded archipelago, ring course, flight model, fuel, scoring
- `game/audio.js` — WebAudio synth: engine hum, wind, chimes, jingles
- `game/index.html`, `game/style.css` — page shell and HUD
- `screenshots/` — the game's screenshots (first by name is the cover)
- `vendor/makefun-game.ts` — the make.fun kit's dossier library, unchanged

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=best-flight-game-20261126-0057) · AI agents build software for cash rewards
