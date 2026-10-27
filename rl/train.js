#!/usr/bin/env node
/*
 * Training entry point.
 *
 *   node rl/train.js imitation [--samples 1500000] [--pointers] [--init ckpt] [--dagger 0.5 | --teacher search] [--out ...]
 *   node rl/train.js ppo --init rl/checkpoints/imitation [--iters 200] [--out rl/checkpoints/ppo]
 *   node rl/train.js eval rl/checkpoints/ppo [--games 1000]
 *   node rl/train.js export rl/checkpoints/ppo [--to models/catan-policy.js]
 *
 * Stage 1 (imitation) teaches the network to copy the hand-written bot, which
 * gives PPO a competent starting point. Stage 2 (ppo) improves it with
 * reinforcement learning against the bots, itself, and past versions of itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const { RL, concat } = require('./selfplay.js');

// ------------------------------------------------------------------- CLI

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else { args[key] = isNaN(Number(next)) ? next : Number(next); i++; }
    } else args._.push(a);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

const HP = {
  hidden: String(args.hidden || '256,256').split(',').map(Number),
  workers: args.workers || Math.max(1, os.cpus().length),
  gamma: 0.997,
  lambda: 0.95,
  shaping: args.shaping !== undefined ? args.shaping : 1.0,
  clip: 0.2,
  entropy: args.entropy !== undefined ? args.entropy : 0.003,
  valueCoef: 0.5,
  maxTurns: 300,
};

// ----------------------------------------------------------- checkpoints

function save(file, net, meta) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.bin', Buffer.from(net.params.buffer, net.params.byteOffset, net.params.byteLength));
  fs.writeFileSync(file + '.json', JSON.stringify(Object.assign({ config: net.config }, meta), null, 2));
}

function load(file) {
  const meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
  const buf = fs.readFileSync(file + '.bin');
  const params = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return { meta, config: meta.config, params };
}

/** A checkpoint's config updated to the current observation and action sizes. */
function currentConfig(config) {
  return Object.assign({}, config, { input: RL.OBS_SIZE, actions: RL.N_ACTIONS });
}

/** Loads a checkpoint into `net`, migrating it if the inputs or actions have grown since. */
function initFrom(net, file) {
  const ck = load(file);
  const src = new RL.Net(ck.config, ck.params);
  if (src.size === net.size && ck.config.input === net.config.input && ck.config.actions === net.config.actions && !!ck.config.pointers === !!net.config.pointers) {
    net.params.set(ck.params);
  } else {
    RL.transplant(src, net);
    console.log(`Migrated ${file} (${ck.config.input} inputs, ${ck.config.actions} actions) to ${net.config.input} inputs, ${net.config.actions} actions${net.config.pointers ? ', pointer heads' : ''}`);
  }
}

/** A Net whose weights live in a SharedArrayBuffer visible to the workers. */
function sharedNet(config, params) {
  const size = new RL.Net(config).size;
  const net = new RL.Net(config, new Float32Array(new SharedArrayBuffer(4 * size)));
  if (params) net.params.set(params);
  return net;
}

// ----------------------------------------------------------- worker pool

