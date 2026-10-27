#!/usr/bin/env node
/*
 * Autopilot: plays your seat on a Catan board in a real browser.
 *
 *   node bridge/autopilot.js [--profile replica] [--url URL] [--headed]
 *                            [--advise | --auto] [--model models/catan-policy.js]
 *
 * Each loop it reads the board into a snapshot (bridge/snapshot.js), asks the
 * trained policy for a move, and carries the move out with mouse clicks via
 * the site profile (bridge/profiles/*.js). In --advise mode it only prints the
 * suggested move and leaves the clicking to you.
 */
'use strict';

const path = require('path');
const { chromium } = require('playwright');
const { C, RL } = require('../rl/selfplay.js');
require('./snapshot.js');
const { Driver, sleep } = require('./driver.js');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

function loadPolicy(file) {
  require(path.resolve(file));
  if (!C.RL_MODEL) throw new Error(`No model in ${file}. Train and export one first (see rl/README.md).`);
  return new RL.PolicyAgent(RL.importModel(C.RL_MODEL), { greedy: true });
}

/** A short key for "has the game moved on?" checks. */
function stateKey(s) {
  return JSON.stringify([s.phase, s.current, s.turn, s.hand, s.buildings.length, s.roads.length, s.robber, s.devCards.length, s.discardCount, s.dice, s.prompt, s.devPlayedThisTurn, s.freeRoads]);
}

function describe(move) {
  const rest = Object.entries(move).filter(([k]) => !['kind', 'action', 'label'].includes(k)).map(([k, v]) => `${k}=${JSON.stringify(v)}`);
  return [move.kind, ...rest].join(' ');
}

async function run(opts) {
  const profile = require(`./profiles/${opts.profile || 'replica'}.js`);
  const agent = loadPolicy(opts.model || path.join(__dirname, '..', 'models', 'catan-policy.js'));
  const auto = opts.advise ? false : opts.auto ? true : profile.autoByDefault;
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  if (profile.notice) log(profile.notice);
  log(`Autopilot: profile ${profile.name}, ${auto ? 'clicking moves automatically' : 'advice only (you click)'}`);

  const browser = opts.browser || await chromium.launch({ headless: !opts.headed });
  const page = opts.page || await browser.newPage({ viewport: { width: 1400, height: 860 } });
  if (!opts.page) await page.goto(opts.url || profile.defaultUrl);
  if (profile.prepare) await profile.prepare(page);
  if (opts.start && profile.startGame) await profile.startGame(page, opts.start);

  const ctx = RL.newContext();
  let lastAdvice = null;
  let stuck = 0;
  const stats = { moves: 0, retries: 0 };
  const deadline = Date.now() + (opts.timeoutMs || 30 * 60 * 1000);

  while (Date.now() < deadline) {
    const snap = await profile.readSnapshot(page);
    if (!snap) { await sleep(300); continue; }
    if (snap.phase === 'gameOver') {
      log(`Game over. ${snap.winner === snap.me ? 'We won!' : 'We did not win.'}`);
      break;
    }
    if (auto && profile.handlePrompt && await profile.handlePrompt(page, snap, new Driver(page, await profile.transform(page)))) continue;
    if (!C.Bridge.needsDecision(snap)) { await sleep(150); continue; }

    const key = stateKey(snap);
    const move = C.Bridge.decide(snap, agent, ctx);
    if (!auto) {
      if (key !== lastAdvice) {
        log(`Suggested move: ${describe(move)}`);
        await new Driver(page, await profile.transform(page)).showAdvice(move, describe(move)).catch(() => {});
        lastAdvice = key;
      }
      await sleep(500);
      continue;
    }

    log(`turn ${snap.turn} ${snap.phase}: ${describe(move)}`);
    const driver = new Driver(page, await profile.transform(page), { pause: opts.pause });
    if (profile.reset && !snap.prompt) await profile.reset(page);
    try {
      await profile.performMove(move, driver);
    } catch (e) {
      log(`  could not perform move: ${e.message}`);
    }
    stats.moves++;

    // Wait for the page to reflect the move.
    let changed = false;
    for (let i = 0; i < 40 && !changed; i++) {
      await sleep(100);
      const after = await profile.readSnapshot(page);
      changed = !after || stateKey(after) !== key;
    }
    if (changed) stuck = 0;
    else {
      stats.retries++;
      if (++stuck >= 3) throw new Error(`Move had no effect three times in a row: ${describe(move)}`);
    }
  }

  const final = await profile.readSnapshot(page);
  if (!opts.page) await browser.close();
  return { final, stats };
}

module.exports = { run };

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  run({
    profile: args.profile,
    url: args.url,
    headed: !!args.headed,
    advise: !!args.advise,
    auto: !!args.auto,
    model: args.model,
    start: args['start-game'] ? { speed: 'fast', brain: 'classic' } : null,
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
