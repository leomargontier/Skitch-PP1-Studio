// Less common embroidery formats, ported from pyembroidery's readers (MIT).
// Same output as readers.js: { threads, cmds } in 0.1 mm, y down, absolute coordinates.
import { Builder, s8, thread, markJumpRunTrims } from './common.js';
import { readDst, readExp, pecStitches } from './readers.js'; // used only inside functions (circular import)
import { PEC_PALETTE, HUS_PALETTE, SHV_PALETTE, SEW_PALETTE } from './palettes.js';

// pyembroidery-style output: stitch/move relative, needle changes become colour changes after the first stitch
class Out extends Builder {
  constructor() { super(); this.sewn = false; this.threads = []; }
  stitch(x, y) { this.rel('stitch', x, y); this.sewn = true; }
  move(x, y) { if (x || y) this.rel('jump', x, y); }
  abs(t, x, y) { this.rel(t, x - this.x, y - this.y); if (t === 'stitch') this.sewn = true; }
  color(x = 0, y = 0) { this.move(x, y); this.mark('color'); }
  needle() { if (this.sewn) this.mark('color'); }
  trim() { this.mark('trim'); }
  done(trimRuns = false) {
    const n = this.cmds.filter((c) => c.t === 'color').length + 1;
    const threads = this.threads.slice(0, Math.max(n, this.threads.length));
    for (let i = threads.length; i < n; i++) threads.push(thread(null, i));
    return { threads, cmds: trimRuns ? markJumpRunTrims(this.cmds) : this.cmds };
  }
}
const pal = (p, i) => { const e = p[i % p.length]; return e ? { rgb: e[0], name: e[1] } : thread(null, i); };
const view = (buf) => new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const s16 = (v) => (v > 0x7fff ? v - 0x10000 : v);
const s24 = (v) => (v > 0x7fffff ? v - 0x1000000 : v);
const u24le = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const u24be = (b, p) => (b[p] << 16) | (b[p + 1] << 8) | b[p + 2];

