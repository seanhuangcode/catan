/*
 * Site-independent game snapshots.
 *
 * A snapshot is plain JSON describing a game from ONE player's point of view
 * (only what that player can see). Any front end -- this repo's board, or a
 * reader for another site -- can produce one, and the trained policy can then
 * choose a move for it without knowing where the game is being played.
 *
 * Board locations use axial hex coordinates with corner/side indices, so they
 * don't depend on any site's internal numbering:
 *   hex      [q, r]           19 tiles, q,r in -2..2 with |q+r| <= 2;
 *                             r = -2 is the top row, q grows to the right
 *   vertex   [q, r, corner]   corner 0 = top, then clockwise (1 = upper right ... 5 = upper left)
 *   edge     [q, r, side]     side i joins corner i and corner i+1 (side 0 = upper-right edge)
 * Any of the up to three hexes touching a vertex (or two touching an edge) may
 * be used to name it.
 *
 * Snapshot fields (all required unless marked optional):
 *   me                     seat index of the player we are deciding for
 *   turn                   turn counter (increments every time a player ends a turn)
 *   phase                  'setupSettlement' | 'setupRoad' | 'preRoll' | 'discard' |
 *                          'moveRobber' | 'steal' | 'main' | 'roadBuilding' | 'gameOver'
 *   current                seat whose turn it is
 *   winner                 seat that won (gameOver only, optional)
 *   setupRound             1 or 2 during setup (optional otherwise)
 *   lastSetupVertex        vertex of the settlement just placed (setupRoad only)
 *   dice                   [d1, d2] or null
 *   devPlayedThisTurn      boolean
 *   discardCount           cards `me` must discard (discard phase)
 *   stealFrom              seats that can be robbed (steal phase)
 *   freeRoads              free roads left (roadBuilding phase)
 *   vpToWin                default 10
 *   hexes                  [{hex, resource ('wood'|'brick'|'sheep'|'wheat'|'ore'|'desert'), number}]
 *   robber                 hex
 *   ports                  [{type ('any' or a resource), vertices: [vertex, vertex]}]
 *   buildings              [{owner, type ('settlement'|'city'), vertex}]
 *   roads                  [{owner, edge}]
 *   players                [{name, handCount, devCount, knightsPlayed}] in seat order
 *   hand                   my resource cards {wood, brick, sheep, wheat, ore}
 *   devCards               my development cards [{type, playable}] (playable = bought before this turn)
 *   bank                   resource cards left in the bank (optional; estimated if missing)
 *   devDeckCount           development cards left (optional; estimated if missing)
 *   longestRoad / largestArmy   seat holding the award, or null
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const R = C.RESOURCES;

  // ------------------------------------------------------- coordinates

  function index(game) {
    if (game._hexIndex) return game._hexIndex;
    const byQR = new Map();
    for (const h of game.hexes) byQR.set(h.q + ',' + h.r, h);
    return (game._hexIndex = byQR);
  }

  function hexAt(game, [q, r]) {
    const h = index(game).get(q + ',' + r);
    if (!h) throw new Error(`No hex at ${q},${r}`);
    return h;
  }

  const vertexId = (game, [q, r, c]) => hexAt(game, [q, r]).vertices[c];
  const edgeId = (game, [q, r, s]) => hexAt(game, [q, r]).edges[s];

  function vertexRef(game, vid) {
    for (const h of game.hexes) {
      const c = h.vertices.indexOf(vid);
      if (c >= 0) return [h.q, h.r, c];
    }
    throw new Error('Unknown vertex ' + vid);
  }

  function edgeRef(game, eid) {
    for (const h of game.hexes) {
      const s = h.edges.indexOf(eid);
      if (s >= 0) return [h.q, h.r, s];
    }
    throw new Error('Unknown edge ' + eid);
  }

  const hexRef = (game, hid) => [game.hexes[hid].q, game.hexes[hid].r];

  // --------------------------------------------- game -> snapshot

  /** Snapshot of `game` as seen by player `me`. */
  function toSnapshot(game, me) {
    const p = game.players[me];
    const snap = {
      me,
      turn: game.turn,
      phase: game.phase,
      current: game.current,
      winner: game.winner,
      setupRound: game.phase.startsWith('setup') ? (game.setupStep < game.players.length ? 1 : 2) : null,
      lastSetupVertex: game.phase === 'setupRoad' ? vertexRef(game, game.lastSetupVertex) : null,
      dice: game.dice ? game.dice.slice() : null,
      devPlayedThisTurn: game.devPlayed,
      discardCount: game.phase === 'discard' ? game.discardPending[me] || 0 : 0,
      stealFrom: game.phase === 'steal' ? game.stealCandidates.slice() : [],
      freeRoads: game.phase === 'roadBuilding' ? game.freeRoads : 0,
      vpToWin: game.vpToWin,
      hexes: game.hexes.map(h => ({ hex: [h.q, h.r], resource: h.resource, number: h.number })),
      robber: hexRef(game, game.robber),
      ports: game.ports.map(pt => ({ type: pt.type, vertices: pt.vertices.map(v => vertexRef(game, v)) })),
      buildings: game.vertices.filter(v => v.building).map(v => ({ owner: v.building.player, type: v.building.type, vertex: vertexRef(game, v.id) })),
      roads: game.edges.filter(e => e.road !== null).map(e => ({ owner: e.road, edge: edgeRef(game, e.id) })),
      players: game.players.map(o => ({ name: o.name, handCount: C.handTotal(o.hand), devCount: o.devCards.length, knightsPlayed: o.knightsPlayed })),
      hand: Object.assign({}, p.hand),
      devCards: p.devCards.map(c => ({ type: c.type, playable: c.turnBought < game.turn })),
      bank: Object.assign({}, game.bank),
      devDeckCount: game.devDeck.length,
      longestRoad: game.longestRoadHolder,
      largestArmy: game.largestArmyHolder,
    };
    return snap;
  }

  // --------------------------------------------- snapshot -> game

  /**
   * Rebuilds an engine Game from a snapshot so the policy (and the rules
   * engine's legality checks) can run on it. Opponents' hidden cards are
   * filled with placeholders of the right count; the policy only ever sees
   * the counts.
   */
  function buildGame(snap) {
    const n = snap.players.length;
    const game = new C.Game({
      players: snap.players.map((pl, i) => ({ name: pl.name || 'P' + i, isBot: i !== snap.me })),
      vpToWin: snap.vpToWin || 10,
    });
    game.log = [];

    for (const h of snap.hexes) {
      const hex = hexAt(game, h.hex);
      hex.resource = h.resource;
      hex.number = h.resource === 'desert' ? null : h.number;
    }
    game.robber = hexAt(game, snap.robber).id;

    for (const v of game.vertices) v.port = null;
    game.ports = snap.ports.map(pt => {
      const vids = pt.vertices.map(ref => vertexId(game, ref));
      for (const vid of vids) game.vertices[vid].port = pt.type;
      const a = game.vertices[vids[0]];
      const b = game.vertices[vids[1]];
      return { type: pt.type, vertices: vids, x: (a.x + b.x) / 2 * 1.15, y: (a.y + b.y) / 2 * 1.15, edge: null };
    });

    for (const pl of game.players) {
      pl.settlementsLeft = 5;
      pl.citiesLeft = 4;
      pl.roadsLeft = 15;
    }
    for (const b of snap.buildings) {
      game.vertices[vertexId(game, b.vertex)].building = { player: b.owner, type: b.type };
      const pl = game.players[b.owner];
      if (b.type === 'city') pl.citiesLeft--;
      else pl.settlementsLeft--;
    }
    for (const r of snap.roads) {
      game.edges[edgeId(game, r.edge)].road = r.owner;
      game.players[r.owner].roadsLeft--;
    }

    game.turn = snap.turn;
    game.current = snap.current;
    game.phase = snap.phase;
    game.dice = snap.dice ? snap.dice.slice() : null;
    game.devPlayed = !!snap.devPlayedThisTurn;
    game.longestRoadHolder = snap.longestRoad === undefined ? null : snap.longestRoad;
    game.largestArmyHolder = snap.largestArmy === undefined ? null : snap.largestArmy;
    for (const pl of game.players) pl.roadLength = game.computeRoadLength(pl.id);

    // Hands: mine exactly; opponents as placeholder cards of the right count.
    snap.players.forEach((info, i) => {
      const pl = game.players[i];
      pl.knightsPlayed = info.knightsPlayed || 0;
      if (i === snap.me) {
        pl.hand = Object.assign(C.emptyHand(), snap.hand);
        pl.devCards = (snap.devCards || []).map(c => ({ type: c.type, turnBought: c.playable ? snap.turn - 1 : snap.turn }));
      } else {
        pl.hand = C.emptyHand();
        for (let k = 0; k < (info.handCount || 0); k++) pl.hand[R[k % 5]]++;
        pl.devCards = [];
        for (let k = 0; k < (info.devCount || 0); k++) pl.devCards.push({ type: 'knight', turnBought: -1 });
      }
    });

    if (snap.bank) game.bank = Object.assign(C.emptyHand(), snap.bank);
    else {
      // Estimate: 19 of each, minus my cards and an even share of everyone else's.
      const others = snap.players.reduce((s, pl, i) => s + (i === snap.me ? 0 : pl.handCount || 0), 0);
      for (const r of R) game.bank[r] = Math.max(0, 19 - (snap.hand[r] || 0) - Math.round(others / 5));
    }
    const devHeld = snap.players.reduce((s, pl) => s + (pl.devCount || 0), 0);
    const knights = snap.players.reduce((s, pl) => s + (pl.knightsPlayed || 0), 0);
    const deckCount = snap.devDeckCount !== undefined ? snap.devDeckCount : Math.max(0, 25 - devHeld - knights);
    game.devDeck = new Array(deckCount).fill('knight');

    // Setup bookkeeping.
    if (snap.phase === 'setupSettlement' || snap.phase === 'setupRoad') {
      game.setupStep = snap.setupRound === 2 ? n : 0;
    } else {
      game.setupStep = 2 * n;
    }
    if (snap.lastSetupVertex) game.lastSetupVertex = vertexId(game, snap.lastSetupVertex);
    game.discardPending = snap.phase === 'discard' && snap.discardCount ? { [snap.me]: snap.discardCount } : {};
    game.stealCandidates = (snap.stealFrom || []).slice();
    game.freeRoads = snap.freeRoads || 0;
    game.afterRobber = 'main';
    game.afterRoadBuilding = 'main';
    return game;
  }

  // ------------------------------------------------------ decisions

  /** True when the snapshot is waiting on a decision from `me`. */
  function needsDecision(snap) {
    if (snap.phase === 'gameOver') return false;
    if (snap.phase === 'discard') return snap.discardCount > 0;
    return snap.current === snap.me;
  }

  /**
   * Chooses the next move for snap.me with a PolicyAgent (or anything with the
   * same choose/chooseDiscard methods). Returns a site-independent move:
   *   {kind, vertex?, edge?, hex?, victim?, resources?, resource?, give?, get?, cards?}
   * kind 'offer' means: offer the other players `give` for `get`, and take the
   * trade if someone accepts.
   * plus `action` (the policy's action index) for logging.
   */
  function decide(snap, agent, ctx) {
    const game = buildGame(snap);
    const me = snap.me;
    ctx = ctx || C.RL.newContext();
    C.RL.syncTurn(ctx, game);
    if (snap.phase === 'discard') {
      const cards = agent.chooseDiscard(game, me, snap.discardCount, ctx);
      return { kind: 'discard', cards };
    }
    const a = agent.choose(game, me, ctx);
    if (game.phase === 'main') ctx.mainActions++;
    const act = C.RL.toAction(game, me, a);
    const move = { action: a, label: C.RL.describe(a) };
    switch (act.type) {
      case 'placeSetupSettlement': return Object.assign(move, { kind: 'placeSettlement', vertex: vertexRef(game, act.vertex) });
      case 'buildSettlement': return Object.assign(move, { kind: 'buildSettlement', vertex: vertexRef(game, act.vertex) });
      case 'buildCity': return Object.assign(move, { kind: 'buildCity', vertex: vertexRef(game, act.vertex) });
      case 'placeSetupRoad': return Object.assign(move, { kind: 'placeRoad', edge: edgeRef(game, act.edge) });
      case 'placeFreeRoad': return Object.assign(move, { kind: 'placeFreeRoad', edge: edgeRef(game, act.edge) });
      case 'buildRoad': return Object.assign(move, { kind: 'buildRoad', edge: edgeRef(game, act.edge) });
      case 'moveRobber': return Object.assign(move, { kind: 'moveRobber', hex: hexRef(game, act.hex) });
      case 'steal': return Object.assign(move, { kind: 'steal', victim: act.victim });
      case 'rollDice': return Object.assign(move, { kind: 'roll' });
      case 'endTurn': return Object.assign(move, { kind: 'endTurn' });
      case 'buyDevCard': return Object.assign(move, { kind: 'buyDevCard' });
      case 'playKnight': return Object.assign(move, { kind: 'playKnight' });
      case 'playRoadBuilding': return Object.assign(move, { kind: 'playRoadBuilding' });
      case 'playYearOfPlenty': return Object.assign(move, { kind: 'playYearOfPlenty', resources: act.resources });
      case 'playMonopoly': return Object.assign(move, { kind: 'playMonopoly', resource: act.resource });
      case 'bankTrade': return Object.assign(move, { kind: 'bankTrade', give: act.give, get: act.get });
      case 'offer':
        C.RL.noteOffer(ctx, a);
        return Object.assign(move, { kind: 'offer', give: act.give, get: act.get });
      default: throw new Error('Unhandled action ' + act.type);
    }
  }

  /** Converts a move back into a Game#perform action on an engine game (used in tests). */
  function moveToAction(game, move) {
    switch (move.kind) {
      case 'placeSettlement': return { type: 'placeSetupSettlement', vertex: vertexId(game, move.vertex) };
      case 'buildSettlement': return { type: 'buildSettlement', vertex: vertexId(game, move.vertex) };
      case 'buildCity': return { type: 'buildCity', vertex: vertexId(game, move.vertex) };
      case 'placeRoad': return { type: 'placeSetupRoad', edge: edgeId(game, move.edge) };
      case 'placeFreeRoad': return { type: 'placeFreeRoad', edge: edgeId(game, move.edge) };
      case 'buildRoad': return { type: 'buildRoad', edge: edgeId(game, move.edge) };
      case 'moveRobber': return { type: 'moveRobber', hex: hexAt(game, move.hex).id };
      case 'steal': return { type: 'steal', victim: move.victim };
      case 'roll': return { type: 'rollDice' };
      case 'endTurn': return { type: 'endTurn' };
      case 'buyDevCard': return { type: 'buyDevCard' };
      case 'playKnight': return { type: 'playKnight' };
      case 'playRoadBuilding': return { type: 'playRoadBuilding' };
      case 'playYearOfPlenty': return { type: 'playYearOfPlenty', resources: move.resources };
      case 'playMonopoly': return { type: 'playMonopoly', resource: move.resource };
      case 'bankTrade': return { type: 'bankTrade', give: move.give, get: move.get };
      case 'discard': return { type: 'discard', cards: move.cards };
      case 'offer': return { type: 'offer', give: move.give, get: move.get };
      default: throw new Error('Unknown move ' + move.kind);
    }
  }

  C.Bridge = Object.assign(C.Bridge || {}, {
    toSnapshot, buildGame, needsDecision, decide, moveToAction,
    vertexId, edgeId, vertexRef, edgeRef, hexRef, hexAt,
  });
})(Catan);
