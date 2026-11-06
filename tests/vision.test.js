/*
 * Finding colonist's board in screenshots (bridge/vision.js), on two real
 * colonist screens cropped to the board:
 *   colonist-board-setup.png    during setup, with colonist's glowing rings on
 *                               the corners you may build on
 *   colonist-board-dragged.png  the board dragged half off the left edge
 * Both are from the same game; colonist-board-layout.json is its tile layout.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { decodePNG, locateBoard } = require('../bridge/vision.js');
const { ColonistGame } = require('../bridge/colonist-state.js');
const { geometry } = require('../bridge/driver.js');

const FIX = path.join(__dirname, 'fixtures');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!ok) failed++;
}

const layout = JSON.parse(fs.readFileSync(path.join(FIX, 'colonist-board-layout.json'), 'utf8'));
const game = new ColonistGame();
game.state = { mapState: { ...layout, tileCornerStates: {}, tileEdgeStates: {} } };
const tiles = Object.keys(layout.tileHexStates).map(i => ({ ...game.boardPos('tile', Number(i)), desert: layout.tileHexStates[i].type === 0 }));
const at = (fit, b) => ({ x: fit.centerX + b.x * fit.hexSize, y: fit.centerY + b.y * fit.hexSize });

(async () => {
  const setupPng = fs.readFileSync(path.join(FIX, 'colonist-board-setup.png'));
  const setup = locateBoard(decodePNG(setupPng), tiles);
  check('finds all 18 number tokens during setup', setup && setup.matched === 18, setup && `${setup.matched} matched`);
  check('board size from the tokens', setup && Math.abs(setup.hexSize - 57.15) < 0.6, setup && `hex radius ${setup.hexSize.toFixed(2)} px`);
  // Measured by eye on the screenshot: colonist's glowing ring on the top corner
  // of the top-left tile (a wheat 5).
  const ring = { x: 242.4, y: 120 };
  const corner = setup && at(setup, geometry.vertex([0, -2, 0]));
  const miss = corner ? Math.hypot(corner.x - ring.x, corner.y - ring.y) : Infinity;
  check('a corner lands in colonist\'s glowing ring', miss < 3, `${miss.toFixed(1)} px off`);

  const dragged = locateBoard(decodePNG(fs.readFileSync(path.join(FIX, 'colonist-board-dragged.png'))), tiles);
  check('finds the board when it was dragged half off screen', dragged && dragged.matched >= 13 && dragged.error < 0.05, dragged && `${dragged.matched} tokens, error ${(dragged.error * 100).toFixed(1)}%`);
  check('same board size after dragging', dragged && setup && Math.abs(dragged.hexSize - setup.hexSize) < 0.6);
  check('nothing found on a screen without a board', locateBoard({ width: 200, height: 100, data: Buffer.alloc(200 * 100 * 4, 230) }, tiles) === null);

  // The same through a real browser screenshot, and through the colonist profile.
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
    await page.setContent(`<body style="margin:0"><img src="data:image/png;base64,${setupPng.toString('base64')}" style="display:block"></body>`);
    await page.waitForFunction(() => document.images[0].complete);
    const live = locateBoard(decodePNG(await page.screenshot({ type: 'png', scale: 'css' })), tiles);
    check('reads a browser screenshot the same way', live && Math.hypot(live.centerX - setup.centerX, live.centerY - setup.centerY) < 1);

    const profile = require('../bridge/profiles/colonist.js');
    Object.assign(profile, { persist: false, game, vision: false, cal: null, offset: { x: 0, y: 0 } });
    const found = await profile.locate(page);
    const t = await profile.transform();
    const p = t.toScreen(geometry.vertex([0, -2, 0]));
    check('the colonist profile aims at the ring from a screenshot', found && Math.hypot(p.x - ring.x, p.y - ring.y) < 3, `${Math.hypot(p.x - ring.x, p.y - ring.y).toFixed(1)} px off`);
  } finally {
    await browser.close();
  }

  if (failed) { console.log(`${failed} vision test(s) failed`); process.exit(1); }
  console.log('All vision tests passed');
})();
