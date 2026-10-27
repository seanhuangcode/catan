/*
 * Training-side helpers (Node): running games between agents, turning a
 * player's decisions into PPO training samples, packing samples into flat
 * typed arrays, and computing loss gradients.
 */
'use strict';

require('../js/board.js');
require('../js/game.js');
require('../js/ai.js');
require('./encoding.js');
require('./nn.js');
require('./agent.js');
require('../js/searchbot.js');
require('./search.js');

const C = globalThis.Catan;
const RL = C.RL;
const R = C.RESOURCES;
const NA = RL.N_ACTIONS;

/** Wraps the hand-written bot. With onStep set, it records its moves as labels. */
class HeuristicAgent {
  constructor(opts = {}) {
    this.kind = 'heuristic';
    this.onStep = opts.onStep || null;
    this.obs = new Float32Array(RL.OBS_SIZE);
    this.mismatches = 0;
  }

  label(game, me, ctx, a) {
    if (!this.onStep || a < 0) return;
    RL.encode(game, me, ctx, this.obs);
    const mask = RL.legalMask(game, me, ctx);
    if (!mask[a]) { this.mismatches++; return; }
    const sp = RL.sparsify(this.obs);
    this.onStep({ pid: me, idx: sp.idx, val: sp.val, mask, action: a, logp: 0, value: 0, vp: game.victoryPoints(me, true) });
  }

  act(game, me, ctx) {
    const action = C.AI.decide(game, me);
    this.label(game, me, ctx, RL.fromAction(game, me, action));
    return action;
  }

  respond(game, me, from, offer, ctx) {
    const accept = C.AI.evaluateTrade(game, me, from, offer.give, offer.get);
    if (this.onStep) {
      ctx.respondTo = { from, give: offer.give, get: offer.get };
      this.label(game, me, ctx, accept ? RL.A.RESPOND : RL.A.RESPOND + 1);
      ctx.respondTo = null;
    }
    return accept;
  }

  discard(game, me, count, ctx) {
    const cards = C.AI.chooseDiscard(game, me, count);
    if (this.onStep) {
      ctx.discardSel = C.emptyHand();
      for (let i = 0; i < 5; i++) {
        for (let k = 0; k < cards[R[i]]; k++) {
          this.label(game, me, ctx, RL.A.DISCARD + i);
          ctx.discardSel[R[i]]++;
        }
      }
      ctx.discardSel = null;
    }
    return cards;
  }
}

/**
 * DAgger: the learner's policy chooses the moves that are played, while the
 * heuristic bot records what it would have done in each of those positions.
 * This teaches the network to recover from its own mistakes.
 */
class DaggerAgent {
  constructor(net, opts = {}) {
    this.kind = 'policy';
    this.teacher = new HeuristicAgent({ onStep: opts.onStep });
    this.student = new RL.PolicyAgent(net, { rng: opts.rng });
  }

  act(game, me, ctx) {
    this.teacher.act(game, me, ctx); // records the label only
    return this.student.act(game, me, ctx);
  }

  discard(game, me, count, ctx) {
    this.teacher.discard(game, me, count, ctx);
    return this.student.discard(game, me, count, ctx);
  }

  respond(game, me, from, offer, ctx) {
    this.teacher.respond(game, me, from, offer, ctx);
    return this.student.respond(game, me, from, offer, ctx);
  }
}

/** Asks every other seat about `pid`'s offer and makes the trade with the first who accepts. */
function resolveOffer(game, pid, offer, agents, ctxs) {
  const accepters = game.players.filter(o => {
    if (o.id === pid) return false;
    const agent = agents && agents[o.id];
    if (agent && agent.respond) return agent.respond(game, o.id, pid, offer, ctxs[o.id]);
    return C.AI.evaluateTrade(game, o.id, pid, offer.give, offer.get);
  });
  if (accepters.length) game.perform(pid, { type: 'playerTrade', to: accepters[0].id, give: offer.give, get: offer.get });
}

/**
 * Plays one game. `agents[i]` controls seat i and implements
 * act(game, pid, ctx) -> action and discard(game, pid, count, ctx) -> cards.
 * Returns the finished (or turn-capped) Game.
 */
function playGame(agents, opts = {}) {
  const game = new C.Game({
    players: agents.map((_, i) => ({ name: 'P' + i, isBot: true })),
    rng: opts.rng || Math.random,
    vpToWin: opts.vpToWin || 10,
  });
  const ctxs = agents.map(() => RL.newContext());
  const maxTurns = opts.maxTurns || 300;
  let steps = 0;
  while (game.phase !== 'gameOver' && game.turn <= maxTurns) {
    if (++steps > 50000) throw new Error('Game exceeded step limit');
    if (game.phase === 'discard') {
      for (const pid of game.pendingActors()) {
        const cards = agents[pid].discard(game, pid, game.discardPending[pid], ctxs[pid]);
        const res = game.perform(pid, { type: 'discard', cards });
        if (!res.ok) throw new Error(`Discard rejected: ${res.error}`);
      }
      continue;
    }
    const pid = game.current;
    const ctx = ctxs[pid];
    RL.syncTurn(ctx, game);
    const wasMain = game.phase === 'main';
    const agent = agents[pid];
    const action = agent.act(game, pid, ctx);
    if (action.type === 'offer') {
      RL.noteOffer(ctx, RL.fromAction(game, pid, action));
      resolveOffer(game, pid, action, agents, ctxs);
    } else {
      const res = game.perform(pid, action);
      if (!res.ok) {
        if (agent.kind === 'policy') throw new Error(`Legal-mask bug: ${JSON.stringify(action)} rejected in ${game.phase}: ${res.error}`);
        game.perform(pid, { type: game.phase === 'preRoll' ? 'rollDice' : 'endTurn' });
      }
    }
    if (wasMain) ctx.mainActions++;
  }
  return game;
}

