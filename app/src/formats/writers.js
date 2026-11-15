// Embroidery file writers beyond PES/DST, ported from pyembroidery's writers (MIT).
// Every writer takes a normalized pattern (0.1 mm, y down) and returns bytes.
import { JEF_PALETTE } from './palettes.js';
import { writePes, writePec } from './pes-writer.js';
import { writeDst } from './dst-writer.js';

// Flat command list centred on the design: [{ c: 'stitch'|'jump'|'trim'|'color', x, y }], moves split
// so no step is longer than max (in either axis). A segment is a jump to its first point, then stitches.
export function stream(pattern, max = 127) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of pattern.blocks) for (const s of b.segments) for (const [x, y] of s.points) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const ox = Math.round((x0 + x1) / 2), oy = Math.round((y0 + y1) / 2);
  const out = [];
  let cx = 0, cy = 0;
  const move = (c, x, y) => {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x - cx), Math.abs(y - cy)) / max)), sx = cx, sy = cy;
    for (let i = 1; i <= n; i++) {
      const nx = Math.round(sx + ((x - sx) * i) / n), ny = Math.round(sy + ((y - sy) * i) / n);
      out.push({ c, x: nx, y: ny }); cx = nx; cy = ny;
    }
  };
  pattern.blocks.forEach((b, bi) => {
    if (bi) out.push({ c: 'color', x: cx, y: cy });
    b.segments.forEach((s, si) => {
      if (s.trim && (si || !bi)) out.push({ c: 'trim', x: cx, y: cy });
      move('jump', s.points[0][0] - ox, s.points[0][1] - oy);
      for (const [x, y] of s.points.slice(1)) move('stitch', x - ox, y - oy);
    });
  });
  const box = { x0: x0 - ox, y0: y0 - oy, x1: x1 - ox, y1: y1 - oy };
  return { cmds: out, box, threads: pattern.blocks.map((b) => b.thread) };
}

class Out {
  constructor() { this.b = []; }
  u8(v) { this.b.push(v & 0xff); }
  u16(v) { this.u8(v); this.u8(v >> 8); }
  u32(v) { this.u16(v); this.u16(v >>> 16); }
  str(s) { for (const c of s) this.u8(c.charCodeAt(0)); }
  fill(n, v = 0) { for (let i = 0; i < n; i++) this.u8(v); }
  set32(at, v) { for (let i = 0; i < 4; i++) this.b[at + i] = (v >>> (8 * i)) & 0xff; }
  get pos() { return this.b.length; }
  bytes() { return Uint8Array.from(this.b); }
}
const deltas = (cmds, fn) => { let px = 0, py = 0; for (const c of cmds) { fn(c, c.x - px, c.y - py); px = c.x; py = c.y; } };

// ---- EXP (Melco) ----
export function writeExp(pattern) {
  const o = new Out();
  deltas(stream(pattern).cmds, (c, dx, dy) => {
    if (c.c === 'stitch') { o.u8(dx); o.u8(-dy); }
    else if (c.c === 'jump') { o.u8(0x80); o.u8(0x04); o.u8(dx); o.u8(-dy); }
    else if (c.c === 'trim') { o.u8(0x80); o.u8(0x80); o.u8(0x07); o.u8(0); }
    else if (c.c === 'color') { o.u8(0x80); o.u8(0x01); o.u8(0); o.u8(0); }
  });
  return o.bytes();
}

