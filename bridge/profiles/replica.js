/*
 * Site profile for this repo's own board (index.html). It is the reference
 * implementation of a profile and the test target for the autopilot:
 *   - readSnapshot: builds a snapshot of the human seat from the page
 *   - transform:    maps board coordinates to screen pixels from the SVG
 *   - performMove:  carries out a move with mouse clicks on the real UI
 */
'use strict';

const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  name: 'replica',
  defaultUrl: 'file://' + path.join(ROOT, 'index.html'),
  autoByDefault: true,

  async prepare(page) {
    await page.addScriptTag({ path: path.join(ROOT, 'bridge', 'snapshot.js') });
  },

  /** Fills in the start screen and starts a game (for unattended demos). */
  async startGame(page, opts = {}) {
    if (opts.speed) await page.selectOption('select[name=speed]', opts.speed);
    if (opts.brain) await page.selectOption('select[name=brain]', opts.brain);
    await page.click('button[type=submit]');
  },

  async readSnapshot(page) {
    return page.evaluate(() => {
      const c = window.Catan && window.Catan.current;
      if (!c) return null;
      const snap = window.Catan.Bridge.toSnapshot(c.game, c.ui.human);
      const d = c.ui.dialog;
      snap.prompt = d ? d.id : null; // open dialog, if any
      return snap;
    });
  },

  async transform(page) {
    const t = await page.evaluate(() => {
      const svg = document.getElementById('board');
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const scale = Math.min(r.width / vb.width, r.height / vb.height);
      return {
        scale,
        ox: r.left + (r.width - vb.width * scale) / 2 - vb.x * scale,
        oy: r.top + (r.height - vb.height * scale) / 2 - vb.y * scale,
      };
    });
    const S = 60; // SVG units per hex unit (js/ui.js)
    return { toScreen: ({ x, y }) => ({ x: t.ox + x * S * t.scale, y: t.oy + y * S * t.scale }) };
  },

  /** Cancels a half-finished build mode before the next move. */
  async reset(page) {
    await page.keyboard.press('Escape');
  },

  /** Handles dialogs the policy doesn't decide (bot trade offers): decline them. */
  async handlePrompt(page, snap, driver) {
    if (snap.prompt === 'offer') {
      await driver.clickSelector('[data-act=no]');
      return true;
    }
    return false;
  },

  async performMove(move, driver) {
    const pick = r => `.pick-card[data-r=${r}][data-d="1"]`;
    switch (move.kind) {
      case 'placeSettlement': return driver.clickVertex(move.vertex);
      case 'placeRoad':
      case 'placeFreeRoad': return driver.clickEdge(move.edge);
      case 'moveRobber': return driver.clickHex(move.hex);
      case 'buildSettlement':
        await driver.clickSelector('button[data-action=settlement]');
        return driver.clickVertex(move.vertex);
      case 'buildCity':
        await driver.clickSelector('button[data-action=city]');
        return driver.clickVertex(move.vertex);
      case 'buildRoad':
        await driver.clickSelector('button[data-action=road]');
        return driver.clickEdge(move.edge);
      case 'roll': return driver.clickSelector('button[data-action=roll]');
      case 'endTurn': return driver.clickSelector('button[data-action=end]');
      case 'buyDevCard': return driver.clickSelector('button[data-action=dev]');
      case 'playKnight': return driver.clickSelector('[data-dev=knight]');
      case 'playRoadBuilding': return driver.clickSelector('[data-dev=roadBuilding]');
      case 'playYearOfPlenty':
        await driver.clickSelector('[data-dev=yearOfPlenty]');
        for (const r of move.resources) await driver.clickSelector(pick(r));
        return driver.clickSelector('[data-act=ok]');
      case 'playMonopoly':
        await driver.clickSelector('[data-dev=monopoly]');
        return driver.clickSelector(`.pick-card[data-r=${move.resource}]`);
      case 'steal': return driver.clickSelector(`.choice[data-p="${move.victim}"]`);
      case 'discard':
        for (const [r, n] of Object.entries(move.cards)) await driver.clickTimes(pick(r), n);
        return driver.clickSelector('[data-act=ok]');
      case 'offer': {
        await driver.clickSelector('button[data-action=trade]');
        for (const [r, n] of Object.entries(move.give)) await driver.clickTimes(`.trade-row:nth-child(1) ${pick(r)}`, n);
        for (const [r, n] of Object.entries(move.get)) await driver.clickTimes(`.trade-row:nth-child(2) ${pick(r)}`, n);
        await driver.clickSelector('[data-act=offer]');
        // Wait for the answers, then take the trade with the first player who accepted.
        await driver.page.waitForSelector('.responses .response', { timeout: 5000 });
        if (await driver.page.locator('.btn.accept').count()) await driver.clickSelector('.btn.accept');
        return driver.clickSelector('[data-act=close]');
      }
      case 'bankTrade': {
        await driver.clickSelector('button[data-action=trade]');
        for (const [r, n] of Object.entries(move.give)) await driver.clickTimes(`.trade-row:nth-child(1) ${pick(r)}`, n);
        for (const [r, n] of Object.entries(move.get)) await driver.clickTimes(`.trade-row:nth-child(2) ${pick(r)}`, n);
        await driver.clickSelector('[data-act=bank]');
        return driver.clickSelector('[data-act=close]');
      }
      default: throw new Error('replica profile cannot perform ' + move.kind);
    }
  },
};
