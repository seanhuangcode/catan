/*
 * Policy agent: picks actions with a trained Net. Used both by the training
 * code (sampling, recording trajectories) and by the browser game (greedy play).
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const RL = C.RL;

  class PolicyAgent {
    /**
     * @param {Net} net
     * @param {object} [opts]
     * @param {boolean} [opts.greedy=false]  take the most likely action instead of sampling
     * @param {function} [opts.rng=Math.random]
     * @param {function} [opts.onStep]  called with each decision's record (for training)
     */
    constructor(net, opts = {}) {
      this.kind = 'policy';
      this.net = net;
      this.greedy = !!opts.greedy;
      this.rng = opts.rng || Math.random;
      this.onStep = opts.onStep || null;
      this.obs = new Float32Array(RL.OBS_SIZE);
      this.mask = new Uint8Array(RL.N_ACTIONS);
      this.probs = new Float32Array(RL.N_ACTIONS);
    }

    /** Returns an action index for player `me`. */
    choose(game, me, ctx) {
      RL.encode(game, me, ctx, this.obs);
      RL.legalMask(game, me, ctx, this.mask);
      // Older models were trained on fewer (leading) inputs; give them only those.
      const sp = RL.sparsify(this.net.config.input < this.obs.length ? this.obs.subarray(0, this.net.config.input) : this.obs);
      this.net.forward(sp.idx, sp.val);
      const lse = RL.maskedSoftmax(this.net.logits, this.mask, this.probs);
      let a = -1;
      if (this.greedy) {
        let best = -1;
        for (let i = 0; i < this.probs.length; i++) if (this.mask[i] && this.probs[i] > best) { best = this.probs[i]; a = i; }
      } else {
        let u = this.rng();
        for (let i = 0; i < this.probs.length; i++) {
          if (!this.mask[i]) continue;
          a = i;
          u -= this.probs[i];
          if (u <= 0) break;
        }
      }
      if (this.onStep) {
        this.onStep({
          pid: me,
          idx: sp.idx,
          val: sp.val,
          mask: this.mask.slice(),
          action: a,
          logp: this.net.logits[a] - lse,
          value: this.net.value,
          vp: game.victoryPoints(me, true),
        });
      }
      return a;
    }

    /** Chooses a full discard of `count` cards, one card at a time. */
    chooseDiscard(game, me, count, ctx) {
      ctx.discardSel = C.emptyHand();
      for (let k = 0; k < count; k++) {
        const a = this.choose(game, me, ctx);
        ctx.discardSel[C.RESOURCES[a - RL.A.DISCARD]]++;
      }
      const cards = ctx.discardSel;
      ctx.discardSel = null;
      return cards;
    }

    /** Returns the next Game#perform action. */
    decide(game, me, ctx) {
      if (game.phase === 'discard') {
        return { type: 'discard', cards: this.chooseDiscard(game, me, game.discardPending[me], ctx) };
      }
      return RL.toAction(game, me, this.choose(game, me, ctx));
    }

    /** Answers player `from`'s offer to give us `offer.give` for `offer.get`. */
    respond(game, me, from, offer, ctx) {
      // Unless a model was trained to answer offers itself (config.respond),
      // it answers like the classic bot, which plays better (see rl/README.md).
      if (!this.net.config.respond || this.net.config.actions <= RL.A.RESPOND) return C.AI.evaluateTrade(game, me, from, offer.give, offer.get);
      ctx.respondTo = { from, give: offer.give, get: offer.get };
      const a = this.choose(game, me, ctx);
      ctx.respondTo = null;
      return a === RL.A.RESPOND;
    }

    // Agent interface used by RL.playGame.
    act(game, me, ctx) { return RL.toAction(game, me, this.choose(game, me, ctx)); }
    discard(game, me, count, ctx) { return this.chooseDiscard(game, me, count, ctx); }
  }

  RL.PolicyAgent = PolicyAgent;
})(Catan);
