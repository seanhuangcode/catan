# Reinforcement learning for Catan

This folder trains a neural network to play Catan. It uses the same rules engine as the browser game (`js/game.js`), so the trained model plugs directly into the game as the **Neural network** bot type.

It's written in plain JavaScript with no dependencies. Training runs on CPU cores using Node worker threads.

## How it works

**Observation (1,808 numbers).** The board from one player's point of view:
- each tile's resource, number and robber;
- each corner's buildings, harbor, production pips, and whether you can build there;
- each edge's roads and whether you can build there;
- each player's public stats (points, card counts, knights, road length, production);
- your own hand and development cards, the turn phase, and the bank.

Opponents' hidden cards are never included.

**Actions (252).** One flat list covers every kind of move: settlement, road, or city on each spot, robber on each tile, steal from each opponent, discard one card of each resource, roll, end turn, buy or play development cards, and 20 bank trades. A legality mask removes illegal moves, and `tests/rl.test.js` checks that every move the mask allows is accepted by the engine. Multi-card discards are made one card at a time.

**Network.** A multilayer perceptron, 1,808 → 256 → 256, with a policy head (252 action logits) and a value head (predicted outcome). That's about 594,000 parameters. The forward and backward passes and the Adam optimizer are hand-written in `nn.js`. The input is mostly zeros, so the first layer only processes the nonzero entries.

**Training happens in two stages:**
1. **Imitation** (`train.js imitation`). The hand-written bots play each other, and the network learns to predict their moves (cross-entropy) and the game outcome (value regression). This gives a competent starting policy, which is far faster than learning from random play.
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

## Limitations and next steps

- **Trading.** The network doesn't propose player-to-player trades, and incoming offers are answered by the hand-written trade evaluator. It only trades with the bank and harbors. Adding offer and accept actions is the biggest missing piece.
- **Player count.** Training uses 4-player games only. 3-player games work, but they're out of distribution.
- **Architecture.** A plain MLP doesn't know which corners touch which tiles; it has to learn that from data. A graph neural network over the board would learn faster and generalize better.
- **Opponent modeling.** Bigger gains would likely come from search at decision time (e.g. Monte Carlo rollouts with the policy) and from tracking opponents' likely hands based on what's been revealed.
- **"Optimal."** Catan has hidden information, dice and multiple players, so there's no practical way to compute a provably optimal strategy. The goal is a bot that beats strong baselines by a measurable, statistically significant margin.
