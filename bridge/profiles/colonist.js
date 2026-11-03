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
 *   the board   is a canvas, so by position. Whenever a spot glows (setup),
 *               colonist reports which spot is under the mouse. Pairing those
 *               reports with the mouse position gives the board's exact place,
 *               size and rotation on screen (bridge/fit.js), saved in
 *               bridge/profiles/colonist.calibration.json. Moving the mouse over
 *               a few glowing spots during setup is enough; setup clicks are
 *               also checked against those reports before clicking.
 * Moves this profile can't make yet (trades, choosing between several
 * players to rob) are left to the player; see bridge/autopilot.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { ColonistGame, colonistCorner, colonistEdgeEnds } = require('../colonist-state.js');
const { fitSimilarity } = require('../fit.js');
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
    this.mouse = null;
    this.samples = new Map(); // "corner:12" -> {board: {x, y}, points: [{x, y}]}
    this.fitted = false;
    const watch = ws => {
      if (!/colonist\.io/.test(ws.url())) return;
      ws.on('framereceived', f => { const m = decodeFrame(f.payload, false); if (m) this.game.handle(m); });
      ws.on('framesent', f => {
        const m = decodeFrame(f.payload, true);
        if (m && m.action === 66) this.onHover(m.payload);
      });
    };
    page.on('websocket', watch);
    // Track the mouse on the page (yours or the autopilot's) to pair with hover reports.
    await page.exposeBinding('__catanMouse', (_src, p) => { this.mouse = { x: p.x, y: p.y, t: Date.now() }; }).catch(() => {});
    const track = () => window.addEventListener('mousemove', e => window.__catanMouse({ x: e.clientX, y: e.clientY }), true);
    await page.addInitScript(track).catch(() => {});
    // colonist's connection opens when the page loads, so it has to load again
    // now that we're listening. colonist reconnects to a running game by itself.
    if (/colonist\.io/.test(page.url())) {
      console.log('Reloading the colonist tab so the autopilot can follow the game…');
      await page.reload().catch(() => {});
    }
    await page.evaluate(track).catch(() => {});
    console.log('Waiting for a game against bots to start (or continue).');
    if (!this.cal) console.log('Board position not known yet: during setup, move your mouse over a few glowing spots.');
  },

  /** colonist says the mouse is over spot `index` (or nothing): learn the board's position from it. */
  onHover(index) {
    this.hover = { index, t: Date.now() };
    if (index !== null && index !== undefined) this.hoverSeen = true;
    if (index === null || index === undefined || !this.game.started || !this.mouse || Date.now() - this.mouse.t > 400) return;
    const as = (this.game.state.currentState || {}).actionState;
    let key;
    let board;
    const ms = this.game.state.mapState;
    if ((as === 1 || as === 6 || as === 7) && ms.tileCornerStates[index]) {
      key = 'corner:' + index;
      board = colonistCorner(ms.tileCornerStates[index]);
    } else if ((as === 3 || as === 4 || as === 30 || as === 31) && ms.tileEdgeStates[index]) {
      const [a, b] = colonistEdgeEnds(ms.tileEdgeStates[index]);
      key = 'edge:' + index;
      board = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    } else return;
    const entry = this.samples.get(key) || { board, points: [] };
    entry.points.push({ x: this.mouse.x, y: this.mouse.y });
    if (entry.points.length > 20) entry.points.shift();
    this.samples.set(key, entry);
    this.refit();
  },

  /** Fits the board position from the hover samples once they span a few spots. */
  refit() {
    const pairs = [...this.samples.values()].map(e => ({
      board: e.board,
      screen: { x: e.points.reduce((a, p) => a + p.x, 0) / e.points.length, y: e.points.reduce((a, p) => a + p.y, 0) / e.points.length },
    }));
    if (pairs.length < 3) return;
    const fit = fitSimilarity(pairs);
    if (!fit || fit.maxError > 0.4 * fit.hexSize) return;
    const board = { centerX: +fit.centerX.toFixed(1), centerY: +fit.centerY.toFixed(1), hexSize: +fit.hexSize.toFixed(2), rotation: +fit.rotation.toFixed(2), fromHover: pairs.length };
    const first = !this.fitted;
    this.cal = { board };
    this.offset = { x: 0, y: 0 };
    this.fitted = true;
    if (this.persist !== false) {
      try { fs.writeFileSync(CALIBRATION, JSON.stringify(this.cal, null, 2) + '\n'); } catch (e) { /* read-only */ }
    }
    if (first) console.log(`  learned the board's position from ${pairs.length} spots (saved)`);
  },

  async readSnapshot() {
    const snap = this.game.snapshot();
    if (!snap) return null;
    // Mid-way through a card picker the autopilot is already handling.
    snap.busy = snap.actionState === 32;
    return snap;
  },

  async transform() {
    if (!this.cal) return { toScreen: () => { throw new Error("the board's position isn't known yet: move your mouse over a few glowing spots during setup"); } };
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
   * Clicks a board spot. During setup, colonist reports which spot is under
   * the mouse: point first, and only click once it reports `expected`
   * (searching nearby if needed; every report also refines the board fit).
   */
  async clickBoard(driver, pt, expected) {
    const page = driver.page;
    if (expected === undefined || expected < 0) return driver.clickPoint(pt);
    const at = async p => {
      this.hover = null;
      await page.mouse.move(p.x, p.y, { steps: 2 });
      await sleep(90);
      return this.hover && this.hover.index === expected;
    };
    const target = async () => (await this.transform()).toScreen(this.lastTarget);
    if (await at(pt)) return driver.clickPoint(pt);
    // Search outwards; if the fit improves meanwhile, jump to the new estimate.
    const size = this.cal.board.hexSize;
    let center = pt;
    for (let ring = 1; ring <= 6; ring++) {
      for (let k = 0; k < 8; k++) {
        const a = (Math.PI / 4) * k + ring * 0.4;
        const p = { x: center.x + Math.cos(a) * ring * size * 0.07, y: center.y + Math.sin(a) * ring * size * 0.07 };
        if (await at(p)) return driver.clickPoint(p);
      }
      if (this.lastTarget) {
        const p = await target();
        if (Math.hypot(p.x - center.x, p.y - center.y) > 2) {
          center = p;
          if (await at(p)) return driver.clickPoint(p);
        }
      }
    }
    // colonist never reported any spot this session: it may not send hover
    // reports any more, so click the best estimate rather than nothing.
    if (!this.hoverSeen) return driver.clickPoint(pt);
    throw new Error("colonist didn't confirm the spot under the mouse");
  },

  /** Waits (up to 20 s) for the board's position, asking the player to hover glowing spots. */
  async ensureBoard() {
    if (this.cal) return;
    console.log("  I don't know where the board is yet: please move your mouse over a few of the glowing spots.");
    for (let i = 0; i < 100 && !this.cal; i++) await sleep(200);
    if (!this.cal) throw new Error("the board's position isn't known yet");
  },

  async pickCards(driver, cards) {
    for (const [r, n] of Object.entries(cards)) {
      for (let k = 0; k < n; k++) await driver.clickSelector(SEL.pickCard(RES_CODE[r]));
    }
    await driver.clickSelector(SEL.confirm);
  },

  async performMove(move, driver) {
    const BOARD = ['placeSettlement', 'placeRoad', 'placeFreeRoad', 'moveRobber', 'buildSettlement', 'buildCity', 'buildRoad'];
    if (BOARD.includes(move.kind)) await this.ensureBoard();
    const t = await this.transform();
    const g = this.game;
    const vertex = () => t.toScreen((this.lastTarget = geometry.vertex(move.vertex)));
    const edge = () => t.toScreen((this.lastTarget = geometry.edge(move.edge)));
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
