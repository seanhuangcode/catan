/*
 * Tests the colonist.io reader against a recorded game (tests/fixtures):
 *   - binary WebSocket frames decode
 *   - at every decision in the game, our engine's legal moves equal the
 *     spots colonist highlighted, and the move actually made is legal
 *   - every player's points computed by our engine match colonist's own
 *     count after every update
 *   - the trained policy can decide from every one of those positions
 *
 *   node tests/colonist.test.js
 */
'use strict';

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');
const { C, RL } = require('../rl/selfplay.js');
require('../bridge/snapshot.js');
require('../models/catan-policy.js');
const { ColonistGame } = require('../bridge/colonist-state.js');
const { decodeFrame } = require('../bridge/profiles/colonist.js');

const B = C.Bridge;
let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else { failures++; console.log(`FAIL ${name}${detail ? ': ' + detail : ''}`); }
}

const lines = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'fixtures', 'colonist-game.jsonl.gz'))).toString().trim().split('\n').map(JSON.parse);

// Binary frames.
{
  const raw = lines.filter(l => l.raw);
  const recv = decodeFrame(Buffer.from(raw[0].data, 'base64'), false);
  const sent = decodeFrame(Buffer.from(raw[1].data, 'base64'), true);
  check('decodes a received game update', recv && recv.id === '130' && recv.data.type === 91);
  check('decodes a sent move (after its channel header)', sent && sent.action === 15 && Number.isInteger(sent.payload));
}

const agent = new RL.PolicyAgent(RL.importModel(C.RL_MODEL), { greedy: true });
const g = new ColonistGame();
const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
let decisions = 0;
let matched = 0;
let legalChoices = 0;
let vpChecks = 0;
let vpMismatch = null;
let decideErrors = null;

for (const l of lines) {
  if (l.raw) continue;
  if (l.dir === 'received') {
    g.handle(l.msg);
    if (l.msg.data.type === 91 && g.started) {
      // Points: our engine (public points) vs colonist's victoryPointsState.
      const snap = g.snapshot();
      const game = B.buildGame(JSON.parse(JSON.stringify(snap)));
      g.playOrder.forEach((color, seat) => {
        const vps = (g.state.playerStates[color] || {}).victoryPointsState || {};
        // colonist counts hidden VP cards only for their owner; compare public points.
        const theirs = Object.entries(vps).filter(([k]) => k !== '2').reduce((s, [k, v]) => s + (k === '1' ? 2 * v : k === '3' || k === '4' ? 2 * v : v), 0);
        const ours = game.victoryPoints(seat, false);
        vpChecks++;
        if (ours !== theirs && !vpMismatch) vpMismatch = `seat ${seat}: ours ${ours}, colonist ${theirs} (${JSON.stringify(vps)})`;
      });
    }
    continue;
  }
  const { action, payload } = l.msg;
  const snap = g.snapshot();
  const as = snap.actionState;
  if (action === 11 && !(as === 3 || as === 4)) continue; // also sent alongside 21 (free roads)
  const game = B.buildGame(JSON.parse(JSON.stringify(snap)));
  const me = snap.me;
  let ours;
  let theirs;
  if (action === 15) { ours = game.validSettlementSpots(me, snap.phase === 'setupSettlement').map(v => g.cornerIndex(B.vertexRef(game, v))); theirs = g.highlights.corners; }
  else if (action === 18) { ours = game.validCitySpots(me).map(v => g.cornerIndex(B.vertexRef(game, v))); theirs = g.highlights.corners; }
  else if (action === 3) { ours = game.validRobberHexes(me).map(h => g.tileIndex(B.hexRef(game, h))); theirs = g.highlights.tiles; }
  else { ours = game.validRoadSpots(me).map(e => g.edgeIndex(B.edgeRef(game, e))); theirs = g.highlights.edges; }
  decisions++;
  if (sameSet(ours, theirs)) matched++;
  if (ours.includes(payload)) legalChoices++;
  try { B.decide(JSON.parse(JSON.stringify(snap)), agent, RL.newContext()); } catch (e) { decideErrors = decideErrors || e.message; }
}

