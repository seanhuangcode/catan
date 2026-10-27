/*
 * Site profile for colonist.io. PARTIAL: the board-to-screen mapping and the
 * move flows are in place, but reading the game state (readSnapshot) still has
 * to be written from a recorded session, because colonist.io's page and
 * network messages could not be inspected while this was built. See
 * bridge/README.md ("Finishing colonist.io support").
 *
 * Calibration lives in bridge/profiles/colonist.calibration.json:
 *   {
 *     "board": { "centerX": 640, "centerY": 400, "hexSize": 52, "rotation": 0 },
 *     "controls": { "roll": "<css selector or {x,y}>", "endTurn": ..., "buildRoad": ...,
 *                   "buildSettlement": ..., "buildCity": ..., "buyDevCard": ..., ... }
 *   }
 * `node bridge/record-colonist.js --calibrate` measures the board part for you.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CALIBRATION = path.join(__dirname, 'colonist.calibration.json');

function loadCalibration() {
  if (!fs.existsSync(CALIBRATION)) {
    throw new Error(`Missing ${path.relative(process.cwd(), CALIBRATION)}. Run: node bridge/record-colonist.js --calibrate`);
  }
  return JSON.parse(fs.readFileSync(CALIBRATION, 'utf8'));
}

module.exports = {
  name: 'colonist',
  defaultUrl: 'https://colonist.io/',
  autoByDefault: false,
  notice:
    'Fair play: only use the autopilot where automated play is allowed, such as games against\n' +
    "colonist.io's computer opponents or private games with friends who agree to it. Using it in\n" +
    'public or ranked games against people is cheating, breaks colonist.io\'s rules, and can get\n' +
    'your account banned. Advice mode (the default) only shows suggestions.',

  async prepare() {
    this.cal = loadCalibration();
  },

  async transform() {
    const b = this.cal.board;
    const rot = ((b.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    return {
      toScreen: ({ x, y }) => ({
        x: b.centerX + (x * cos - y * sin) * b.hexSize,
        y: b.centerY + (x * sin + y * cos) * b.hexSize,
      }),
    };
  },

  async readSnapshot() {
    throw new Error(
      'Reading colonist.io game state is not implemented yet. Record a session with\n' +
      '  node bridge/record-colonist.js\n' +
      'and implement readSnapshot() in bridge/profiles/colonist.js from the recorded\n' +
      'messages (see bridge/README.md).'
    );
  },

  async handlePrompt() {
    return false;
  },

  async control(driver, name) {
    const c = this.cal.controls && this.cal.controls[name];
    if (!c) throw new Error(`No "${name}" control in the colonist calibration file`);
    if (typeof c === 'string') return driver.clickSelector(c);
    return driver.clickPoint({ x: c.x, y: c.y });
  },

  async performMove(move, driver) {
    switch (move.kind) {
      case 'placeSettlement': return driver.clickVertex(move.vertex);
      case 'placeRoad':
      case 'placeFreeRoad': return driver.clickEdge(move.edge);
      case 'moveRobber': return driver.clickHex(move.hex);
      case 'buildSettlement': await this.control(driver, 'buildSettlement'); return driver.clickVertex(move.vertex);
      case 'buildCity': await this.control(driver, 'buildCity'); return driver.clickVertex(move.vertex);
      case 'buildRoad': await this.control(driver, 'buildRoad'); return driver.clickEdge(move.edge);
      case 'roll': return this.control(driver, 'roll');
      case 'endTurn': return this.control(driver, 'endTurn');
      case 'buyDevCard': return this.control(driver, 'buyDevCard');
      default:
        // Dialog-based moves (discard, steal, development cards, bank trades)
        // need selectors for colonist.io's dialogs, taken from a recording.
        throw new Error(`colonist profile cannot perform "${move.kind}" yet; add it from a recorded session`);
    }
  },
};
