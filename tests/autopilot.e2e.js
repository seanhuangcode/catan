/*
 * End-to-end test: the autopilot plays the human seat of this repo's game in
 * a real (headless) browser, using only mouse clicks, until the game ends.
 *
 *   npm run test:e2e        (needs Playwright: npm install)
 */
'use strict';

const { run } = require('../bridge/autopilot.js');

(async () => {
  const t0 = Date.now();
  const { final, stats } = await run({ profile: 'replica', start: { speed: 'instant', brain: 'classic' }, quiet: true, pause: 30, timeoutMs: 10 * 60 * 1000 });
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  if (!final || final.phase !== 'gameOver') {
    console.log(`FAIL autopilot game did not finish (${stats.moves} moves, ${secs}s)`);
    process.exit(1);
  }
  console.log(`ok   autopilot finished a game with ${stats.moves} clicked moves and ${stats.retries} retries (${secs}s); ${final.winner === final.me ? 'it won' : 'it lost'}`);
})().catch(e => {
  console.log('FAIL ' + e.message);
  process.exit(1);
});