check(`legal moves match colonist's highlights at every decision (${matched}/${decisions})`, decisions >= 14 && matched === decisions);
check(`every move made in the game is legal in our engine (${legalChoices}/${decisions})`, legalChoices === decisions);
check(`points match colonist's count after every update (${vpChecks} checks)`, !vpMismatch, vpMismatch);
check('the policy decides from every position', !decideErrors, decideErrors);
const fin = g.snapshot();
check('reads the finished game', fin.phase === 'gameOver' && fin.buildings.length === 15 && fin.roads.length === 23, `${fin.phase} ${fin.buildings.length} ${fin.roads.length}`);

// The live profile: messages arrive through the page's WebSocket listener,
// and each kind of move turns into clicks (recorded by a fake driver here).
(async () => {
  const profile = Object.create(require('../bridge/profiles/colonist.js'));
  profile.persist = false; // no calibration or session files from tests
  let onSocket = null;
  let reloaded = false;
  const fakePage = {
    on: (ev, fn) => { if (ev === 'websocket') onSocket = fn; },
    mouse: { move: async () => {} },
    url: () => 'https://colonist.io/#268598698',
    reload: async () => { reloaded = true; },
    exposeBinding: async () => {}, addInitScript: async () => {}, evaluate: async () => {},
    locator: () => ({ first: () => ({ isVisible: async () => false }) }),
  };
  const log = console.log;
  console.log = () => {};
  await profile.prepare(fakePage);
  console.log = log;
  const handlers = {};
  onSocket({ url: () => 'wss://socket.svr.colonist.io/', on: (ev, fn) => { handlers[ev] = fn; } });
  for (const l of lines) {
    if (!l.raw && l.dir === 'received') handlers.framereceived({ payload: JSON.stringify(l.msg) });
  }
  check('reloads the colonist tab so it sees the game connection open', reloaded);
  const live = await profile.readSnapshot();
  check('the live listener reads the same game', live && live.phase === 'gameOver' && live.buildings.length === 15);

  profile.cal = { board: { centerX: 600, centerY: 400, hexSize: 50, rotation: 0 } };
  const clicks = [];
  const driver = {
    page: fakePage,
    clickSelector: async sel => clicks.push(sel),
    clickPoint: async pt => clicks.push([Math.round(pt.x), Math.round(pt.y)]),
  };
  const moves = [
    { kind: 'placeSettlement', vertex: [0, 0, 0] }, { kind: 'buildRoad', edge: [0, 0, 1] },
    { kind: 'buildCity', vertex: [1, -1, 3] }, { kind: 'moveRobber', hex: [0, 0] },
    { kind: 'roll' }, { kind: 'endTurn' }, { kind: 'buyDevCard' }, { kind: 'playKnight' },
    { kind: 'playYearOfPlenty', resources: ['ore', 'ore'] }, { kind: 'playMonopoly', resource: 'wheat' },
    { kind: 'discard', cards: { wood: 1, sheep: 2 } },
  ];
  // Stand-in board: build modes are on when needed and every click changes the board.
  const MODES = { buildRoad: 4, buildSettlement: 6, buildCity: 7, moveRobber: 24 };
  profile.game.boardKey = () => String(clicks.length);
  let err = null;
  for (const m of moves) {
    profile.game.state.currentState.actionState = MODES[m.kind] || 0;
    try { await profile.performMove(m, driver); } catch (e) { err = err || `${m.kind}: ${e.message}`; }
  }
  check('every supported move turns into clicks', !err, err);
  check('the board center maps to the calibrated point', JSON.stringify(clicks.slice(-0).find(c => Array.isArray(c) && c[0] === 600 && c[1] === 400)) === '[600,400]');
  check('Year of Plenty picks two ore and confirms', clicks.join(' ').includes('[data-card-enum="15"] [class*="cardSelection-"] [data-card-enum="5"] [class*="cardSelection-"] [data-card-enum="5"] [class*="actionBox-"] [class*="confirmButton-"]'));
  let refused = false;
  await profile.performMove({ kind: 'steal', victim: 1 }, driver);
  check('discarding picks cards from your hand and confirms', clicks.join(' ').includes('#player-card-inventory [data-card-enum="1"] #player-card-inventory [data-card-enum="3"] #player-card-inventory [data-card-enum="3"] [class*="confirmButton-"]'));
  const victimName = profile.game.snapshot().players[1].name;
  check('stealing clicks the chosen player, then confirms',
    String(clicks[clicks.length - 2]).includes('playerOption-') && String(clicks[clicks.length - 2]).includes(JSON.stringify(victimName))
    && String(clicks[clicks.length - 1]).includes('confirmButton-'));
  try { await profile.performMove({ kind: 'bankTrade', give: { wood: 4 }, get: { ore: 1 } }, driver); } catch (e) { refused = true; }
  check("moves it can't make are handed to the player", refused);

  // Board clicks against a simulated colonist: it knows where the board really
  // is and reports the glowing spot under the mouse, like the real page.
  const { geometry } = require('../bridge/driver.js');
  const { colonistCorner } = require('../bridge/colonist-state.js');
  const TRUE = { cx: 640, cy: 410, s: 55 };
  const trueScreen = b => ({ x: TRUE.cx + b.x * TRUE.s, y: TRUE.cy + b.y * TRUE.s });
  async function setupScenario(cal, userHovers) {
    const pr = Object.create(require('../bridge/profiles/colonist.js'));
    pr.persist = false; // don't save a calibration file from a test
    let sock = null;
    let binding = null;
    const h = {};
    const page = {
      on: (ev, fn) => { if (ev === 'websocket') sock = fn; },
      url: () => 'about:blank',
      exposeBinding: async (name, fn) => { binding = fn; },
      addInitScript: async () => {}, evaluate: async () => {},
      mouse: {
        move: async (x, y) => {
          binding(null, { x, y });
          // colonist: report the glowing corner within reach of the mouse.
          let hit = null;
          for (const idx of pr.game.highlights.corners) {
            const p = trueScreen(colonistCorner(pr.game.state.mapState.tileCornerStates[idx]));
            if (Math.hypot(p.x - x, p.y - y) < 0.3 * TRUE.s) hit = idx;
          }
          h.framesent({ payload: JSON.stringify({ action: 66, payload: hit }) });
        },
      },
    };
    const log = console.log;
    console.log = () => {};
    await pr.prepare(page);
    pr.cal = cal;
    sock({ url: () => 'wss://socket.svr.colonist.io/', on: (ev, fn) => { h[ev] = fn; } });
    // Replay the recorded game up to my first setup placement.
    for (const l of lines) {
      if (l.raw) continue;
      if (l.dir === 'sent') { if (l.msg.action === 15) break; continue; }
      h.framereceived({ payload: JSON.stringify(l.msg) });
    }
    for (const idx of userHovers) {
      const p = trueScreen(colonistCorner(pr.game.state.mapState.tileCornerStates[idx]));
      await page.mouse.move(p.x + 3, p.y - 2);
    }
    const snap = await pr.readSnapshot();
    const spots = pr.game.highlights.corners;
    const want = pr.game.cornerRef(spots[spots.length - 1]);
    const clicked = [];
    const truthPt = trueScreen(geometry.vertex(want));
    const drv = {
      page,
      clickSelector: async () => {},
      clickPoint: async pt => {
        clicked.push(pt);
        if (Math.hypot(pt.x - truthPt.x, pt.y - truthPt.y) < 0.3 * TRUE.s) {
          pr.game.state.mapState.tileCornerStates[spots[spots.length - 1]].owner = pr.game.me;
        }
      },
    };
    let error = null;
    try { await pr.performMove({ kind: 'placeSettlement', vertex: want }, drv); } catch (e) { error = e.message; }
    console.log = log;
    const truth = trueScreen(geometry.vertex(want));
    const miss = clicked.length ? Math.hypot(clicked[0].x - truth.x, clicked[0].y - truth.y) : Infinity;
    return { snap, error, miss, fitted: pr.fitted };
  }
  // Main game: no hover reports. A road click slightly off misses; the profile
  // nudges until the road appears, and learns the spot from the click that worked.
  async function roadScenario() {
    const pr = Object.create(require('../bridge/profiles/colonist.js'));
    pr.persist = false;
    let sock = null;
    let binding = null;
    const h = {};
    const page = {
      on: (ev, fn) => { if (ev === 'websocket') sock = fn; },
      url: () => 'about:blank',
      exposeBinding: async (name, fn) => { binding = fn; },
      addInitScript: async () => {}, evaluate: async () => {},
      mouse: { move: async () => {} },
    };
    const log = console.log;
    console.log = () => {};
    await pr.prepare(page);
    sock({ url: () => 'wss://socket.svr.colonist.io/', on: (ev, fn) => { h[ev] = fn; } });
    for (const l of lines) {
      if (l.raw) continue;
      if (l.dir === 'sent') { if (l.msg.action === 15) break; continue; }
      h.framereceived({ payload: JSON.stringify(l.msg) });
    }
    pr.cal = { board: { centerX: TRUE.cx + 6, centerY: TRUE.cy + 4, hexSize: TRUE.s, rotation: 0 } };
    pr.game.state.currentState.actionState = 4;
    const idx = Object.keys(pr.game.state.mapState.tileEdgeStates).map(Number).find(k => { try { pr.game.edgeRef(k); return !pr.game.state.mapState.tileEdgeStates[k].owner; } catch (e) { return false; } });
    const want = pr.game.edgeRef(idx);
    const truth = trueScreen(geometry.edge(want));
    let clicks = 0;
    const drv = {
      page,
      clickSelector: async () => {},
      clickPoint: async pt => {
        clicks++;
        binding(null, { x: pt.x, y: pt.y, down: true });
        if (Math.hypot(pt.x - truth.x, pt.y - truth.y) < 0.12 * TRUE.s) {
          const diff = { mapState: { tileEdgeStates: { [idx]: { owner: pr.game.me, type: 1 } } } };
          h.framereceived({ payload: JSON.stringify({ id: '130', data: { type: 91, payload: { diff } } }) });
        }
      },
    };
    let error = null;
    try { await pr.performMove({ kind: 'buildRoad', edge: want }, drv); } catch (e) { error = e.message; }
    console.log = log;
    return { error, clicks, learned: pr.samples.has('edge:' + idx) };
  }
  const rr = await roadScenario();
  check(`a slightly-off road click is nudged until it lands (${rr.clicks} clicks)`, !rr.error && rr.clicks > 1, rr.error);
  check('the click that worked teaches the profile where that spot is', rr.learned);

  const bad = { board: { centerX: TRUE.cx + 30, centerY: TRUE.cy - 18, hexSize: TRUE.s * 1.08, rotation: 2 } };
  const r1 = await setupScenario(bad, []);
  check(`a wrong calibration still clicks the right setup spot (off by ${r1.miss.toFixed(1)} px)`, r1.snap.phase === 'setupSettlement' && r1.miss < 0.3 * TRUE.s, r1.error);
  const r2 = await setupScenario(null, [0, 5, 9, 14, 20]);
  check('learns the board from you hovering glowing spots, then clicks right', r2.fitted && r2.miss < 0.3 * TRUE.s, r2.error || `miss ${r2.miss}`);

  if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nAll colonist tests passed');
})();
