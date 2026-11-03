/*
 * Site profile for colonist.io.
 *
 * Reading: the game is read from colonist's own WebSocket messages
 * (bridge/colonist-state.js), checked against a recorded game: for every
 * decision in it, our legal moves matched the spots colonist highlighted.
 * The page must be (re)loaded after the autopilot attaches so it sees the
 * game connection open.
 *
 * Clicking:
 *   buttons     by id (#roll-dice-button, #action-button-build-city, ...) or
 *               by icon (road/settlement buttons have no id)
 *   cards       by their card code: [data-card-enum="11"] is a Knight, 1-5 are resources
 *   pop-ups     card pickers (Year of Plenty, Monopoly, discards) by card code,
 *               then the confirm button
 *   the board   is a canvas, so by position, from the calibration in
 *               bridge/profiles/colonist.calibration.json (npm run calibrate-colonist).
 *               During setup colonist reports which spot the mouse is over;
 *               the profile checks that before clicking and fine-tunes the
 *               calibration from it.
 * Moves this profile can't make yet (trades, choosing between several
 * players to rob) are left to the player; see bridge/autopilot.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ColonistGame } = require('../colonist-state.js');
const { decode } = require('../msgpack.js');
const { geometry, sleep } = require('../driver.js');

const CALIBRATION = path.join(__dirname, 'colonist.calibration.json');
const RES_CODE = { wood: 1, brick: 2, sheep: 3, wheat: 4, ore: 5 };
const DEV_CODE = { playKnight: 11, playMonopoly: 13, playRoadBuilding: 14, playYearOfPlenty: 15 };

const SEL = {
  roll: '#roll-dice-button',
  endTurn: '#action-button-pass-turn',
  buyDev: '#action-button-buy-dev-card',
  city: '#action-button-build-city',
  road: '[class*="actionButton-"]:has(img[src*="/road_"])',
  settlement: '[class*="actionButton-"]:has(img[src*="/settlement_"])',
  handCard: code => `#player-card-inventory [data-card-enum="${code}"]`,
  pickCard: code => `[class*="cardSelection-"] [data-card-enum="${code}"]`,
  confirm: '[class*="actionBox-"] [class*="confirmButton-"]',
};

/** Decodes one WebSocket frame payload to a message object (or null). */
function decodeFrame(payload, sent) {
  try {
    if (typeof payload === 'string') return JSON.parse(payload);
    const b = Buffer.from(payload);
    // Messages the page sends start with: kind byte, counter byte, channel name.
    const off = sent ? 3 + b[2] : 0;
    return decode(b, off).value;
  } catch (e) {
    return null;
  }
}

