/*
 * Finds colonist's board in a screenshot, so board clicks don't depend on a
 * guessed or remembered position.
 *
 * colonist draws a pale square number token on every tile except the desert,
 * always the same distance below the tile's center. The game state says which
 * tiles have tokens, so matching the tokens found in the screenshot to those
 * tiles gives the board's exact position and size on screen.
 *
 *   locateBoard(image, tiles) -> { centerX, centerY, hexSize, rotation, matched, error } | null
 *     image  { width, height, data }  RGBA pixels in CSS pixels (decodePNG)
 *     tiles  [{ x, y, desert }]       tile centers in board units (hex radius 1)
 *
 * No dependencies: PNG decoding uses Node's zlib.
 */
'use strict';

const zlib = require('zlib');
const { fitSimilarity } = require('./fit.js');

// Token center below its tile's center, in hex radii (measured on colonist's
// board against the glowing corner markers during setup).
const TOKEN_DY = 0.32;

/** Decodes an 8-bit, non-interlaced PNG (what browsers' screenshots are) to RGBA. */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('unsupported PNG (needs 8-bit, non-interlaced)');
      colorType = body[9];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = { 2: 3, 6: 4, 0: 1, 4: 2 }[colorType];
  if (!bpp) throw new Error('unsupported PNG color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const s = x * bpp;
      if (bpp >= 3) { data[o] = cur[s]; data[o + 1] = cur[s + 1]; data[o + 2] = cur[s + 2]; data[o + 3] = bpp === 4 ? cur[s + 3] : 255; } else {
        data[o] = data[o + 1] = data[o + 2] = cur[s];
        data[o + 3] = bpp === 2 ? cur[s + 1] : 255;
      }
    }
    cur.copy(prev);
  }
  return { width, height, data };
}

/** Connected blobs of pixels that pass `ok(r, g, b)`. */
function blobs({ width: W, height: H, data }, ok) {
  const seen = new Uint8Array(W * H);
  const out = [];
  const stack = [];
  for (let s = 0; s < W * H; s++) {
    if (seen[s]) continue;
    seen[s] = 1;
    if (!ok(data[s * 4], data[s * 4 + 1], data[s * 4 + 2])) continue;
    const b = { n: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      const x = p % W;
      const y = (p - x) / W;
      b.n++; b.sx += x; b.sy += y;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      const next = [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1];
      for (const q of next) {
        if (q < 0 || seen[q]) continue;
        if (ok(data[q * 4], data[q * 4 + 1], data[q * 4 + 2])) { seen[q] = 1; stack.push(q); }
      }
    }
    b.w = b.x1 - b.x0 + 1;
    b.h = b.y1 - b.y0 + 1;
    out.push(b);
  }
  return out;
}

/** The pale, square, same-sized blobs that look like number tokens. */
function findTokens(image) {
  const pale = (r, g, b) => Math.min(r, g, b) > 205 && Math.max(r, g, b) - Math.min(r, g, b) < 30;
  const squares = blobs(image, pale).filter(b => b.w >= 12 && b.w <= 150 && b.w / b.h > 0.8 && b.w / b.h < 1.25 && b.n > 0.55 * b.w * b.h);
  // The largest group of squares of one size: tokens (other pale squares, such
  // as port labels, dice and panels, come in other sizes or fewer copies).
  let best = [];
  for (const c of squares) {
    const group = squares.filter(o => Math.abs(o.w - c.w) <= 0.15 * c.w && Math.abs(o.h - c.h) <= 0.15 * c.h);
    if (group.length > best.length) best = group;
  }
  // Center of the bounding box: the digits inside a token are holes in the blob.
  return best.map(b => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, size: (b.w + b.h) / 2 }));
}

/**
 * Matches the tokens in the screenshot to the tiles that carry one and returns
 * where the board is (board origin, hex radius and rotation, in CSS pixels).
 */
function locateBoard(image, tiles) {
  const tokens = findTokens(image);
  const spots = tiles.filter(t => !t.desert).map(t => ({ x: t.x, y: t.y + TOKEN_DY }));
  if (tokens.length < Math.min(10, spots.length) || !spots.length) return null;
  // Hex radius from the spacing of neighbouring tokens (neighbour tiles are √3 apart).
  const nn = tokens.map(a => Math.min(...tokens.filter(b => b !== a).map(b => Math.hypot(a.x - b.x, a.y - b.y)))).sort((a, b) => a - b);
  const size0 = nn[Math.floor(nn.length / 2)] / Math.sqrt(3);
  // Try lining each token up with each spot; keep the alignment most tokens agree with.
  const near = (fit, tol) => {
    const rot = (fit.rotation * Math.PI) / 180;
    const pairs = [];
    let err = 0;
    for (const t of tokens) {
      let best = null;
      let bd = Infinity;
      for (const s of spots) {
        const px = fit.centerX + (s.x * Math.cos(rot) - s.y * Math.sin(rot)) * fit.hexSize;
        const py = fit.centerY + (s.x * Math.sin(rot) + s.y * Math.cos(rot)) * fit.hexSize;
        const d = Math.hypot(px - t.x, py - t.y);
        if (d < bd) { bd = d; best = s; }
      }
      if (bd < tol * fit.hexSize) { pairs.push({ board: best, screen: t }); err = Math.max(err, bd); }
    }
    return { pairs, err };
  };
  let best = null;
  for (const t of tokens) {
    for (const s of spots) {
      const guess = { centerX: t.x - s.x * size0, centerY: t.y - s.y * size0, hexSize: size0, rotation: 0 };
      const { pairs } = near(guess, 0.3);
      if (!best || pairs.length > best.pairs.length) best = { guess, pairs };
    }
  }
  if (!best || best.pairs.length < Math.min(10, spots.length)) return null;
  // Refine with every matched token, then once more with the refined position.
  let fit = fitSimilarity(best.pairs) || best.guess;
  const final = near(fit, 0.3);
  if (final.pairs.length >= best.pairs.length) fit = fitSimilarity(final.pairs) || fit;
  const check = near(fit, 0.3);
  // Each tile should hold one token; two tokens on one tile means a bad match.
  const used = new Set(check.pairs.map(p => p.board));
  if (used.size !== check.pairs.length) return null;
  return { centerX: fit.centerX, centerY: fit.centerY, hexSize: fit.hexSize, rotation: fit.rotation, matched: check.pairs.length, tokens: tokens.length, error: check.err / fit.hexSize };
}

module.exports = { decodePNG, findTokens, locateBoard, TOKEN_DY };
