#!/usr/bin/env node
/*
 * Autopilot: plays your seat on a Catan board in a real browser.
 *
 *   node bridge/autopilot.js [--profile replica] [--url URL] [--headed]
 *                            [--advise | --auto] [--model models/catan-policy.js]
 *                            [--connect]   use your own Chrome (see `npm run open-chrome`)
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

  let browser = opts.browser;
  let page = opts.page;
  if (!page && opts.connect) {
    // Attach to a Chrome the user started with remote debugging, and use its tab.
    // Chrome may still be starting: keep trying for a while.
    for (let i = 0; ; i++) {
      try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${opts.port || 9222}`); break; } catch (e) {
        if (i >= 30) throw new Error(`Could not reach Chrome on port ${opts.port || 9222}. Start it with: npm run open-chrome`);
        await sleep(1000);
      }
    }
    const pages = browser.contexts()[0].pages();
    page = pages.find(p => p.url().includes(new URL(profile.defaultUrl).hostname)) || pages[0];
    log(`Attached to your Chrome tab: ${page.url()}`);
  }
  if (!page) {
    browser = browser || await chromium.launch({ headless: !opts.headed });
    page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
    await page.goto(opts.url || profile.defaultUrl);
  }
  if (profile.prepare) await profile.prepare(page);
  if (opts.start && profile.startGame) await profile.startGame(page, opts.start);

  const ctx = RL.newContext();
  // Moves this site's profile can't carry out yet are never chosen.
  if (profile.disallow) ctx.disallow = profile.disallow;
  let waitingOnYou = null;
  let lastAdvice = null;
  let stuck = 0;
  const stats = { moves: 0, retries: 0 };
  const deadline = Date.now() + (opts.timeoutMs || 30 * 60 * 1000);

  while (Date.now() < deadline) {
    const snap = await profile.readSnapshot(page);
    if (!snap) { await sleep(300); continue; }
    if (snap.phase === 'gameOver') {
      log(`Game over. ${snap.winner === undefined ? '' : snap.winner === snap.me ? 'We won!' : 'We did not win.'}`);
      break;
    }
    if (auto && profile.handlePrompt && await profile.handlePrompt(page, snap, new Driver(page, () => profile.transform(page)))) continue;
    if (snap.busy || !C.Bridge.needsDecision(snap)) { await sleep(150); continue; }

    const key = stateKey(snap);
    if (waitingOnYou === key) { await sleep(300); continue; } // the player is doing this move
    const move = C.Bridge.decide(snap, agent, ctx);
    if (!auto) {
      if (key !== lastAdvice) {
        log(`Suggested move: ${describe(move)}`);
        await new Driver(page, () => profile.transform(page)).showAdvice(move, describe(move)).catch(() => {});
        lastAdvice = key;
      }
      await sleep(500);
      continue;
    }

    log(`turn ${snap.turn} ${snap.phase}: ${describe(move)}`);
    const driver = new Driver(page, () => profile.transform(page), { pause: opts.pause });
    if (profile.reset && !snap.prompt) await profile.reset(page);
    try {
      await profile.performMove(move, driver);
    } catch (e) {
      // Hand the move over rather than getting stuck: tell the player what to do.
      log(`  I can't click this one (${e.message.split('\n')[0]}).\n  Please do it yourself: ${describe(move)}`);
      if (profile.onHandover) await profile.onHandover(page, move);
      waitingOnYou = key;
      continue;
    }
    stats.moves++;

    // Wait for the page to reflect the move.
    let changed = false;
    for (let i = 0; i < 40 && !changed; i++) {
      await sleep(100);
      const after = await profile.readSnapshot(page);
      changed = !after || stateKey(after) !== key;
    }
    if (changed || move.kind === 'offer') stuck = 0; // a declined offer changes nothing
    else {
      stats.retries++;
      if (++stuck >= 3) {
        log(`  That didn't work three times. Please do it yourself: ${describe(move)}`);
        if (profile.onHandover) await profile.onHandover(page, move);
        waitingOnYou = key;
        stuck = 0;
      }
    }
  }

  const final = await profile.readSnapshot(page);
  if (!opts.page && !opts.connect) await browser.close();
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
    connect: !!args.connect,
    port: args.port ? Number(args.port) : undefined,
    timeoutMs: args.minutes ? Number(args.minutes) * 60000 : undefined,
    start: args['start-game'] ? { speed: 'fast', brain: 'classic' } : null,
  }).catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