// ---- 3-byte "sign bits in the control byte" families ----
function zStitches(buf, p) { // DSZ, FXY, GT
  const o = new Out();
  for (; p + 2 < buf.length; p += 3) {
    let y = -buf[p], x = buf[p + 1];
    const c = buf[p + 2];
    if (c & 0x40) x = -x;
    if (c & 0x20) y = -y;
    if ((c & 0x1f) === 0) o.stitch(x, y);
    else if ((c & 0x1f) === 1) o.move(x, y);
    else if (c === 0x82) continue;
    else if (c === 0x9b) o.trim();
    else if (c >= 0x83 && c <= 0x9a) o.needle();
    else break;
  }
  return o.done();
}
function readDsb(buf) {
  const o = new Out();
  for (let p = 512; p + 2 < buf.length; p += 3) {
    const c = buf[p];
    let y = -buf[p + 1], x = buf[p + 2];
    if (c & 0x40) y = -y;
    if (c & 0x20) x = -x;
    if ((c & 0x1f) === 0) o.stitch(x, y);
    else if ((c & 0x1f) === 1) o.move(x, y);
    else if (c === 0xf8) break;
    else if (c === 0xe7) o.trim();
    else if (c === 0xe8) continue;
    else if (c >= 0xe9 && c < 0xf8) o.needle();
    else break;
  }
  return o.done();
}
function readU01(buf) {
  const o = new Out();
  for (let p = 0x100; p + 2 < buf.length; p += 3) {
    const c = buf[p];
    let dy = -buf[p + 1], dx = buf[p + 2];
    if (c & 0x20) dx = -dx;
    if (c & 0x40) dy = -dy;
    const k = c & 0x1f;
    if (k === 0) o.stitch(dx, dy);
    else if (k === 1 || k === 3 || k === 5) o.move(dx, dy);
    else if (k === 2 || k === 4) { if (dx || dy) o.stitch(dx, dy); } // speed change, then maybe a stitch
    else if (k === 6 || k === 7) { o.trim(); o.move(dx, dy); }
    else if (k === 8) o.move(dx, dy);
    else if (k >= 0x09 && k <= 0x17) { o.needle(); o.move(dx, dy); }
    else break;
  }
  return o.done();
}
function read10o(buf) {
  const o = new Out();
  for (let p = 0; p + 2 < buf.length; p += 3) {
    const c = buf[p];
    let y = -buf[p + 1], x = buf[p + 2];
    if (c & 0x20) x = -x;
    if (c & 0x40) y = -y;
    if ((c & 0x1f) === 0) o.stitch(x, y);
    else if ((c & 0x1f) === 0x10) o.move(x, y);
    else if (c === 0x8a || c === 0x82) continue;
    else if (c === 0x85) o.color();
    else if (c === 0x81) o.trim();
    else break;
  }
  return o.done();
}
function readInb(buf) {
  const o = new Out();
  for (let p = 0x2000; p + 2 < buf.length; p += 3) {
    let x = buf[p], y = -buf[p + 1];
    const c = buf[p + 2];
    if (c & 0x20) y = -y;
    if (c & 0x40) x = -x;
    if ((c & 0x0f) === 0) o.stitch(x, y);
    else if ((c & 0x0f) === 1) o.color(x, y);
    else if ((c & 0x0f) === 2) o.move(x, y);
    else break;
  }
  return o.done();
}
function readNew(buf) {
  const o = new Out();
  for (let p = 2; p + 2 < buf.length; p += 3) {
    let x = buf[p], y = -buf[p + 1], c = buf[p + 2];
    if (c & 0x40) x = -x;
    if (c & 0x20) y = -y;
    c &= 0x1f;
    if (c === 0) o.stitch(x, y);
    else if (c === 0x11) break;
    else if (c & 0x02) o.color();
    else if (c & 0x01) o.move(x, y);
  }
  return o.done();
}
function readZxy(buf) {
  const o = new Out();
  for (let p = 3 + ((buf[1] << 8) | buf[2]); p + 2 < buf.length; p += 3) {
    let c = buf[p], x = buf[p + 1], y = -buf[p + 2];
    if (c & 0x08) x = -x;
    if (c & 0x04) y = -y;
    c &= ~0x0c;
    if (c === 0) o.stitch(x, y);
    else if (c & 0x02) o.move(x, y);
    else if (c & 0x20) { if (buf[p + 1] === 0xff) break; o.needle(); }
  }
  return o.done();
}
function readKsm(buf) {
  const o = new Out();
  let trimmed = false, sewn = false;
  for (let p = 0x200; p + 2 < buf.length; p += 3) {
    let y = -buf[p], x = buf[p + 1], c = buf[p + 2];
    if (c & 0x40) x = -x;
    if (c & 0x20) y = -y;
    c &= 0x1f;
    if (x || y) { if (trimmed) o.move(x, y); else { o.stitch(x, y); sewn = true; } }
    if (c === 0 || c === 0x05) continue;
    if (c === 0x07 || c === 0x13 || c === 0x1d) { if (sewn) o.trim(); trimmed = true; }
    else if ((c >= 0x17 && c <= 0x19) || c === 0x1b) trimmed = false;
    else if (c >= 0x0b && c <= 0x12) { o.needle(); trimmed = true; }
    else break;
  }
  return o.done();
}
function readStc(buf) {
  const o = new Out();
  for (let p = 0x28; p + 2 < buf.length; p += 3) {
    const x = s8(buf[p]), y = -s8(buf[p + 1]), c = buf[p + 2];
    if (c === 1) o.stitch(x, y);
    else if (c === 0) o.move(x, y);
    else if (c === 25) break;
    else o.needle();
  }
  return o.done();
}
function read100(buf) {
  const o = new Out();
  for (let p = 0; p + 3 < buf.length; p += 4) {
    let x = buf[p + 2], y = buf[p + 3];
    if (x > 0x80) x = -(x - 0x80);
    if (y > 0x80) y = -(y - 0x80);
    if (buf[p] === 0x61) o.stitch(x, -y);
    else if (buf[p] & 1) o.move(x, -y);
    else o.color();
  }
  return o.done();
}

