// A small GRIB2 reader for DWD's ICON files — only what they use: one field per file, simple values compressed
// with CCSDS / AEC ("template 5.42", the libaec Rice coding), no bitmap. Plain JavaScript, no installs.

// Read a GRIB2 file → Float32Array of values (in the file's order)
export function readGrib(buf) {
  if (buf.toString("latin1", 0, 4) !== "GRIB" || buf[7] !== 2) throw new Error("not a GRIB2 file");
  let p = 16;
  let s5 = null;
  for (;;) {
    if (buf.toString("latin1", p, p + 4) === "7777") break;
    const len = buf.readUInt32BE(p);
    const n = buf[p + 4];
    if (n === 5) s5 = p;
    if (n === 6 && buf[p + 5] !== 255) throw new Error("bitmaps not supported");
    if (n === 7) {
      if (!s5) throw new Error("no section 5");
      return decode(buf, s5, p + 5, p + len);
    }
    p += len;
  }
  throw new Error("no data section");
}

// GRIB's scale factors are sign + size, not the usual two's complement
const signed16 = (v) => (v & 0x8000 ? -(v & 0x7fff) : v);

function decode(buf, s5, start, end) {
  const n = buf.readUInt32BE(s5 + 5);
  const tmpl = buf.readUInt16BE(s5 + 9);
  const R = buf.readFloatBE(s5 + 11);
  const E = signed16(buf.readUInt16BE(s5 + 15));
  const D = signed16(buf.readUInt16BE(s5 + 17));
  const bits = buf[s5 + 19];
  const out = new Float32Array(n);
  const scale = 2 ** E / 10 ** D;
  const base = R / 10 ** D;
  if (bits === 0) return out.fill(base);
  let raw;
  if (tmpl === 42) {
    const flags = buf[s5 + 21];
    const block = buf[s5 + 22];
    const rsi = buf.readUInt16BE(s5 + 23);
    raw = aecDecode(buf.subarray(start, end), n, bits, block, rsi, flags);
  } else if (tmpl === 0) {
    raw = new Uint32Array(n);
    const r = bitReader(buf.subarray(start, end));
    for (let i = 0; i < n; i++) raw[i] = r.get(bits);
  } else throw new Error(`packing template ${tmpl} not supported`);
  for (let i = 0; i < n; i++) out[i] = base + raw[i] * scale;
  return out;
}

function bitReader(b) {
  let pos = 0; // in bits
  return {
    get(n) {
      let v = 0;
      while (n > 0) {
        const off = pos & 7;
        const take = Math.min(8 - off, n);
        v = v * (1 << take) + ((b[pos >>> 3] >> (8 - off - take)) & ((1 << take) - 1));
        pos += take;
        n -= take;
      }
      return v;
    },
    // "fundamental sequence": count the 0 bits before the next 1
    fs() {
      let c = 0;
      for (;;) {
        const off = pos & 7;
        const rest = (b[pos >>> 3] << off) & 0xff;
        if (rest === 0) {
          c += 8 - off;
          pos += 8 - off;
          if (pos >>> 3 >= b.length) throw new Error("AEC data ran out");
        } else {
          const z = Math.clz32(rest) - 24;
          c += z;
          pos += z + 1;
          return c;
        }
      }
    },
    align() {
      pos = (pos + 7) & ~7;
    },
  };
}

// CCSDS 121.0-B (as libaec writes it): blocks of `block` samples, `rsi` blocks per reference sample interval.
// Returns the unsigned whole numbers (before GRIB's scaling).
const AEC_PREPROCESS = 8, AEC_RESTRICTED = 16, AEC_PAD_RSI = 32, AEC_SIGNED = 1;
export function aecDecode(b, n, bits, block, rsi, flags) {
  if (flags & AEC_SIGNED) throw new Error("signed AEC data not supported");
  const pp = !!(flags & AEC_PREPROCESS);
  const idLen = bits > 16 ? 5 : bits > 8 ? 4 : flags & AEC_RESTRICTED && bits <= 4 ? (bits <= 2 ? 1 : 2) : 3;
  const idMax = (1 << idLen) - 1;
  const xmax = 2 ** bits - 1;
  const r = bitReader(b);
  const d = new Uint32Array(n);
  let i = 0; // samples written
  const put = (v) => {
    if (i < n) d[i] = v;
    i++;
  };
  while (i < n) {
    const rsiStart = i;
    let blk = 0; // blocks done in this interval
    while (blk < rsi && i < n) {
      const ref = pp && blk === 0 ? 1 : 0;
      const id = r.get(idLen);
      if (id === 0) {
        const second = r.get(1);
        if (ref) put(r.get(bits));
        if (second) {
          // second extension: pairs coded together
          for (let k = ref; k < block; ) {
            const m = r.fs();
            const beta = Math.floor((Math.sqrt(8 * m + 1) - 1) / 2);
            const d1 = m - (beta * (beta + 1)) / 2;
            if ((k & 1) === 0) {
              put(beta - d1);
              k++;
            }
            put(d1);
            k++;
          }
          blk++;
        } else {
          // zero blocks (5 = "the rest of this 64-block segment")
          let z = r.fs() + 1;
          if (z === 5) z = Math.min(rsi - blk, 64 - (blk % 64));
          else if (z > 5) z--;
          for (let k = z * block - ref; k > 0; k--) put(0);
          blk += z;
        }
      } else if (id === idMax) {
        // stored as is
        for (let k = 0; k < block; k++) put(r.get(bits));
        blk++;
      } else {
        // split: k low bits sent separately from the unary high part
        const k = id - 1;
        if (ref) put(r.get(bits));
        const cnt = block - ref;
        const hi = new Array(cnt);
        for (let j = 0; j < cnt; j++) hi[j] = r.fs();
        const f = 2 ** k;
        for (let j = 0; j < cnt; j++) put(hi[j] * f + (k ? r.get(k) : 0));
        blk++;
      }
    }
    if (flags & AEC_PAD_RSI) r.align();
    // undo the preprocessing (unit-delay prediction + mapping) for this interval
    if (pp) {
      const stop = Math.min(i, n);
      let last = d[rsiStart];
      for (let j = rsiStart + 1; j < stop; j++) {
        const delta = d[j];
        const theta = Math.min(last, xmax - last);
        let x;
        if (delta <= 2 * theta) x = delta & 1 ? last - (delta + 1) / 2 : last + delta / 2;
        else if (last < xmax - last) x = delta; // near the bottom: last + (delta - theta), theta = last
        else x = xmax - delta; // near the top
        d[j] = x;
        last = x;
      }
    }
  }
  return d;
}
