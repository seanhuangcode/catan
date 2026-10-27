/*
 * Headless self-play test: runs many bot-only games through the real rules
 * engine and checks invariants after every action.
 *
 *   node tests/simulate.js [games=200]
 */
'use strict';

require('../js/board.js');
require('../js/game.js');
require('../js/ai.js');

const C = globalThis.Catan;
const R = C.RESOURCES;

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function assert(cond, msg) {
  if (!cond) throw new Error('Invariant failed: ' + msg);
}

function checkBoard() {
  const g = new C.Game({ players: [{ name: 'a' }, { name: 'b' }, { name: 'c' }], rng: mulberry32(1) });
  assert(g.hexes.length === 19, '19 hexes');
  assert(g.vertices.length === 54, '54 vertices, got ' + g.vertices.length);
  assert(g.edges.length === 72, '72 edges, got ' + g.edges.length);
  assert(g.ports.length === 9, '9 ports');
  assert(g.vertices.filter(v => v.port).length === 18, '18 port vertices');
  const counts = {};
  for (const h of g.hexes) counts[h.resource] = (counts[h.resource] || 0) + 1;
  assert(counts.wood === 4 && counts.brick === 3 && counts.sheep === 4 && counts.wheat === 4 && counts.ore === 3 && counts.desert === 1, 'tile counts');
  for (const h of g.hexes) {
    if (h.number === 6 || h.number === 8) {
      for (const n of h.neighbors) assert(![6, 8].includes(g.hexes[n].number), 'red numbers adjacent');
    }
  }
}

function checkInvariants(g) {
  for (const r of R) {
    const held = g.players.reduce((s, p) => s + p.hand[r], 0);
    assert(held + g.bank[r] === 19, `resource conservation for ${r}`);
    assert(g.bank[r] >= 0, 'bank non-negative');
    for (const p of g.players) assert(p.hand[r] >= 0, 'hand non-negative');
  }
  for (const p of g.players) {
    const roads = g.edges.filter(e => e.road === p.id).length;
    const settlements = g.vertices.filter(v => v.building && v.building.player === p.id && v.building.type === 'settlement').length;
    const cities = g.vertices.filter(v => v.building && v.building.player === p.id && v.building.type === 'city').length;
    assert(roads + p.roadsLeft === 15, 'road count');
    assert(settlements + p.settlementsLeft === 5, 'settlement count');
    assert(cities + p.citiesLeft === 4, 'city count');
  }
  for (const v of g.vertices) {
    if (!v.building) continue;
    for (const a of v.adj) assert(!g.vertices[a].building, 'distance rule');
  }
  const devHeld = g.players.reduce((s, p) => s + p.devCards.length, 0);
  assert(devHeld + g.devDeck.length <= 25, 'dev card count');
}

function runGame(seed, nPlayers) {
  const rng = mulberry32(seed);
  const players = [];
  for (let i = 0; i < nPlayers; i++) players.push({ name: 'Bot' + i, isBot: true });
  const g = new C.Game({ players, rng, friendlyRobber: seed % 2 === 0 });
  let steps = 0;
  while (g.phase !== 'gameOver') {
    if (++steps > 30000) throw new Error(`Game ${seed} did not finish (turn ${g.turn}, phase ${g.phase})`);
    if (g.turn > 1500) throw new Error(`Game ${seed} stalled at turn ${g.turn}`);
    if (g.phase === 'discard') {
      for (const pid of g.pendingActors()) {
        const res = g.perform(pid, { type: 'discard', cards: C.AI.chooseDiscard(g, pid, g.discardPending[pid]) });
        assert(res.ok, 'discard failed: ' + res.error);
      }
      checkInvariants(g);
      continue;
    }
    const pid = g.current;
    const a = C.AI.decide(g, pid);
    assert(a, `no action in phase ${g.phase}`);
    if (a.type === 'offer') {
      const accepters = g.players.filter(o => o.id !== pid && C.AI.evaluateTrade(g, o.id, pid, a.give, a.get));
      if (accepters.length) {
        const res = g.perform(pid, { type: 'playerTrade', to: accepters[0].id, give: a.give, get: a.get });
        assert(res.ok, 'trade failed: ' + res.error);
      }
      continue;
    }
    const res = g.perform(pid, a);
    if (!res.ok) throw new Error(`Game ${seed}: ${a.type} failed in ${g.phase}: ${res.error} ${JSON.stringify(a)}`);
    checkInvariants(g);
  }
  assert(g.victoryPoints(g.winner) >= g.vpToWin, 'winner has enough points');
  return g;
}

checkBoard();
const games = Number(process.argv[2]) || 200;
let turns = 0;
const wins = {};
for (let i = 1; i <= games; i++) {
  const g = runGame(i, i % 3 === 0 ? 3 : 4);
  turns += g.turn;
  wins[g.winner] = (wins[g.winner] || 0) + 1;
}
console.log(`OK: ${games} games, average ${(turns / games).toFixed(1)} turns, wins by seat ${JSON.stringify(wins)}`);
