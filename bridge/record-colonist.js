#!/usr/bin/env node
/*
 * Records a colonist.io session so the colonist profile's game-state reader
 * can be written from real data. Run it on your own computer (it opens a
 * visible browser), play a game normally, then press Ctrl+C.
 *
 *   node bridge/record-colonist.js              record a session
 *   node bridge/record-colonist.js --calibrate  measure the board position for the autopilot
 *
 * A recording (bridge/recordings/<time>/) contains:
 *   frames.jsonl     every WebSocket message sent and received, with timestamps
 *   clicks.jsonl     your clicks: position plus the element under the pointer
 *   screens/*.png    a screenshot every few seconds and after clicks
 *   page.html        the page's HTML when you stop
 * It records only your own browser session. Your login stays in
 * bridge/.colonist-browser so you don't have to sign in every time; delete that
 * folder to sign out.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const calibrate = args.includes('--calibrate');
const URL = 'https://colonist.io/';

async function openBrowser() {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.colonist-browser'), {
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

async function captureClicks(page, onClick) {
  await page.exposeBinding('__catanRecordClick', (_src, info) => onClick(info));
  const script = () => {
    const describe = el => {
      const parts = [];
      for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
        let s = e.tagName.toLowerCase();
        if (e.id) s += '#' + e.id;
        else if (typeof e.className === 'string' && e.className.trim()) s += '.' + e.className.trim().split(/\s+/).slice(0, 3).join('.');
        parts.unshift(s);
      }
      return parts.join(' > ');
    };
    window.addEventListener('mousedown', ev => {
      const el = ev.target;
      window.__catanRecordClick({
        t: Date.now(), x: ev.clientX, y: ev.clientY, button: ev.button,
        path: describe(el), text: (el.innerText || el.getAttribute('aria-label') || '').slice(0, 60),
      });
    }, true);
  };
  await page.addInitScript(script);
  await page.evaluate(script).catch(() => {});
}

async function record() {
  const dir = path.join(__dirname, 'recordings', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(path.join(dir, 'screens'), { recursive: true });
  const frames = fs.createWriteStream(path.join(dir, 'frames.jsonl'));
  const clicks = fs.createWriteStream(path.join(dir, 'clicks.jsonl'));
  const { ctx, page } = await openBrowser();
  let nFrames = 0;
  let nShots = 0;

  const onSocket = ws => {
    const write = dir => payload => {
      nFrames++;
      const binary = typeof payload !== 'string';
      frames.write(JSON.stringify({ t: Date.now(), dir, url: ws.url(), binary, data: binary ? Buffer.from(payload).toString('base64') : payload }) + '\n');
    };
    ws.on('framesent', e => write('sent')(e.payload));
    ws.on('framereceived', e => write('received')(e.payload));
  };
  page.on('websocket', onSocket);

  const shot = async () => {
    try { await page.screenshot({ path: path.join(dir, 'screens', String(nShots++).padStart(5, '0') + '.png') }); } catch (e) { /* page busy */ }
  };
  let lastClickShot = 0;
  await captureClicks(page, info => {
    clicks.write(JSON.stringify(info) + '\n');
    if (Date.now() - lastClickShot > 800) { lastClickShot = Date.now(); setTimeout(shot, 400); }
  });
  await page.goto(URL);
  const timer = setInterval(shot, 4000);
  console.log(`Recording to ${path.relative(process.cwd(), dir)}`);
  console.log('Play a game in the browser window (a game against computer opponents is ideal). Press Ctrl+C to stop.');

  const stop = async () => {
    clearInterval(timer);
    try { fs.writeFileSync(path.join(dir, 'page.html'), await page.content()); } catch (e) { /* closed */ }
    frames.end();
    clicks.end();
    console.log(`\nSaved ${nFrames} messages and ${nShots} screenshots to ${path.relative(process.cwd(), dir)}`);
    await ctx.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  ctx.on('close', stop);
}

async function runCalibration() {
  const { ctx, page } = await openBrowser();
  const queue = [];
  let waiting = null;
  await captureClicks(page, info => {
    if (waiting) { const w = waiting; waiting = null; w(info); } else queue.push(info);
  });
  await page.goto(URL);
  const nextClick = () => new Promise(res => { queue.length = 0; waiting = res; });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));

  await ask('Start or open a game so the board is visible, then press Enter here. ');
  console.log('Click the exact CENTER of the middle tile of the board.');
  const c = await nextClick();
  console.log('Now click the exact CENTER of the tile directly to its RIGHT.');
  const r = await nextClick();
  const dx = r.x - c.x;
  const dy = r.y - c.y;
  const dist = Math.hypot(dx, dy);
  const cal = {
    board: {
      centerX: Math.round(c.x),
      centerY: Math.round(c.y),
      hexSize: +(dist / Math.sqrt(3)).toFixed(2), // center-to-center distance = sqrt(3) * hex radius
      rotation: +((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2),
    },
    controls: {},
  };
  const file = path.join(__dirname, 'profiles', 'colonist.calibration.json');
  if (fs.existsSync(file)) cal.controls = JSON.parse(fs.readFileSync(file, 'utf8')).controls || {};
  for (const name of ['roll', 'endTurn', 'buildRoad', 'buildSettlement', 'buildCity', 'buyDevCard', 'trade']) {
    queue.length = 0;
    await ask(`Click the "${name}" button in the game (it's fine if it does something), then press Enter. Press Enter alone to skip. `);
    const hit = queue[queue.length - 1];
    if (hit) cal.controls[name] = { x: hit.x, y: hit.y, seen: hit.path };
  }
  fs.writeFileSync(file, JSON.stringify(cal, null, 2) + '\n');
  console.log(`Saved ${path.relative(process.cwd(), file)}:`, JSON.stringify(cal.board));
  rl.close();
  await ctx.close();
}

(calibrate ? runCalibration() : record()).catch(e => {
  console.error(e);
  process.exit(1);
});
