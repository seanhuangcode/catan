/*
 * Reads colonist.io games from their WebSocket messages.
 *
 * colonist sends one full game state when a game starts (message type 4) and
 * then diffs of that same state (type 91): objects to merge in, where a null
 * value deletes the key. ColonistGame replays those messages to keep an exact
 * copy of the game and converts it into a snapshot (bridge/snapshot.js) from
 * one player's point of view, so the trained policy can decide a move.
 *
 * Codes worked out from a recorded game (see bridge/README.md):
 *   resources       1 wood, 2 brick, 3 sheep, 4 wheat, 5 ore (tile type 0 = desert)
 *   cards           0 = hidden resource card, 10 = hidden development card,
 *                   11 knight, 12 victory point, 13 monopoly, 14 road building,
 *                   15 year of plenty
 *   harbors         type 1 = 3:1, types 2..6 = 2:1 for resources 1..5
 *   corner (x,y,z)  z 0 = top corner of tile (x,y), z 1 = bottom corner
 *   edge (x,y,z)    z 0 = upper-left side of tile (x,y), 1 = left side, 2 = lower-left side
 *   turnState       0 setup, 1 before the roll, 2 after the roll
 *   actionState     1/3 place setup settlement/road, 4/6/7 choose a road/settlement/city
 *                   spot, 24 move the robber, 27 choose who to rob, 28 discard,
 *                   30/31 free roads (Road Building), 32 pick cards (Year of Plenty)
 * Tile coordinates are the same axial (q, r) coordinates the snapshot uses.
 */
'use strict';

const RES = [null, 'wood', 'brick', 'sheep', 'wheat', 'ore'];
const TILE = ['desert', 'wood', 'brick', 'sheep', 'wheat', 'ore'];
const DEV = { 11: 'knight', 12: 'victoryPoint', 13: 'monopoly', 14: 'roadBuilding', 15: 'yearOfPlenty' };
const SQ3 = Math.sqrt(3);

// ------------------------------------------------------------- geometry

const center = (q, r) => ({ x: SQ3 * (q + r / 2), y: 1.5 * r });
const cornerPos = (q, r, c) => {
  const h = center(q, r);
  const a = (Math.PI / 180) * (60 * c - 90);
  return { x: h.x + Math.cos(a), y: h.y + Math.sin(a) };
};

/** Position of a colonist corner (x, y, z). */
function colonistCorner({ x, y, z }) {
  return cornerPos(x, y, z === 0 ? 0 : 3);
}

/** The two end points of a colonist edge (x, y, z). */
function colonistEdgeEnds({ x, y, z }) {
  const side = z === 0 ? 5 : z === 1 ? 4 : 3; // side s joins corners s and s+1
  return [cornerPos(x, y, side), cornerPos(x, y, (side + 1) % 6)];
}

/**
 * Index of the board's corners by position, as snapshot references
 * [q, r, corner] on land tiles (colonist sometimes names corners from water tiles).
 */
function landCorners() {
  const out = [];
  for (let r = -2; r <= 2; r++) {
    for (let q = Math.max(-2, -r - 2); q <= Math.min(2, -r + 2); q++) {
      for (let c = 0; c < 6; c++) out.push({ ref: [q, r, c], p: cornerPos(q, r, c) });
    }
  }
  return out;
}
const LAND = landCorners();

function refAt(p) {
  let best = null;
  let bestD = Infinity;
  for (const k of LAND) {
    const d = (k.p.x - p.x) ** 2 + (k.p.y - p.y) ** 2;
    if (d < bestD) { bestD = d; best = k.ref; }
  }
  if (bestD > 1e-3) throw new Error('No land corner at that position');
  return best;
}

/** Snapshot edge reference [q, r, side] for two corner positions. */
function edgeRefFor(a, b) {
  const ra = refAt(a);
  const rb = refAt(b);
  // Find a land tile that has both corners next to each other.
  for (let r = -2; r <= 2; r++) {
    for (let q = Math.max(-2, -r - 2); q <= Math.min(2, -r + 2); q++) {
      for (let s = 0; s < 6; s++) {
        const p = cornerPos(q, r, s);
        const n = cornerPos(q, r, (s + 1) % 6);
        const same = (u, v) => Math.abs(u.x - v.x) < 1e-6 && Math.abs(u.y - v.y) < 1e-6;
        if ((same(p, a) && same(n, b)) || (same(p, b) && same(n, a))) return [q, r, s];
      }
    }
  }
  throw new Error(`No land edge between ${ra} and ${rb}`);
}

// ------------------------------------------------------------- the game

