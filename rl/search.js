/*
 * Policy + value lookahead ("NetSearch"): for the policy's most likely moves,
 * play each one on a private copy of the game (hidden cards replaced, deck
 * reshuffled; see js/searchbot.js) and score the resulting position with the
 * network's value head. Picks the move with the best expected outcome.
 *
 * The value head predicts (win - shaping potential), so a position's
 * estimated chance of winning is value + shaping * VP / 10.
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const RL = C.RL;

  /** Location kind of an action ('SETTLE', 'ROAD', 'CITY', 'ROBBER'), or null. */
  function groupOf(a) {
    const A = RL.A;
    if (a < A.ROAD) return 'SETTLE';
    if (a < A.CITY) return 'ROAD';
    if (a < A.ROBBER) return 'CITY';
    if (a < A.STEAL) return 'ROBBER';
    return null;
  }

  class NetSearchAgent extends RL.PolicyAgent {
    /**
     * @param {Net} net
     * @param {object} [opts]  topK: moves to look ahead on; samples: copies per random move;
     *                         shaping: potential coefficient used in training (default 1)
     */
    constructor(net, opts = {}) {
      super(net, Object.assign({}, opts, { greedy: true }));
      this.kind = 'policy';
      this.topK = opts.topK || 5;
      this.samples = opts.samples || 3;
      this.shaping = opts.shaping !== undefined ? opts.shaping : 1;
      this.prior = opts.prior !== undefined ? opts.prior : 0.01;
      this.scratch = new Float32Array(RL.OBS_SIZE);
      // onLabel receives each decision with the move the search chose (for training).
      this.onLabel = opts.onLabel || null;
    }

    choose(game, me, ctx) {
      const a = this.search(game, me, ctx);
      if (this.onLabel) {
        const sp = RL.sparsify(RL.encode(game, me, ctx, this.scratch));
        this.onLabel({ pid: me, idx: sp.idx, val: sp.val, mask: RL.legalMask(game, me, ctx), action: a, logp: 0, value: 0, vp: game.victoryPoints(me, true) });
      }
      return a;
    }

    /** Estimated chance that `me` wins from position `g` (at one of my decision points). */
    winEstimate(g, me, ctx) {
      if (g.phase === 'gameOver') return g.winner === me ? 1 : 0;
      RL.encode(g, me, ctx, this.scratch);
      const sp = RL.sparsify(this.scratch.subarray(0, this.net.config.input));
      this.net.forward(sp.idx, sp.val);
      return this.net.value + this.shaping * g.victoryPoints(me, true) / 10;
    }

    search(game, me, ctx) {
      const greedy = super.choose(game, me, ctx); // fills this.probs and this.mask
      const phase = game.phase;
      // Lookahead only where the next position is still my decision in the same turn.
      if (phase !== 'main' && phase !== 'setupSettlement' && phase !== 'moveRobber' && phase !== 'roadBuilding') return greedy;
      const probs = this.probs.slice();
      const legal = [];
      for (let a = 0; a < probs.length; a++) if (this.mask[a]) legal.push(a);
      if (legal.length < 2) return greedy;
      legal.sort((x, y) => probs[y] - probs[x]);
      // The policy decides WHAT to do (build, trade, end turn...); the lookahead
      // only picks WHERE, among moves of the same kind as the policy's choice.
      // Comparing different kinds of move relies on fine value differences
      // the value head can't resolve reliably.
      const group = groupOf(greedy);
      if (!group) return greedy;
      const cands = legal.filter(a => groupOf(a) === group).slice(0, this.topK);
      if (cands.length < 2) return greedy;
      const base = C.privateCopy(game, me, this.rng);
      const here = this.winEstimate(base, me, ctx);
      const A = RL.A;
      let best = greedy;
      let bestV = -Infinity;
      for (const a of cands) {
        let v;
        if (a === A.END || a >= A.OFFER || a === A.ROLL) {
          v = here; // no deterministic successor position to look at
        } else {
          const n = a === A.BUY_DEV ? this.samples : 1;
          v = 0;
          for (let s = 0; s < n; s++) {
            const g = C.copyGame(base);
            if (a === A.BUY_DEV) C.shuffle(g.devDeck, this.rng);
            const res = g.perform(me, RL.toAction(g, me, a));
            if (!res.ok) { v = -Infinity; break; }
            const ctx2 = Object.assign({}, ctx, { mainActions: ctx.mainActions + (phase === 'main' ? 1 : 0) });
            v += this.winEstimate(g, me, ctx2);
          }
          v /= n;
        }
        v += this.prior * Math.log(Math.max(probs[a], 1e-6));
        if (v > bestV) { bestV = v; best = a; }
      }
      return best;
    }
  }

  RL.NetSearchAgent = NetSearchAgent;
})(Catan);
