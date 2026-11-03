#!/usr/bin/env node
/*
 * One command to let the trained network play your seat on colonist.io:
 *
 *   npm run play-colonist            plays (clicks the moves itself)
 *   npm run play-colonist -- --advise   only shows suggestions on the board
 *
 * It opens Google Chrome on colonist.io if needed (macOS), then starts the
 * autopilot attached to that Chrome. The first time, move the mouse over a few
 * glowing spots during setup so it learns where the board is. Use it only against colonist.io's computer opponents, or in private
 * games with friends who agree.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const PORT = 9222;
const CALIBRATION = path.join(__dirname, 'profiles', 'colonist.calibration.json');
const advise = process.argv.includes('--advise');

function chromeReady() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  if (!(await chromeReady())) {
    if (process.platform !== 'darwin') {
      console.log(`Start Chrome with remote debugging on port ${PORT} and open colonist.io, then run this again.`);
      process.exit(1);
    }
    console.log('Opening Chrome on colonist.io…');
    spawn('open', ['-na', 'Google Chrome', '--args', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(os.homedir(), 'colonist-chrome')}`, 'https://colonist.io/'], { stdio: 'ignore', detached: true }).unref();
    for (let i = 0; i < 30 && !(await chromeReady()); i++) await new Promise(r => setTimeout(r, 1000));
    if (!(await chromeReady())) { console.log('Chrome did not start. Is Google Chrome installed?'); process.exit(1); }
  }

  if (!fs.existsSync(CALIBRATION)) {
    console.log('\nFirst game: when your first settlement is due, move your mouse slowly over a few');
    console.log('of the glowing spots on the board. That shows the autopilot exactly where the board is');
    console.log("(it says \"learned the board's position\" and remembers it).\n");
  }

  const { run } = require('./autopilot.js');
  const { final } = await run({ profile: 'colonist', connect: true, auto: !advise, advise, timeoutMs: 3 * 60 * 60 * 1000 });
  if (!final) console.log('No game was found.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