function merge(target, diff) {
  for (const [k, v] of Object.entries(diff)) {
    if (v === null) delete target[k];
    else if (typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
  return target;
}

const emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });

class ColonistGame {
  constructor() {
    this.state = null; // colonist's gameState, kept up to date
    this.me = null; // my color
    this.playOrder = null; // colors in turn order
    this.settings = {};
    this.highlights = { corners: [], edges: [], tiles: [] };
    this.selectCards = null; // card picking prompt (Year of Plenty, ...)
    this.publicHands = {}; // color -> expected resources, from public card movements
    this.ended = false;
    this.winner = null; // winning color, once the game is over
    // Called with {kind: 'corner'|'edge'|'tile', index} when one of my pieces
    // (or the robber, on my turn) lands somewhere: lets the profile learn
    // where on screen that spot is from the click that put it there.
    this.onPlaced = null;
  }

  get started() { return !!this.state; }

  /** Feeds one decoded message ({id, data: {type, payload}}). Returns true if it was a game message. */
  handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.id !== '130' || !msg.data) return false;
    const { type, payload } = msg.data;
    switch (type) {
      case 4:
        this.state = JSON.parse(JSON.stringify(payload.gameState));
        this.me = payload.playerColor;
        this.playOrder = payload.playOrder.slice();
        this.settings = payload.gameSettings || {};
        this.users = payload.playerUserStates || [];
        this.publicHands = {};
        for (const c of this.playOrder) this.publicHands[c] = emptyHand();
        this.ended = false;
        break;
      case 91:
        if (this.state && payload && payload.diff) {
          this.notePlacements(payload.diff);
          merge(this.state, payload.diff);
        }
        break;
      case 30: this.highlights.corners = payload || []; break;
      case 31: this.highlights.edges = payload || []; break;
      case 33: this.highlights.tiles = payload || []; break;
      case 18: this.selectCards = payload; break;
      case 43: this.trackCards(payload); break;
      case 45: {
        this.ended = true;
        const players = (payload && payload.endGameState && payload.endGameState.players) || {};
        for (const p of Object.values(players)) if (p && p.winningPlayer) this.winner = p.color;
        break;
      }
      default: return true;
    }
    return true;
  }

  /** Card counting from a public card movement (type 43). */
  trackCards({ givingPlayer, givingCards = [], receivingPlayer, receivingCards = [] }) {
    const move = (from, to, cards) => {
      const unknown = cards.filter(c => c === 0).length;
      for (const c of cards) {
        if (!RES[c]) continue;
        if (from && this.publicHands[from]) this.publicHands[from][RES[c]] -= 1;
        if (to && this.publicHands[to]) this.publicHands[to][RES[c]] += 1;
      }
      // A hidden card (a steal): shift the expectation proportionally.
      for (let k = 0; k < unknown; k++) {
        const src = this.publicHands[from];
        if (!src) continue;
        const total = Object.values(src).reduce((a, b) => a + Math.max(0, b), 0);
        for (const r of Object.keys(src)) {
          const share = total > 0 ? Math.max(0, src[r]) / total : 0.2;
          src[r] -= share;
          if (to && this.publicHands[to]) this.publicHands[to][r] += share;
        }
      }
    };
    move(givingPlayer, receivingPlayer, givingCards);
    move(receivingPlayer, givingPlayer, receivingCards);
    for (const h of Object.values(this.publicHands)) for (const r of Object.keys(h)) if (h[r] < 0) h[r] = 0;
  }

  notePlacements(diff) {
    if (!this.onPlaced) return;
    const ms = diff.mapState || {};
    for (const [k, c] of Object.entries(ms.tileCornerStates || {})) {
      if (c && c.owner === this.me) this.onPlaced({ kind: 'corner', index: Number(k) });
    }
    for (const [k, e] of Object.entries(ms.tileEdgeStates || {})) {
      if (e && e.owner === this.me) this.onPlaced({ kind: 'edge', index: Number(k) });
    }
    const rob = diff.mechanicRobberState;
    const cur = (this.state.currentState || {}).currentTurnPlayerColor;
    if (rob && rob.locationTileIndex !== undefined && cur === this.me) this.onPlaced({ kind: 'tile', index: rob.locationTileIndex });
  }

  /** Board position (snapshot units) of a colonist corner, edge midpoint or tile center. */
  boardPos(kind, index) {
    const ms = this.state.mapState;
    if (kind === 'corner') return colonistCorner(ms.tileCornerStates[index]);
    if (kind === 'edge') { const [a, b] = colonistEdgeEnds(ms.tileEdgeStates[index]); return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
    const h = ms.tileHexStates[index];
    return center(h.x, h.y);
  }

  /** A short fingerprint of the board, to tell whether a click changed anything. */
  boardKey() {
    if (!this.state) return '';
    const ms = this.state.mapState;
    const own = o => Object.entries(o).filter(([, v]) => v.owner).map(([k, v]) => k + ':' + v.owner + ':' + (v.buildingType || v.type)).join(',');
    const rob = this.state.mechanicRobberState ? this.state.mechanicRobberState.locationTileIndex : '';
    return own(ms.tileCornerStates) + '|' + own(ms.tileEdgeStates) + '|' + rob;
  }

  seatOf(color) { return this.playOrder.indexOf(color); }

  /** Converts colonist indices to snapshot references. */
  cornerRef(index) { return refAt(colonistCorner(this.state.mapState.tileCornerStates[index])); }
  edgeRef(index) { const [a, b] = colonistEdgeEnds(this.state.mapState.tileEdgeStates[index]); return edgeRefFor(a, b); }
  tileRef(index) { const h = this.state.mapState.tileHexStates[index]; return [h.x, h.y]; }

  /** Colonist index of a snapshot corner / edge / tile reference (for clicking or checking). */
  cornerIndex(ref) {
    const p = cornerPos(...ref);
    for (const [k, c] of Object.entries(this.state.mapState.tileCornerStates)) {
      const q = colonistCorner(c);
      if (Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6) return Number(k);
    }
    return -1;
  }

  edgeIndex(ref) {
    const a = cornerPos(ref[0], ref[1], ref[2]);
    const b = cornerPos(ref[0], ref[1], (ref[2] + 1) % 6);
    const same = (u, v) => Math.abs(u.x - v.x) < 1e-6 && Math.abs(u.y - v.y) < 1e-6;
    for (const [k, e] of Object.entries(this.state.mapState.tileEdgeStates)) {
      const [p, q] = colonistEdgeEnds(e);
      if ((same(p, a) && same(q, b)) || (same(p, b) && same(q, a))) return Number(k);
    }
    return -1;
  }

  tileIndex([q, r]) {
    for (const [k, h] of Object.entries(this.state.mapState.tileHexStates)) if (h.x === q && h.y === r) return Number(k);
    return -1;
  }

  /** Snapshot (bridge/snapshot.js format) of the game as I see it, or null before a game starts. */
  snapshot() {
    if (!this.state) return null;
    const s = this.state;
    const cur = s.currentState || {};
    const n = this.playOrder.length;
    const me = this.seatOf(this.me);
    const ms = s.mapState;
    const ps = s.playerStates || {};
    const devState = s.mechanicDevelopmentCardsState || { players: {}, bankDevelopmentCards: { cards: [] } };

    const buildings = [];
    for (const [k, c] of Object.entries(ms.tileCornerStates)) {
      if (c.owner) buildings.push({ owner: this.seatOf(c.owner), type: c.buildingType === 2 ? 'city' : 'settlement', vertex: this.cornerRef(k), colonist: Number(k) });
    }
    const roads = [];
    for (const [k, e] of Object.entries(ms.tileEdgeStates)) {
      if (e.owner) roads.push({ owner: this.seatOf(e.owner), edge: this.edgeRef(k), colonist: Number(k) });
    }
    const ports = Object.values(ms.portEdgeStates).map(pe => {
      const [a, b] = colonistEdgeEnds(pe);
      return { type: pe.type === 1 ? 'any' : RES[pe.type - 1], vertices: [refAt(a), refAt(b)] };
    });

    const players = this.playOrder.map(color => {
      const st = ps[color] || {};
      const dev = (devState.players && devState.players[color]) || {};
      const used = (dev.developmentCardsUsed || []);
      const user = (this.users || []).find(u => u.selectedColor === color) || {};
      return {
        name: user.username || 'P' + color,
        color,
        handCount: ((st.resourceCards && st.resourceCards.cards) || []).length,
        devCount: ((dev.developmentCards && dev.developmentCards.cards) || []).length,
        knightsPlayed: used.filter(c => c === 11).length,
        publicHand: Object.assign({}, this.publicHands[color]),
      };
    });

    const myCards = ((ps[this.me] && ps[this.me].resourceCards && ps[this.me].resourceCards.cards) || []);
    const hand = emptyHand();
    for (const c of myCards) if (RES[c]) hand[RES[c]]++;
    players[me].publicHand = Object.assign({}, hand);

    const myDev = (devState.players && devState.players[this.me]) || {};
    const boughtNow = ((myDev.developmentCardsBoughtThisTurn) || []).slice();
    const devCards = ((myDev.developmentCards && myDev.developmentCards.cards) || []).filter(c => DEV[c]).map(c => {
      const i = boughtNow.indexOf(c);
      const fresh = i >= 0;
      if (fresh) boughtNow.splice(i, 1);
      return { type: DEV[c], playable: !fresh };
    });

    const holder = (mech, flag) => {
      for (const [color, v] of Object.entries(mech || {})) if (v && v[flag]) return this.seatOf(Number(color));
      return null;
    };

    // Phase.
    const as = cur.actionState;
    const ts = cur.turnState;
    let phase;
    if (this.ended) phase = 'gameOver';
    else if (ts === 0 || ts === undefined) phase = as === 3 ? 'setupRoad' : 'setupSettlement';
    else if (as === 24) phase = 'moveRobber';
    else if (as === 27) phase = 'steal';
    else if (as === 28) phase = 'discard';
    else if (as === 30 || as === 31) phase = 'roadBuilding';
    else if (ts === 1) phase = 'preRoll';
    else phase = 'main';

    const robberIndex = s.mechanicRobberState ? s.mechanicRobberState.locationTileIndex : null;
    const settlementsPlaced = buildings.length;
    const snap = {
      me,
      turn: cur.completedTurns || 0,
      phase,
      current: this.seatOf(cur.currentTurnPlayerColor),
      setupRound: settlementsPlaced - (phase === 'setupRoad' ? 1 : 0) < n ? 1 : 2,
      dice: s.diceState && s.diceState.diceThrown ? [s.diceState.dice1, s.diceState.dice2] : null,
      devPlayedThisTurn: !!myDev.hasUsedDevelopmentCardThisTurn,
      vpToWin: this.settings.victoryPointsToWin || 10,
      hexes: Object.values(ms.tileHexStates).map(h => ({ hex: [h.x, h.y], resource: TILE[h.type], number: h.type === 0 ? null : h.diceNumber })),
      robber: robberIndex !== null ? this.tileRef(robberIndex) : null,
      ports,
      buildings,
      roads,
      players,
      hand,
      devCards,
      bank: s.bankState && !s.bankState.hideBankCards
        ? Object.fromEntries(RES.slice(1).map((r, i) => [r, s.bankState.resourceCards[i + 1]]))
        : undefined,
      devDeckCount: devState.bankDevelopmentCards ? devState.bankDevelopmentCards.cards.length : undefined,
      longestRoad: holder(s.mechanicLongestRoadState, 'hasLongestRoad'),
      largestArmy: holder(s.mechanicLargestArmyState, 'hasLargestArmy'),
      friendlyRobber: !!this.settings.friendlyRobber,
      discardCount: 0,
      stealFrom: [],
      freeRoads: as === 30 ? 2 : as === 31 ? 1 : 0,
      lastSetupVertex: null,
      winner: this.winner !== null ? this.seatOf(this.winner) : undefined,
      actionState: as,
      selectCards: as === 32 ? this.selectCards : null,
    };

    if (phase === 'discard') {
      const mine = ps[this.me] || {};
      snap.discardCount = mine.isTakingAction && myCards.length > (this.settings.cardDiscardLimit || 7) ? Math.floor(myCards.length / 2) : 0;
    }
    if (phase === 'setupRoad' && snap.current === me) {
      // The settlement I just placed is the one without a road of mine next to it.
      const mineRoads = roads.filter(r => r.owner === me);
      const touches = (v, e) => {
        const ends = [cornerPos(e[0], e[1], e[2]), cornerPos(e[0], e[1], (e[2] + 1) % 6)];
        const p = cornerPos(...v);
        return ends.some(q => Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) < 1e-6);
      };
      const fresh = buildings.find(b => b.owner === me && !mineRoads.some(r => touches(b.vertex, r.edge)));
      snap.lastSetupVertex = fresh ? fresh.vertex : null;
    }
    if (phase === 'steal' && snap.robber) {
      const hex = snap.robber;
      const victims = new Set();
      for (const b of buildings) {
        if (b.owner === me) continue;
        const p = cornerPos(...b.vertex);
        const c = center(hex[0], hex[1]);
        if (Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - 1) < 1e-6 && players[b.owner].handCount > 0) victims.add(b.owner);
      }
      snap.stealFrom = [...victims];
    }
    return snap;
  }
}

module.exports = { ColonistGame, RES, DEV, colonistCorner, colonistEdgeEnds };
