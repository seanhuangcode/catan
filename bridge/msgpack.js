/*
 * Minimal MessagePack decoder (https://msgpack.org/), enough to read
 * colonist.io's WebSocket messages. Extension types are returned as
 * {ext: type, data: Uint8Array}.
 */
'use strict';

function decode(bytes, start = 0) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = start;
  const text = new TextDecoder();

  const str = n => { const s = text.decode(buf.subarray(pos, pos + n)); pos += n; return s; };
  const bin = n => { const b = buf.slice(pos, pos + n); pos += n; return b; };
  const arr = n => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = read(); return a; };
  const map = n => {
    const o = {};
    for (let i = 0; i < n; i++) {
      const k = read();
      o[typeof k === 'object' ? JSON.stringify(k) : k] = read();
    }
    return o;
  };
  const u8 = () => view.getUint8(pos++);
  const u16 = () => { const v = view.getUint16(pos); pos += 2; return v; };
  const u32 = () => { const v = view.getUint32(pos); pos += 4; return v; };

  function read() {
    if (pos >= buf.length) throw new Error('msgpack: unexpected end of data');
    const b = u8();
    if (b <= 0x7f) return b;
    if (b >= 0xe0) return b - 0x100;
    if ((b & 0xf0) === 0x80) return map(b & 0x0f);
    if ((b & 0xf0) === 0x90) return arr(b & 0x0f);
    if ((b & 0xe0) === 0xa0) return str(b & 0x1f);
    switch (b) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u8());
      case 0xc5: return bin(u16());
      case 0xc6: return bin(u32());
      case 0xc7: { const n = u8(); const t = view.getInt8(pos++); return { ext: t, data: bin(n) }; }
      case 0xc8: { const n = u16(); const t = view.getInt8(pos++); return { ext: t, data: bin(n) }; }
      case 0xc9: { const n = u32(); const t = view.getInt8(pos++); return { ext: t, data: bin(n) }; }
      case 0xca: { const v = view.getFloat32(pos); pos += 4; return v; }
      case 0xcb: { const v = view.getFloat64(pos); pos += 8; return v; }
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: { const v = view.getBigUint64(pos); pos += 8; return Number(v); }
      case 0xd0: return view.getInt8(pos++);
      case 0xd1: { const v = view.getInt16(pos); pos += 2; return v; }
      case 0xd2: { const v = view.getInt32(pos); pos += 4; return v; }
      case 0xd3: { const v = view.getBigInt64(pos); pos += 8; return Number(v); }
      case 0xd4: { const t = view.getInt8(pos++); return { ext: t, data: bin(1) }; }
      case 0xd5: { const t = view.getInt8(pos++); return { ext: t, data: bin(2) }; }
      case 0xd6: { const t = view.getInt8(pos++); return { ext: t, data: bin(4) }; }
      case 0xd7: { const t = view.getInt8(pos++); return { ext: t, data: bin(8) }; }
      case 0xd8: { const t = view.getInt8(pos++); return { ext: t, data: bin(16) }; }
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16());
      case 0xdd: return arr(u32());
      case 0xde: return map(u16());
      case 0xdf: return map(u32());
      default: throw new Error('msgpack: unknown type byte 0x' + b.toString(16));
    }
  }

  const value = read();
  return { value, end: pos };
}

module.exports = { decode };
