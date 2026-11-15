// Brother PES (version 1) writer for a normalized pattern (0.1 mm units, y down).
// Layout follows pyembroidery's PesWriter/PecWriter (MIT): PES header + CEmbOne/CSewSeg blocks,
// then the PEC block (thread indexes, stitches, 48x38 thumbnails) that Brother machines read.
import { PEC_PALETTE } from './palettes.js';

const CUT_JUMP = 51; // hops this long are trimmed, as Artspira does

class Out {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u24(v) { this.u16(v); this.u8(v >> 16); }
  u32(v) { this.u16(v); this.u16(v >>> 16); }
  f32(v) { const a = new Uint8Array(new Float32Array([v]).buffer); a.forEach((x) => this.u8(x)); }
  str(s) { for (const c of s) this.u8(c.charCodeAt(0) & 0x7f); }
  bytes(a) { for (const x of a) this.u8(x); }
  set16(at, v) { this.b[at] = v & 0xff; this.b[at + 1] = (v >> 8) & 0xff; }
  set24(at, v) { this.set16(at, v); this.b[at + 2] = (v >> 16) & 0xff; }
  set32(at, v) { this.set16(at, v); this.set16(at + 2, v >>> 16); }
  get pos() { return this.b.length; }
}

// pyembroidery's "red mean" colour distance
function nearest(rgb, palette) {
  const r1 = (rgb >> 16) & 255, g1 = (rgb >> 8) & 255, b1 = rgb & 255;
  let best = null, bd = Infinity;
  palette.forEach((e, i) => {
    if (!e) return;
    const r2 = (e[0] >> 16) & 255, g2 = (e[0] >> 8) & 255, b2 = e[0] & 255, rm = Math.round((r1 + r2) / 2);
    const d = (((512 + rm) * (r1 - r2) ** 2) >> 8) + 4 * (g1 - g2) ** 2 + (((767 - rm) * (b1 - b2) ** 2) >> 8);
    if (d <= bd) { bd = d; best = i; }
  });
  return best;
}

// each distinct thread colour gets its own palette slot, so two threads never share an index
function uniquePalette(rgbs) {
  const free = PEC_PALETTE.slice(), chart = new Array(PEC_PALETTE.length).fill(null);
  for (const rgb of new Set(rgbs)) {
    const i = nearest(rgb, free);
    if (i == null) break;
    free[i] = null; chart[i] = [rgb];
  }
  return rgbs.map((rgb) => nearest(rgb, chart));
}

const BLANK_ICON = '000000000000f0ffffffff0f0800000000100400000000200200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400200000000400400000000200800000000100f0ffffffff0f000000000000';
function icon(points, box, buffer) {
  const g = Uint8Array.from(BLANK_ICON.match(/../g), (h) => parseInt(h, 16));
  const W = 48, H = 38, dw = box.x1 - box.x0 || 1, dh = box.y1 - box.y0 || 1;
  const k = Math.min((W - buffer) / dw, (H - buffer) / dh);
  const tx = -((box.x0 + box.x1) / 2) * k + W / 2, ty = -((box.y0 + box.y1) / 2) * k + H / 2;
  for (const [x, y] of points) {
    const px = Math.floor(x * k + tx), py = Math.floor(y * k + ty);
    if (px >= 0 && py >= 0 && px < W && py < H) g[py * 6 + (px >> 3)] |= 1 << (px & 7);
  }
  return g;
}

// centre the design on (0,0), as Brother files are
function centred(pattern) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of pattern.blocks) for (const s of b.segments) for (const [x, y] of s.points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const ox = Math.round((x0 + x1) / 2), oy = Math.round((y0 + y1) / 2);
  const blocks = pattern.blocks.map((b) => ({ rgb: b.thread?.rgb ?? 0, segments: b.segments.map((s) => ({ trim: s.trim, points: s.points.map(([x, y]) => [x - ox, y - oy]) })) }));
  const box = { x0: x0 - ox, y0: y0 - oy, x1: x1 - ox, y1: y1 - oy };
  return { blocks, box, width: box.x1 - box.x0, height: box.y1 - box.y0 };
}

export function writePec(pattern, name = 'design') {
  const o = new Out();
  o.str('#PEC0001');
  pecBlock(o, centred(pattern), name);
  return Uint8Array.from(o.b);
}