// ---- 2-byte "0x80 escape" families ----
function escape2(buf, p, onCtrl) {
  const o = new Out();
  while (p + 1 < buf.length) {
    const b0 = buf[p], b1 = buf[p + 1]; p += 2;
    if (b0 !== 0x80) { o.stitch(s8(b0), -s8(b1)); continue; }
    const r = onCtrl(o, b1, p);
    if (r < 0) break;
    p += r;
  }
  return o;
}
function readSew(buf) {
  const d = view(buf), n = d.getUint16(0, true), threads = [];
  for (let i = 0; i < n; i++) threads.push(pal(SEW_PALETTE, d.getUint16(2 + i * 2, true)));
  const o = escape2(buf, 0x1d78, (o, c, p) => {
    if (p + 1 >= buf.length) return -1;
    const x = s8(buf[p]), y = -s8(buf[p + 1]);
    if (c & 1) o.color();
    else if (c === 0x04 || c === 0x02) o.move(x, y);
    else if (c === 0x10) o.stitch(x, y);
    else return -1;
    return 2;
  });
  o.threads = threads;
  return o.done();
}
function readEmd(buf) {
  return escape2(buf, 0x30, (o, c, p) => {
    if (c === 0x80) { if (p + 1 >= buf.length) return -1; o.move(s8(buf[p]), -s8(buf[p + 1])); return 2; }
    if (c === 0x2a) { o.color(); return 0; }
    if (c === 0x7d) return 0;
    if (c === 0xad || c === 0x90) { o.trim(); return 0; }
    return -1;
  }).done();
}
function readJpx(buf) {
  const d = view(buf), start = d.getUint32(0, true), n = d.getUint32(0x20, true);
  const o = escape2(buf, start, (o, c, p) => {
    if (p + 1 >= buf.length) return -1;
    const x = s8(buf[p]), y = -s8(buf[p + 1]);
    if (c === 0x02) o.move(x, y);
    else if (c === 0x01) { o.color(); if (x && y) o.move(x, y); }
    else return -1;
    return 2;
  });
  for (let i = 0; i < n; i++) o.threads.push({ ...thread(null, i), name: `JPX index ${d.getUint32(0x3c + i * 4, true)}` });
  return o.done();
}
function readBro(buf) {
  const d = view(buf), o = new Out();
  for (let p = 0x100; p + 1 < buf.length;) {
    const b0 = buf[p], b1 = buf[p + 1];
    if (b0 !== 0x80) { o.stitch(s8(b0), -s8(b1)); p += 2; continue; }
    const c = buf[p + 2]; p += 3; // pyembroidery reads 2 bytes, then the control byte
    if (c === 0x00) continue;
    if (c === 0x02 || c === 0xe0 || p + 3 >= buf.length) break;
    if (c === 0x7e || c === 0x03 || (c > 0xe0 && c < 0xf0)) {
      if (c > 0xe0) o.needle();
      o.move(s16(d.getUint16(p, true)), -s16(d.getUint16(p + 2, true))); p += 4;
    } else break;
  }
  return o.done();
}

// ---- absolute-coordinate formats ----
function readPc(buf, palette) { // PCD, PCQ, PCS (24-bit LE) and PCM (24-bit BE, fixed palette)
  const o = new Out(), K = 5 / 3;
  let p;
  if (palette) {
    const d = view(buf), n = d.getUint16(2);
    for (let i = 0; i < n; i++) o.threads.push(palette[d.getUint16(4 + i * 2)] || thread(null, i));
    p = 4 + n * 2 + 2;
  } else {
    const n = buf[2] | (buf[3] << 8);
    for (let i = 0; i < n; i++) o.threads.push({ rgb: u24be(buf, 4 + i * 4), name: `Color ${i + 1}` });
    p = 4 + n * 4 + 2;
  }
  for (; p + 8 < buf.length + 1 && p + 9 <= buf.length; p += 9) {
    const x = s24(palette ? u24be(buf, p) : u24le(buf, p + 1)) * K, y = -s24(palette ? u24be(buf, p + 4) : u24le(buf, p + 5)) * K, c = buf[p + 8];
    if (c === 0) o.abs('stitch', Math.round(x), Math.round(y));
    else if (c & 1) o.color();
    else if (c & 4) o.abs('jump', Math.round(x), Math.round(y));
    else break;
  }
  return o.done();
}
const PCM_PALETTE = [0x000000, 0x000080, 0x0000ff, 0x008080, 0x00ffff, 0x800080, 0xff00ff, 0x800000, 0xff0000, 0x008000, 0x00ff00, 0x808000, 0xffff00, 0x808080, 0xc0c0c0, 0xffffff].map((rgb, i) => ({ rgb, name: `PCM Color ${i + 1}` }));
function readMax(buf) {
  const d = view(buf), o = new Out(), n = d.getUint32(0xd5, true);
  for (let i = 0, p = 0xd9; i < n && p + 8 <= buf.length; i++, p += 8) o.abs('stitch', Math.round(s24(u24le(buf, p)) * 1.235), Math.round(s24(u24le(buf, p + 4)) * 1.235));
  return o.done();
}
function readMit(buf) {
  const o = new Out();
  let prev = -1;
  for (let p = 0; p + 1 < buf.length; p += 2) {
    const b0 = buf[p], b1 = buf[p + 1];
    let x = (b0 & 0x1f) * 2, y = -(b1 & 0x1f) * 2;
    if (b0 & 0x80) x = -x;
    if (b1 & 0x80) y = -y;
    const c = ((b0 & 0x60) >> 3) | ((b1 & 0x60) >> 5);
    if (c === 0b1100) o.move(x, y);
    else if (c === 0b1000) { if (prev === 0b0111) o.color(); }
    else if (c !== 0) o.stitch(x, y); // 0 marks the end but pyembroidery reads on
    prev = c;
  }
  return o.done();
}

