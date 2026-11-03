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

const zlib = require('zlib');

const CALIBRATION = path.join(__dirname, 'colonist.calibration.json');
const SESSIONS = path.join(__dirname, '..', 'sessions');
// Board modes (actionState) a build button puts colonist in.
const MODE = { buildRoad: [4], buildSettlement: [6], buildCity: [7], moveRobber: [24], placeFreeRoad: [30, 31] };
// How far from a spot a nudged click may land without risking a neighboring spot (hex sizes).
const NUDGE = { corner: 0.22, edge: 0.15, tile: 0.35 };
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
  anyConfirm: '[class*="confirmButton-"]',
  // "Choose a player to steal 1 random card": avatars with the player's name.
  victim: name => `[class*="actionBox-"] [class*="playerOption-"]:has([class*="playerName-"]:text-is(${JSON.stringify(name)}))`,
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
    this.lastDown = null;
    this.page = page;
    // Every piece of mine that lands where a click just happened pins that spot on screen.
    this.game.onPlaced = ({ kind, index }) => {
      if (kind === 'tile' || !this.lastDown || Date.now() - this.lastDown.t > 3000) return;
      this.addSample(`${kind}:${index}`, this.game.boardPos(kind, index), this.lastDown);
    };
    // A session log (game messages, plus page snapshots when a move is handed to you)
    // that can be pushed to improve the profile; see bridge/README.md.
    this.sessionDir = path.join(SESSIONS, new Date().toISOString().replace(/[:.]/g, '-'));
    let log = null;
    try {
      if (this.persist === false) throw new Error('not saving');
      fs.mkdirSync(this.sessionDir, { recursive: true });
      log = zlib.createGzip();
      log.pipe(fs.createWriteStream(path.join(this.sessionDir, 'frames.jsonl.gz')));
      const end = () => { try { log.end(); } catch (e) { /* closed */ } };
      process.on('exit', end);
      process.on('SIGINT', () => { end(); setTimeout(() => process.exit(0), 300); });
    } catch (e) { log = null; }
    const record = (dir, payload) => {
      if (!log) return;
      const binary = typeof payload !== 'string';
      log.write(JSON.stringify({ t: Date.now(), dir, binary, data: binary ? Buffer.from(payload).toString('base64') : payload }) + '\n');
    };
    const watch = ws => {
      if (!/colonist\.io/.test(ws.url())) return;
      ws.on('framereceived', f => { record('received', f.payload); const m = decodeFrame(f.payload, false); if (m) this.game.handle(m); });
      ws.on('framesent', f => {
        record('sent', f.payload);
        const m = decodeFrame(f.payload, true);
        if (m && m.action === 66) this.onHover(m.payload);
      });
    };
    page.on('websocket', watch);
    // Track the mouse on the page (yours or the autopilot's) to pair with hover reports.
    await page.exposeBinding('__catanMouse', (_src, p) => {
      this.mouse = { x: p.x, y: p.y, t: Date.now() };
      if (p.down) this.lastDown = this.mouse;
    }).catch(() => {});
    const track = () => {
      window.addEventListener('mousemove', e => window.__catanMouse({ x: e.clientX, y: e.clientY }), true);
      window.addEventListener('mousedown', e => window.__catanMouse({ x: e.clientX, y: e.clientY, down: true }), true);
    };
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
    this.addSample(key, board, this.mouse);
  },

  addSample(key, board, point) {
    const entry = this.samples.get(key) || { board, points: [] };
    entry.points.push({ x: point.x, y: point.y });
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
    if (pairs.length < 3) {
      // Too few spots for size and rotation: at least correct the overall shift.
      if (this.cal && !this.fitted) {
        const b = this.cal.board;
        const rot = ((b.rotation || 0) * Math.PI) / 180;
        let dx = 0;
        let dy = 0;
        for (const q of pairs) {
          dx += q.screen.x - (b.centerX + (q.board.x * Math.cos(rot) - q.board.y * Math.sin(rot)) * b.hexSize);
          dy += q.screen.y - (b.centerY + (q.board.x * Math.sin(rot) + q.board.y * Math.cos(rot)) * b.hexSize);
        }
        this.offset = { x: dx / pairs.length, y: dy / pairs.length };
      }
      return;
    }
    let fit = fitSimilarity(pairs);
    // Drop the worst-fitting spot (a stray report) a couple of times if needed.
    for (let k = 0; fit && fit.maxError > 0.25 * fit.hexSize && pairs.length > 3 && k < 2; k++) {
      const rot = (fit.rotation * Math.PI) / 180;
      const errOf = q => Math.hypot(fit.centerX + (q.board.x * Math.cos(rot) - q.board.y * Math.sin(rot)) * fit.hexSize - q.screen.x,
        fit.centerY + (q.board.x * Math.sin(rot) + q.board.y * Math.cos(rot)) * fit.hexSize - q.screen.y);
      pairs.sort((a, b) => errOf(a) - errOf(b));
      pairs.pop();
      fit = fitSimilarity(pairs);
    }
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
   * Clicks a board spot and makes sure it took.
   *   expected  during setup: the spot index colonist must report under the
   *             mouse before clicking (searching nearby if needed)
   *   kind      'corner' | 'edge' | 'tile': how far a nudged retry may go
   *   mode      board modes (actionState) the click needs; `button` re-enters it
   * After a click, wait for the board to change; if it didn't, retry with small
   * nudges that stay well inside the intended spot.
   */
  async clickBoard(driver, pt, opts = {}) {
    const { expected, kind = 'corner', mode, button } = opts;
    const page = driver.page;
    if (expected !== undefined && expected >= 0) {
      await this.warmUp(page);
      const t = await this.transform();
      const aim = this.lastTarget ? t.toScreen(this.lastTarget) : pt;
      let dir = null;
      if (kind === 'edge' && this.lastEdge) {
        const a = t.toScreen(this.lastEdge[0]);
        const b = t.toScreen(this.lastEdge[1]);
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
      }
      let found = await this.search(page, aim, idx => idx === expected, kind, Date.now() + 12000, dir);
      // colonist never reported any spot this session: it may not send hover
      // reports any more, so click the best estimate rather than nothing.
      if (!found && this.hoverSeen) throw new Error("colonist didn't confirm the spot under the mouse");
      pt = found || aim;
    }
    const size = this.cal.board.hexSize;
    const r = NUDGE[kind] * size;
    const tries = [pt];
    for (const f of [0.5, 1]) for (let k = 0; k < 8; k++) tries.push({ x: pt.x + Math.cos((Math.PI / 4) * k) * r * f, y: pt.y + Math.sin((Math.PI / 4) * k) * r * f });
    for (const p of tries) {
      const as = (this.game.state.currentState || {}).actionState;
      if (mode && !mode.includes(as)) {
        if (!button) break; // the mode ended without us (e.g. the turn moved on)
        await driver.clickSelector(button);
        await this.waitFor(() => mode.includes((this.game.state.currentState || {}).actionState), 800);
      }
      const before = this.game.boardKey();
      await driver.clickPoint(p);
      if (await this.waitFor(() => this.game.boardKey() !== before, 900)) return;
    }
    throw new Error('the click on the board did not register');
  },

  /**
   * Setup warm-up: while many spots glow, point at a few spread over the board.
   * Each one colonist confirms is an exact data point; together they pin the
   * board's position, size and rotation before any click. Takes a few seconds.
   */
  async warmUp(page) {
    if (this.warmedUp || !this.cal) return;
    this.warmedUp = true;
    const spots = this.game.highlights.corners.slice();
    if (spots.length < 6) return;
    const pos = spots.map(i => ({ i, b: this.game.boardPos('corner', i) }));
    // Farthest-point sampling: spots spread over the whole board.
    const chosen = [pos.reduce((a, q) => (Math.hypot(q.b.x, q.b.y) > Math.hypot(a.b.x, a.b.y) ? q : a))];
    while (chosen.length < 6) {
      let best = null;
      let bestD = -1;
      for (const q of pos) {
        const d = Math.min(...chosen.map(c => Math.hypot(c.b.x - q.b.x, c.b.y - q.b.y)));
        if (d > bestD) { bestD = d; best = q; }
      }
      chosen.push(best);
    }
    const deadline = Date.now() + 9000;
    let found = 0;
    for (const c of chosen) {
      if (Date.now() > deadline) break;
      const center = (await this.transform()).toScreen(c.b);
      if (await this.search(page, center, idx => idx === c.i, 'corner', deadline)) found++;
    }
    console.log(`  checked the board's position against ${found} glowing spots`);
  },

  /**
   * Moves the mouse around `center` until colonist reports a spot accepted by
   * `ok`. Corners: rings around the point. Edges: across the edge's line first.
   * Returns the screen point, or null.
   */
  async search(page, center, ok, kind, deadline = Infinity, edgeDir = null) {
    const size = this.cal.board.hexSize;
    const at = async p => {
      this.hover = null;
      await page.mouse.move(p.x, p.y, { steps: 2 });
      await sleep(80);
      return this.hover && this.hover.index !== null && ok(this.hover.index);
    };
    const pts = [center];
    if (kind === 'edge' && edgeDir) {
      const n = { x: -edgeDir.y, y: edgeDir.x }; // across the road
      for (let a = -0.25; a <= 0.25001; a += 0.125) {
        for (let d = 0.04; d <= 0.5; d += 0.04) {
          for (const sgn of [1, -1]) pts.push({ x: center.x + (n.x * sgn * d + edgeDir.x * a) * size, y: center.y + (n.y * sgn * d + edgeDir.y * a) * size });
        }
      }
    } else {
      for (let ring = 1; ring <= 7; ring++) {
        for (let k = 0; k < 8 + ring * 2; k++) {
          const a = (2 * Math.PI * k) / (8 + ring * 2);
          pts.push({ x: center.x + Math.cos(a) * ring * size * 0.065, y: center.y + Math.sin(a) * ring * size * 0.065 });
        }
      }
    }
    for (const p of pts) {
      if (Date.now() > deadline) return null;
      if (await at(p)) return p;
    }
    return null;
  },

  /** Polls `cond` for up to `ms` milliseconds. */
  async waitFor(cond, ms) {
    for (let t = 0; t < ms; t += 50) { if (cond()) return true; await sleep(50); }
    return cond();
  },

  /** When a move is handed to the player, keep a snapshot of the page for improving the profile. */
  async onHandover(page, move) {
    if (!this.sessionDir || this.persist === false) return;
    const n = (this.handovers = (this.handovers || 0) + 1);
    const base = path.join(this.sessionDir, `handover-${String(n).padStart(2, '0')}-${move.kind}`);
    try {
      const html = await page.content();
      fs.writeFileSync(base + '.html.gz', zlib.gzipSync(html));
      await page.screenshot({ path: base + '.jpg', type: 'jpeg', quality: 60 });
      fs.writeFileSync(base + '.json', JSON.stringify({ move, actionState: (this.game.state.currentState || {}).actionState, highlights: this.game.highlights }, null, 1));
    } catch (e) { /* page busy */ }
  },

  /** Waits (up to 20 s) for the board's position, asking the player to hover glowing spots. */
  async ensureBoard() {
    if (this.cal) return;
    console.log("  I don't know where the board is yet: please move your mouse over a few of the glowing spots.");
    for (let i = 0; i < 100 && !this.cal; i++) await sleep(200);
    if (!this.cal) throw new Error("the board's position isn't known yet");
  },

  async pickCards(driver, cards, fromHand) {
    for (const [r, n] of Object.entries(cards)) {
      for (let k = 0; k < n; k++) {
        if (fromHand) {
          // Discards: cards may be picked from a picker or straight from my hand.
          const picker = driver.page.locator(SEL.pickCard(RES_CODE[r])).first();
          if (await picker.isVisible().catch(() => false)) await driver.clickSelector(SEL.pickCard(RES_CODE[r]));
          else await driver.clickSelector(SEL.handCard(RES_CODE[r]));
        } else await driver.clickSelector(SEL.pickCard(RES_CODE[r]));
      }
    }
    await driver.clickSelector(fromHand ? SEL.anyConfirm : SEL.confirm);
  },

  async performMove(move, driver) {
    const BOARD = ['placeSettlement', 'placeRoad', 'placeFreeRoad', 'moveRobber', 'buildSettlement', 'buildCity', 'buildRoad'];
    if (BOARD.includes(move.kind)) await this.ensureBoard();
    const t = await this.transform();
    const g = this.game;
    const vertex = () => t.toScreen((this.lastTarget = geometry.vertex(move.vertex)));
    const edge = () => {
      const [q, r, side] = move.edge;
      this.lastEdge = [geometry.vertex([q, r, side]), geometry.vertex([q, r, (side + 1) % 6])];
      return t.toScreen((this.lastTarget = geometry.edge(move.edge)));
    };
    switch (move.kind) {
      case 'placeSettlement': return this.clickBoard(driver, vertex(), { expected: g.cornerIndex(move.vertex), kind: 'corner' });
      case 'placeRoad': return this.clickBoard(driver, edge(), { expected: g.edgeIndex(move.edge), kind: 'edge' });
      case 'placeFreeRoad': return this.clickBoard(driver, edge(), { kind: 'edge', mode: MODE.placeFreeRoad });
      case 'moveRobber': return this.clickBoard(driver, t.toScreen((this.lastTarget = geometry.hex(move.hex))), { kind: 'tile', mode: MODE.moveRobber });
      case 'buildSettlement': await driver.clickSelector(SEL.settlement); return this.clickBoard(driver, vertex(), { kind: 'corner', mode: MODE.buildSettlement, button: SEL.settlement });
      case 'buildCity': await driver.clickSelector(SEL.city); return this.clickBoard(driver, vertex(), { kind: 'corner', mode: MODE.buildCity, button: SEL.city });
      case 'buildRoad': await driver.clickSelector(SEL.road); return this.clickBoard(driver, edge(), { kind: 'edge', mode: MODE.buildRoad, button: SEL.road });
      case 'steal': {
        const snap = g.snapshot();
        await driver.clickSelector(SEL.victim(snap.players[move.victim].name), { timeout: 3000 });
        return driver.clickSelector(SEL.confirm);
      }
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
        return this.pickCards(driver, move.cards, true);
      default:
        throw new Error(`the colonist profile can't do "${move.kind}" yet`);
    }
  },
};
