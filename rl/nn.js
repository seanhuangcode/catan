/*
 * A small dependency-free neural network: an MLP trunk with ReLU activations
 * feeding a policy head (one logit per action) and a scalar value head.
 *
 * All weights live in one flat Float32Array so they are easy to optimize,
 * serialize, and share between worker threads. Each weight matrix is stored
 * input-major (row i holds the outgoing weights of input i), which lets the
 * first layer skip the zero entries of the sparse observation.
 */
var Catan = globalThis.Catan || (globalThis.Catan = {});

(function (C) {
  'use strict';

  class Net {
    /** @param {{input:number, hidden:number[], actions:number}} config */
    constructor(config, params) {
      this.config = config;
      const sizes = [config.input, ...config.hidden];
      this.layers = [];
      let off = 0;
      const add = (nIn, nOut) => {
        const layer = { nIn, nOut, w: off, b: off + nIn * nOut };
        off += nIn * nOut + nOut;
        return layer;
      };
      for (let i = 0; i + 1 < sizes.length; i++) this.layers.push(add(sizes[i], sizes[i + 1]));
      const last = sizes[sizes.length - 1];
      this.policy = add(last, config.actions);
      this.valueHead = add(last, 1);
      // Pointer heads (optional): appended last so older checkpoints load as a prefix.
      this.groups = [];
      if (config.pointers) {
        for (const g of C.RL.pointerGroups()) {
          this.groups.push(Object.assign({}, g, { layer: add(last, g.F), z: new Float32Array(g.F), dz: new Float32Array(g.F), feat: new Float32Array(g.count * g.F) }));
        }
        this.dense = new Float32Array(config.input);
      }
      this.size = off;
      this.params = params || new Float32Array(off);
      this.grads = null;

      // Scratch buffers (one forward/backward at a time per Net instance).
      this.acts = config.hidden.map(h => new Float32Array(h));
      this.deltas = config.hidden.map(h => new Float32Array(h));
      this.logits = new Float32Array(config.actions);
      this.value = 0;
    }

    /** He initialization for hidden layers; near-zero heads so the initial policy is uniform. */
    init(rng) {
      rng = rng || Math.random;
      const P = this.params;
      const gauss = () => {
        const u = 1 - rng();
        const v = rng();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
      };
      const fill = (layer, scale) => {
        for (let i = 0; i < layer.nIn * layer.nOut; i++) P[layer.w + i] = gauss() * scale;
        for (let i = 0; i < layer.nOut; i++) P[layer.b + i] = 0;
      };
      for (const l of this.layers) fill(l, Math.sqrt(2 / Math.min(l.nIn, 256)));
      fill(this.policy, 0.01);
      fill(this.valueHead, 0.01);
      for (const g of this.groups) fill(g.layer, 0); // start as a no-op
      return this;
    }

    /** Forward pass on a sparse input. Results land in this.logits / this.value. */
    forward(idx, val) {
      const P = this.params;
      let prev = null;
      for (let li = 0; li < this.layers.length; li++) {
        const l = this.layers[li];
        const out = this.acts[li];
        const nOut = l.nOut;
        for (let o = 0; o < nOut; o++) out[o] = P[l.b + o];
        if (li === 0) {
          for (let k = 0; k < idx.length; k++) {
            const x = val[k];
            const base = l.w + idx[k] * nOut;
            for (let o = 0; o < nOut; o++) out[o] += x * P[base + o];
          }
        } else {
          for (let i = 0; i < l.nIn; i++) {
            const x = prev[i];
            if (x === 0) continue;
            const base = l.w + i * nOut;
            for (let o = 0; o < nOut; o++) out[o] += x * P[base + o];
          }
        }
        for (let o = 0; o < nOut; o++) if (out[o] < 0) out[o] = 0;
        prev = out;
      }
      this.head(this.policy, prev, this.logits);
      const v = new Float32Array(1);
      this.head(this.valueHead, prev, v);
      this.value = v[0];
      if (this.groups.length) this.pointerForward(idx, val, prev);
      return this;
    }

    /** Adds feature(location) . (A h + c) to each location action's logit. */
    pointerForward(idx, val, top) {
      const dense = this.dense;
      dense.fill(0);
      for (let k = 0; k < idx.length; k++) dense[idx[k]] = val[k];
      for (const g of this.groups) {
        this.head(g.layer, top, g.z);
        const feat = g.feat;
        feat.fill(0);
        for (let i = 0; i < g.count; i++) {
          const base = i * g.F;
          for (let k = g.offsets[i]; k < g.offsets[i + 1]; k++) feat[base + g.slots[k]] += dense[g.obs[k]];
          let s = 0;
          for (let f = 0; f < g.F; f++) s += feat[base + f] * g.z[f];
          this.logits[g.start + i] += s;
        }
      }
    }

    head(l, x, out) {
      const P = this.params;
      for (let o = 0; o < l.nOut; o++) out[o] = P[l.b + o];
      for (let i = 0; i < l.nIn; i++) {
        const xi = x[i];
        if (xi === 0) continue;
        const base = l.w + i * l.nOut;
        for (let o = 0; o < l.nOut; o++) out[o] += xi * P[base + o];
      }
    }

    /**
     * Backward pass for the most recent forward(idx, val). Accumulates the
     * gradient of the loss into `grads` given dLoss/dLogits and dLoss/dValue.
     */
    backward(idx, val, dLogits, dValue, grads) {
      const P = this.params;
      const G = grads;
      const nL = this.layers.length;
      const top = this.acts[nL - 1];
      const dTop = this.deltas[nL - 1];
      dTop.fill(0);
      this.headBackward(this.policy, top, dLogits, dTop, G);
      this.headBackward(this.valueHead, top, [dValue], dTop, G);
      for (const g of this.groups) {
        const dz = g.dz;
        dz.fill(0);
        for (let i = 0; i < g.count; i++) {
          const d = dLogits[g.start + i];
          if (d === 0) continue;
          const base = i * g.F;
          for (let f = 0; f < g.F; f++) dz[f] += d * g.feat[base + f];
        }
        this.headBackward(g.layer, top, dz, dTop, G);
      }

      for (let li = nL - 1; li >= 0; li--) {
        const l = this.layers[li];
        const out = this.acts[li];
        const d = this.deltas[li];
        for (let o = 0; o < l.nOut; o++) if (out[o] <= 0) d[o] = 0; // ReLU
        for (let o = 0; o < l.nOut; o++) G[l.b + o] += d[o];
        const nOut = l.nOut;
        if (li === 0) {
          for (let k = 0; k < idx.length; k++) {
            const x = val[k];
            const base = l.w + idx[k] * nOut;
            for (let o = 0; o < nOut; o++) G[base + o] += x * d[o];
          }
        } else {
          const prev = this.acts[li - 1];
          const dPrev = this.deltas[li - 1];
          for (let i = 0; i < l.nIn; i++) {
            const base = l.w + i * nOut;
            const x = prev[i];
            let s = 0;
            if (x !== 0) {
              for (let o = 0; o < nOut; o++) {
                s += P[base + o] * d[o];
                G[base + o] += x * d[o];
              }
            } else {
              for (let o = 0; o < nOut; o++) s += P[base + o] * d[o];
            }
            dPrev[i] = s;
          }
        }
      }
    }

    headBackward(l, x, dOut, dX, G) {
      const P = this.params;
      const nOut = l.nOut;
      for (let o = 0; o < nOut; o++) G[l.b + o] += dOut[o];
      for (let i = 0; i < l.nIn; i++) {
        const base = l.w + i * nOut;
        const xi = x[i];
        let s = 0;
        for (let o = 0; o < nOut; o++) {
          const g = dOut[o];
          if (g === 0) continue;
          s += P[base + o] * g;
          if (xi !== 0) G[base + o] += xi * g;
        }
        dX[i] += s;
      }
    }
  }

  /**
   * Masked softmax over this.logits. Writes probabilities into `probs` (zero
   * for illegal actions) and returns log-sum-exp for log-probabilities.
   */
  function maskedSoftmax(logits, mask, probs) {
    let max = -Infinity;
    for (let a = 0; a < logits.length; a++) if (mask[a] && logits[a] > max) max = logits[a];
    let sum = 0;
    for (let a = 0; a < logits.length; a++) {
      if (mask[a]) {
        const e = Math.exp(logits[a] - max);
        probs[a] = e;
        sum += e;
      } else probs[a] = 0;
    }
    for (let a = 0; a < logits.length; a++) probs[a] /= sum;
    return max + Math.log(sum);
  }

  class Adam {
    constructor(size, opts = {}) {
      this.lr = opts.lr || 3e-4;
      this.b1 = opts.b1 || 0.9;
      this.b2 = opts.b2 || 0.999;
      this.eps = opts.eps || 1e-8;
      this.clip = opts.clip || 1.0;
      this.m = new Float32Array(size);
      this.v = new Float32Array(size);
      this.t = 0;
    }

    /** Applies one update. `grads` holds the summed gradient over `count` samples. */
    step(params, grads, count) {
      const n = params.length;
      let norm = 0;
      for (let i = 0; i < n; i++) norm += (grads[i] / count) ** 2;
      norm = Math.sqrt(norm);
      const scale = (norm > this.clip ? this.clip / norm : 1) / count;
      this.t++;
      const { b1, b2, eps } = this;
      const lr = this.lr * Math.sqrt(1 - b2 ** this.t) / (1 - b1 ** this.t);
      const m = this.m;
      const v = this.v;
      for (let i = 0; i < n; i++) {
        const g = grads[i] * scale;
        m[i] = b1 * m[i] + (1 - b1) * g;
        v[i] = b2 * v[i] + (1 - b2) * g * g;
        params[i] -= lr * m[i] / (Math.sqrt(v[i]) + eps);
      }
      return norm;
    }
  }

  // ------------------------------------------------------- serialization

  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function fromBase64(str) {
    if (typeof Buffer !== 'undefined') {
      const b = Buffer.from(str, 'base64');
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    }
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  // IEEE half-precision conversion, used to halve the size of exported models.
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  function toHalf(x) {
    f32[0] = x;
    const b = u32[0];
    const sign = (b >>> 16) & 0x8000;
    let e = ((b >>> 23) & 0xff) - 127 + 15;
    let m = b & 0x7fffff;
    if (e <= 0) {
      if (e < -10) return sign;
      m = (m | 0x800000) >> (1 - e);
      return sign | ((m + 0x1000) >> 13);
    }
    if (e >= 31) return sign | 0x7c00;
    const h = sign | (e << 10) | (m >> 13);
    return (m & 0x1000) ? h + 1 : h;
  }
  function fromHalf(h) {
    const sign = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) return sign * m * 2 ** -24;
    if (e === 31) return m ? NaN : sign * Infinity;
    return sign * (1 + m / 1024) * 2 ** (e - 15);
  }

  /**
   * Copies weights from `src` into `dst` layer by layer, for networks whose
   * inputs or actions were extended by appending (new rows/columns start at
   * zero, so the new network behaves like the old one at first).
   */
  function transplant(src, dst) {
    const copy = (a, b) => {
      if (!a || !b) return;
      const nIn = Math.min(a.nIn, b.nIn);
      const nOut = Math.min(a.nOut, b.nOut);
      for (let i = 0; i < nIn; i++) {
        for (let o = 0; o < nOut; o++) dst.params[b.w + i * b.nOut + o] = src.params[a.w + i * a.nOut + o];
      }
      for (let o = 0; o < nOut; o++) dst.params[b.b + o] = src.params[a.b + o];
    };
    const zero = l => dst.params.fill(0, l.w, l.b + l.nOut);
    dst.layers.forEach((l, i) => { if (src.layers[i]) { zero(l); copy(src.layers[i], l); } });
    zero(dst.policy);
    copy(src.policy, dst.policy);
    zero(dst.valueHead);
    copy(src.valueHead, dst.valueHead);
    dst.groups.forEach((g, i) => { zero(g.layer); if (src.groups[i]) copy(src.groups[i].layer, g.layer); });
    return dst;
  }

  /** Packs a model as {config, dtype, data} with base64 weights. */
  function exportModel(net, dtype = 'float16', meta = {}) {
    let bytes;
    if (dtype === 'float16') {
      const h = new Uint16Array(net.size);
      for (let i = 0; i < net.size; i++) h[i] = toHalf(net.params[i]);
      bytes = new Uint8Array(h.buffer);
    } else {
      bytes = new Uint8Array(net.params.buffer.slice(net.params.byteOffset, net.params.byteOffset + net.params.byteLength));
    }
    return Object.assign({ config: net.config, dtype, data: toBase64(bytes) }, meta);
  }

  function importModel(model) {
    const bytes = fromBase64(model.data);
    const net = new Net(model.config);
    if (model.dtype === 'float16') {
      const h = new Uint16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      for (let i = 0; i < net.size; i++) net.params[i] = fromHalf(h[i]);
    } else {
      net.params.set(new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    }
    return net;
  }

  C.RL = Object.assign(C.RL || {}, { Net, Adam, maskedSoftmax, transplant, exportModel, importModel });
})(Catan);
