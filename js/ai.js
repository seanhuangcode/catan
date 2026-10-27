/*
 * Bot players. AI.decide(game, pid) returns the next action for a bot as an
 * ordinary action object for Game#perform, or {type: 'offer', give, get} when
 * the bot wants to propose a trade to the other players (resolved by the
 * controller, since it may need to ask the human).
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const R = C.RESOURCES;
  const COSTS = C.COSTS;
  const RES_WEIGHT = { wood: 1.05, brick: 1.05, sheep: 0.9, wheat: 1.1, ore: 1.0 };
  const AI = {};

  const pips = hex => (hex.number ? C.PIPS[hex.number] : 0);
  const missing = (hand, cost) => R.reduce((s, r) => s + Math.max(0, (cost[r] || 0) - hand[r]), 0);

  function memory(game, pid) {
    game._ai = game._ai || {};
    let m = game._ai[pid];
    if (!m || m.turn !== game.turn) m = game._ai[pid] = { turn: game.turn, actions: 0, offers: 0, offered: new Set() };
    return m;
  }

  /** Expected pips per resource for a player's current buildings. */
  AI.production = function (game, pid) {
    const prod = C.emptyHand();
    for (const v of game.vertices) {
      if (!v.building || v.building.player !== pid) continue;
      const mult = v.building.type === 'city' ? 2 : 1;
      for (const h of v.hexes) {
        const hex = game.hexes[h];
        if (hex.resource !== 'desert') prod[hex.resource] += pips(hex) * mult;
      }
    }
    return prod;
  };

  AI.vertexScore = function (game, pid, vid, prod) {
    prod = prod || AI.production(game, pid);
    const v = game.vertices[vid];
    let s = 0;
    const kinds = new Set();
    for (const h of v.hexes) {
      const hex = game.hexes[h];
      if (hex.resource === 'desert') continue;
      let w = RES_WEIGHT[hex.resource];
      if (prod[hex.resource] === 0) w += 0.35; // diversity
      s += pips(hex) * w * (hex.id === game.robber ? 0.6 : 1);
      kinds.add(hex.resource);
    }
    s += kinds.size * 0.8;
    if (v.port) {
      if (v.port === 'any') s += 1.2;
      else if (prod[v.port] >= 5 || v.hexes.some(h => game.hexes[h].resource === v.port)) s += 2.5;
      else s += 0.5;
    }
    return s;
  };

  /**
   * Finds the most valuable empty settlement spot reachable by building up to
   * three roads. Returns {edge, score, dist} where edge is the first road to build.
   */
  AI.roadPlan = function (game, pid) {
    const prod = AI.production(game, pid);
    const dist = new Map();
    const first = new Map();
    const queue = [];
    for (const v of game.vertices) {
      const mine = v.building
        ? v.building.player === pid
        : v.edges.some(e => game.edges[e].road === pid);
      if (mine) { dist.set(v.id, 0); queue.push(v.id); }
    }
    let best = null;
    while (queue.length) {
      const vid = queue.shift();
      const d = dist.get(vid);
      if (d >= 3) continue;
      for (const eid of game.vertices[vid].edges) {
        const e = game.edges[eid];
        if (e.road !== null) continue;
        const nxt = e.v[0] === vid ? e.v[1] : e.v[0];
        if (dist.has(nxt)) continue;
        dist.set(nxt, d + 1);
        first.set(nxt, d === 0 ? eid : first.get(vid));
        if (game.vertices[nxt].building) continue; // opponent piece blocks the way
        if (game.canPlaceSettlement(pid, nxt, true)) {
          const score = AI.vertexScore(game, pid, nxt, prod) / (1 + 0.6 * d);
          if (!best || score > best.score) best = { edge: first.get(nxt), score, dist: d + 1 };
        }
        queue.push(nxt);
      }
    }
    if (best && !game.canPlaceRoad(pid, best.edge)) return null;
    return best;
  };

  /** A road that increases our longest road the most (or null). */
  function longestRoadEdge(game, pid) {
    const base = game.computeRoadLength(pid);
    let best = null;
    let bestLen = base;
    for (const eid of game.validRoadSpots(pid)) {
      game.edges[eid].road = pid;
      const len = game.computeRoadLength(pid);
      game.edges[eid].road = null;
      if (len > bestLen) { bestLen = len; best = eid; }
    }
    return best;
  }

  function anyRoadEdge(game, pid) {
    const plan = AI.roadPlan(game, pid);
    if (plan) return plan.edge;
    const lr = longestRoadEdge(game, pid);
    if (lr !== null) return lr;
    const spots = game.validRoadSpots(pid);
    return spots.length ? spots[Math.floor(game.rng() * spots.length)] : null;
  }

  function goalList(game, pid) {
    const p = game.players[pid];
    const goals = [];
    if (p.citiesLeft > 0 && p.settlementsLeft < 5) goals.push({ type: 'city', cost: COSTS.city, value: 3.2 });
    if (p.settlementsLeft > 0) {
      if (game.validSettlementSpots(pid).length) goals.push({ type: 'settlement', cost: COSTS.settlement, value: 3.5 });
      else if (p.roadsLeft > 0 && AI.roadPlan(game, pid)) goals.push({ type: 'road', cost: COSTS.road, value: 2.2 });
    }
    if (game.devDeck.length) goals.push({ type: 'dev', cost: COSTS.dev, value: 1.4 });
    if (!goals.length && p.roadsLeft > 0) goals.push({ type: 'road', cost: COSTS.road, value: 0.8 });
    return goals;
  }

  function primaryGoal(goals, hand) {
    let best = null;
    let bestScore = -Infinity;
    for (const g of goals) {
      const s = g.value - 0.9 * missing(hand, g.cost);
      if (s > bestScore) { bestScore = s; best = g; }
    }
    return best;
  }

  function utility(hand, goals) {
    const total = C.handTotal(hand);
    let u = 0.03 * total;
    for (const g of goals) u += g.value / (1 + missing(hand, g.cost));
    if (total > 7) u -= 0.15 * (total - 7);
    return u;
  }

  // ----------------------------------------------------------------- setup

  function bestSetupSettlement(game, pid) {
    const prod = AI.production(game, pid);
    let best = null;
    let bestScore = -Infinity;
    for (const vid of game.validSettlementSpots(pid, true)) {
      const s = AI.vertexScore(game, pid, vid, prod) + game.rng() * 0.2;
      if (s > bestScore) { bestScore = s; best = vid; }
    }
    return best;
  }

  function bestSetupRoad(game, pid) {
    const sv = game.lastSetupVertex;
    let best = null;
    let bestScore = -Infinity;
    for (const eid of game.vertices[sv].edges) {
      const e = game.edges[eid];
      if (e.road !== null) continue;
      const far = e.v[0] === sv ? e.v[1] : e.v[0];
      let s = 0;
      for (const n of game.vertices[far].adj) {
        if (n !== sv && game.canPlaceSettlement(pid, n, true)) s = Math.max(s, AI.vertexScore(game, pid, n));
      }
      s += game.rng() * 0.2;
      if (s > bestScore) { bestScore = s; best = eid; }
    }
    return best;
  }

  // ---------------------------------------------------------------- robber

  AI.chooseRobberHex = function (game, pid) {
    let best = null;
    let bestScore = -Infinity;
    for (const hid of game.validRobberHexes(pid)) {
      const hex = game.hexes[hid];
      let s = 0;
      let victim = false;
      for (const vid of hex.vertices) {
        const b = game.vertices[vid].building;
        if (!b) continue;
        const mult = b.type === 'city' ? 2 : 1;
        if (b.player === pid) s -= 100;
        else {
          s += pips(hex) * mult * (1 + game.victoryPoints(b.player, false) / 4);
          if (C.handTotal(game.players[b.player].hand) > 0) victim = true;
        }
      }
      if (victim) s += 2;
      s += game.rng() * 0.01;
      if (s > bestScore) { bestScore = s; best = hid; }
    }
    return best;
  };

  AI.chooseVictim = function (game, pid, candidates) {
    let best = candidates[0];
    let bestScore = -Infinity;
    for (const c of candidates) {
      const s = game.victoryPoints(c, false) * 3 + C.handTotal(game.players[c].hand);
      if (s > bestScore) { bestScore = s; best = c; }
    }
    return best;
  };

  function robberOnMe(game, pid) {
    return game.hexes[game.robber].vertices.some(vid => {
      const b = game.vertices[vid].building;
      return b && b.player === pid;
    }) && game.hexes[game.robber].number;
  }

  // --------------------------------------------------------- discard/trade

  AI.chooseDiscard = function (game, pid, n) {
    const hand = Object.assign({}, game.players[pid].hand);
    const goals = goalList(game, pid);
    const out = C.emptyHand();
    for (let k = 0; k < n; k++) {
      let bestR = null;
      let bestU = -Infinity;
      for (const r of R) {
        if (hand[r] <= 0) continue;
        hand[r]--;
        const u = utility(hand, goals);
        hand[r]++;
        if (u > bestU) { bestU = u; bestR = r; }
      }
      hand[bestR]--;
      out[bestR]++;
    }
    return out;
  };

  /**
   * Would `pid` accept a trade from `fromPid` in which pid receives `receive`
   * and gives `give`?
   */
  AI.evaluateTrade = function (game, pid, fromPid, receive, give) {
    const p = game.players[pid];
    if (!C.hasResources(p.hand, give)) return false;
    if (game.victoryPoints(fromPid, false) >= game.vpToWin - 2) return false; // don't feed the leader
    const goals = goalList(game, pid);
    const after = Object.assign({}, p.hand);
    for (const r of R) after[r] += (receive[r] || 0) - (give[r] || 0);
    const gain = utility(after, goals) - utility(p.hand, goals);
    if (C.handTotal(receive) < C.handTotal(give)) return gain > 0.5;
    return gain > 0.05;
  };

  function bankTradeAction(game, pid) {
    const p = game.players[pid];
    const hand = p.hand;
    const goals = goalList(game, pid);
    const goal = primaryGoal(goals, hand);
    if (!goal) return null;
    const cost = goal.cost;
    const miss = R.filter(r => hand[r] < (cost[r] || 0) && game.bank[r] > 0);
    const totalMissing = missing(hand, cost);
    if (!miss.length || miss.length < R.filter(r => hand[r] < (cost[r] || 0)).length) return null;

    let credits = 0;
    let bestGive = null;
    let bestLeft = -1;
    for (const r of R) {
      const surplus = hand[r] - (cost[r] || 0);
      const ratio = game.tradeRatio(pid, r);
      if (surplus >= ratio) {
        credits += Math.floor(surplus / ratio);
        if (surplus - ratio > bestLeft) { bestLeft = surplus - ratio; bestGive = r; }
      }
    }
    // Only trade with the bank if it completes the build, or to shed a big hand.
    if (!bestGive || (credits < totalMissing && C.handTotal(hand) < 8)) return null;
    return {
      type: 'bankTrade',
      give: { [bestGive]: game.tradeRatio(pid, bestGive) },
      get: { [miss[0]]: 1 },
    };
  }

  function offerAction(game, pid, mem) {
    if (mem.offers >= 1) return null;
    const hand = game.players[pid].hand;
    const goal = primaryGoal(goalList(game, pid), hand);
    if (!goal) return null;
    const miss = R.filter(r => hand[r] < (goal.cost[r] || 0));
    if (!miss.length || missing(hand, goal.cost) > 2) return null;
    const want = miss[0];
    const surplus = R.filter(r => r !== want && hand[r] > (goal.cost[r] || 0)).sort((a, b) => hand[b] - hand[a]);
    if (!surplus.length) return null;
    const key = surplus[0] + '>' + want;
    if (mem.offered.has(key)) return null;
    mem.offered.add(key);
    mem.offers++;
    return { type: 'offer', give: { [surplus[0]]: 1 }, get: { [want]: 1 } };
  }

  // ------------------------------------------------------------ dev cards

  function devAction(game, pid, preRoll) {
    if (game.devPlayed) return null;
    const p = game.players[pid];
    const playable = type => p.devCards.some(c => c.type === type && c.turnBought < game.turn);

    if (playable('knight')) {
      const la = game.largestArmyHolder;
      const laKnights = la === null ? 2 : game.players[la].knightsPlayed;
      const wantsArmy = la !== pid && p.knightsPlayed + 1 >= 3 && p.knightsPlayed + 1 > laKnights;
      if (robberOnMe(game, pid) || (!preRoll && wantsArmy)) return { type: 'playKnight' };
    }
    if (preRoll) return null;

    if (playable('monopoly')) {
      let best = null;
      let bestN = 0;
      for (const r of R) {
        const n = game.players.reduce((s, o) => s + (o.id === pid ? 0 : o.hand[r]), 0);
        if (n > bestN) { bestN = n; best = r; }
      }
      if (bestN >= 4) return { type: 'playMonopoly', resource: best };
    }

    if (playable('yearOfPlenty')) {
      const goals = goalList(game, pid);
      const goal = primaryGoal(goals.filter(g => g.type !== 'dev'), p.hand) || primaryGoal(goals, p.hand);
      if (goal) {
        const list = [];
        for (const r of R) for (let i = p.hand[r]; i < (goal.cost[r] || 0); i++) list.push(r);
        if (list.length >= 1 && list.length <= 2) {
          if (list.length === 1) {
            const prod = AI.production(game, pid);
            list.push(R.slice().sort((a, b) => prod[a] - prod[b])[0]);
          }
          const want = C.emptyHand();
          for (const r of list) want[r]++;
          if (C.hasResources(game.bank, want)) return { type: 'playYearOfPlenty', resources: list };
        }
      }
    }

    if (playable('roadBuilding') && p.roadsLeft > 0 && game.validRoadSpots(pid).length) {
      const noSpots = game.validSettlementSpots(pid).length === 0;
      if ((noSpots && AI.roadPlan(game, pid)) || longestRoadEdge(game, pid) !== null) return { type: 'playRoadBuilding' };
    }
    return null;
  }

  // ----------------------------------------------------------------- main

  function mainAction(game, pid) {
    const p = game.players[pid];
    const hand = p.hand;
    const mem = memory(game, pid);
    if (++mem.actions > 60) return { type: 'endTurn' };

    const dev = devAction(game, pid, false);
    if (dev) return dev;

    if (p.citiesLeft > 0 && C.hasResources(hand, COSTS.city)) {
      const spots = game.validCitySpots(pid);
      if (spots.length) {
        const val = vid => game.vertices[vid].hexes.reduce((s, h) => s + (h === game.robber ? 0 : pips(game.hexes[h])), 0);
        spots.sort((a, b) => val(b) - val(a));
        return { type: 'buildCity', vertex: spots[0] };
      }
    }

    const spots = game.validSettlementSpots(pid);
    if (p.settlementsLeft > 0 && spots.length && C.hasResources(hand, COSTS.settlement)) {
      const prod = AI.production(game, pid);
      spots.sort((a, b) => AI.vertexScore(game, pid, b, prod) - AI.vertexScore(game, pid, a, prod));
      return { type: 'buildSettlement', vertex: spots[0] };
    }

    if (p.roadsLeft > 0 && C.hasResources(hand, COSTS.road)) {
      if (!spots.length && p.settlementsLeft > 0) {
        const plan = AI.roadPlan(game, pid);
        if (plan) return { type: 'buildRoad', edge: plan.edge };
      }
      // Push for longest road when it is within reach or we have cards to spare.
      const holder = game.longestRoadHolder;
      const target = holder === null ? 5 : game.players[holder].roadLength + 1;
      if (holder !== pid && p.roadLength + 2 >= target && p.roadsLeft > 1) {
        const e = longestRoadEdge(game, pid);
        if (e !== null && (spots.length === 0 || C.handTotal(hand) >= 7)) return { type: 'buildRoad', edge: e };
      }
    }

    if (game.devDeck.length && C.hasResources(hand, COSTS.dev)) {
      const goal = primaryGoal(goalList(game, pid), hand);
      const after = Object.assign({}, hand);
      for (const r of R) after[r] -= COSTS.dev[r] || 0;
      if (!goal || goal.type === 'dev' || missing(after, goal.cost) <= missing(hand, goal.cost) || C.handTotal(hand) >= 8) {
        return { type: 'buyDevCard' };
      }
    }

    const trade = bankTradeAction(game, pid);
    if (trade) return trade;

    const offer = offerAction(game, pid, mem);
    if (offer) return offer;

    return { type: 'endTurn' };
  }

  AI.decide = function (game, pid) {
    switch (game.phase) {
      case 'setupSettlement':
        return { type: 'placeSetupSettlement', vertex: bestSetupSettlement(game, pid) };
      case 'setupRoad':
        return { type: 'placeSetupRoad', edge: bestSetupRoad(game, pid) };
      case 'preRoll':
        return devAction(game, pid, true) || { type: 'rollDice' };
      case 'discard':
        return { type: 'discard', cards: AI.chooseDiscard(game, pid, game.discardPending[pid]) };
      case 'moveRobber':
        return { type: 'moveRobber', hex: AI.chooseRobberHex(game, pid) };
      case 'steal':
        return { type: 'steal', victim: AI.chooseVictim(game, pid, game.stealCandidates) };
      case 'roadBuilding':
        return { type: 'placeFreeRoad', edge: anyRoadEdge(game, pid) };
      case 'main':
        return mainAction(game, pid);
      default:
        return null;
    }
  };

  C.AI = AI;
})(Catan);