// ---- XXX (Singer) ----
function readXxx(buf) {
  const d = view(buf), o = new Out(), n = d.getUint16(0x27, true);
  let p = 0x100;
  while (p < buf.length) {
    const b1 = buf[p++];
    if (b1 === 0x7d || b1 === 0x7e) { if (p + 3 >= buf.length) break; o.move(s16(d.getUint16(p, true)), -s16(d.getUint16(p + 2, true))); p += 4; continue; }
    if (p >= buf.length) break;
    const b2 = buf[p++];
    if (b1 !== 0x7f) { o.stitch(s8(b1), -s8(b2)); continue; }
    const x = s8(buf[p]), y = -s8(buf[p + 1]); p += 2;
    if (b2 === 0x01) o.move(x, y);
    else if (b2 === 0x03) { o.trim(); o.move(x, y); }
    else if (b2 === 0x08 || (b2 >= 0x0a && b2 <= 0x17)) o.color();
    else if (b2 === 0x7f || b2 === 0x18) break;
  }
  p += 2;
  for (let i = 0; i < n && p + 4 <= buf.length; i++, p += 4) o.threads.push({ rgb: d.getUint32(p) & 0xffffff, name: `Color ${i + 1}` });
  return o.done();
}

// ---- TBF (Tajima) ----
function readTbf(buf) {
  const o = new Out();
  for (let p = 0x20e; buf[p] === 0x45; p += 5) o.threads.push({ rgb: u24be(buf, p + 1), name: `Color ${o.threads.length + 1}` });
  let needle = 0;
  for (let p = 0x600; p + 2 < buf.length; p += 3) {
    const x = buf[p], y = buf[p + 1], c = buf[p + 2];
    if (c === 0x80) o.stitch(s8(x), -s8(y));
    else if (c === 0x81) { if (buf[0x10a + needle++]) o.needle(); }
    else if (c === 0x90) { if (!x && !y) o.trim(); else o.move(s8(x), -s8(y)); }
    else if (c === 0x40) continue;
    else if (c === 0x86) o.trim();
    else break;
  }
  return o.done();
}

// ---- ZHS (Zeng Hsing) ----
function readZhs(buf) {
  const d = view(buf), start = d.getUint32(0x0f, true), head = d.getUint32(0x13, true), o = new Out();
  for (let i = 0; i < buf[head]; i++) o.threads.push({ rgb: u24be(buf, head + 1 + i * 3), name: `Color ${i + 1}` });
  const bits = (a, b, pick) => { let v = 0; for (let k = 0; k < 8; k++) v += ((k % 2 === 0) === pick ? a : b) & (1 << k); v = s8(v); return v >= 63 ? v + 1 : v <= -63 ? v - 1 : v; };
  let xx = 0, yy = 0;
  for (let p = start; p + 2 < buf.length; p += 3) {
    const c = buf[p];
    if (c === 0x10) continue;
    xx += bits(buf[p + 1], buf[p + 2], true); yy += bits(buf[p + 2], buf[p + 1], true);
    if (c === 0x02) { o.stitch(xx, -yy); xx = yy = 0; }
    else if (c === 0x01) { o.move(xx, -yy); xx = yy = 0; }
    else if (c === 0x04) { xx = yy = 0; o.color(); }
    else if (c === 0x80) break;
  }
  return o.done();
}

