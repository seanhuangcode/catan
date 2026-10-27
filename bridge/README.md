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

**Status: partly done.** This was built in an environment that couldn't reach colonist.io, so nothing here has been run against the real site yet. Here's what exists:

- **Board clicks.** These work from a calibration that `node bridge/record-colonist.js --calibrate` measures. You click the center tile and its right-hand neighbor, then the main buttons.
- **Moves.** Board placements, roll, end turn, build buttons and buying development cards go through the calibration. Dialog-based moves (discarding, stealing, playing development cards, bank trades) still need colonist.io's selectors.
- **Reading the game state** (`readSnapshot` in `profiles/colonist.js`) **is not written yet.** That's the main missing piece.

### Finishing colonist.io support

1. On your own computer, run `node bridge/record-colonist.js` and play one full game, ideally against colonist.io's computer opponents. It saves every network message, your clicks (with the element under the pointer), and periodic screenshots to `bridge/recordings/`.
2. Colonist.io sends game state over a WebSocket. Use the recording to write `readSnapshot()`. It should keep a running copy of the game from those messages, convert colonist's tile and corner numbering to the `[q, r, corner]` coordinates above, and return a snapshot. The recorded screenshots show what the true state was at each moment, so you can check the reader against them.
3. Fill in the remaining dialog moves in `performMove()` using the selectors in `clicks.jsonl`.
4. Test in advice mode first (`--profile colonist`, the default for colonist): it draws a ring on the suggested spot. Switch to `--auto` only once the suggestions consistently line up.

### Fair play

Only use the autopilot where automated play is allowed: games against colonist.io's computer opponents, or private games with friends who agree to it. Using it in public or ranked games against people is cheating, breaks colonist.io's rules, and can get your account banned. The colonist profile starts in advice mode and prints this reminder. The bridge deliberately has no features for hiding automation.
