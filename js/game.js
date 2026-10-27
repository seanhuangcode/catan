/*
 * Rules engine. Every state change goes through Game#perform(playerId, action),
 * which validates the action fully before mutating anything. The UI and the
 * bots use the same entry point, so bots can never break the rules.
 *
 * Phases:
 *   setupSettlement -> setupRoad   (snake draft: 1..n, n..1)
 *   preRoll   roll, or play a development card first
 *   discard   everyone holding more than 7 cards discards half (after a 7)
 *   moveRobber -> steal
 *   main      build, trade, buy/play development cards, end turn
 *   roadBuilding  placing the two free roads from a Road Building card
 *   gameOver
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  const R = C.RESOURCES;

  const DEV_POOL = [].concat(
    Array(14).fill('knight'),
    Array(5).fill('victoryPoint'),
    Array(2).fill('roadBuilding'),
    Array(2).fill('yearOfPlenty'),
    Array(2).fill('monopoly')
  );

  C.emptyHand = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
  C.handTotal = h => R.reduce((s, r) => s + ((h && h[r]) || 0), 0);
  C.hasResources = (hand, cost) => R.every(r => (hand[r] || 0) >= ((cost && cost[r]) || 0));

  function need(cond, msg) {
    if (!cond) throw new Error(msg);
  }

  function cleanHand(h) {
    const out = C.emptyHand();
    for (const r of R) {
      const n = Math.floor(Number(h && h[r]) || 0);
      out[r] = n > 0 ? n : 0;
    }
    return out;
  }

  // Log helper: expands a hand into a list of resource tokens for the log.
  function cards(h) {
    const out = [];
    for (const r of R) if (h[r] > 0) out.push({ r, n: h[r] });
    return out;
  }
  C.logCards = cards;

  class Game {
    /**
     * @param {object} opts
     * @param {{name:string,color:string,isBot:boolean}[]} opts.players
     * @param {number} [opts.vpToWin=10]
     * @param {boolean} [opts.friendlyRobber=false]  robber can't target players with <= 2 public VP
     * @param {function} [opts.rng=Math.random]
     */
    constructor(opts) {
      this.rng = opts.rng || Math.random;
      const b = C.generateBoard(this.rng);
      this.hexes = b.hexes;
      this.vertices = b.vertices;
      this.edges = b.edges;
      this.ports = b.ports;
      this.robber = b.robber;
      this.vpToWin = opts.vpToWin || 10;
      this.friendlyRobber = !!opts.friendlyRobber;

      this.players = opts.players.map((p, i) => ({
        id: i,
        name: p.name,
        color: p.color,
        isBot: !!p.isBot,
        hand: C.emptyHand(),
        devCards: [],
        knightsPlayed: 0,
        roadsLeft: 15,
        settlementsLeft: 5,
        citiesLeft: 4,
        roadLength: 0,
      }));
      this.bank = { wood: 19, brick: 19, sheep: 19, wheat: 19, ore: 19 };
      this.devDeck = C.shuffle(DEV_POOL.slice(), this.rng);

      const n = this.players.length;
      this.firstPlayer = Math.floor(this.rng() * n);
      const order = [];
      for (let i = 0; i < n; i++) order.push((this.firstPlayer + i) % n);
      this.setupOrder = order.concat(order.slice().reverse());
      this.setupStep = 0;
      this.current = this.setupOrder[0];
      this.phase = 'setupSettlement';
      this.turn = 0;
      this.dice = null;
      this.rollCount = 0;
      this.devPlayed = false;
      this.discardPending = {};
      this.stealCandidates = [];
      this.afterRobber = 'main';
      this.freeRoads = 0;
      this.afterRoadBuilding = 'main';
      this.lastSetupVertex = null;
      this.longestRoadHolder = null;
      this.largestArmyHolder = null;
      this.winner = null;
      this.lastBuild = null;
      this.diceStats = {};
      for (let s = 2; s <= 12; s++) this.diceStats[s] = 0;

      this.log = [];
      this.listeners = [];
      this.addLog(['Game started. ', { p: this.firstPlayer }, ' goes first.']);
    }

    // ---------------------------------------------------------------- events

    on(fn) { this.listeners.push(fn); }

    emit() { for (const fn of this.listeners) fn(this); }

    /**
     * Adds a log entry. `parts` is visible to everyone; `priv` ({to, parts}) is
     * shown instead to the listed players (e.g. what card was stolen).
     */
    addLog(parts, priv) {
      this.log.push({ id: this.log.length, turn: this.turn, parts, priv: priv || null });
    }

    // --------------------------------------------------------------- actions

    perform(pid, action) {
      try {
        need(this.phase !== 'gameOver', 'The game is over');
        need(action && typeof action.type === 'string', 'Missing action');
        const fn = this['act_' + action.type];
        need(typeof fn === 'function', 'Unknown action: ' + action.type);
        need(this.players[pid], 'Unknown player');
        fn.call(this, pid, action);
      } catch (e) {
        return { ok: false, error: e.message };
      }
      this.emit();
      return { ok: true };
    }

    requireTurn(pid, ...phases) {
      need(pid === this.current, "It's not your turn");
      need(phases.includes(this.phase), "You can't do that right now");
    }

    act_placeSetupSettlement(pid, { vertex }) {
      this.requireTurn(pid, 'setupSettlement');
      need(this.canPlaceSettlement(pid, vertex, true), 'You cannot build a settlement there');
      const p = this.players[pid];
      this.vertices[vertex].building = { player: pid, type: 'settlement' };
      p.settlementsLeft--;
      this.lastSetupVertex = vertex;
      this.lastBuild = { kind: 'vertex', id: vertex, seq: this.log.length };
      this.addLog([{ p: pid }, ' placed a ', { piece: 'settlement', p: pid }]);
      if (this.setupStep >= this.players.length) {
        const got = C.emptyHand();
        for (const h of this.vertices[vertex].hexes) {
          const res = this.hexes[h].resource;
          if (res !== 'desert' && this.bank[res] > got[res]) got[res]++;
        }
        this.giveFromBank(pid, got);
        if (C.handTotal(got) > 0) this.addLog([{ p: pid }, ' received starting resources ', ...cards(got)]);
      }
      this.phase = 'setupRoad';
    }

    act_placeSetupRoad(pid, { edge }) {
      this.requireTurn(pid, 'setupRoad');
      const e = this.edges[edge];
      need(e && e.road === null && e.v.includes(this.lastSetupVertex), 'The road must touch the settlement you just placed');
      const p = this.players[pid];
      e.road = pid;
      p.roadsLeft--;
      this.lastBuild = { kind: 'edge', id: edge, seq: this.log.length };
      this.addLog([{ p: pid }, ' placed a ', { piece: 'road', p: pid }]);
      this.setupStep++;
      this.updateLongestRoad();
      if (this.setupStep >= this.setupOrder.length) {
        this.current = this.firstPlayer;
        this.turn = 1;
        this.phase = 'preRoll';
        this.addLog([{ turnStart: this.current }]);
      } else {
        this.current = this.setupOrder[this.setupStep];
        this.phase = 'setupSettlement';
      }
    }

    act_rollDice(pid, action) {
      this.requireTurn(pid, 'preRoll');
      let d1, d2;
      if (action.dice) {
        [d1, d2] = action.dice;
        need([d1, d2].every(d => Number.isInteger(d) && d >= 1 && d <= 6), 'Invalid dice');
      } else {
        d1 = 1 + Math.floor(this.rng() * 6);
        d2 = 1 + Math.floor(this.rng() * 6);
      }
      const sum = d1 + d2;
      this.dice = [d1, d2];
      this.rollCount++;
      this.diceStats[sum]++;
      this.addLog([{ p: pid }, ' rolled ', { dice: [d1, d2] }]);

      if (sum === 7) {
        this.discardPending = {};
        for (const p of this.players) {
          const t = C.handTotal(p.hand);
          if (t > 7) {
            this.discardPending[p.id] = Math.floor(t / 2);
            this.addLog([{ p: p.id }, ` must discard ${Math.floor(t / 2)} cards`]);
          }
        }
        this.afterRobber = 'main';
        this.phase = Object.keys(this.discardPending).length ? 'discard' : 'moveRobber';
      } else {
        this.produce(sum);
        this.phase = 'main';
      }
    }

    act_discard(pid, { cards: discard }) {
      need(this.phase === 'discard' && this.discardPending[pid], 'You do not need to discard');
      const p = this.players[pid];
      const n = this.discardPending[pid];
      const d = cleanHand(discard);
      need(C.handTotal(d) === n, `You must discard exactly ${n} cards`);
      need(C.hasResources(p.hand, d), "You don't have those cards");
      this.pay(pid, d);
      delete this.discardPending[pid];
      this.addLog([{ p: pid }, ' discarded ', ...cards(d)]);
      if (Object.keys(this.discardPending).length === 0) this.phase = 'moveRobber';
    }

    act_moveRobber(pid, { hex }) {
      this.requireTurn(pid, 'moveRobber');
      need(this.hexes[hex], 'Unknown tile');
      need(hex !== this.robber, 'The robber must move to a different tile');
      need(this.canMoveRobberTo(pid, hex), 'Friendly robber: you cannot target players with 2 or fewer points');
      this.robber = hex;
      const h = this.hexes[hex];
      this.addLog([{ p: pid }, ' moved the robber to ', { tile: h.resource, number: h.number }]);
      const victims = this.robberVictims(pid, hex);
      if (victims.length === 0) {
        this.phase = this.afterRobber;
      } else if (victims.length === 1) {
        this.stealFrom(pid, victims[0]);
        this.phase = this.afterRobber;
      } else {
        this.stealCandidates = victims;
        this.phase = 'steal';
      }
    }

    act_steal(pid, { victim }) {
      this.requireTurn(pid, 'steal');
      need(this.stealCandidates.includes(victim), 'You cannot steal from that player');
      this.stealFrom(pid, victim);
      this.stealCandidates = [];
      this.phase = this.afterRobber;
    }

    act_buildRoad(pid, { edge }) {
      this.requireTurn(pid, 'main');
      const p = this.players[pid];
      need(p.roadsLeft > 0, 'You have no roads left');
      need(C.hasResources(p.hand, C.COSTS.road), 'Not enough resources for a road');
      need(this.canPlaceRoad(pid, edge), 'You cannot build a road there');
      this.pay(pid, C.COSTS.road);
      this.edges[edge].road = pid;
      p.roadsLeft--;
      this.lastBuild = { kind: 'edge', id: edge, seq: this.log.length };
      this.addLog([{ p: pid }, ' built a ', { piece: 'road', p: pid }]);
      this.updateLongestRoad();
      this.checkWin();
    }

    act_buildSettlement(pid, { vertex }) {
      this.requireTurn(pid, 'main');
      const p = this.players[pid];
      need(p.settlementsLeft > 0, 'You have no settlements left');
      need(C.hasResources(p.hand, C.COSTS.settlement), 'Not enough resources for a settlement');
      need(this.canPlaceSettlement(pid, vertex, false), 'You cannot build a settlement there');
      this.pay(pid, C.COSTS.settlement);
      this.vertices[vertex].building = { player: pid, type: 'settlement' };
      p.settlementsLeft--;
      this.lastBuild = { kind: 'vertex', id: vertex, seq: this.log.length };
      this.addLog([{ p: pid }, ' built a ', { piece: 'settlement', p: pid }]);
      this.updateLongestRoad(); // a settlement can cut an opponent's road
      this.checkWin();
    }

    act_buildCity(pid, { vertex }) {
      this.requireTurn(pid, 'main');
      const p = this.players[pid];
      const v = this.vertices[vertex];
      need(p.citiesLeft > 0, 'You have no cities left');
      need(C.hasResources(p.hand, C.COSTS.city), 'Not enough resources for a city');
      need(v && v.building && v.building.player === pid && v.building.type === 'settlement', 'Cities must upgrade one of your settlements');
      this.pay(pid, C.COSTS.city);
      v.building.type = 'city';
      p.citiesLeft--;
      p.settlementsLeft++;
      this.lastBuild = { kind: 'vertex', id: vertex, seq: this.log.length };
      this.addLog([{ p: pid }, ' built a ', { piece: 'city', p: pid }]);
      this.checkWin();
    }

    act_buyDevCard(pid) {
      this.requireTurn(pid, 'main');
      const p = this.players[pid];
      need(this.devDeck.length > 0, 'No development cards left');
      need(C.hasResources(p.hand, C.COSTS.dev), 'Not enough resources for a development card');
      this.pay(pid, C.COSTS.dev);
      const type = this.devDeck.pop();
      p.devCards.push({ type, turnBought: this.turn });
      this.addLog(
        [{ p: pid }, ' bought a ', { d: 'hidden' }],
        { to: [pid], parts: [{ p: pid }, ' bought ', { d: type }] }
      );
      this.checkWin();
    }

    // Validates that `type` can be played now and returns its index in the hand.
    findPlayableDev(pid, type) {
      this.requireTurn(pid, 'preRoll', 'main');
      need(!this.devPlayed, 'You can only play one development card per turn');
      const idx = this.players[pid].devCards.findIndex(c => c.type === type && c.turnBought < this.turn);
      need(idx >= 0, `You have no ${C.DEV_NAMES[type]} card you can play this turn`);
      return idx;
    }

    consumeDev(pid, idx) {
      const card = this.players[pid].devCards.splice(idx, 1)[0];
      this.devPlayed = true;
      this.addLog([{ p: pid }, ' played ', { d: card.type }]);
    }

    act_playKnight(pid) {
      const idx = this.findPlayableDev(pid, 'knight');
      this.consumeDev(pid, idx);
      this.players[pid].knightsPlayed++;
      this.afterRobber = this.phase;
      this.phase = 'moveRobber';
      this.updateLargestArmy();
      this.checkWin();
    }

    act_playRoadBuilding(pid) {
      const idx = this.findPlayableDev(pid, 'roadBuilding');
      const p = this.players[pid];
      need(p.roadsLeft > 0, 'You have no roads left');
      need(this.validRoadSpots(pid).length > 0, 'There is nowhere to build a road');
      this.consumeDev(pid, idx);
      this.freeRoads = Math.min(2, p.roadsLeft);
      this.afterRoadBuilding = this.phase;
      this.phase = 'roadBuilding';
    }

    act_placeFreeRoad(pid, { edge }) {
      this.requireTurn(pid, 'roadBuilding');
      need(this.canPlaceRoad(pid, edge), 'You cannot build a road there');
      const p = this.players[pid];
      this.edges[edge].road = pid;
      p.roadsLeft--;
      this.freeRoads--;
      this.lastBuild = { kind: 'edge', id: edge, seq: this.log.length };
      this.addLog([{ p: pid }, ' built a ', { piece: 'road', p: pid }]);
      this.updateLongestRoad();
      this.checkWin();
      if (this.phase !== 'gameOver' && (this.freeRoads <= 0 || p.roadsLeft === 0 || this.validRoadSpots(pid).length === 0)) {
        this.freeRoads = 0;
        this.phase = this.afterRoadBuilding;
      }
    }

    act_playYearOfPlenty(pid, { resources }) {
      const idx = this.findPlayableDev(pid, 'yearOfPlenty');
      need(Array.isArray(resources) && resources.length === 2 && resources.every(r => R.includes(r)), 'Choose two resources');
      const want = C.emptyHand();
      for (const r of resources) want[r]++;
      need(R.every(r => this.bank[r] >= want[r]), 'The bank does not have those resources');
      this.consumeDev(pid, idx);
      this.giveFromBank(pid, want);
      this.addLog([{ p: pid }, ' took ', ...cards(want), ' from the bank']);
    }

    act_playMonopoly(pid, { resource }) {
      const idx = this.findPlayableDev(pid, 'monopoly');
      need(R.includes(resource), 'Choose a resource');
      this.consumeDev(pid, idx);
      const p = this.players[pid];
      let total = 0;
      for (const o of this.players) {
        if (o.id === pid) continue;
        total += o.hand[resource];
        p.hand[resource] += o.hand[resource];
        o.hand[resource] = 0;
      }
      this.addLog([{ p: pid }, ` took ${total} `, { r: resource, n: 1, plain: true }, ' from everyone']);
    }

    act_bankTrade(pid, { give, get }) {
      this.requireTurn(pid, 'main');
      const p = this.players[pid];
      const g = cleanHand(give);
      const w = cleanHand(get);
      let credits = 0;
      for (const r of R) {
        if (!g[r]) continue;
        need(!w[r], 'You cannot trade a resource for itself');
        const ratio = this.tradeRatio(pid, r);
        need(g[r] % ratio === 0, `You must give ${C.RES_NAMES[r]} in multiples of ${ratio}`);
        credits += g[r] / ratio;
      }
      need(C.hasResources(p.hand, g), "You don't have those cards");
      const want = C.handTotal(w);
      need(want > 0 && want === credits, 'That trade is not balanced');
      need(C.hasResources(this.bank, w), 'The bank does not have those resources');
      this.pay(pid, g);
      this.giveFromBank(pid, w);
      this.addLog([{ p: pid }, ' gave the bank ', ...cards(g), ' and got ', ...cards(w)]);
    }

    act_playerTrade(pid, { to, give, get }) {
      this.requireTurn(pid, 'main');
      need(to !== pid && this.players[to], 'Invalid trade partner');
      const g = cleanHand(give);
      const w = cleanHand(get);
      need(C.handTotal(g) > 0 && C.handTotal(w) > 0, 'Both sides must give something');
      need(R.every(r => !(g[r] && w[r])), 'You cannot trade a resource for itself');
      const p = this.players[pid];
      const o = this.players[to];
      need(C.hasResources(p.hand, g), "You don't have those cards");
      need(C.hasResources(o.hand, w), `${o.name} doesn't have those cards`);
      for (const r of R) {
        p.hand[r] += w[r] - g[r];
        o.hand[r] += g[r] - w[r];
      }
      this.addLog([{ p: pid }, ' gave ', ...cards(g), ' and got ', ...cards(w), ' from ', { p: to }]);
    }

    act_endTurn(pid) {
      this.requireTurn(pid, 'main');
      this.turn++;
      this.current = (this.current + 1) % this.players.length;
      this.devPlayed = false;
      this.phase = 'preRoll';
      this.addLog([{ turnStart: this.current }]);
      this.checkWin(); // e.g. longest road gained on someone else's turn
    }

    // --------------------------------------------------------------- helpers

    pay(pid, cost) {
      const p = this.players[pid];
      for (const r of R) {
        const c = cost[r] || 0;
        p.hand[r] -= c;
        this.bank[r] += c;
      }
    }

    giveFromBank(pid, h) {
      const p = this.players[pid];
      for (const r of R) {
        const c = h[r] || 0;
        p.hand[r] += c;
        this.bank[r] -= c;
      }
    }

    produce(sum) {
      const n = this.players.length;
      const owed = {};
      for (const r of R) owed[r] = new Array(n).fill(0);
      for (const h of this.hexes) {
        if (h.number !== sum || h.id === this.robber) continue;
        for (const vid of h.vertices) {
          const b = this.vertices[vid].building;
          if (b) owed[h.resource][b.player] += b.type === 'city' ? 2 : 1;
        }
      }
      const gains = this.players.map(() => C.emptyHand());
      for (const r of R) {
        const total = owed[r].reduce((a, b) => a + b, 0);
        if (!total) continue;
        const owners = owed[r].map((x, i) => (x > 0 ? i : -1)).filter(i => i >= 0);
        if (total <= this.bank[r]) {
          for (const i of owners) gains[i][r] = owed[r][i];
        } else if (owners.length === 1) {
          gains[owners[0]][r] = this.bank[r];
        } else {
          this.addLog(['The bank ran out of ', { r, n: 1, plain: true }, ' — nobody receives it']);
        }
      }
      let any = false;
      gains.forEach((g, i) => {
        if (C.handTotal(g) > 0) {
          any = true;
          this.giveFromBank(i, g);
          this.addLog([{ p: i }, ' got ', ...cards(g)]);
        }
      });
      if (!any) this.addLog(['No one got any resources']);
    }

    robberVictims(pid, hex) {
      const out = [];
      for (const vid of this.hexes[hex].vertices) {
        const b = this.vertices[vid].building;
        if (b && b.player !== pid && !out.includes(b.player) && C.handTotal(this.players[b.player].hand) > 0) out.push(b.player);
      }
      return out;
    }

    canMoveRobberTo(pid, hex) {
      if (hex === this.robber || !this.hexes[hex]) return false;
      if (!this.friendlyRobber) return true;
      const protectedHere = this.hexes[hex].vertices.some(vid => {
        const b = this.vertices[vid].building;
        return b && b.player !== pid && this.victoryPoints(b.player, false) <= 2;
      });
      if (!protectedHere) return true;
      // If every tile is protected, the robber may go anywhere.
      return !this.hexes.some(h => h.id !== this.robber && !h.vertices.some(vid => {
        const b = this.vertices[vid].building;
        return b && b.player !== pid && this.victoryPoints(b.player, false) <= 2;
      }));
    }

    validRobberHexes(pid) {
      return this.hexes.filter(h => this.canMoveRobberTo(pid, h.id)).map(h => h.id);
    }

    stealFrom(thief, victim) {
      const pool = [];
      const vh = this.players[victim].hand;
      for (const r of R) for (let i = 0; i < vh[r]; i++) pool.push(r);
      if (!pool.length) return;
      const r = pool[Math.floor(this.rng() * pool.length)];
      vh[r]--;
      this.players[thief].hand[r]++;
      this.addLog(
        [{ p: thief }, ' stole a card from ', { p: victim }],
        { to: [thief, victim], parts: [{ p: thief }, ' stole ', { r, n: 1 }, ' from ', { p: victim }] }
      );
    }

    tradeRatio(pid, res) {
      let ratio = 4;
      for (const v of this.vertices) {
        if (!v.port || !v.building || v.building.player !== pid) continue;
        if (v.port === res) return 2;
        if (v.port === 'any') ratio = 3;
      }
      return ratio;
    }

    canPlaceSettlement(pid, vid, setup) {
      const v = this.vertices[vid];
      if (!v || v.building) return false;
      if (v.adj.some(a => this.vertices[a].building)) return false;
      if (setup) return true;
      return v.edges.some(e => this.edges[e].road === pid);
    }

    canPlaceRoad(pid, eid) {
      const e = this.edges[eid];
      if (!e || e.road !== null) return false;
      return e.v.some(vid => {
        const v = this.vertices[vid];
        if (v.building) return v.building.player === pid;
        return v.edges.some(x => x !== eid && this.edges[x].road === pid);
      });
    }

    validSettlementSpots(pid, setup) {
      return this.vertices.filter(v => this.canPlaceSettlement(pid, v.id, setup)).map(v => v.id);
    }

    validRoadSpots(pid) {
      if (this.phase === 'setupRoad') {
        return this.vertices[this.lastSetupVertex].edges.filter(e => this.edges[e].road === null);
      }
      return this.edges.filter(e => this.canPlaceRoad(pid, e.id)).map(e => e.id);
    }

    validCitySpots(pid) {
      return this.vertices
        .filter(v => v.building && v.building.player === pid && v.building.type === 'settlement')
        .map(v => v.id);
    }

    computeRoadLength(pid) {
      let best = 0;
      const used = new Set();
      const dfs = (vid, len) => {
        if (len > best) best = len;
        const v = this.vertices[vid];
        if (len > 0 && v.building && v.building.player !== pid) return; // road is cut here
        for (const eid of v.edges) {
          const e = this.edges[eid];
          if (e.road !== pid || used.has(eid)) continue;
          used.add(eid);
          dfs(e.v[0] === vid ? e.v[1] : e.v[0], len + 1);
          used.delete(eid);
        }
      };
      const starts = new Set();
      for (const e of this.edges) if (e.road === pid) { starts.add(e.v[0]); starts.add(e.v[1]); }
      for (const s of starts) dfs(s, 0);
      return best;
    }

    updateLongestRoad() {
      const lens = this.players.map(p => (p.roadLength = this.computeRoadLength(p.id)));
      const holder = this.longestRoadHolder;
      const max = Math.max(...lens);
      let next;
      if (holder !== null && lens[holder] >= max && lens[holder] >= 5) {
        next = holder;
      } else {
        const leaders = lens.map((l, i) => (l === max && l >= 5 ? i : -1)).filter(i => i >= 0);
        next = leaders.length === 1 ? leaders[0] : null;
      }
      if (next !== holder) {
        this.longestRoadHolder = next;
        if (next !== null) this.addLog([{ p: next }, ' took ', { award: 'longestRoad' }]);
        else this.addLog([{ award: 'longestRoad' }, ' is no longer held by anyone']);
      }
    }

    updateLargestArmy() {
      const h = this.largestArmyHolder;
      const holderKnights = h === null ? 2 : this.players[h].knightsPlayed;
      for (const p of this.players) {
        if (p.id !== h && p.knightsPlayed >= 3 && p.knightsPlayed > holderKnights) {
          this.largestArmyHolder = p.id;
          this.addLog([{ p: p.id }, ' took ', { award: 'largestArmy' }]);
          return;
        }
      }
    }

    victoryPoints(pid, includeHidden = true) {
      const p = this.players[pid];
      let vp = (5 - p.settlementsLeft) + 2 * (4 - p.citiesLeft);
      if (this.longestRoadHolder === pid) vp += 2;
      if (this.largestArmyHolder === pid) vp += 2;
      if (includeHidden) vp += p.devCards.filter(c => c.type === 'victoryPoint').length;
      return vp;
    }

    checkWin() {
      if (this.phase === 'gameOver' || this.turn < 1) return;
      const pid = this.current;
      const vp = this.victoryPoints(pid);
      if (vp >= this.vpToWin) {
        this.winner = pid;
        this.phase = 'gameOver';
        this.addLog([{ p: pid }, ` won the game with ${vp} victory points!`]);
      }
    }

    /** Players who must act right now (several during a discard). */
    pendingActors() {
      if (this.phase === 'gameOver') return [];
      if (this.phase === 'discard') return Object.keys(this.discardPending).map(Number);
      return [this.current];
    }
  }

  C.RES_NAMES = { wood: 'Lumber', brick: 'Brick', sheep: 'Wool', wheat: 'Grain', ore: 'Ore' };
  C.DEV_NAMES = {
    knight: 'Knight',
    victoryPoint: 'Victory Point',
    roadBuilding: 'Road Building',
    yearOfPlenty: 'Year of Plenty',
    monopoly: 'Monopoly',
  };
  C.Game = Game;
})(Catan);
