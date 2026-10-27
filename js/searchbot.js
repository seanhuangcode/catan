/*
 * Search bot: for every legal move it plays the move on a copy of the game
 * and scores the resulting position with a hand-tuned evaluation, then picks
 * the best. The copy only contains what this player can see: opponents'
 * hands become placeholder cards of the right count and the development deck
 * is reshuffled, so the search never peeks at hidden information.
 *
 * Uses the RL action space (rl/encoding.js) to enumerate legal moves.
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const R = C.RESOURCES;
  const RES_WEIGHT = { wood: 1.0, brick: 1.0, sheep: 0.85, wheat: 1.05, ore: 1.0 };

  // ------------------------------------------------------------ copies

  /** A copy of `game` as player `me` sees it, safe to play moves on. */
  function privateCopy(game, me, rng) {
    const c = Object.create(Object.getPrototypeOf(game));
    Object.assign(c, game);
    c.listeners = [];
    c.log = [];
    c._ai = undefined;
    c.rng = rng;
    c.vertices = game.vertices.map(v => Object.assign({}, v, { building: v.building && Object.assign({}, v.building) }));
    c.edges = game.edges.map(e => Object.assign({}, e));
    c.players = game.players.map(p => {
      const q = Object.assign({}, p, { hand: Object.assign({}, p.hand), devCards: p.devCards.map(d => Object.assign({}, d)) });
      if (p.id !== me) {
        q.hand = C.placeholderHand(C.handTotal(p.hand), game.publicHands && game.publicHands[p.id]);
        q.devCards = p.devCards.map(() => ({ type: 'knight', turnBought: -1 }));
      }
      return q;
    });
    c.bank = Object.assign({}, game.bank);
    c.publicHands = (game.publicHands || game.players.map(() => C.emptyHand())).map(h => Object.assign({}, h));
    c.devDeck = C.shuffle(game.devDeck.slice(), rng);
    c.discardPending = Object.assign({}, game.discardPending);
    c.stealCandidates = game.stealCandidates.slice();
    c.dice = game.dice ? game.dice.slice() : null;
    c.diceStats = Object.assign({}, game.diceStats);
    return c;
  }

  /** Cheap copy of an already-private copy (no re-hiding needed). */
  function copy(g) {
    const c = Object.create(Object.getPrototypeOf(g));
    Object.assign(c, g);
    c.log = [];
    c.vertices = g.vertices.map(v => Object.assign({}, v, { building: v.building && Object.assign({}, v.building) }));
    c.edges = g.edges.map(e => Object.assign({}, e));
    c.players = g.players.map(p => Object.assign({}, p, { hand: Object.assign({}, p.hand), devCards: p.devCards.slice() }));
    c.bank = Object.assign({}, g.bank);
    c.publicHands = g.publicHands.map(h => Object.assign({}, h));
    c.devDeck = g.devDeck.slice();
    c.discardPending = Object.assign({}, g.discardPending);
    c.stealCandidates = g.stealCandidates.slice();
    c.diceStats = Object.assign({}, g.diceStats);
    return c;
  }

  // ---------------------------------------------------------- evaluation

  const pips = h => (h.number ? C.PIPS[h.number] : 0);

  function production(g, pid) {
    const prod = C.emptyHand();
    for (const v of g.vertices) {
      if (!v.building || v.building.player !== pid) continue;
      const mult = v.building.type === 'city' ? 2 : 1;
      for (const hid of v.hexes) {
        const h = g.hexes[hid];
        if (h.resource !== 'desert' && hid !== g.robber) prod[h.resource] += pips(h) * mult;
      }
    }
    return prod;
  }

  function spotValue(g, vid) {
    let s = 0;
    for (const hid of g.vertices[vid].hexes) {
      const h = g.hexes[hid];
      if (h.resource !== 'desert') s += pips(h) * RES_WEIGHT[h.resource];
    }
    return s;
  }

  /** Best open settlement spots now legal, and reachable with one more road. */
  function expansion(g, me) {
    let best0 = 0;
    let count0 = 0;
    let best1 = 0;
    const p = g.players[me];
    if (p.settlementsLeft === 0) return { best0, count0, best1 };
    const mine = new Set();
    for (const v of g.vertices) {
      if (v.building ? v.building.player === me : v.edges.some(e => g.edges[e].road === me)) mine.add(v.id);
    }
    for (const vid of mine) {
      if (g.canPlaceSettlement(me, vid, true) && g.vertices[vid].edges.some(e => g.edges[e].road === me)) {
        count0++;
        best0 = Math.max(best0, spotValue(g, vid));
      }
      const v = g.vertices[vid];
      if (v.building && v.building.player !== me) continue;
      for (const eid of v.edges) {
        const e = g.edges[eid];
        if (e.road !== null) continue;
        const n = e.v[0] === vid ? e.v[1] : e.v[0];
        if (g.canPlaceSettlement(me, n, true)) best1 = Math.max(best1, spotValue(g, n));
      }
    }
    return { best0, count0, best1 };
  }

  const missing = (hand, cost) => R.reduce((s, r) => s + Math.max(0, (cost[r] || 0) - hand[r]), 0);

  /** Score of a position for player `me` (higher is better). */
  function evaluate(g, me) {
    const p = g.players[me];
    const vp = g.victoryPoints(me, true);
    if (vp >= g.vpToWin) return 1e9;
    let v = 1000 * vp;

    const prod = production(g, me);
    let kinds = 0;
    for (const r of R) {
      v += 9 * RES_WEIGHT[r] * Math.min(prod[r], 12);
      if (prod[r] > 0) kinds++;
    }
    v += 10 * kinds;

    let enemy = 0;
    for (const o of g.players) {
      if (o.id === me) continue;
      const op = production(g, o.id);
      const lead = 1 + g.victoryPoints(o.id, false) / 5;
      enemy += lead * R.reduce((s, r) => s + op[r], 0);
    }
    v -= 1.5 * enemy / Math.max(1, g.players.length - 1);

    const ex = expansion(g, me);
    v += 20 * Math.min(ex.count0, 2) + 3 * ex.best0 + 1.5 * ex.best1;

    v += 4 * Math.min(p.roadLength, 12);
    v += 18 * p.knightsPlayed;
    v += 14 * p.devCards.filter(d => d.type !== 'victoryPoint').length;

    const hand = p.hand;
    const total = C.handTotal(hand);
    const goals = [];
    if (p.citiesLeft > 0 && p.settlementsLeft < 5) goals.push(missing(hand, C.COSTS.city));
    if (p.settlementsLeft > 0 && ex.count0 > 0) goals.push(missing(hand, C.COSTS.settlement));
    goals.push(missing(hand, C.COSTS.dev) + 1);
    v -= 14 * Math.min(...goals);
    v += 2 * Math.min(total, 7);
    if (total > 7) v -= 12 * (total - 7);
    return v;
  }

  // ------------------------------------------------------------- search

  class SearchBot {
    constructor(opts = {}) {
      this.kind = 'search';
      this.rng = opts.rng || Math.random;
      this.devSamples = opts.devSamples || 4;
    }

    /** Best Game#perform action for player `me` (offers are not considered). */
    decide(game, me, ctx) {
      ctx = ctx || C.RL.newContext();
      if (game.phase === 'discard') return { type: 'discard', cards: this.chooseDiscard(game, me, game.discardPending[me]) };
      if (game.phase === 'steal') return { type: 'steal', victim: C.AI.chooseVictim(game, me, game.stealCandidates) };
      const mask = C.RL.legalMask(game, me, ctx);
      const base = privateCopy(game, me, this.rng);
      const here = evaluate(base, me);
      let best = null;
      let bestV = -Infinity;
      for (let a = 0; a < mask.length; a++) {
        if (!mask[a] || a >= C.RL.A.OFFER) continue;
        const v = this.score(base, me, a, here);
        if (v > bestV) { bestV = v; best = a; }
      }
      return C.RL.toAction(game, me, best);
    }

    /** Expected score after action `a`. */
    score(base, me, a, here) {
      const A = C.RL.A;
      // Rolling and ending the turn don't change what we hold; judge them as "now".
      if (a === A.END) return here + 0.5;
      if (a === A.ROLL) return here + 1;
      const samples = a === A.BUY_DEV ? this.devSamples : 1;
      let sum = 0;
      for (let s = 0; s < samples; s++) {
        const g = copy(base);
        if (a === A.BUY_DEV) C.shuffle(g.devDeck, this.rng);
        const res = g.perform(me, C.RL.toAction(g, me, a));
        sum += res.ok ? evaluate(g, me) : -Infinity;
      }
      return sum / samples;
    }

    chooseDiscard(game, me, count) {
      const g = privateCopy(game, me, this.rng);
      const out = C.emptyHand();
      for (let k = 0; k < count; k++) {
        let best = null;
        let bestV = -Infinity;
        for (const r of R) {
          if (g.players[me].hand[r] <= 0) continue;
          g.players[me].hand[r]--;
          const v = evaluate(g, me);
          g.players[me].hand[r]++;
          if (v > bestV) { bestV = v; best = r; }
        }
        g.players[me].hand[best]--;
        out[best]++;
      }
      return out;
    }

    // Agent interface used by rl/selfplay.js playGame.
    act(game, me, ctx) { return this.decide(game, me, ctx); }
    discard(game, me, count) { return this.chooseDiscard(game, me, count); }
  }

  C.SearchBot = SearchBot;
  C.searchEvaluate = evaluate;
  C.privateCopy = privateCopy;
  C.copyGame = copy;
})(Catan);
