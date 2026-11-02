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
 *   frames.jsonl.gz  every WebSocket message sent and received, with timestamps
 *   clicks.jsonl     your clicks: position plus the element under the pointer
 *   screens/*.jpg    a screenshot every few seconds and after clicks
 *   dom/*.html.gz    the page's HTML (every frame) once a minute and when you stop
 * Screenshots are small JPEGs and the rest is compressed, so a full game
 * stays well under GitHub's 100 MB per-file limit.
 * It records only your own browser session. Your login stays in
 * bridge/.colonist-browser so you don't have to sign in every time; delete that
 * folder to sign out.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const calibrate = args.includes('--calibrate');
// --url and --headless exist for testing the recorder against another page.
const urlArg = args.indexOf('--url');
const URL = urlArg >= 0 ? args[urlArg + 1] : 'https://colonist.io/';
const HEADLESS = args.includes('--headless');

async function openBrowser() {
  const ctx = await chromium.launchPersistentContext(path.join(__dirname, '.colonist-browser'), {
    headless: HEADLESS,
    viewport: HEADLESS ? { width: 1400, height: 900 } : null,
    // We close the browser ourselves on Ctrl+C, after saving everything.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
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
  fs.mkdirSync(path.join(dir, 'dom'), { recursive: true });
  const framesFile = fs.createWriteStream(path.join(dir, 'frames.jsonl.gz'));
  const frames = zlib.createGzip();
  frames.pipe(framesFile);
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
    const file = path.join(dir, 'screens', String(nShots++).padStart(5, '0') + '.jpg');
    try { await page.screenshot({ path: file, type: 'jpeg', quality: 60, scale: 'css' }); } catch (e) { /* page busy */ }
  };
  let nDom = 0;
  const saveDom = async () => {
    try {
      const parts = [];
      for (const f of page.frames()) {
        parts.push(`<!-- frame: ${f.url()} -->\n` + await f.content());
      }
      fs.writeFileSync(path.join(dir, 'dom', String(nDom++).padStart(4, '0') + '.html.gz'), zlib.gzipSync(parts.join('\n')));
    } catch (e) { /* navigating */ }
  };
  let lastClickShot = 0;
  await captureClicks(page, info => {
    clicks.write(JSON.stringify(info) + '\n');
    if (Date.now() - lastClickShot > 800) { lastClickShot = Date.now(); setTimeout(shot, 400); }
  });
  await page.goto(URL);
  if (process.env.CATAN_RECORDER_SELFTEST) {
    // Test hook: real mouse clicks, to check that clicks get recorded.
    await page.mouse.click(300, 300);
    await page.mouse.click(700, 450);
  }
  const timer = setInterval(shot, 5000);
  const domTimer = setInterval(saveDom, 60000);
  console.log(`Recording to ${path.relative(process.cwd(), dir)}`);
  console.log('Play a game in the browser window (a game against computer opponents is ideal). Press Ctrl+C to stop.');

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(domTimer);
    await saveDom();
    // Wait until everything is written to disk before exiting.
    await Promise.all([
      new Promise(res => { framesFile.on('finish', res); frames.end(); }),
      new Promise(res => clicks.end(res)),
    ]);
    console.log(`\nSaved ${nFrames} messages and ${nShots} screenshots to ${path.relative(process.cwd(), dir)}`);
    await ctx.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', stop);
  ctx.on('close', stop);
}

async function runCalibration() {
  const { ctx, page } = await openBrowser();
  process.on('SIGINT', () => ctx.close().finally(() => process.exit(0)));
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
