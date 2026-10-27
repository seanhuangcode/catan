# Catan

A full Settlers of Catan game that runs in your browser, modeled on [colonist.io](https://colonist.io). You play against 2–3 bots, using the standard base-game rules.

No build step and no dependencies. Open `index.html` in a browser and play.

## Running

```bash
# Option 1: just open the file
open index.html

# Option 2: serve it locally
npm start   # http://localhost:8000
```

## Features

- **Random base-game board.** 19 tiles (4 lumber, 3 brick, 4 wool, 4 grain, 3 ore, 1 desert) and 18 number tokens. 6s and 8s are never next to each other. There are 9 harbors: four 3:1 and one 2:1 for each resource.
- **Setup in snake order.** Turn order is 1→n, then n→1. Your second settlement gives you its starting resources.
- **Full turn flow.** Roll for production (with the bank-shortage rule). On a 7, anyone holding more than 7 cards discards half, then the roller moves the robber and steals.
- **Building:** roads, settlements (distance rule), and cities. Each player has 15 roads, 5 settlements, and 4 cities.
- **Development cards.** The 25-card deck has 14 Knights, 5 Victory Points, 2 Road Building, 2 Year of Plenty, and 2 Monopoly. You can play one per turn, and not on the turn you bought it. Knights can be played before you roll.
- **Longest Road and Largest Army.** Longest Road needs 5+ roads and is lost if an opponent's settlement cuts your road. Largest Army needs 3+ knights.
- **Trading.** Trade with the bank at 4:1, 3:1, or 2:1 depending on your harbors. You can offer trades to the bots, and bots will offer trades to you.
- **Bots** pick setup spots, build, trade, play development cards, and use the robber. They also avoid feeding a player who is close to winning.
- **Colonist-style UI.** The game log hides private info (stolen cards and bought dev cards are visible only to the players involved). You also get player panels, a bank display, dice, and a game-over screen with dice stats.
- **Neural network bots** trained with reinforcement learning (see [`rl/README.md`](rl/README.md)). Choose them under "Bot type" on the start screen.
- **Options:** 2 or 3 bots, points to win (8–15), bot speed, and the friendly robber.
- **Keyboard:** <kbd>Space</kbd> rolls or ends your turn. <kbd>Esc</kbd> cancels build mode.

## Project layout

| File | Purpose |
| --- | --- |
| `js/board.js` | Hex geometry and random map generation |
| `js/game.js` | Rules engine. Every move goes through `Game#perform`, which checks it before applying it |
| `js/ai.js` | Bot decision making |
| `js/controller.js` | Runs the bots in the browser and handles trade offers |
| `js/ui.js` | SVG board, hand, action bar, log, and dialogs |
| `js/main.js` | Start screen and game setup |
| `rl/` | Reinforcement learning: encoding, neural network, training (see [`rl/README.md`](rl/README.md)) |
| `models/catan-policy.js` | The trained network the browser loads |
| `tests/simulate.js` | Headless self-play test |
| `tests/rl.test.js` | Tests for the RL code (gradient check, legal moves) |

## Tests

```bash
npm test          # 200 bot-only games with rule checks after every move, plus the RL tests
node tests/simulate.js 1000
```