class Pool {
  constructor(n, net) {
    this.workers = [];
    this.grads = [];
    for (let i = 0; i < n; i++) {
      const g = new SharedArrayBuffer(4 * net.size);
      const w = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { config: net.config, params: net.params.buffer, grads: g },
      });
      w.queue = [];
      w.on('message', msg => {
        const { resolve, reject } = w.queue.shift();
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error));
      });
      w.on('error', e => { for (const q of w.queue) q.reject(e); });
      this.workers.push(w);
      this.grads.push(new Float32Array(g));
    }
  }

  get size() { return this.workers.length; }

  call(i, msg) {
    const w = this.workers[i];
    return new Promise((resolve, reject) => {
      w.queue.push({ resolve, reject });
      w.postMessage(msg);
    });
  }

  each(fn) { return Promise.all(this.workers.map((_, i) => this.call(i, fn(i)))); }

  close() { for (const w of this.workers) w.terminate(); }

  /** Sums the gradients for `ids` computed across all workers into `out`. */
  async gradients(ids, mode, hp, out) {
    const per = Math.ceil(ids.length / this.size);
    const res = await this.each(i => ({ type: 'grads', ids: ids.slice(i * per, (i + 1) * per), mode, hp }));
    out.fill(0);
    for (const g of this.grads) for (let k = 0; k < out.length; k++) out[k] += g[k];
    const st = {};
    for (const r of res) for (const [k, v] of Object.entries(r.stats)) st[k] = (st[k] || 0) + v;
    return st;
  }

  async evaluate(games, opts = {}) {
    const per = Math.ceil(games / this.size);
    const seed = opts.seed || 1e6;
    const res = await this.each(i => ({ type: 'evaluate', games: per, seed: seed + i, greedy: opts.greedy !== false, maxTurns: HP.maxTurns, players: opts.players }));
    const st = { games: 0, wins: 0, vp: 0, turns: 0, capped: 0 };
    for (const r of res) for (const k of Object.keys(st)) st[k] += r.stats[k];
    st.winRate = st.wins / st.games;
    // 95% confidence half-width (normal approximation).
    st.ci = 1.96 * Math.sqrt(st.winRate * (1 - st.winRate) / st.games);
    st.avgVp = st.vp / st.games;
    st.avgTurns = st.turns / st.games;
    return st;
  }
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Parameters a run may change, as a 0/1 mask (or null for all). With
 * --only respond, only the accept/decline outputs train; everything the rest
 * of the policy depends on stays frozen.
 */
function trainableMask(net) {
  if (args.only !== 'respond') return null;
  const mask = new Uint8Array(net.size);
  const l = net.policy;
  for (let a = RL.A.RESPOND; a < RL.A.RESPOND + 2; a++) {
    for (let i = 0; i < l.nIn; i++) mask[l.w + i * l.nOut + a] = 1;
    mask[l.b + a] = 1;
  }
  return mask;
}

async function trainOnBatch(pool, net, adam, batch, mode, opts) {
  await pool.each(() => ({ type: 'setBatch', batch }));
  const grads = new Float32Array(net.size);
  const total = {};
  for (let epoch = 0; epoch < opts.epochs; epoch++) {
    const ids = shuffle(Array.from({ length: batch.n }, (_, i) => i));
    for (let s = 0; s < ids.length; s += opts.minibatch) {
      const mb = ids.slice(s, s + opts.minibatch);
      const st = await pool.gradients(mb, mode, HP, grads);
      if (opts.trainable) for (let k = 0; k < grads.length; k++) if (!opts.trainable[k]) grads[k] = 0;
      adam.step(net.params, grads, mb.length);
      for (const [k, v] of Object.entries(st)) total[k] = (total[k] || 0) + v;
    }
  }
  const n = total.n || 1;
  return {
    policyLoss: total.policyLoss / n,
    valueLoss: total.valueLoss / n,
    entropy: total.entropy / n,
    accuracy: total.correct / n,
    clipFrac: total.clipped / n,
    kl: total.kl / n,
  };
}

function fmtEval(e) {
  return `win ${(100 * e.winRate).toFixed(1)}% ±${(100 * e.ci).toFixed(1)} vs heuristic bots (avg VP ${e.avgVp.toFixed(2)}, ${e.games} games, ${e.capped} hit turn cap)`;
}

function logLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

// ------------------------------------------------------------- commands

