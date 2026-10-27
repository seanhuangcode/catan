/*
 * Tests for the RL stack:
 *   - analytic gradients match numerical gradients
 *   - every action the legality mask allows is accepted by the engine
 *   - the heuristic bot's moves map onto the action space
 *   - model export/import round-trips
 *
 *   node tests/rl.test.js
 */
'use strict';

const { C, RL, HeuristicAgent, playGame, mulberry32 } = require('../rl/selfplay.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

// ------------------------------------------------------------ gradient check
{
  const rng = mulberry32(7);
  const net = new RL.Net({ input: 30, hidden: [12, 9], actions: 6 }).init(rng);
  for (let i = 0; i < net.size; i++) net.params[i] += (rng() - 0.5) * 0.2; // non-zero biases too
  const idx = Uint16Array.from([1, 4, 9, 17, 22, 29]);
  const val = Float32Array.from([0.5, -1.2, 0.8, 1.0, 0.3, -0.4]);
  const cL = Float32Array.from([0.3, -0.7, 1.1, 0.2, -0.5, 0.9]);
  const cV = -0.6;
  const loss = () => {
    net.forward(idx, val);
    let s = cV * net.value;
    for (let j = 0; j < 6; j++) s += cL[j] * net.logits[j];
    return s;
  };
  const grads = new Float32Array(net.size);
  loss();
  net.backward(idx, val, cL, cV, grads);
  let worst = 0;
  for (let i = 0; i < net.size; i++) {
    const old = net.params[i];
    const eps = 1e-2;
    net.params[i] = old + eps;
    const up = loss();
    net.params[i] = old - eps;
    const down = loss();
    net.params[i] = old;
    const num = (up - down) / (2 * eps);
    const err = Math.abs(num - grads[i]) / Math.max(1e-3, Math.abs(num) + Math.abs(grads[i]));
    // ReLU kinks make a few finite differences meaningless; ignore tiny gradients.
    if (Math.abs(num) > 1e-3 || Math.abs(grads[i]) > 1e-3) worst = Math.max(worst, err);
  }
  check('gradient check', worst < 2e-2, `worst relative error ${worst.toFixed(4)}`);
}

// ------------------------------------------- gradient check, pointer heads
{
  const rng = mulberry32(11);
  const net = new RL.Net({ input: RL.OBS_SIZE, hidden: [10, 8], actions: RL.N_ACTIONS, pointers: true }).init(rng);
  for (let i = 0; i < net.size; i++) net.params[i] += (rng() - 0.5) * 0.1;
  const g = playGame([0, 1, 2, 3].map(() => new HeuristicAgent()), { rng: mulberry32(2), maxTurns: 25 });
  const sp = RL.sparsify(RL.encode(g, 0, RL.newContext()));
  const cL = new Float32Array(RL.N_ACTIONS).map(() => rng() - 0.5);
  const loss = () => {
    net.forward(sp.idx, sp.val);
    let s = 0.4 * net.value;
    for (let j = 0; j < cL.length; j++) s += cL[j] * net.logits[j];
    return s;
  };
  const grads = new Float32Array(net.size);
  loss();
  net.backward(sp.idx, sp.val, cL, 0.4, grads);
  // Check every pointer-head parameter plus a sample of the rest.
  const ids = [];
  const firstPointer = net.groups[0].layer.w;
  for (let i = firstPointer; i < net.size; i++) ids.push(i);
  for (let k = 0; k < 600; k++) ids.push(Math.floor(rng() * firstPointer));
  let worst = 0;
  for (const i of ids) {
    const old = net.params[i];
    net.params[i] = old + 1e-2;
    const up = loss();
    net.params[i] = old - 1e-2;
    const down = loss();
    net.params[i] = old;
    const num = (up - down) / 2e-2;
    if (Math.abs(num) > 1e-3 || Math.abs(grads[i]) > 1e-3) {
      worst = Math.max(worst, Math.abs(num - grads[i]) / Math.max(1e-3, Math.abs(num) + Math.abs(grads[i])));
    }
  }
  check('gradient check with pointer heads', worst < 2e-2, `worst relative error ${worst.toFixed(4)}`);
}

// --------------------------------------------- legal actions always accepted
{
  class RandomAgent {
    constructor(rng) { this.kind = 'policy'; this.rng = rng; }
    pick(game, me, ctx) {
      const mask = RL.legalMask(game, me, ctx);
      const legal = [];
      for (let a = 0; a < mask.length; a++) if (mask[a]) legal.push(a);
      if (!legal.length) throw new Error(`No legal actions in ${game.phase}`);
      // Bias toward ending the turn so random games make progress.
      if (mask[RL.A.END] && this.rng() < 0.3) return RL.A.END;
      return legal[Math.floor(this.rng() * legal.length)];
    }
    act(game, me, ctx) { return RL.toAction(game, me, this.pick(game, me, ctx)); }
    respond(game, me, from, offer, ctx) {
      ctx.respondTo = { from, give: offer.give, get: offer.get };
      const a = this.pick(game, me, ctx);
      ctx.respondTo = null;
      return a === RL.A.RESPOND;
    }
    discard(game, me, n, ctx) {
      ctx.discardSel = C.emptyHand();
      for (let k = 0; k < n; k++) ctx.discardSel[C.RESOURCES[this.pick(game, me, ctx) - RL.A.DISCARD]]++;
      const cards = ctx.discardSel;
      ctx.discardSel = null;
      return cards;
    }
  }
  let error = null;
  let games = 0;
  try {
    for (let s = 1; s <= 40; s++) {
      const rng = mulberry32(s);
      const n = s % 4 === 0 ? 3 : 4;
      const agents = [];
      for (let i = 0; i < n; i++) agents.push(i % 2 === 0 || s % 3 === 0 ? new RandomAgent(rng) : new HeuristicAgent());
      playGame(agents, { rng, maxTurns: 150 });
      games++;
    }
  } catch (e) { error = e.message; }
  check('random legal actions are always accepted (40 games)', !error, error);

  // Same with an untrained network choosing.
  try {
    const net = new RL.Net({ input: RL.OBS_SIZE, hidden: [32], actions: RL.N_ACTIONS }).init(mulberry32(3));
    const rng = mulberry32(99);
    for (let s = 0; s < 5; s++) {
      playGame([0, 1, 2, 3].map(() => new RL.PolicyAgent(net, { rng })), { rng, maxTurns: 80 });
    }
    check('untrained policy plays without illegal moves', true);
  } catch (e) { check('untrained policy plays without illegal moves', false, e.message); }
}

// ------------------------------------------ heuristic moves map to actions
{
  let labels = 0;
  const agents = [0, 1, 2, 3].map(() => new HeuristicAgent({ onStep: () => labels++ }));
  for (let s = 1; s <= 20; s++) playGame(agents, { rng: mulberry32(s) });
  const mismatches = agents.reduce((a, g) => a + g.mismatches, 0);
  check('heuristic moves map onto legal actions', labels > 1000 && mismatches / labels < 0.002, `${labels} labels, ${mismatches} mismatches`);
}

// ------------------------------------------------------- export / import
{
  const net = new RL.Net({ input: 50, hidden: [16], actions: 7 }).init(mulberry32(5));
  const back32 = RL.importModel(JSON.parse(JSON.stringify(RL.exportModel(net, 'float32'))));
  const same = net.params.every((x, i) => x === back32.params[i]);
  const back16 = RL.importModel(JSON.parse(JSON.stringify(RL.exportModel(net, 'float16'))));
  let maxErr = 0;
  net.params.forEach((x, i) => { maxErr = Math.max(maxErr, Math.abs(x - back16.params[i]) / Math.max(1e-4, Math.abs(x))); });
  check('float32 export round-trips exactly', same);
  check('float16 export round-trips within 0.1%', maxErr < 1e-3, `max relative error ${maxErr}`);
}

if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll RL tests passed');