// nearest palette entry by pyembroidery's "red mean" distance; skip = index not to use
function nearestIndex(rgb, palette, skip = -1) {
  const r1 = (rgb >> 16) & 255, g1 = (rgb >> 8) & 255, b1 = rgb & 255;
  let best = 0, bd = Infinity;
  palette.forEach((e, i) => {
    if (!e || i === skip) return;
    const r2 = (e[0] >> 16) & 255, g2 = (e[0] >> 8) & 255, b2 = e[0] & 255, rm = Math.round((r1 + r2) / 2);
    const d = (((512 + rm) * (r1 - r2) ** 2) >> 8) + 4 * (g1 - g2) ** 2 + (((767 - rm) * (b1 - b2) ** 2) >> 8);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

// ---- JEF (Janome). Trims are written as 3 empty jumps (Janome machines cut on them) ----
export function writeJef(pattern, _name, date = new Date()) {
  const { cmds, box, threads } = stream(pattern);
  const palette = [];
  threads.forEach((t, i) => {
    let k = nearestIndex(t.rgb, JEF_PALETTE);
    if (i && palette[i - 1] === k && threads[i - 1].rgb !== t.rgb) k = nearestIndex(t.rgb, JEF_PALETTE, k); // two threads, one look
    palette.push(k);
  });
  let points = 1;
  for (const c of cmds) points += c.c === 'stitch' ? 1 : c.c === 'trim' ? 6 : 2;
  const o = new Out(), n = threads.length;
  o.u32(0x74 + n * 8); o.u32(0x14);
  const p2 = (v) => String(v).padStart(2, '0');
  o.str(`${date.getFullYear()}${p2(date.getMonth() + 1)}${p2(date.getDate())}${p2(date.getHours())}${p2(date.getMinutes())}${p2(date.getSeconds())}`);
  o.u8(0); o.u8(0); o.u32(n); o.u32(points);
  const w = Math.round(box.x1 - box.x0), h = Math.round(box.y1 - box.y0);
  o.u32(w < 500 && h < 500 ? 1 : w < 1260 && h < 1100 ? 3 : w < 1400 && h < 2000 ? 2 : w < 2000 && h < 2000 ? 4 : 0);
  const hw = Math.round(w / 2), hh = Math.round(h / 2);
  o.u32(hw); o.u32(hh); o.u32(hw); o.u32(hh);
  for (const [ex, ey] of [[550, 550], [250, 250], [700, 1000], [700, 1000]]) {
    const x = ex - hw, y = ey - hh;
    for (const v of Math.min(x, y) >= 0 ? [x, y, x, y] : [-1, -1, -1, -1]) o.u32(v);
  }
  palette.forEach((k) => o.u32(k));
  for (let i = 0; i < n; i++) o.u32(0x0d);
  deltas(cmds, (c, dx, dy) => {
    if (c.c === 'stitch') { o.u8(dx); o.u8(-dy); }
    else if (c.c === 'jump') { o.u8(0x80); o.u8(0x02); o.u8(dx); o.u8(-dy); }
    else if (c.c === 'trim') for (let i = 0; i < 3; i++) { o.u8(0x80); o.u8(0x02); o.u8(0); o.u8(0); }
    else if (c.c === 'color') { o.u8(0x80); o.u8(0x01); o.u8(0); o.u8(0); }
  });
  o.u8(0x80); o.u8(0x10);
  return o.bytes();
}

// ---- U01 (Barudan). Colour changes select the next needle (1-15) ----
export function writeU01(pattern) {
  const { cmds, box } = stream(pattern);
  const o = new Out();
  o.fill(0x80, 0x30);
  o.u16(box.x0); o.u16(-box.y1); o.u16(box.x1); o.u16(-box.y0); o.u32(0); o.u32(cmds.length + 2);
  const last = cmds.at(-1) || { x: 0, y: 0 };
  o.u16(last.x); o.u16(-last.y);
  o.fill(0x100 - o.pos, 0);
  let needle = 1;
  const rec = (cmd, dx, dy) => { cmd |= 0x80 | (dy >= 0 ? 0x40 : 0) | (dx <= 0 ? 0x20 : 0); o.u8(cmd); o.u8(Math.abs(dy)); o.u8(Math.abs(dx)); };
  rec(0x08, 0, 0); // pick needle 1
  deltas(cmds, (c, dx, dy) => {
    if (c.c === 'stitch') rec(0, dx, dy);
    else if (c.c === 'jump') rec(0x01, dx, dy);
    else if (c.c === 'trim') rec(0x07, dx, dy);
    else if (c.c === 'color') { needle = (needle % 15) + 1; rec(0x08 + needle, dx, dy); }
  });
  o.u8(0xf8); o.u8(0); o.u8(0);
  return o.bytes();
}

// ---- XXX (Singer) ----
export function writeXxx(pattern) {
  const { cmds, box, threads } = stream(pattern, 124);
  const o = new Out();
  o.fill(0x17); o.u32(cmds.length); o.fill(0x0c); o.u32(threads.length); o.u16(0);
  o.u16(Math.trunc(box.x1 - box.x0)); o.u16(Math.trunc(box.y1 - box.y0));
  const last = cmds.at(-1) || { x: 0, y: 0 };
  o.u16(last.x); o.u16(-last.y); o.u16(-box.x0); o.u16(box.y1);
  o.fill(0x42); o.u16(0); o.u16(0); o.fill(0x73); o.u16(0x20); o.fill(0x08);
  const endAt = o.pos; o.u32(0);
  deltas(cmds, (c, dx, dy) => {
    if (c.c === 'stitch') { o.u8(dx); o.u8(-dy); }
    else { o.u8(0x7f); o.u8({ jump: 0x01, trim: 0x03, color: 0x08 }[c.c]); o.u8(dx); o.u8(-dy); }
  });
  o.set32(endAt, o.pos);
  o.u8(0x7f); o.u8(0x7f); o.u8(0x02); o.u8(0x14);
  o.u8(0); o.u8(0);
  for (const t of threads) { o.u8(0); o.u8(t.rgb >> 16); o.u8(t.rgb >> 8); o.u8(t.rgb); }
  for (let i = threads.length; i < 21; i++) o.u32(0);
  o.u32(0xffffff00); o.u8(0); o.u8(1);
  return o.bytes();
}

// ---- G-code (for DIY embroidery machines; X/Y in mm, Z advances one step per stitch) ----
export function writeGcode(pattern) {
  const { cmds, box, threads } = stream(pattern, 1e9);
  const f = (v) => (v / 10).toFixed(3);
  const lines = [
    `(STITCH_COUNT: ${cmds.filter((c) => c.c === 'stitch').length})`, `(THREAD_COUNT: ${threads.length - 1})`,
    `(EXTENTS_LEFT: ${f(box.x0)})`, `(EXTENTS_TOP: ${f(box.y0)})`, `(EXTENTS_RIGHT: ${f(box.x1)})`, `(EXTENTS_BOTTOM: ${f(box.y1)})`,
    `(EXTENTS_WIDTH: ${f(box.x1 - box.x0)})`, `(EXTENTS_HEIGHT: ${f(box.y1 - box.y0)})`,
    ...threads.map((t, i) => `(Thread${i}: #${t.rgb.toString(16).padStart(6, '0')} ${t.name || ''})`),
  ];
  let z = 0;
  // pyembroidery flips both axes for G-code
  for (const c of cmds) {
    if (c.c === 'stitch') { lines.push(`G00 X${f(-c.x)} Y${f(-c.y)}`, `G00 Z${z.toFixed(1)}`); z += 10; }
    else if (c.c === 'jump') lines.push(`G00 X${f(-c.x)} Y${f(-c.y)}`);
    else if (c.c === 'color') lines.push('M00');
  }
  lines.push('M30');
  return new TextEncoder().encode(lines.join('\n') + '\n');
}

// ---- VP3 (Pfaff / Husqvarna Viking). Jumps become long stitches, as in every VP3 writer ----
export function writeVp3(pattern) {
  let x0 = Infinity, y0 = Infinity;
  for (const b of pattern.blocks) for (const s of b.segments) for (const [x, y] of s.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); }
  let x1 = -Infinity, y1 = -Infinity;
  for (const b of pattern.blocks) for (const s of b.segments) for (const [x, y] of s.points) { x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
  const blocks = pattern.blocks.map((b) => ({ thread: b.thread, pts: b.segments.flatMap((s, si) => [...(si && s.trim ? ['trim'] : []), ...s.points.map(([x, y]) => [x - cx, y - cy])]) }));
  const ex = { x0: x0 - cx, y0: y0 - cy, x1: x1 - cx, y1: y1 - cy };
  const B = [];
  const u8 = (v) => B.push(v & 0xff), u16 = (v) => { u8(v >> 8); u8(v); }, u24 = (v) => { u8(v >> 16); u16(v); }, u32 = (v) => { u16(v >>> 16); u16(v); };
  const raw = (...a) => a.forEach(u8), str8 = (t) => { u16(t.length); for (const c of t) u8(c.charCodeAt(0)); }, str16 = (t) => { u16(t.length * 2); for (const c of t) u16(c.charCodeAt(0)); };
  const hole = () => { const at = B.length; u32(0); return at; };
  const patch = (at) => { const v = B.length - at - 4; [24, 16, 8, 0].forEach((sh, i) => (B[at + i] = (v >>> sh) & 0xff)); };
  B.push(...'%vsm%'.split('').map((c) => c.charCodeAt(0)), 0);
  str16('Produced by     Software Ltd');
  raw(0, 2, 0); const fileEnd = hole(); str16('');
  u32(ex.x1 * 100); u32(-ex.y0 * 100); u32(ex.x0 * 100); u32(-ex.y1 * 100);
  u32(blocks.reduce((n, b) => n + b.pts.filter((p) => p !== 'trim').length, 0));
  raw(0, blocks.length, 12, 0, 1);
  raw(0, 3, 0); const designEnd = hole();
  const w = ex.x1 - ex.x0, h = ex.y1 - ex.y0, hw = Math.trunc(w / 2), hh = Math.trunc(h / 2);
  u32(0); u32(0); raw(0, 0, 0);
  u32(-hw * 100); u32(hw * 100); u32(-hh * 100); u32(hh * 100); u32(Math.trunc(w) * 100); u32(Math.trunc(h) * 100);
  str16(''); raw(0x64, 0x64); u32(4096); u32(0); u32(0); u32(4096);
  raw(...'xxPP'.split('').map((c) => c.charCodeAt(0)), 1, 0); str16('Produced by     Software Ltd');
  u16(blocks.length);
  blocks.forEach((b, bi) => {
    const pts = b.pts.filter((p) => p !== 'trim');
    raw(0, 5, 0); const blockEnd = hole();
    const first = bi === 0 || !pts.length ? [0, 0] : pts[0], last = pts.at(-1) || [0, 0];
    u32(first[0] * 100); u32(-first[1] * 100);
    raw(1, 0); u24(b.thread.rgb); raw(0, 0, 0, 5, 0x28);
    str8(''); str8((b.thread.name || '#' + b.thread.rgb.toString(16).padStart(6, '0')).replace(/[^\x20-\x7e]/g, '')); str8('');
    u32((last[0] - first[0]) * 100); u32(-(last[1] - first[1]) * 100);
    raw(0, 1, 0); const stEnd = hole(); raw(0x0a, 0xf6, 0);
    let lx = first[0], ly = first[1];
    for (const p of b.pts) {
      if (p === 'trim') { raw(0x80, 0x03); continue; }
      const dx = p[0] - lx, dy = p[1] - ly; lx = p[0]; ly = p[1];
      if (Math.abs(dx) <= 127 && Math.abs(dy) <= 127 && !(dx === -128 || dy === -128) && (dx & 0xff) !== 0x80) { u8(dx); u8(dy); }
      else { raw(0x80, 0x01); u16(dx); u16(dy); raw(0x80, 0x02); }
    }
    patch(stEnd); u8(0); patch(blockEnd);
  });
  patch(designEnd); patch(fileEnd);
  return Uint8Array.from(B);
}

// ---- TBF (Tajima). Each colour picks the next needle ----
export function writeTbf(pattern, name = 'design') {
  const { cmds, box, threads } = stream(pattern);
  const o = new Out(), pad = (t, n) => String(t).padStart(n, ' ');
  o.str('3.00'); o.fill(0x80 - o.pos, 0x20);
  const last = cmds.at(-1) || { x: 0, y: 0 }, ax = last.x, ay = -last.y;
  o.str(`LA:${name.slice(0, 16).padEnd(16, ' ')}\rST:${pad(cmds.filter((c) => c.c === 'stitch').length, 7)}\rCO:${pad(threads.length, 3)}\r`);
  o.str(`+X:${pad(Math.abs(box.x1), 5)}\r-X:${pad(Math.abs(box.x0), 5)}\r+Y:${pad(Math.abs(box.y1), 5)}\r-Y:${pad(Math.abs(box.y0), 5)}\r`);
  o.str(`AX:${ax >= 0 ? '+' : '-'}${pad(Math.abs(ax), 5)}\rAY:${ay >= 0 ? '+' : '-'}${pad(Math.abs(ay), 5)}\r`);
  o.str(`TP:${'EG/'.padEnd(32, ' ')}\rJC:3\rDO:`);
  const needles = threads.map((_, i) => (i % 15) + 1);
  for (let i = 0; i < 256; i++) o.u8(needles[i] || 0);
  o.str('\rDA:');
  for (const t of threads) { o.u8(0x45); o.u8(t.rgb >> 16); o.u8(t.rgb >> 8); o.u8(t.rgb); o.u8(0x20); }
  o.fill(0x376 - o.pos, 0x20); o.u8(0x0d); o.u8(0x1a); o.fill(0x600 - o.pos, 0x20);
  const rec = (dx, dy, cmd) => { o.u8(dx); o.u8(-dy); o.u8(cmd); };
  rec(0, 0, 0x81); // first needle
  deltas(cmds, (c, dx, dy) => rec(dx, dy, { stitch: 0x80, jump: 0x90, trim: 0x86, color: 0x81 }[c.c]));
  rec(0, 0, 0x8f); o.u8(0x1a);
  return o.bytes();
}

// format registry for saving: extension -> { name, write }
export const WRITERS = {
  pes: { name: 'Brother PES', write: writePes },
  dst: { name: 'Tajima DST', write: writeDst },
  pec: { name: 'Brother PEC', write: writePec },
  jef: { name: 'Janome JEF', write: writeJef },
  exp: { name: 'Melco EXP', write: writeExp },
  u01: { name: 'Barudan U01', write: writeU01 },
  xxx: { name: 'Singer XXX', write: writeXxx },
  vp3: { name: 'Pfaff/Viking VP3', write: writeVp3 },
  tbf: { name: 'Tajima TBF', write: writeTbf },
  gcode: { name: 'G-code', write: writeGcode },
};
