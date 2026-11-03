# Bridge: playing on a real board

The bridge lets the trained policy (`rl/`) play on a Catan board in a real browser by clicking, the same way a person does.

```
 web page ──reader──▶ snapshot (JSON) ──policy──▶ move ──driver──▶ mouse clicks ──▶ web page
```

| Part | File | Site-specific? |
| --- | --- | --- |
| Snapshot format, rebuilding a game from it, choosing a move | `snapshot.js` | No |
| Board geometry and real mouse input (Playwright) | `driver.js` | No |
| Reading the page, mapping the board to the screen, the clicks for each move | `profiles/<site>.js` | **Yes** |
| The loop: read → decide → click → wait for the page to update | `autopilot.js` | No |

## Snapshot format

A snapshot is the game from one player's point of view, containing only what that player can see. Board locations use axial tile coordinates:
- a tile is `[q, r]`;
- a corner is `[q, r, corner]`, where corner 0 is the top and the rest go clockwise;
- an edge is `[q, r, side]`, where side *i* joins corner *i* and *i+1*.

So a reader never needs to know this engine's internal numbering. All the fields are documented at the top of `snapshot.js`.

`tests/bridge.test.js` checks that rebuilding a game from a snapshot gives the network exactly the same observation and legal moves as the original game, across thousands of states.

## Our own board (works now)

```bash
npm install                  # installs Playwright (dev only)
npm run autopilot            # opens the game, starts it, and plays your seat with clicks
npm run test:e2e             # same thing headless; passes when a full game finishes
node bridge/autopilot.js --advise --headed   # only shows suggestions, you click
```

## colonist.io

**Reading the game: done and tested.** `colonist-state.js` follows colonist's WebSocket messages: one full game state at the start (type 4), then diffs (type 91). It turns them into snapshots. `tests/colonist.test.js` replays a real recorded game (`tests/fixtures/colonist-game.jsonl.gz`, cleaned of tokens) and checks:
- at every decision, our engine's legal moves exactly equal the spots colonist highlighted;
- every move made was legal for us;
- every player's points match colonist's own count after every update (1,368 checks).

This found and fixed one real rule difference: colonist's friendly robber also protects your *own* tiles while you have 2 or fewer points.

**Clicking: written, not yet tried on the live site.**
- Buttons are clicked by id (`#roll-dice-button`, `#action-button-build-city`, …) or icon.
- Cards are clicked by their card code (`[data-card-enum]`).
- Card pickers (Year of Plenty, Monopoly, discards) use the confirm button.
- The board is a canvas, so it's clicked by position from the calibration. During setup colonist reports which spot is under the mouse; the autopilot checks that before clicking and fine-tunes the calibration from it.
- Trades and choosing between several players to rob aren't automated yet. The network never picks trades on colonist. When a move can't be clicked, the autopilot tells you what to do and waits for you.

### Playing a game with it

Use colonist.io's **computer opponents** (or friends who agree). On a Mac, in this folder:
```bash
npm run play-colonist               # plays your seat, clicking the moves itself
npm run play-colonist -- --advise   # only shows the suggested move on the board
```
It opens Chrome on colonist.io (a separate Chrome profile in `~/colonist-chrome`), asks you to measure the board the first time (start a game, click the middle tile, then its right neighbor), reloads the tab so it can follow the game, and plays. Don't resize the window after measuring; delete `bridge/profiles/colonist.calibration.json` to measure again.

### Message codes (from the recorded game)

| | |
| --- | --- |
| resources / cards | 1 wood, 2 brick, 3 sheep, 4 wheat, 5 ore; 11 knight, 12 VP, 13 monopoly, 14 road building, 15 year of plenty; 0 / 10 hidden |
| tiles | type 0 desert, 1–5 as above; (x, y) is the same axial (q, r) as snapshots |
| corners (x, y, z) | z 0 top / z 1 bottom corner of tile (x, y) |
| edges (x, y, z) | z 0 upper-left, 1 left, 2 lower-left side of tile (x, y) |
| harbors | type 1 = 3:1, 2–6 = 2:1 for resource type − 1 |
| turnState / actionState | 0 setup, 1 before the roll, 2 after; actionState 1/3 setup settlement/road, 4/6/7 road/settlement/city spot, 24 robber, 27 pick victim, 28 discard, 30/31 free roads, 32 pick cards |
| messages | 30/31/33 legal corners/edges/tiles, 43 cards changing hands, 18 card picker, 45 game over |

### Fair play

Only use the autopilot where automated play is allowed: games against colonist.io's computer opponents, or private games with friends who agree to it. Using it in public or ranked games against people is cheating, breaks colonist.io's rules, and can get your account banned. The colonist profile starts in advice mode and prints this reminder. The bridge deliberately has no features for hiding automation.
