/*
 * Board geometry and random map generation.
 *
 * The board uses pointy-top hexes in axial coordinates (radius 2, 19 tiles),
 * laid out in rows of 3-4-5-4-3 like the classic base game. Coordinates are in
 * "hex units" (hex radius = 1); the UI scales them to pixels.
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  C.RESOURCES = ['wood', 'brick', 'sheep', 'wheat', 'ore'];

  C.COSTS = {
    road: { wood: 1, brick: 1 },
    settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
    city: { wheat: 2, ore: 3 },
    dev: { sheep: 1, wheat: 1, ore: 1 },
  };

  // Number of "pips" (dots) on each number token = ways to roll it out of 36.
  C.PIPS = { 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1 };

  C.shuffle = function (arr, rng) {
    rng = rng || Math.random;
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  };

  const TILE_POOL = [].concat(
    Array(4).fill('wood'),
    Array(3).fill('brick'),
    Array(4).fill('sheep'),
    Array(4).fill('wheat'),
    Array(3).fill('ore'),
    ['desert']
  );
  const NUMBER_POOL = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];
  const PORT_POOL = ['any', 'any', 'any', 'any', 'wood', 'brick', 'sheep', 'wheat', 'ore'];
  const AXIAL_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  // Spacing (in coastal edges) between consecutive harbors around the 30-edge coastline.
  const PORT_GAPS = [3, 3, 4, 3, 3, 4, 3, 3, 4];

  function buildGeometry() {
    const SQ3 = Math.sqrt(3);
    const hexes = [];
    const vertices = [];
    const edges = [];
    const hexKey = new Map();
    const vertexKey = new Map();
    const edgeKey = new Map();

    for (let r = -2; r <= 2; r++) {
      for (let q = Math.max(-2, -r - 2); q <= Math.min(2, -r + 2); q++) {
        const id = hexes.length;
        hexes.push({
          id, q, r,
          x: SQ3 * (q + r / 2),
          y: 1.5 * r,
          resource: null,
          number: null,
          vertices: [],
          edges: [],
          neighbors: [],
        });
        hexKey.set(q + ',' + r, id);
      }
    }

    for (const h of hexes) {
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 180) * (60 * i - 90);
        const x = h.x + Math.cos(ang);
        const y = h.y + Math.sin(ang);
        const key = Math.round(x * 1000) + ',' + Math.round(y * 1000);
        let vid = vertexKey.get(key);
        if (vid === undefined) {
          vid = vertices.length;
          vertices.push({ id: vid, x, y, hexes: [], adj: [], edges: [], building: null, port: null });
          vertexKey.set(key, vid);
        }
        vertices[vid].hexes.push(h.id);
        h.vertices.push(vid);
      }
    }

    for (const h of hexes) {
      for (let i = 0; i < 6; i++) {
        const a = h.vertices[i];
        const b = h.vertices[(i + 1) % 6];
        const key = Math.min(a, b) + '-' + Math.max(a, b);
        let eid = edgeKey.get(key);
        if (eid === undefined) {
          eid = edges.length;
          edges.push({ id: eid, v: [a, b], hexes: [], road: null });
          edgeKey.set(key, eid);
          vertices[a].adj.push(b);
          vertices[b].adj.push(a);
          vertices[a].edges.push(eid);
          vertices[b].edges.push(eid);
        }
        edges[eid].hexes.push(h.id);
        h.edges.push(eid);
      }
      for (const [dq, dr] of AXIAL_DIRS) {
        const n = hexKey.get((h.q + dq) + ',' + (h.r + dr));
        if (n !== undefined) h.neighbors.push(n);
      }
    }

    return { hexes, vertices, edges };
  }

  function numbersOk(hexes, strict) {
    for (const h of hexes) {
      if (!h.number) continue;
      const red = h.number === 6 || h.number === 8;
      for (const nid of h.neighbors) {
        const n = hexes[nid].number;
        if (!n) continue;
        if (red && (n === 6 || n === 8)) return false;
        if (strict && n === h.number) return false;
      }
    }
    return true;
  }

  /**
   * Generates a random base-game map. Red numbers (6 and 8) are never adjacent
   * and, when possible, identical numbers are not adjacent either.
   */
  C.generateBoard = function (rng) {
    rng = rng || Math.random;
    const { hexes, vertices, edges } = buildGeometry();

    const tiles = C.shuffle(TILE_POOL.slice(), rng);
    let desert = 0;
    hexes.forEach((h, i) => {
      h.resource = tiles[i];
      if (h.resource === 'desert') desert = h.id;
    });

    let fallback = null;
    for (let attempt = 0; attempt < 4000; attempt++) {
      const nums = C.shuffle(NUMBER_POOL.slice(), rng);
      let k = 0;
      for (const h of hexes) h.number = h.resource === 'desert' ? null : nums[k++];
      if (numbersOk(hexes, true)) { fallback = null; break; }
      if (!fallback && numbersOk(hexes, false)) fallback = hexes.map(h => h.number);
    }
    if (fallback) hexes.forEach((h, i) => { h.number = fallback[i]; });

    const coast = edges.filter(e => e.hexes.length === 1).map(e => {
      const a = vertices[e.v[0]];
      const b = vertices[e.v[1]];
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      return { e, mx, my, ang: Math.atan2(my, mx) };
    });
    coast.sort((a, b) => a.ang - b.ang);

    const portTypes = C.shuffle(PORT_POOL.slice(), rng);
    const ports = [];
    let idx = 0;
    for (let i = 0; i < PORT_GAPS.length; i++) {
      const c = coast[idx % coast.length];
      const h = hexes[c.e.hexes[0]];
      const dx = c.mx - h.x;
      const dy = c.my - h.y;
      const len = Math.hypot(dx, dy);
      const type = portTypes[i];
      ports.push({
        edge: c.e.id,
        type,
        vertices: c.e.v.slice(),
        x: c.mx + (dx / len) * 0.62,
        y: c.my + (dy / len) * 0.62,
      });
      for (const vid of c.e.v) vertices[vid].port = type;
      idx += PORT_GAPS[i];
    }

    return { hexes, vertices, edges, ports, robber: desert };
  };
})(Catan);
