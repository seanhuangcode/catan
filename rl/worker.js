/*
 * Worker thread: plays games (for imitation data, PPO rollouts, or
 * evaluation) and computes gradients on shards of a shared training batch.
 * Network weights are shared with the main thread through a SharedArrayBuffer.
 */
'use strict';

const { parentPort, workerData } = require('worker_threads');
const { RL, HeuristicAgent, playGame, finalize, pack, accumulateGrads, mulberry32 } = require('./selfplay.js');

const net = new RL.Net(workerData.config, new Float32Array(workerData.params));
const grads = new Float32Array(workerData.grads);
const snapshots = new Map(); // past versions of the policy, used as opponents
let batch = null;

function seatOrder(n, rng) {
  const seats = [];
  for (let i = 0; i < n; i++) seats.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  return seats;
}

/** Imitation data: heuristic bots play each other and every move becomes a label. */
function imitation(msg) {
  const rng = mulberry32(msg.seed);
  const all = [];
  for (let g = 0; g < msg.games; g++) {
    const steps = [[], [], [], []];
    const agents = [0, 1, 2, 3].map(() => new HeuristicAgent({ onStep: s => steps[s.pid].push(s) }));
    const game = playGame(agents, { rng });
    steps.forEach((list, pid) => {
      for (const s of list) {
        s.value = 0;
        // Value target is the (undiscounted) shaped return from this point on.
        s.ret = (game.winner === pid ? 1 : 0) - msg.hp.shaping * s.vp / 10;
      }
      all.push(...list);
    });
  }
  return { batch: pack(all, false) };
}

/**
 * PPO rollouts. Each game is one of:
 *   'heuristic'  one learner seat vs heuristic bots
 *   'self'       all seats played by the current policy
 *   'past'       one learner seat vs past snapshots of itself
 */
function rollout(msg) {
  const rng = mulberry32(msg.seed);
  const all = [];
  const stats = { games: 0, heuristicGames: 0, heuristicWins: 0, steps: 0, turns: 0, capped: 0 };
  for (let g = 0; g < msg.games; g++) {
    const r = rng();
    const mode = r < msg.mix.heuristic ? 'heuristic' : r < msg.mix.heuristic + msg.mix.self || snapshots.size === 0 ? 'self' : 'past';
    const nPlayers = 4;
    const steps = [];
    for (let i = 0; i < nPlayers; i++) steps.push([]);
    const learner = () => new RL.PolicyAgent(net, { rng, onStep: s => steps[s.pid].push(s) });
    const seats = seatOrder(nPlayers, rng);
    const agents = new Array(nPlayers);
    if (mode === 'self') {
      for (let i = 0; i < nPlayers; i++) agents[i] = learner();
    } else {
      agents[seats[0]] = learner();
      const ids = [...snapshots.keys()];
      for (let i = 1; i < nPlayers; i++) {
        if (mode === 'heuristic') agents[seats[i]] = new HeuristicAgent();
        else agents[seats[i]] = new RL.PolicyAgent(snapshots.get(ids[Math.floor(rng() * ids.length)]), { rng });
      }
    }
    const game = playGame(agents, { rng, maxTurns: msg.maxTurns });
    stats.games++;
    stats.turns += game.turn;
    if (game.winner === null) stats.capped++;
    if (mode === 'heuristic') {
      stats.heuristicGames++;
      if (game.winner === seats[0]) stats.heuristicWins++;
    }
    steps.forEach((list, pid) => {
      if (!list.length) return;
      finalize(list, game.winner === pid, msg.hp);
      all.push(...list);
    });
  }
  stats.steps = all.length;
  return { batch: pack(all, false), stats };
}

/** Evaluation: one greedy (or sampling) learner seat against heuristic bots. */
function evaluate(msg) {
  const rng = mulberry32(msg.seed);
  const players = msg.players || 4;
  const st = { games: 0, wins: 0, vp: 0, turns: 0, capped: 0, placeWins: new Array(players).fill(0), placeGames: new Array(players).fill(0) };
  for (let g = 0; g < msg.games; g++) {
    const seat = Math.floor(rng() * players);
    const agents = [];
    for (let i = 0; i < players; i++) agents.push(i === seat ? new RL.PolicyAgent(net, { rng, greedy: msg.greedy }) : new HeuristicAgent());
    const game = playGame(agents, { rng, maxTurns: msg.maxTurns });
    // Turn order position of the learner (0 = went first).
    const pos = (seat - game.firstPlayer + players) % players;
    st.games++;
    st.placeGames[pos]++;
    if (game.winner === seat) { st.wins++; st.placeWins[pos]++; }
    if (game.winner === null) st.capped++;
    st.vp += game.victoryPoints(seat, true);
    st.turns += game.turn;
  }
  return { stats: st };
}

parentPort.on('message', msg => {
  try {
    let result;
    switch (msg.type) {
      case 'imitation': result = imitation(msg); break;
      case 'rollout': result = rollout(msg); break;
      case 'evaluate': result = evaluate(msg); break;
      case 'snapshot': {
        const snap = new RL.Net(workerData.config, Float32Array.from(msg.params));
        snapshots.set(msg.id, snap);
        if (snapshots.size > msg.keep) snapshots.delete(snapshots.keys().next().value);
        result = {};
        break;
      }
      case 'setBatch': batch = msg.batch; result = {}; break;
      case 'grads': {
        grads.fill(0);
        result = { stats: accumulateGrads(net, batch, msg.ids, msg.mode, msg.hp, grads) };
        break;
      }
      default: throw new Error('Unknown task ' + msg.type);
    }
    parentPort.postMessage({ ok: true, result });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.stack || e.message });
  }
});