module.exports = {
  decodeFrame,
  name: 'colonist',
  defaultUrl: 'https://colonist.io/',
  autoByDefault: false,
  disallow: ['BANK', 'OFFER'],
  notice:
    'Fair play: use the autopilot only where automated play is allowed, such as games against\n' +
    "colonist.io's computer opponents or private games with friends who agree to it. Using it in\n" +
    "public or ranked games against people is cheating, breaks colonist.io's rules, and can get\n" +
    'your account banned. Advice mode (the default) only shows suggestions.',

  async prepare(page) {
    this.cal = fs.existsSync(CALIBRATION) ? JSON.parse(fs.readFileSync(CALIBRATION, 'utf8')) : null;
    this.offset = { x: 0, y: 0 };
    this.game = new ColonistGame();
    this.hover = null;
    const watch = ws => {
      if (!/colonist\.io/.test(ws.url())) return;
      ws.on('framereceived', f => { const m = decodeFrame(f.payload, false); if (m) this.game.handle(m); });
      ws.on('framesent', f => {
        const m = decodeFrame(f.payload, true);
        if (m && m.action === 66) this.hover = { index: m.payload, t: Date.now() };
      });
    };
    page.on('websocket', watch);
    // colonist's connection opens when the page loads, so it has to load again
    // now that we're listening. colonist reconnects to a running game by itself.
    if (/colonist\.io/.test(page.url())) {
      console.log('Reloading the colonist tab so the autopilot can follow the game…');
      await page.reload().catch(() => {});
    }
    console.log('Waiting for a game against bots to start (or continue).');
    if (!this.cal) console.log('No board calibration yet: run `npm run calibrate-colonist` first to let it click the board.');
  },

  async readSnapshot() {
    const snap = this.game.snapshot();
    if (!snap) return null;
    // Mid-way through a card picker the autopilot is already handling.
    snap.busy = snap.actionState === 32;
    return snap;
  },

  async transform() {
    if (!this.cal) return { toScreen: () => { throw new Error('the board is not calibrated (npm run calibrate-colonist)'); } };
    const b = this.cal.board;
    const rot = ((b.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return {
      toScreen: ({ x, y }) => ({
        x: b.centerX + this.offset.x + (x * cos - y * sin) * b.hexSize,
        y: b.centerY + this.offset.y + (x * sin + y * cos) * b.hexSize,
      }),
    };
  },

  /**
   * Points at a board spot. During setup colonist reports which spot the
   * mouse is over (as `expected`'s index); if it isn't the expected one, search
   * nearby and remember the correction. Then click.
   */
  async clickBoard(driver, pt, expected) {
    const page = driver.page;
    if (expected !== undefined && expected >= 0) {
      let reported = false;
      const tryAt = async p => {
        this.hover = null;
        await page.mouse.move(p.x, p.y, { steps: 3 });
        await sleep(120);
        if (this.hover) reported = true;
        return this.hover && this.hover.index === expected;
      };
      let hit = await tryAt(pt);
      if (!hit && !reported) {
        // No hover report at all (colonist only sends them during setup): just click.
        return driver.clickPoint(pt);
      }
      const size = this.cal ? this.cal.board.hexSize : 50;
      for (let ring = 1; !hit && ring <= 3; ring++) {
        for (let k = 0; k < 8 && !hit; k++) {
          const a = (Math.PI / 4) * k;
          const p = { x: pt.x + Math.cos(a) * ring * size * 0.08, y: pt.y + Math.sin(a) * ring * size * 0.08 };
          if (await tryAt(p)) {
            hit = true;
            this.offset.x += p.x - pt.x;
            this.offset.y += p.y - pt.y;
            pt = p;
          }
        }
      }
      if (!hit) throw new Error('colonist did not report the expected spot under the mouse; recalibrate (npm run calibrate-colonist)');
    }
    await driver.clickPoint(pt);
  },

  async pickCards(driver, cards) {
    for (const [r, n] of Object.entries(cards)) {
      for (let k = 0; k < n; k++) await driver.clickSelector(SEL.pickCard(RES_CODE[r]));
    }
    await driver.clickSelector(SEL.confirm);
  },

  async performMove(move, driver) {
    const t = await this.transform();
    const g = this.game;
    const vertex = () => t.toScreen(geometry.vertex(move.vertex));
    const edge = () => t.toScreen(geometry.edge(move.edge));
    switch (move.kind) {
      case 'placeSettlement': return this.clickBoard(driver, vertex(), g.cornerIndex(move.vertex));
      case 'placeRoad': return this.clickBoard(driver, edge(), g.edgeIndex(move.edge));
      case 'placeFreeRoad': return this.clickBoard(driver, edge());
      case 'moveRobber': return this.clickBoard(driver, t.toScreen(geometry.hex(move.hex)));
      case 'buildSettlement': await driver.clickSelector(SEL.settlement); return this.clickBoard(driver, vertex());
      case 'buildCity': await driver.clickSelector(SEL.city); return this.clickBoard(driver, vertex());
      case 'buildRoad': await driver.clickSelector(SEL.road); return this.clickBoard(driver, edge());
      case 'roll': return driver.clickSelector(SEL.roll);
      case 'endTurn': return driver.clickSelector(SEL.endTurn);
      case 'buyDevCard': return driver.clickSelector(SEL.buyDev);
      case 'playKnight':
      case 'playRoadBuilding':
        return driver.clickSelector(SEL.handCard(DEV_CODE[move.kind]));
      case 'playYearOfPlenty': {
        await driver.clickSelector(SEL.handCard(DEV_CODE.playYearOfPlenty));
        const cards = {};
        for (const r of move.resources) cards[r] = (cards[r] || 0) + 1;
        return this.pickCards(driver, cards);
      }
      case 'playMonopoly':
        await driver.clickSelector(SEL.handCard(DEV_CODE.playMonopoly));
        return this.pickCards(driver, { [move.resource]: 1 });
      case 'discard':
        return this.pickCards(driver, move.cards);
      default:
        throw new Error(`the colonist profile can't do "${move.kind}" yet`);
    }
  },
};