// ---- SHV (Husqvarna Viking) ----
function readShv(buf) {
  const d = view(buf), o = new Out();
  let p = 0x56;
  p += 1 + buf[p];
  const w = buf[p], h = buf[p + 1];
  p += 2 + 4 + Math.ceil(h / 2) * w;
  const n = buf[p]; p += 1 + 18;
  const perColour = [];
  for (let i = 0; i < n; i++) { perColour.push(d.getUint32(p)); o.threads.push(pal(SHV_PALETTE, buf[p + 4])); p += 5 + 9; }
  p -= 2;
  let inJump = false, since = 0, ci = 0, max = perColour[0] ?? 0;
  while (p + 1 < buf.length) {
    const b0 = buf[p], b1 = buf[p + 1]; p += 2;
    if (since >= max) { o.color(); since = 0; ci++; max = perColour[ci] ?? Infinity; }
    if (b0 === 0x80) {
      since++;
      if (b1 === 3) continue;
      if (b1 === 2) { inJump = false; continue; }
      if (b1 === 1) { since += 2; o.move(s16(d.getUint16(p)), s16(d.getUint16(p + 2))); p += 4; inJump = true; continue; }
    }
    since++;
    if (inJump) o.move(s8(b0), s8(b1)); else o.stitch(s8(b0), s8(b1));
  }
  return o.done();
}

// ---- PHB / PHC (Brother, PEC stitches inside) ----
function readPhb(buf) {
  const d = view(buf), o = new Out(), n = d.getUint16(0x71, true);
  for (let i = 0; i < n; i++) o.threads.push(pal(PEC_PALETTE, buf[0x73 + i]));
  let off = 0x52 + d.getUint32(0x54, true);
  off += d.getUint32(off, true) + 2;
  off += d.getUint32(off, true);
  const p = off + 14 + 1 + buf[off + 14] + 0x15;
  return { threads: o.threads, cmds: pecStitches(buf, p) };
}
function readPhc(buf) {
  const d = view(buf), o = new Out(), n = d.getUint16(0x4d, true);
  for (let i = 0; i < n; i++) o.threads.push(pal(PEC_PALETTE, buf[0x4f + i]));
  let p = d.getUint16(0x30, true) + buf[0x2b];
  p += 2 + d.getUint16(p, true);
  p += 4 + d.getUint32(p, true) + 10;
  p += 1 + buf[p] + 0x1d;
  return { threads: o.threads, cmds: pecStitches(buf, p) };
}

