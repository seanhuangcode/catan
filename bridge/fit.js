/*
 * Fits the board-to-screen mapping (scale, rotation, offset) from pairs of
 * board positions and the screen points where they were seen. Least squares
 * over complex numbers: screen = a * board + b, with a = scale * e^(i * angle).
 */
'use strict';

function fitSimilarity(pairs) {
  const n = pairs.length;
  if (n < 2) return null;
  let mbx = 0, mby = 0, msx = 0, msy = 0;
  for (const { board, screen } of pairs) { mbx += board.x; mby += board.y; msx += screen.x; msy += screen.y; }
  mbx /= n; mby /= n; msx /= n; msy /= n;
  let num_re = 0, num_im = 0, den = 0;
  for (const { board, screen } of pairs) {
    const bx = board.x - mbx, by = board.y - mby, sx = screen.x - msx, sy = screen.y - msy;
    // (s) * conj(b)
    num_re += sx * bx + sy * by;
    num_im += sy * bx - sx * by;
    den += bx * bx + by * by;
  }
  if (den < 1e-9) return null;
  const ar = num_re / den, ai = num_im / den;
  const scale = Math.hypot(ar, ai);
  const rotation = (Math.atan2(ai, ar) * 180) / Math.PI;
  // b = ms - a * mb
  const cx = msx - (ar * mbx - ai * mby);
  const cy = msy - (ar * mby + ai * mbx);
  let err = 0;
  for (const { board, screen } of pairs) {
    const px = ar * board.x - ai * board.y + cx, py = ar * board.y + ai * board.x + cy;
    err = Math.max(err, Math.hypot(px - screen.x, py - screen.y));
  }
  return { centerX: cx, centerY: cy, hexSize: scale, rotation, maxError: err };
}

module.exports = { fitSimilarity };
