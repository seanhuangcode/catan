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
  let onSocket = null;
  let reloaded = false;
  const fakePage = {
    on: (ev, fn) => { if (ev === 'websocket') onSocket = fn; },
    mouse: { move: async () => {} },
    url: () => 'https://colonist.io/#268598698',
    reload: async () => { reloaded = true; },
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
  let err = null;
  for (const m of moves) { try { await profile.performMove(m, driver); } catch (e) { err = err || `${m.kind}: ${e.message}`; } }
  check('every supported move turns into clicks', !err, err);
  check('the board center maps to the calibrated point', JSON.stringify(clicks.slice(-0).find(c => Array.isArray(c) && c[0] === 600 && c[1] === 400)) === '[600,400]');
  check('Year of Plenty picks two ore and confirms', clicks.join(' ').includes('[data-card-enum="15"] [class*="cardSelection-"] [data-card-enum="5"] [class*="cardSelection-"] [data-card-enum="5"] [class*="actionBox-"] [class*="confirmButton-"]'));
  let refused = false;
  try { await profile.performMove({ kind: 'steal', victim: 1 }, driver); } catch (e) { refused = true; }
  check("moves it can't make are handed to the player", refused);

  if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nAll colonist tests passed');
})();
