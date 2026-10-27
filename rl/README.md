# Reinforcement learning for Catan

This folder trains a neural network to play Catan. It uses the same rules engine as the browser game (`js/game.js`), so the trained model plugs directly into the game as the **Neural network** bot type.

It's written in plain JavaScript with no dependencies. Training runs on CPU cores using Node worker threads.

## How it works

**Observation (1,809 numbers).** The board from one player's point of view:
- each tile's resource, number and robber;
- each corner's buildings, harbor, production pips, and whether you can build there;
- each edge's roads and whether you can build there;
- each player's public stats (points, card counts, knights, road length, production);
- your own hand and development cards, the turn phase, and the bank.

Opponents' hidden cards are never included.

**Actions (272).** One flat list covers every kind of move: settlement, road, or city on each spot, robber on each tile, steal from each opponent, discard one card of each resource, roll, end turn, buy or play development cards, 20 bank trades, and 20 one-for-one trade offers to the other players (at most 2 per turn, never the same offer twice). A legality mask removes illegal moves, and `tests/rl.test.js` checks that every move the mask allows is accepted by the engine. Multi-card discards are made one card at a time.

**Network.** A multilayer perceptron, 1,809 → 256 → 256, with a policy head (272 action logits) and a value head (predicted outcome).

On top of that are **pointer heads**: for each kind of location (settlement spot, city, road, robber tile, steal target), one shared scorer rates every location from that location's own features (and its neighbors'), conditioned on the overall game state. Without them, the network has to learn separately for each of the 54 corners that "high pips = good spot"; with them, what it learns about one corner applies to every corner. Adding pointer heads raised imitation accuracy from about 75% to 84%.

That's about 640,000 parameters in total. The forward and backward passes and the Adam optimizer are hand-written in `nn.js`, and the input is mostly zeros, so the first layer only processes the nonzero entries.

**Training happens in two stages:**
1. **Imitation** (`train.js imitation`). The hand-written bots play each other, and the network learns to predict their moves (cross-entropy) and the game outcome (value regression). This gives a competent starting policy, which is far faster than learning from random play.

   With `--dagger p`, each seat is instead played by the network with probability *p*, while the hand-written bot labels what it would have done in each of those positions (DAgger). This teaches the network to recover from its own mistakes rather than only seeing positions the bot would reach.
2. **PPO** (`train.js ppo`). Proximal Policy Optimization (clipped objective, GAE advantages, entropy bonus). Each iteration plays games of three kinds:
   - 50% against the hand-written bots;
   - 30% pure self-play;
   - 20% against frozen past versions of itself, to avoid overfitting to one opponent.

**Reward.** +1 for winning. On top of that is a small *potential-based* bonus for gaining victory points: potential = VP/10, dropped to 0 at the end of the game. Potential-based shaping speeds up learning without changing which strategy is optimal. The final objective is still just winning.

## Commands

```bash
npm run train:imitation                   # stage 1, ~10 min on 4 cores
npm run train:ppo -- --iters 300          # stage 2, run as long as you like
npm run eval                              # win rate vs 3 hand-written bots (4p and 3p)
npm run export-model                      # writes models/catan-policy.js for the browser
```

Useful options:

| Option | Meaning |
| --- | --- |
| `--workers N` | Number of worker threads |
| `--games N` | Games per worker per iteration |
| `--lr` | Learning rate |
| `--entropy` | Entropy bonus |
| `--mix-heuristic`, `--mix-self` | Opponent mix |
| `--hidden 256,256` | Layer sizes |
| `--eval-every` | How often to evaluate |

Training logs go to `rl/checkpoints/*.log.jsonl`.

## Evaluation

The metric is the win rate of one network seat against three copies of the hand-written bot over many games, with a random seat each game. A bot exactly as strong as the others wins 25% in 4-player games. Reported numbers include a 95% confidence interval.

## Results so far

