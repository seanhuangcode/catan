/*
 * Observation and action encoding for reinforcement learning.
 *
 * Observations are always from one player's point of view ("me" = seat 0,
 * other seats in turn order after me) and only contain what that player can
 * legitimately see: the board, public player stats, opponents' card counts,
 * and its own hand and development cards.
 *
 * Actions are a fixed, flat set of N_ACTIONS indices. A legality mask selects
 * which ones are allowed in the current state; every masked-in action is
 * guaranteed to be accepted by Game#perform (see tests/rl.test.js).
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const R = C.RESOURCES;
  const N_HEX = 19;
  const N_VERTEX = 54;
  const N_EDGE = 72;
  const MAX_SEATS = 4;
  const PHASES = ['setupSettlement', 'setupRoad', 'preRoll', 'discard', 'moveRobber', 'steal', 'main', 'roadBuilding'];
  const TILE_TYPES = ['wood', 'brick', 'sheep', 'wheat', 'ore', 'desert'];
  const PORT_TYPES = ['any', 'wood', 'brick', 'sheep', 'wheat', 'ore'];
  const DEV_TYPES = ['knight', 'victoryPoint', 'roadBuilding', 'yearOfPlenty', 'monopoly'];
  // Main-phase actions allowed per turn before only "end turn" stays legal.
  const MAX_MAIN_ACTIONS = 30;
  // Trade offers to other players allowed per turn.
  const MAX_OFFERS = 2;

  // ------------------------------------------------------------ actions

  const A = {};
  let n = 0;
  const block = (name, size) => { A[name] = n; n += size; };
  block('SETTLE', N_VERTEX); // setup or regular settlement on a vertex
  block('ROAD', N_EDGE); // setup, regular or free road on an edge
  block('CITY', N_VERTEX);
  block('ROBBER', N_HEX);
  block('STEAL', MAX_SEATS - 1); // relative seat 1..3
  block('DISCARD', 5); // discard one card of a resource
  block('ROLL', 1);
  block('END', 1);
  block('BUY_DEV', 1);
  block('KNIGHT', 1);
  block('ROAD_BUILDING', 1);
  block('YOP', 15); // Year of Plenty resource pairs
  block('MONO', 5);
  block('BANK', 20); // give (best ratio) of one resource for 1 of another
  block('OFFER', 20); // offer other players 1 of one resource for 1 of another
  const N_ACTIONS = n;

  const YOP_PAIRS = [];
  for (let i = 0; i < 5; i++) for (let j = i; j < 5; j++) YOP_PAIRS.push([R[i], R[j]]);
  const BANK_PAIRS = [];
  for (const g of R) for (const s of R) if (g !== s) BANK_PAIRS.push([g, s]);

  // ------------------------------------------------------- observations

  const HEX_F = 8; // tile one-hot (6), pips, robber
  const VERTEX_F = 22; // settlement by seat (4), city by seat (4), port (6), pips by resource (5), total pips, can settle, can settle ignoring roads
  const EDGE_F = 5; // road by seat (4), can build
  const PLAYER_F = 16;
  const SELF_F = 45;
  const O_HEX = 0;
  const O_VERTEX = O_HEX + N_HEX * HEX_F;
  const O_EDGE = O_VERTEX + N_VERTEX * VERTEX_F;
  const O_PLAYER = O_EDGE + N_EDGE * EDGE_F;
  const O_SELF = O_PLAYER + MAX_SEATS * PLAYER_F;
  // Appended later: each opponent's publicly known hand (see Game#publicHands).
  // Kept last so models trained before it still read the same inputs.
  const PUBLIC_F = 5;
  const O_PUBLIC = O_SELF + SELF_F;
  const OBS_SIZE = O_PUBLIC + (MAX_SEATS - 1) * PUBLIC_F;

  /**
   * Extra per-decision context the engine doesn't track:
   *   discardSel   cards already chosen during a multi-card discard
   *   mainActions  main-phase actions taken so far this turn
   *   offers       trade offers made so far this turn
   *   offered      action indices of those offers (an offer isn't repeated in a turn)
   *   turnSeen     turn these counters belong to (reset them when it changes)
   */
  function newContext() {
    return { discardSel: null, mainActions: 0, offers: 0, offered: [], turnSeen: -1 };
  }

  /** Resets the per-turn counters in `ctx` when the game has moved to a new turn. */
  function syncTurn(ctx, game) {
    if (ctx.turnSeen === game.turn) return;
    ctx.turnSeen = game.turn;
    ctx.mainActions = 0;
    ctx.offers = 0;
    ctx.offered = [];
  }

  /** Records that the offer with action index `a` was made this turn. */
  function noteOffer(ctx, a) {
    ctx.offers = (ctx.offers || 0) + 1;
    (ctx.offered || (ctx.offered = [])).push(a);
  }

  const rel = (game, me, pid) => (pid - me + game.players.length) % game.players.length;

  function playableDev(game, p, type) {
    return p.devCards.some(c => c.type === type && c.turnBought < game.turn);
  }

  function production(game, pid) {
    const prod = C.emptyHand();
    for (const v of game.vertices) {
      if (!v.building || v.building.player !== pid) continue;
      const mult = v.building.type === 'city' ? 2 : 1;
      for (const h of v.hexes) {
        const hex = game.hexes[h];
        if (hex.resource !== 'desert' && hex.id !== game.robber) prod[hex.resource] += C.PIPS[hex.number] * mult;
      }
    }
    return prod;
  }

  /** Acting player for the current decision. */
  function actor(game) {
    if (game.phase === 'discard') return game.pendingActors()[0];
    return game.current;
  }

  /** Hand as the acting player sees it (minus cards already picked for a discard). */
  function effectiveHand(game, me, ctx) {
    const h = Object.assign({}, game.players[me].hand);
    if (ctx && ctx.discardSel) for (const r of R) h[r] -= ctx.discardSel[r];
    return h;
  }

  /**
   * Encodes the state for player `me` into `out` (a Float32Array of OBS_SIZE,
   * allocated if omitted) and returns it.
   */
  function encode(game, me, ctx, out) {
    out = out || new Float32Array(OBS_SIZE);
    out.fill(0);
    const nP = game.players.length;
    const phase = game.phase;
    const myTurn = game.current === me;

    for (const h of game.hexes) {
      const o = O_HEX + h.id * HEX_F;
      out[o + TILE_TYPES.indexOf(h.resource)] = 1;
      out[o + 6] = h.number ? C.PIPS[h.number] / 5 : 0;
      out[o + 7] = h.id === game.robber ? 1 : 0;
    }

    const settleSetup = phase === 'setupSettlement' && myTurn;
    for (const v of game.vertices) {
      const o = O_VERTEX + v.id * VERTEX_F;
      if (v.building) out[o + (v.building.type === 'city' ? 4 : 0) + rel(game, me, v.building.player)] = 1;
      if (v.port) out[o + 8 + PORT_TYPES.indexOf(v.port)] = 1;
      let total = 0;
      for (const hid of v.hexes) {
        const hex = game.hexes[hid];
        if (hex.resource === 'desert') continue;
        const p = C.PIPS[hex.number] / 5;
        out[o + 14 + R.indexOf(hex.resource)] += p;
        total += p;
      }
      out[o + 19] = total / 3;
      if (!v.building) {
        out[o + 20] = game.canPlaceSettlement(me, v.id, settleSetup) ? 1 : 0;
        out[o + 21] = game.canPlaceSettlement(me, v.id, true) ? 1 : 0;
      }
    }

    const setupRoad = phase === 'setupRoad' && myTurn;
    for (const e of game.edges) {
      const o = O_EDGE + e.id * EDGE_F;
      if (e.road !== null) out[o + rel(game, me, e.road)] = 1;
      else if (setupRoad ? e.v.includes(game.lastSetupVertex) : game.canPlaceRoad(me, e.id)) out[o + 4] = 1;
    }

    for (const p of game.players) {
      const o = O_PLAYER + rel(game, me, p.id) * PLAYER_F;
      out[o] = 1; // seat present
      out[o + 1] = game.victoryPoints(p.id, false) / 10;
      out[o + 2] = C.handTotal(p.hand) / 10;
      out[o + 3] = p.devCards.length / 5;
      out[o + 4] = p.knightsPlayed / 5;
      out[o + 5] = p.roadLength / 10;
      out[o + 6] = game.longestRoadHolder === p.id ? 1 : 0;
      out[o + 7] = game.largestArmyHolder === p.id ? 1 : 0;
      out[o + 8] = p.roadsLeft / 15;
      out[o + 9] = p.settlementsLeft / 5;
      out[o + 10] = p.citiesLeft / 4;
      const prod = production(game, p.id);
      for (let i = 0; i < 5; i++) out[o + 11 + i] = prod[R[i]] / 15;
    }

    const me_ = game.players[me];
    const hand = effectiveHand(game, me, ctx);
    let o = O_SELF;
    for (let i = 0; i < 5; i++) out[o + i] = hand[R[i]] / 5;
    o += 5;
    for (let i = 0; i < 5; i++) {
      const t = DEV_TYPES[i];
      out[o + i] = me_.devCards.filter(c => c.type === t && c.turnBought < game.turn).length / 2;
      out[o + 5 + i] = me_.devCards.filter(c => c.type === t && c.turnBought >= game.turn).length / 2;
    }
    o += 10;
    out[o++] = game.victoryPoints(me, true) / 10;
    for (let i = 0; i < 5; i++) out[o + i] = (4 - game.tradeRatio(me, R[i])) / 2;
    o += 5;
    out[o++] = game.devPlayed ? 1 : 0;
    out[o + PHASES.indexOf(phase)] = 1;
    o += PHASES.length;
    out[o++] = phase === 'discard' ? ((game.discardPending[me] || 0) - (ctx && ctx.discardSel ? C.handTotal(ctx.discardSel) : 0)) / 5 : 0;
    out[o++] = phase === 'roadBuilding' ? game.freeRoads / 2 : 0;
    for (let i = 0; i < 5; i++) out[o + i] = game.bank[R[i]] / 19;
    o += 5;
    out[o++] = game.devDeck.length / 25;
    out[o++] = Math.min(game.turn, 200) / 100;
    out[o++] = ctx ? Math.min(ctx.mainActions, MAX_MAIN_ACTIONS) / MAX_MAIN_ACTIONS : 0;
    out[o++] = game.setupStep >= nP ? 1 : 0;
    out[o++] = myTurn ? 1 : 0;
    out[o++] = nP === 3 ? 1 : 0;
    out[o++] = game.dice ? (game.dice[0] + game.dice[1]) / 12 : 0;
    out[o++] = game.vpToWin / 10;
    out[o++] = ctx ? Math.min(ctx.offers || 0, MAX_OFFERS) / MAX_OFFERS : 0;

    if (game.publicHands) {
      for (const pl of game.players) {
        if (pl.id === me) continue;
        const base = O_PUBLIC + (rel(game, me, pl.id) - 1) * PUBLIC_F;
        for (let i = 0; i < 5; i++) out[base + i] = game.publicHands[pl.id][R[i]] / 5;
      }
    }
    return out;
  }

  /** Sparse view of a dense observation: {idx: Uint16Array, val: Float32Array}. */
  function sparsify(dense) {
    let nnz = 0;
    for (let i = 0; i < dense.length; i++) if (dense[i] !== 0) nnz++;
    const idx = new Uint16Array(nnz);
    const val = new Float32Array(nnz);
    let k = 0;
    for (let i = 0; i < dense.length; i++) {
      if (dense[i] !== 0) { idx[k] = i; val[k] = dense[i]; k++; }
    }
    return { idx, val };
  }

  // -------------------------------------------------------------- masks

  function devMask(game, me, mask) {
    if (game.devPlayed) return;
    const p = game.players[me];
    if (playableDev(game, p, 'knight')) mask[A.KNIGHT] = 1;
    if (playableDev(game, p, 'roadBuilding') && p.roadsLeft > 0 && game.validRoadSpots(me).length > 0) mask[A.ROAD_BUILDING] = 1;
    if (playableDev(game, p, 'yearOfPlenty')) {
      YOP_PAIRS.forEach(([a, b], i) => {
        if (a === b ? game.bank[a] >= 2 : game.bank[a] >= 1 && game.bank[b] >= 1) mask[A.YOP + i] = 1;
      });
    }
    if (playableDev(game, p, 'monopoly')) for (let i = 0; i < 5; i++) mask[A.MONO + i] = 1;
  }

  /** Legal action mask for the acting player. */
  function legalMask(game, me, ctx, mask) {
    mask = mask || new Uint8Array(N_ACTIONS);
    mask.fill(0);
    const p = game.players[me];
    switch (game.phase) {
      case 'setupSettlement':
        for (const v of game.validSettlementSpots(me, true)) mask[A.SETTLE + v] = 1;
        break;
      case 'setupRoad':
      case 'roadBuilding':
        for (const e of game.validRoadSpots(me)) mask[A.ROAD + e] = 1;
        break;
      case 'preRoll':
        mask[A.ROLL] = 1;
        devMask(game, me, mask);
        break;
      case 'discard': {
        const hand = effectiveHand(game, me, ctx);
        for (let i = 0; i < 5; i++) if (hand[R[i]] > 0) mask[A.DISCARD + i] = 1;
        break;
      }
      case 'moveRobber':
        for (const h of game.validRobberHexes(me)) mask[A.ROBBER + h] = 1;
        break;
      case 'steal':
        for (const v of game.stealCandidates) mask[A.STEAL + rel(game, me, v) - 1] = 1;
        break;
      case 'main': {
        mask[A.END] = 1;
        if (ctx && ctx.mainActions >= MAX_MAIN_ACTIONS) break;
        const hand = p.hand;
        if (p.roadsLeft > 0 && C.hasResources(hand, C.COSTS.road)) for (const e of game.validRoadSpots(me)) mask[A.ROAD + e] = 1;
        if (p.settlementsLeft > 0 && C.hasResources(hand, C.COSTS.settlement)) for (const v of game.validSettlementSpots(me, false)) mask[A.SETTLE + v] = 1;
        if (p.citiesLeft > 0 && C.hasResources(hand, C.COSTS.city)) for (const v of game.validCitySpots(me)) mask[A.CITY + v] = 1;
        if (game.devDeck.length > 0 && C.hasResources(hand, C.COSTS.dev)) mask[A.BUY_DEV] = 1;
        devMask(game, me, mask);
        BANK_PAIRS.forEach(([g, s], i) => {
          if (hand[g] >= game.tradeRatio(me, g) && game.bank[s] > 0) mask[A.BANK + i] = 1;
          if (hand[g] >= 1 && (!ctx || ((ctx.offers || 0) < MAX_OFFERS && !(ctx.offered || []).includes(A.OFFER + i)))) mask[A.OFFER + i] = 1;
        });
        break;
      }
    }
    return mask;
  }

  // ---------------------------------------------------- action mapping

  /**
   * Converts an action index into a Game#perform action. Discard picks return
   * {type: 'discardPick', resource}; the caller collects them into one discard.
   */
  function toAction(game, me, a) {
    if (a < A.ROAD) return { type: game.phase === 'setupSettlement' ? 'placeSetupSettlement' : 'buildSettlement', vertex: a - A.SETTLE };
    if (a < A.CITY) {
      const edge = a - A.ROAD;
      if (game.phase === 'setupRoad') return { type: 'placeSetupRoad', edge };
      if (game.phase === 'roadBuilding') return { type: 'placeFreeRoad', edge };
      return { type: 'buildRoad', edge };
    }
    if (a < A.ROBBER) return { type: 'buildCity', vertex: a - A.CITY };
    if (a < A.STEAL) return { type: 'moveRobber', hex: a - A.ROBBER };
    if (a < A.DISCARD) return { type: 'steal', victim: (me + 1 + a - A.STEAL) % game.players.length };
    if (a < A.ROLL) return { type: 'discardPick', resource: R[a - A.DISCARD] };
    if (a === A.ROLL) return { type: 'rollDice' };
    if (a === A.END) return { type: 'endTurn' };
    if (a === A.BUY_DEV) return { type: 'buyDevCard' };
    if (a === A.KNIGHT) return { type: 'playKnight' };
    if (a === A.ROAD_BUILDING) return { type: 'playRoadBuilding' };
    if (a < A.MONO) return { type: 'playYearOfPlenty', resources: YOP_PAIRS[a - A.YOP].slice() };
    if (a < A.BANK) return { type: 'playMonopoly', resource: R[a - A.MONO] };
    if (a < A.OFFER) {
      const [g, s] = BANK_PAIRS[a - A.BANK];
      return { type: 'bankTrade', give: { [g]: game.tradeRatio(me, g) }, get: { [s]: 1 } };
    }
    // Not a Game#perform action: whoever runs the game asks the other players.
    const [g, s] = BANK_PAIRS[a - A.OFFER];
    return { type: 'offer', give: { [g]: 1 }, get: { [s]: 1 } };
  }

  /**
   * Maps a Game#perform action (e.g. from the heuristic bot) to an action
   * index, or -1 if it has no equivalent (player trades, multi-resource bank
   * trades, whole-hand discards).
   */
  function fromAction(game, me, action) {
    switch (action.type) {
      case 'placeSetupSettlement':
      case 'buildSettlement': return A.SETTLE + action.vertex;
      case 'placeSetupRoad':
      case 'buildRoad':
      case 'placeFreeRoad': return A.ROAD + action.edge;
      case 'buildCity': return A.CITY + action.vertex;
      case 'moveRobber': return A.ROBBER + action.hex;
      case 'steal': return A.STEAL + rel(game, me, action.victim) - 1;
      case 'rollDice': return A.ROLL;
      case 'endTurn': return A.END;
      case 'buyDevCard': return A.BUY_DEV;
      case 'playKnight': return A.KNIGHT;
      case 'playRoadBuilding': return A.ROAD_BUILDING;
      case 'playYearOfPlenty': {
        const [a, b] = action.resources.map(r => R.indexOf(r)).sort((x, y) => x - y);
        return A.YOP + YOP_PAIRS.findIndex(([x, y]) => x === R[a] && y === R[b]);
      }
      case 'playMonopoly': return A.MONO + R.indexOf(action.resource);
      case 'bankTrade': {
        const gives = R.filter(r => action.give[r]);
        const gets = R.filter(r => action.get[r]);
        if (gives.length !== 1 || gets.length !== 1 || action.get[gets[0]] !== 1) return -1;
        if (action.give[gives[0]] !== game.tradeRatio(me, gives[0])) return -1;
        return A.BANK + BANK_PAIRS.findIndex(([g, s]) => g === gives[0] && s === gets[0]);
      }
      case 'offer': {
        const gives = R.filter(r => action.give[r]);
        const gets = R.filter(r => action.get[r]);
        if (gives.length !== 1 || gets.length !== 1 || action.give[gives[0]] !== 1 || action.get[gets[0]] !== 1) return -1;
        return A.OFFER + BANK_PAIRS.findIndex(([g, s]) => g === gives[0] && s === gets[0]);
      }
      default: return -1;
    }
  }

  /**
   * Location features for the network's pointer heads (see Net in nn.js).
   * For each kind of location action, every action gets a small feature
   * vector gathered from the observation: its own features plus nearby
   * ones. One shared scorer then rates every location of that kind, so
   * what it learns about one corner carries over to all corners.
   * Each group: {start, count, F, offsets, slots, obs}; action i of the group
   * has feature[slots[k]] += obs[obs[k]] for k in offsets[i]..offsets[i+1].
   */
  let groupCache = null;
  function pointerGroups() {
    if (groupCache) return groupCache;
    const geo = C.boardGeometry();
    const vtx = (v, base, list) => { for (let k = 0; k < VERTEX_F; k++) list.push([base + k, O_VERTEX + v * VERTEX_F + k]); };
    const make = (start, count, F, build) => {
      const offsets = new Int32Array(count + 1);
      const slots = [];
      const obs = [];
      for (let i = 0; i < count; i++) {
        offsets[i] = slots.length;
        const list = [];
        build(i, list);
        for (const [s, o] of list) { slots.push(s); obs.push(o); }
      }
      offsets[count] = slots.length;
      return { start, count, F, offsets, slots: Int32Array.from(slots), obs: Int32Array.from(obs) };
    };
    groupCache = [
      // Settlement spot: its own features + the sum of its neighbors'.
      make(A.SETTLE, N_VERTEX, 2 * VERTEX_F, (v, l) => {
        vtx(v, 0, l);
        for (const n of geo.vertices[v].adj) vtx(n, VERTEX_F, l);
      }),
      make(A.CITY, N_VERTEX, VERTEX_F, (v, l) => vtx(v, 0, l)),
      // Road: edge features + both endpoints + the endpoints' neighbors.
      make(A.ROAD, N_EDGE, EDGE_F + 2 * VERTEX_F, (e, l) => {
        for (let k = 0; k < EDGE_F; k++) l.push([k, O_EDGE + e * EDGE_F + k]);
        for (const v of geo.edges[e].v) {
          vtx(v, EDGE_F, l);
          for (const n of geo.vertices[v].adj) vtx(n, EDGE_F + VERTEX_F, l);
        }
      }),
      // Robber tile: tile features + everything on its six corners.
      make(A.ROBBER, N_HEX, HEX_F + VERTEX_F, (h, l) => {
        for (let k = 0; k < HEX_F; k++) l.push([k, O_HEX + h * HEX_F + k]);
        for (const v of geo.hexes[h].vertices) vtx(v, HEX_F, l);
      }),
      // Steal target: that opponent's public stats.
      make(A.STEAL, MAX_SEATS - 1, PLAYER_F, (i, l) => {
        for (let k = 0; k < PLAYER_F; k++) l.push([k, O_PLAYER + (i + 1) * PLAYER_F + k]);
      }),
    ];
    return groupCache;
  }

  function describe(a) {
    for (const name of Object.keys(A).sort((x, y) => A[y] - A[x])) {
      if (a >= A[name]) return a === A[name] && ['ROLL', 'END', 'BUY_DEV', 'KNIGHT', 'ROAD_BUILDING'].includes(name) ? name : `${name}[${a - A[name]}]`;
    }
    return String(a);
  }

  C.RL = Object.assign(C.RL || {}, {
    A, N_ACTIONS, OBS_SIZE, PHASES, YOP_PAIRS, BANK_PAIRS, MAX_MAIN_ACTIONS, MAX_OFFERS,
    newContext, syncTurn, noteOffer, actor, encode, sparsify, legalMask, toAction, fromAction, describe, pointerGroups,
  });
})(Catan);
