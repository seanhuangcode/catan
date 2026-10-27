/*
 * Mouse-input driver shared by all site profiles. It turns board locations
 * (snapshot coordinates) into screen points using a board transform, and
 * clicks with real mouse events through Playwright (move, press, release),
 * the same input a person produces.
 */
'use strict';

const SQ3 = Math.sqrt(3);

/** Position of a board location in hex units (hex radius = 1, board center = 0,0). */
const geometry = {
  hex([q, r]) {
    return { x: SQ3 * (q + r / 2), y: 1.5 * r };
  },
  vertex([q, r, c]) {
    const h = geometry.hex([q, r]);
    const a = (Math.PI / 180) * (60 * c - 90);
    return { x: h.x + Math.cos(a), y: h.y + Math.sin(a) };
  },
  edge([q, r, s]) {
    const a = geometry.vertex([q, r, s]);
    const b = geometry.vertex([q, r, (s + 1) % 6]);
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  },
};

const sleep = ms => new Promise(res => setTimeout(res, ms));

class Driver {
  /**
   * @param {import('playwright').Page} page
   * @param {{toScreen: function({x,y}): {x,y}}} transform  board units -> page pixels
   * @param {object} [opts]
   * @param {number} [opts.pause=120]  ms to wait after each click so the page can react
   */
  constructor(page, transform, opts = {}) {
    this.page = page;
    this.transform = transform;
    this.pause = opts.pause !== undefined ? opts.pause : 120;
  }

  async clickPoint(pt) {
    await this.page.mouse.move(pt.x, pt.y, { steps: 4 });
    await this.page.mouse.down();
    await this.page.mouse.up();
    await sleep(this.pause);
  }

  clickVertex(ref) { return this.clickPoint(this.transform.toScreen(geometry.vertex(ref))); }
  clickEdge(ref) { return this.clickPoint(this.transform.toScreen(geometry.edge(ref))); }
  clickHex(ref) { return this.clickPoint(this.transform.toScreen(geometry.hex(ref))); }

  /** Clicks the center of the first visible element matching `selector`. */
  async clickSelector(selector, opts = {}) {
    const el = this.page.locator(selector).first();
    await el.waitFor({ state: 'visible', timeout: opts.timeout || 3000 });
    const box = await el.boundingBox();
    if (!box) throw new Error('Element has no box: ' + selector);
    await this.clickPoint({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
  }

  async clickTimes(selector, n) {
    for (let i = 0; i < n; i++) await this.clickSelector(selector);
  }

  /** Advice mode: draws a marker on the page at the move's board location, with a label. */
  async showAdvice(move, label) {
    let pt = null;
    if (move.vertex) pt = this.transform.toScreen(geometry.vertex(move.vertex));
    else if (move.edge) pt = this.transform.toScreen(geometry.edge(move.edge));
    else if (move.hex) pt = this.transform.toScreen(geometry.hex(move.hex));
    await this.page.evaluate(({ pt, label }) => {
      let box = document.getElementById('catan-advice');
      if (!box) {
        box = document.createElement('div');
        box.id = 'catan-advice';
        box.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
        document.body.appendChild(box);
      }
      const ring = pt ? `<div style="position:absolute;left:${pt.x - 18}px;top:${pt.y - 18}px;width:36px;height:36px;border:4px solid #ff2d95;border-radius:50%;box-shadow:0 0 12px #ff2d95"></div>` : '';
      box.innerHTML = ring + `<div style="position:absolute;left:12px;bottom:12px;background:#1b1b1f;color:#fff;font:600 14px system-ui;padding:8px 12px;border-radius:8px">Suggested: ${label}</div>`;
    }, { pt, label });
  }
}

module.exports = { Driver, geometry, sleep };