export function writePes(pattern, name = 'design') {
  const c = centred(pattern), { blocks, box, width, height } = c;
  const o = new Out();
  o.str('#PES0001');
  const pecAt = o.pos; o.u32(0);
  o.u16(1); o.u16(1); o.u16(1); // scale to fit, hoop, one block object
  o.u16(0xffff); o.u16(0);

  // CEmbOne / CSewSeg
  o.u16(7); o.str('CEmbOne');
  for (let i = 0; i < 8; i++) o.u16(0);
  const tx = 350 + 1300 / 2 - width / 2, ty = 100 + height + 1800 / 2 - height / 2;
  [1, 0, 0, 1, tx, ty].forEach((v) => o.f32(v));
  o.u16(1); o.u16(0); o.u16(0); o.u16(width); o.u16(height);
  o.bytes([0, 0, 0, 0, 0, 0, 0, 0]);
  const sectionsAt = o.pos; o.u16(0);
  o.u16(0xffff); o.u16(0);
  o.u16(7); o.str('CSewSeg');
  const ax = box.x0, ay = box.y1; // segment coordinates are relative to the bottom-left corner
  const colorLog = [];
  let sections = 0, prevCode = -1, last = null;
  const section = (flag, code, pts) => {
    if (sections) o.u16(0x8003);
    if (code !== prevCode) { colorLog.push([sections, code]); prevCode = code; }
    o.u16(flag); o.u16(code); o.u16(pts.length);
    for (const [x, y] of pts) { o.u16(Math.trunc(x - ax)); o.u16(Math.trunc(y - ay)); }
    sections++;
  };
  for (const b of blocks) {
    const code = nearest(b.rgb, PEC_PALETTE);
    for (const s of b.segments) {
      if (last) section(1, code, [last, s.points[0]]);
      section(0, code, s.points);
      last = s.points.at(-1);
    }
  }
  o.u16(colorLog.length);
  for (const [sec, code] of colorLog) { o.u16(sec); o.u16(code); }
  o.set16(sectionsAt, sections);
  o.u16(0); o.u16(0);

  o.set32(pecAt, o.pos);
  pecBlock(o, c, name);
  return Uint8Array.from(o.b);
}

// PEC block: label, thread indexes, stitches, thumbnails
function pecBlock(o, { blocks, box, width, height }, name) {
  o.str(`LA:${name.slice(0, 8).padEnd(16, ' ')}\r`);
  o.bytes([...Array(12).fill(0x20), 0xff, 0x00, 6, 38]);
  const idx = uniquePalette(blocks.map((b) => b.rgb));
  o.bytes(Array(12).fill(0x20));
  o.u8(idx.length - 1); o.bytes(idx);
  for (let i = idx.length; i < 463; i++) o.u8(0x20);

  const stitchAt = o.pos;
  o.bytes([0, 0]); o.u24(0); o.bytes([0x31, 0xff, 0xf0]);
  o.u16(Math.round(width)); o.u16(Math.round(height)); o.u16(0x1e0); o.u16(0x1b0);
  let cx = 0, cy = 0, jumping = true, colourTwo = true, first = true;
  const value = (v, long, flag) => {
    if (!long && v > -64 && v < 63) o.u8(v & 0x7f);
    else { const w = (v & 0x0fff) | 0x8000 | (flag << 8); o.u8(w >> 8); o.u8(w); }
  };
  const stitch = (x, y) => {
    const dx = x - cx, dy = y - cy;
    if (jumping) { if (dx !== 0 && dy !== 0) { value(0); value(0); } jumping = false; }
    value(dx); value(dy); cx = x; cy = y;
  };
  const jump = (x, y, trim) => {
    jumping = true;
    // PEC long values hold +-2047; split longer moves
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x - cx), Math.abs(y - cy)) / 2047));
    const sx = cx, sy = cy;
    for (let i = 1; i <= n; i++) {
      const nx = Math.round(sx + ((x - sx) * i) / n), ny = Math.round(sy + ((y - sy) * i) / n);
      const flag = first ? 0x10 : trim ? 0x20 : 0x10;
      value(nx - cx, true, flag); value(ny - cy, true, flag); cx = nx; cy = ny;
    }
    first = false;
  };
  blocks.forEach((b, bi) => {
    if (bi > 0) {
      if (jumping) { value(0); value(0); jumping = false; }
      o.bytes([0xfe, 0xb0, colourTwo ? 2 : 1]); colourTwo = !colourTwo;
    }
    b.segments.forEach((s, si) => {
      const [px, py] = s.points[0];
      const hop = Math.hypot(px - cx, py - cy);
      jump(px, py, bi > 0 && si === 0 ? true : s.trim || hop >= CUT_JUMP);
      for (const [x, y] of s.points) stitch(x, y);
    });
  });
  o.u8(0xff);
  o.set24(stitchAt + 2, o.pos - stitchAt);

  const all = blocks.flatMap((b) => b.segments.flatMap((s) => s.points));
  o.bytes(icon(all, box, 4));
  for (const b of blocks) o.bytes(icon(b.segments.flatMap((s) => s.points), box, 5));
}