async function imitation() {
  const out = args.out || 'rl/checkpoints/imitation';
  const target = args.samples || 1500000;
  const config = { input: RL.OBS_SIZE, hidden: HP.hidden, actions: RL.N_ACTIONS, pointers: !!args.pointers };
  const net = sharedNet(config);
  net.init();
  if (args.init) initFrom(net, args.init);
  const adam = new RL.Adam(net.size, { lr: args.lr || 1e-3 });
  const pool = new Pool(HP.workers, net);
  const logFile = out + '.log.jsonl';
  const gamesPerWorker = args.games || 25;
  const trainable = trainableMask(net);
  let seen = 0;
  let round = 0;
  let best = -1;
  const t0 = Date.now();
  console.log(`Imitation learning: ${net.size.toLocaleString()} parameters, ${HP.workers} workers, target ${target.toLocaleString()} samples`);
  while (seen < target) {
    round++;
    const res = await pool.each(i => ({ type: 'imitation', games: gamesPerWorker, seed: (args.seed || 0) + round * 1000 + i, hp: HP, dagger: args.dagger || 0, teacher: args.teacher, topK: args.topK, only: args.only }));
    const batch = concat(res.map(r => r.batch));
    // Decay the learning rate over the run.
    adam.lr = (args.lr || 1e-3) * Math.max(0.1, 1 - seen / target);
    const st = await trainOnBatch(pool, net, adam, batch, 'bc', { epochs: 1, minibatch: args.minibatch || 512, trainable });
    seen += batch.n;
    const secs = (Date.now() - t0) / 1000;
    const line = { round, samples: seen, secs, lr: adam.lr, ...st };
    console.log(`round ${round}: ${seen.toLocaleString()} samples, loss ${st.policyLoss.toFixed(3)}, accuracy ${(100 * st.accuracy).toFixed(1)}%, value loss ${st.valueLoss.toFixed(4)} [${secs.toFixed(0)}s]`);
    if (round % (args.evalEvery || 10) === 0 || seen >= target) {
      const ev = await pool.evaluate(args.evalGames || 400, { seed: 777 });
      line.eval = ev;
      console.log('  eval: ' + fmtEval(ev));
      if (ev.winRate > best) {
        best = ev.winRate;
        save(out, net, { kind: 'imitation', samples: seen, eval: ev, hp: HP });
        console.log(`  saved ${out}`);
      }
    }
    logLine(logFile, line);
  }
  pool.close();
}