// ---- HUS (Husqvarna Viking): three Huffman-compressed streams ----
class Huffman {
  constructor(lengths, value = 0) {
    this.lengths = lengths; this.value = value; this.table = null;
    if (!lengths) return;
    this.width = Math.max(...lengths);
    this.table = [];
    let size = 1 << this.width;
    for (let bl = 1; bl <= this.width; bl++) { size /= 2; lengths.forEach((l, i) => { if (l === bl) for (let k = 0; k < size; k++) this.table.push(i); }); }
  }
  lookup(v) { if (!this.table) return [this.value, 0]; const i = this.table[v >> (16 - this.width)]; return [i, this.lengths[i]]; }
}
export function expand(data, size) {
  let bit = 0, left = -1, chars = null, dists = null;
  const peek = (n) => { let v = 0; const s = bit >> 3, e = (bit + n - 1) >> 3; for (let i = s; i <= e; i++) v = (v * 256) + (data[i] ?? 0); return Math.floor(v / 2 ** ((8 - ((bit + n) % 8)) % 8)) % 2 ** n; };
  const pop = (n) => { const v = peek(n); bit += n; return v; };
  const varLen = () => { let m = pop(3); if (m !== 7) return m; for (let q = 0; q < 13 && pop(1) === 1; q++) m++; return m; };
  const block = () => {
    left = pop(16);
    let n = pop(5), lenH;
    if (!n) lenH = new Huffman(null, pop(5));
    else { const L = new Array(n).fill(0); for (let i = 0; i < n; i++) { if (i === 3) i += pop(2); L[i] = varLen(); } lenH = new Huffman(L, 8); }
    n = pop(9);
    if (!n) chars = new Huffman(null, pop(9));
    else {
      const L = new Array(n).fill(0);
      for (let i = 0; i < n;) {
        const [c0, l] = lenH.lookup(peek(16)); bit += l;
        if (c0 === 0) i += 1; else if (c0 === 1) i += 3 + pop(4); else if (c0 === 2) i += 20 + pop(9); else L[i++] = c0 - 2;
      }
      chars = new Huffman(L);
    }
    n = pop(5);
    if (!n) dists = new Huffman(null, pop(5));
    else { const L = []; for (let i = 0; i < n; i++) L.push(varLen()); dists = new Huffman(L); }
  };
  const out = [];
  while (data.length * 8 > bit && out.length <= size) {
    if (left <= 0) block();
    left--;
    const [c, l] = chars.lookup(peek(16)); bit += l;
    if (c <= 255) out.push(c);
    else if (c === 510) break;
    else {
      const len = c - 253;
      const [h, hl] = dists.lookup(peek(16)); bit += hl;
      const back = (h === 0 ? 0 : (1 << (h - 1)) + pop(h - 1)) + 1, from = out.length - back;
      for (let i = 0; i < len; i++) out.push(out[from + i]);
    }
  }
  return out;
}
function readHus(buf) {
  const d = view(buf), n = d.getUint32(4, true), colours = d.getUint32(8, true);
  const cmdAt = d.getUint32(0x14, true), xAt = d.getUint32(0x18, true), yAt = d.getUint32(0x1c, true);
  const o = new Out();
  for (let i = 0; i < colours; i++) o.threads.push(pal(HUS_PALETTE, d.getUint16(0x2a + i * 2, true)));
  const c = expand(buf.subarray(cmdAt, xAt), n), xs = expand(buf.subarray(xAt, yAt), n), ys = expand(buf.subarray(yAt), n);
  for (let i = 0; i < Math.min(c.length, xs.length, ys.length); i++) {
    const x = s8(xs[i]), y = -s8(ys[i]);
    if (c[i] === 0x80) o.stitch(x, y);
    else if (c[i] === 0x81) o.move(x, y);
    else if (c[i] === 0x84) o.color(x, y);
    else if (c[i] === 0x88) { o.move(x, y); o.trim(); }
    else break;
  }
  return o.done();
}

// ---- G-code (as written by pyembroidery and Hoopbridge: both axes flipped, M00 = colour change) ----
function readGcode(buf) {
  const o = new Out();
  let pending = null;
  for (const line of new TextDecoder().decode(buf).split('\n')) {
    const t = line.replace(/\(.*?\)|;.*/g, '').trim().toUpperCase();
    if (!t) continue;
    if (/^M0?0\b/.test(t) || /^M0?6\b/.test(t)) { if (pending) { o.abs('jump', ...pending); pending = null; } o.color(); continue; }
    const x = t.match(/X(-?[\d.]+)/), y = t.match(/Y(-?[\d.]+)/), z = /Z/.test(t);
    if (x || y) { if (pending) o.abs('jump', ...pending); pending = [x ? -Math.round(parseFloat(x[1]) * 10) : (pending?.[0] ?? o.x), y ? -Math.round(parseFloat(y[1]) * 10) : (pending?.[1] ?? o.y)]; }
    if (z && pending) { o.abs('stitch', ...pending); pending = null; } // the needle goes down on a Z move
  }
  return o.done();
}

const stx = (buf) => readExp(buf, view(buf).getUint32(0x14, true));
export const MORE_READERS = {
  u01: readU01, xxx: readXxx, tbf: readTbf, hus: readHus, shv: readShv, sew: readSew, ksm: readKsm,
  dsz: (b) => zStitches(b, 512), fxy: (b) => zStitches(b, 0x100), gt: (b) => zStitches(b, 0x200), dsb: readDsb,
  exy: (b) => readDst(b, 0x100), tap: (b) => readDst(b, 0), '10o': read10o, 100: read100, inb: readInb, new: readNew,
  zxy: readZxy, stc: readStc, emd: readEmd, jpx: readJpx, bro: readBro, mit: readMit, max: readMax, zhs: readZhs,
  pcd: (b) => readPc(b), pcq: (b) => readPc(b), pcs: (b) => readPc(b), pcm: (b) => readPc(b, PCM_PALETTE),
  phb: readPhb, phc: readPhc, stx, gcode: readGcode,
};