/**
 * Turns one player's decisions into training targets. Reward is +1 for a win,
 * plus potential-based shaping with potential = shaping * VP / 10 (zero at the
 * end of the game), which rewards progress without changing which policy is
 * optimal. Adds `ret` (discounted return) and `adv` (GAE advantage) to each step.
 */
function finalize(steps, won, hp) {
  const T = steps.length;
  const { gamma, lambda, shaping } = hp;
  let nextAdv = 0;
  for (let t = T - 1; t >= 0; t--) {
    const s = steps[t];
    const phi = shaping * s.vp / 10;
    const r = t < T - 1 ? gamma * shaping * steps[t + 1].vp / 10 - phi : (won ? 1 : 0) - phi;
    const nextV = t < T - 1 ? steps[t + 1].value : 0;
    const delta = r + gamma * nextV - s.value;
    nextAdv = delta + gamma * lambda * nextAdv;
    s.adv = nextAdv;
    s.ret = nextAdv + s.value;
  }
}

/** Packs step records into flat typed arrays (optionally SharedArrayBuffer-backed). */
function pack(steps, shared) {
  const alloc = (Type, n) => (shared ? new Type(new SharedArrayBuffer(Math.max(1, n) * Type.BYTES_PER_ELEMENT)) : new Type(n));
  const n = steps.length;
  let nnz = 0;
  for (const s of steps) nnz += s.idx.length;
  const b = {
    n,
    offsets: alloc(Int32Array, n + 1),
    idx: alloc(Uint16Array, nnz),
    val: alloc(Float32Array, nnz),
    masks: alloc(Uint8Array, n * NA),
    action: alloc(Int16Array, n),
    logp: alloc(Float32Array, n),
    value: alloc(Float32Array, n),
    adv: alloc(Float32Array, n),
    ret: alloc(Float32Array, n),
  };
  let o = 0;
  steps.forEach((s, i) => {
    b.offsets[i] = o;
    b.idx.set(s.idx, o);
    b.val.set(s.val, o);
    o += s.idx.length;
    b.masks.set(s.mask, i * NA);
    b.action[i] = s.action;
    b.logp[i] = s.logp;
    b.value[i] = s.value;
    b.adv[i] = s.adv || 0;
    b.ret[i] = s.ret || 0;
  });
  b.offsets[n] = o;
  return b;
}

/** Concatenates packed batches into one SharedArrayBuffer-backed batch. */
function concat(batches) {
  const steps = [];
  for (const b of batches) {
    for (let i = 0; i < b.n; i++) {
      steps.push({
        idx: b.idx.subarray(b.offsets[i], b.offsets[i + 1]),
        val: b.val.subarray(b.offsets[i], b.offsets[i + 1]),
        mask: b.masks.subarray(i * NA, (i + 1) * NA),
        action: b.action[i], logp: b.logp[i], value: b.value[i], adv: b.adv[i], ret: b.ret[i],
      });
    }
  }
  return pack(steps, true);
}

/**
 * Accumulates the loss gradient for samples `ids` of `batch` into `grads`.
 * mode 'bc': cross-entropy on the recorded action + value regression.
 * mode 'ppo': clipped surrogate objective + value loss - entropy bonus.
 */
function accumulateGrads(net, batch, ids, mode, hp, grads) {
  const probs = new Float32Array(NA);
  const dLogits = new Float32Array(NA);
  const st = { n: 0, policyLoss: 0, valueLoss: 0, entropy: 0, correct: 0, clipped: 0, kl: 0 };
  for (const id of ids) {
    const s = batch.offsets[id];
    const e = batch.offsets[id + 1];
    const idx = batch.idx.subarray(s, e);
    const val = batch.val.subarray(s, e);
    const mask = batch.masks.subarray(id * NA, (id + 1) * NA);
    const a = batch.action[id];
    net.forward(idx, val);
    const logits = net.logits;
    const lse = RL.maskedSoftmax(logits, mask, probs);
    const logp = logits[a] - lse;
    let H = 0;
    let best = -1;
    let bestP = -1;
    for (let j = 0; j < NA; j++) {
      const p = probs[j];
      if (p > 0) H -= p * Math.log(p);
      if (mask[j] && p > bestP) { bestP = p; best = j; }
    }

    let g; // dLoss / dlogp(a)
    if (mode === 'bc') {
      g = -1;
      st.policyLoss -= logp;
      if (best === a) st.correct++;
    } else {
      const ratio = Math.exp(logp - batch.logp[id]);
      const A = batch.adv[id];
      const clipped = Math.min(Math.max(ratio, 1 - hp.clip), 1 + hp.clip);
      if (ratio * A <= clipped * A) g = -ratio * A;
      else { g = 0; st.clipped++; }
      st.policyLoss -= Math.min(ratio * A, clipped * A);
      st.kl += batch.logp[id] - logp;
    }
    const ent = hp.entropy || 0;
    for (let j = 0; j < NA; j++) {
      const p = probs[j];
      let d = g * ((j === a ? 1 : 0) - p);
      if (ent && p > 0) d += ent * p * (Math.log(p) + H);
      dLogits[j] = d;
    }
    const vErr = net.value - batch.ret[id];
    st.valueLoss += 0.5 * vErr * vErr;
    st.entropy += H;
    st.n++;
    net.backward(idx, val, dLogits, hp.valueCoef * vErr, grads);
  }
  return st;
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { C, RL, HeuristicAgent, DaggerAgent, playGame, finalize, pack, concat, accumulateGrads, mulberry32 };