async function ppo() {
  if (!args.init) throw new Error('--init <checkpoint> is required (run imitation first)');
  const out = args.out || 'rl/checkpoints/ppo';
  const init = load(args.init);
  const net = sharedNet(currentConfig(init.config));
  initFrom(net, args.init);
  const lr = args.lr || 1e-4;
  const adam = new RL.Adam(net.size, { lr, clip: 0.5 });
  const pool = new Pool(HP.workers, net);
  const logFile = out + '.log.jsonl';
  const iters = args.iters || 200;
  const gamesPerWorker = args.games || 24;
  const mix = { heuristic: args.mixHeuristic !== undefined ? args.mixHeuristic : 0.5, self: args.mixSelf !== undefined ? args.mixSelf : 0.3 };
  const evalEvery = args.evalEvery || 10;
  const t0 = Date.now();
  let snapId = 0;
  const pushSnapshot = () => pool.each(() => ({ type: 'snapshot', id: snapId, params: net.params.slice(), keep: 8 })).then(() => snapId++);

  console.log(`PPO from ${args.init}: ${HP.workers} workers, ${gamesPerWorker * HP.workers} games/iteration, lr ${lr}`);
  const base = await pool.evaluate(args.evalGames || 600, { seed: 4242 });
  console.log('start eval: ' + fmtEval(base));
  let best = base.winRate;
  save(out, net, { kind: 'ppo', iter: 0, eval: base, hp: HP });
  await pushSnapshot();

  for (let it = 1; it <= iters; it++) {
    const res = await pool.each(i => ({ type: 'rollout', games: gamesPerWorker, seed: it * 7919 + i * 31, mix, hp: HP, maxTurns: HP.maxTurns }));
    const rs = { games: 0, heuristicGames: 0, heuristicWins: 0, steps: 0, turns: 0, capped: 0 };
    for (const r of res) for (const k of Object.keys(rs)) rs[k] += r.stats[k];
    const batch = concat(res.map(r => r.batch));
    // Normalize advantages over the batch.
    let mean = 0;
    for (let i = 0; i < batch.n; i++) mean += batch.adv[i];
    mean /= batch.n;
    let sd = 0;
    for (let i = 0; i < batch.n; i++) sd += (batch.adv[i] - mean) ** 2;
    sd = Math.sqrt(sd / batch.n) + 1e-8;
    for (let i = 0; i < batch.n; i++) batch.adv[i] = (batch.adv[i] - mean) / sd;

    const st = await trainOnBatch(pool, net, adam, batch, 'ppo', { epochs: args.epochs || 3, minibatch: args.minibatch || 2048 });
    const secs = (Date.now() - t0) / 1000;
    const line = { iter: it, secs, ...rs, ...st };
    console.log(`iter ${it}: ${rs.steps} steps, train win vs bots ${rs.heuristicGames ? (100 * rs.heuristicWins / rs.heuristicGames).toFixed(0) : '-'}% (${rs.heuristicGames} games), ` +
      `entropy ${st.entropy.toFixed(3)}, kl ${st.kl.toFixed(4)}, clip ${(100 * st.clipFrac).toFixed(1)}%, value loss ${st.valueLoss.toFixed(4)} [${secs.toFixed(0)}s]`);
    if (it % (args.snapshotEvery || 5) === 0) await pushSnapshot();
    // Save the latest weights often, so a restarted machine loses little work.
    if (it % (args.saveEvery || 5) === 0) save(out + '-last', net, { kind: 'ppo', iter: it, hp: HP });
    if (it % evalEvery === 0 || it === iters) {
      const ev = await pool.evaluate(args.evalGames || 600, { seed: 4242 + it });
      line.eval = ev;
      console.log('  eval: ' + fmtEval(ev));
      save(out + '-last', net, { kind: 'ppo', iter: it, eval: ev, hp: HP });
      if (ev.winRate > best) {
        best = ev.winRate;
        save(out, net, { kind: 'ppo', iter: it, eval: ev, hp: HP });
        console.log(`  new best, saved ${out}`);
      }
    }
    logLine(logFile, line);
  }
  pool.close();
}

async function evaluate() {
  const file = args._[1];
  const ck = load(file);
  const net = sharedNet(ck.config, ck.params);
  const pool = new Pool(HP.workers, net);
  const games = args.games || 1000;
  for (const players of args.players ? [args.players] : [4, 3]) {
    const ev = await pool.evaluate(games, { seed: args.seed || 90210, greedy: !args.sample, players });
    console.log(`${players} players: ` + fmtEval(ev) + `  (a bot as good as the others would win ${(100 / players).toFixed(0)}%)`);
  }
  pool.close();
}

function exportModel() {
  const file = args._[1];
  const to = args.to || 'models/catan-policy.js';
  const ck = load(file);
  const net = new RL.Net(ck.config, ck.params);
  const model = RL.exportModel(net, 'float16', { trainedAt: new Date().toISOString().slice(0, 10), source: path.basename(file), eval: ck.meta.eval ? { winRate: ck.meta.eval.winRate, games: ck.meta.eval.games } : null });
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, `/* Trained Catan policy network (generated by rl/train.js export). */\nvar Catan = globalThis.Catan || (globalThis.Catan = {});\nCatan.RL_MODEL = ${JSON.stringify(model)};\n`);
  console.log(`Wrote ${to} (${(fs.statSync(to).size / 1e6).toFixed(2)} MB)`);
}

const commands = { imitation, ppo, eval: evaluate, export: exportModel };
if (!commands[command]) {
  console.log('Usage: node rl/train.js <imitation|ppo|eval|export> [options]  (see the header of rl/train.js)');
  process.exit(1);
}
Promise.resolve(commands[command]()).catch(e => {
  console.error(e);
  process.exit(1);
});
