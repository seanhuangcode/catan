/*
 * Tests for the bridge snapshot format:
 *   - a game rebuilt from a snapshot gives the policy exactly the same
 *     observation and legal moves as the real game
 *   - full games can be played where one seat only ever sees snapshots
 *
 *   node tests/bridge.test.js
 */
'use strict';

const { C, RL, HeuristicAgent, playGame, mulberry32 } = require('../rl/selfplay.js');
require('../bridge/snapshot.js');
const B = C.Bridge;

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

// Snapshot round trip: compare observation + mask at many decision points.
{
  let compared = 0;
  let firstDiff = null;
  const compare = (game, me, ctx) => {
    if (firstDiff) return;
    const snap = JSON.parse(JSON.stringify(B.toSnapshot(game, me)));
    const g2 = B.buildGame(snap);
    const o1 = RL.encode(game, me, ctx);
    const o2 = RL.encode(g2, me, ctx);
    const m1 = RL.legalMask(game, me, ctx);
    const m2 = RL.legalMask(g2, me, ctx);
    for (let i = 0; i < o1.length; i++) {
      if (Math.abs(o1[i] - o2[i]) > 1e-6) { firstDiff = `obs[${i}] ${o1[i]} vs ${o2[i]} in ${game.phase}`; return; }
    }
    for (let i = 0; i < m1.length; i++) {
      if (m1[i] !== m2[i]) { firstDiff = `mask[${RL.describe(i)}] ${m1[i]} vs ${m2[i]} in ${game.phase}`; return; }
    }
    compared++;
  };
  class Probe extends HeuristicAgent {
    act(game, me, ctx) { compare(game, me, ctx); return super.act(game, me, ctx); }
    discard(game, me, n, ctx) { compare(game, me, ctx); return super.discard(game, me, n, ctx); }
  }
  for (let s = 1; s <= 12; s++) playGame([0, 1, 2, 3].map(() => new Probe()), { rng: mulberry32(s) });
  check(`snapshot round trip matches observation and legal moves (${compared} states)`, !firstDiff && compared > 1000, firstDiff);
}

// Full games where seat 0 decides only from snapshots and its moves are mapped back.
{
  class SnapshotSeat {
    constructor(net, rng) { this.kind = 'policy'; this.agent = new RL.PolicyAgent(net, { rng }); this.ctx = RL.newContext(); }
    act(game, me) {
      const move = B.decide(JSON.parse(JSON.stringify(B.toSnapshot(game, me))), this.agent, this.ctx);
      return B.moveToAction(game, move);
    }
    discard(game, me) {
      const move = B.decide(JSON.parse(JSON.stringify(B.toSnapshot(game, me))), this.agent, this.ctx);
      return move.cards;
    }
  }
  let error = null;
  let finished = 0;
  try {
    const net = new RL.Net({ input: RL.OBS_SIZE, hidden: [32], actions: RL.N_ACTIONS }).init(mulberry32(1));
    for (let s = 1; s <= 6; s++) {
      const rng = mulberry32(100 + s);
      const g = playGame([new SnapshotSeat(net, rng), new HeuristicAgent(), new HeuristicAgent(), new HeuristicAgent()], { rng, maxTurns: 120 });
      if (g.phase === 'gameOver') finished++;
    }
  } catch (e) { error = e.message; }
  check('games driven through snapshots never make illegal moves', !error, error);
}

// Calibration math: two tile centers (middle tile and its right neighbor) fix the board transform.
{
  const { geometry } = require('../bridge/driver.js');
  const truth = { cx: 612.5, cy: 401.25, size: 47.3, rot: 0 };
  const toScreen = p => ({ x: truth.cx + p.x * truth.size, y: truth.cy + p.y * truth.size });
  const c = toScreen(geometry.hex([0, 0]));
  const r = toScreen(geometry.hex([1, 0]));
  const hexSize = Math.hypot(r.x - c.x, r.y - c.y) / Math.sqrt(3);
  const rotation = Math.atan2(r.y - c.y, r.x - c.x);
  const est = p => ({ x: c.x + (p.x * Math.cos(rotation) - p.y * Math.sin(rotation)) * hexSize, y: c.y + (p.x * Math.sin(rotation) + p.y * Math.cos(rotation)) * hexSize });
  const v = geometry.vertex([2, -2, 1]);
  const a = toScreen(v);
  const b = est(v);
  check('calibration from two tile centers recovers the board transform', Math.hypot(a.x - b.x, a.y - b.y) < 1e-6);
}

if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log('\nAll bridge tests passed');