Win rate of one network seat against three hand-written bots (4-player games; 25% = as strong as the bots). Each number comes from 400–800 games, which is about ±3 percentage points.

| Model | Win rate | What changed |
| --- | --- | --- |
| Imitation, plain MLP | ~10% | Copies the bot's moves; 75% move accuracy |
| + PPO (first run) | ~13% | Plateaued quickly |
| Imitation + pointer heads | ~8% | 90% move accuracy, yet still lost: it couldn't trade |
| + trade offers | ~14% | Matches the bots' behavior closely |
| + DAgger | ~14% | |
| **+ PPO** (`rl/checkpoints/ppo`) | **32.4% ± 1.4** | About 225 iterations (~21k games) of reinforcement learning against bots, itself, and past versions |

The final number comes from 4,000 fresh games: 32.4% ± 1.4 in 4-player games, so the network wins about 30% more often than a hand-written bot in the same seat. In 3-player games it wins 32.1% ± 1.4, where 33% is parity: it's only even there, because training used 4-player games only.

Two PPO runs from the same starting point (`ppo-run1/2.log.jsonl`) both levelled off at about 28–30% on their 800-game evaluations, so the improvement reproduces. Logs for every run are in `rl/checkpoints/*.log.jsonl`.

## Experiments that didn't help (yet)

These are kept in the code because they're useful tools, and so they aren't repeated blindly.

- **Hand-written search bot** (`js/searchbot.js`). It tries every legal move on a private copy of the game (opponents' hidden cards replaced by placeholders, deck reshuffled) and scores the result with a hand-tuned evaluation. It won 16.4% of 800 games against three heuristic bots, so it's weaker than them, mainly because it doesn't trade.
- **Network + lookahead** (`rl/search.js`, `NetSearchAgent`). This plays the policy's top moves on a private copy and scores each result with the value head:
  - Choosing among *all* top moves: 33.2% vs 28.7% for the network alone on the same 600 games.
  - Only choosing *where* (which spot, edge or tile) once the policy has picked the kind of move: 31.9% vs 29.9% on 900 games.
  - Both gains are within noise.
- **Expert iteration** (`train.js imitation --teacher search`). Training the network to imitate the lookahead's moves *collapsed* it from about 32% to 2% within about 250k samples. The lookahead scores "end turn" and "make an offer" as the current position, and builds as the value head's estimate after the build; the value head isn't precise enough for that comparison. So the search often preferred doing nothing, and imitation amplified it. A sharper value head (or deeper search) is needed before this can work.
- **Catanatron's bots as opponents.** The strong open-source bots (AlphaBeta and value-function players in [bcollazo/catanatron](https://github.com/bcollazo/catanatron)) aren't in the PyPI release, and running code from that repository wasn't permitted in the training environment. Its stdio protocol is a good fit for the snapshot bridge (`bridge/snapshot.js`): an adapter would convert its JSON state into a snapshot and match our chosen move against its playable actions. Its tiles map to our coordinates with q = x, r = z, and its corners NORTH … NORTHWEST map to our corners 0 … 5. It's GPL-3.0, so it should stay a separate tool rather than be copied into this project.

## Limitations and next steps

- **Trading.** The network makes 1-for-1 trade offers, but incoming offers are still answered by the hand-written trade evaluator, and it can't make counter-offers or uneven trades (2-for-1).
- **Player count.** Training uses 4-player games only. 3-player games work, but they're out of distribution.
- **Architecture.** A plain MLP doesn't know which corners touch which tiles; it has to learn that from data. A graph neural network over the board would learn faster and generalize better.
- **Opponent modeling.** Bigger gains would likely come from search at decision time (e.g. Monte Carlo rollouts with the policy) and from tracking opponents' likely hands based on what's been revealed.
- **"Optimal."** Catan has hidden information, dice and multiple players, so there's no practical way to compute a provably optimal strategy. The goal is a bot that beats strong baselines by a measurable, statistically significant margin.
