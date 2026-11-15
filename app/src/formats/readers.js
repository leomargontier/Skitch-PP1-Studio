// Embroidery file readers. Each returns a raw command list in 0.1 mm units, y pointing down:
//   { threads: [{rgb, name}], cmds: [{t:'stitch'|'jump'|'trim'|'color', x, y}] } (absolute coords)
import { PEC_PALETTE, JEF_PALETTE } from './palettes.js';
import { MORE_READERS } from './more-readers.js';

import { thread, Builder, s8, markJumpRunTrims } from './common.js';
export { thread, Builder, s8, markJumpRunTrims };

// ---- PES (reads the embedded PEC block, which every PES version carries) ----
export function readPes(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (String.fromCharCode(...buf.subarray(0, 4)) !== '#PES') throw new Error('Not a PES file');
  return readPecBlock(buf, d.getUint32(8, true));
}

export function readPec(buf) {
  if (String.fromCharCode(...buf.subarray(0, 8)) !== '#PEC0001') throw new Error('Not a PEC file');
  return readPecBlock(buf, 8);
}

function readPecBlock(buf, pec) {
  if (pec + 528 > buf.length) throw new Error('Truncated PEC block');
  const nColors = buf[pec + 48] === 0xff ? 1 : buf[pec + 48] + 1;
  const threads = [];
  for (let i = 0; i < nColors; i++) {
    const idx = buf[pec + 49 + i];
    threads.push(thread(PEC_PALETTE[idx % PEC_PALETTE.length], i));
  }
  return { threads, cmds: pecStitches(buf, pec + 528) };
}

export function pecStitches(buf, p) {
  const b = new Builder();
  while (p + 1 < buf.length) {
    let v1 = buf[p++], v2 = buf[p++];
    if (v1 === 0xff && v2 === 0x00) break;
    if (v1 === 0xfe && v2 === 0xb0) { p++; b.mark('color'); continue; }
    let jump = false, trim = false, x, y;
    if (v1 & 0x80) {
      if (v1 & 0x20) trim = true;
      if (v1 & 0x10) jump = true;
      x = ((v1 & 0x0f) << 8) + v2;
      if (x & 0x800) x -= 0x1000;
      v2 = buf[p++];
    } else {
      x = v1 > 0x3f ? v1 - 0x80 : v1;
    }
    if (v2 & 0x80) {
      if (v2 & 0x20) trim = true;
      if (v2 & 0x10) jump = true;
      y = ((v2 & 0x0f) << 8) + buf[p++];
      if (y & 0x800) y -= 0x1000;
    } else {
      y = v2 > 0x3f ? v2 - 0x80 : v2;
    }
    if (trim) b.mark('trim');
    b.rel(trim || jump ? 'jump' : 'stitch', x, y);
  }
  return b.cmds;
}

// ---- DST (Tajima) ----
export function readDst(buf, start = 512) {
  const b = new Builder();
  let colors = 1;
  for (let p = start; p + 2 < buf.length; p += 3) {
    const b0 = buf[p], b1 = buf[p + 1], b2 = buf[p + 2];
    if ((b2 & 0xf3) === 0xf3) break;
    let x = 0, y = 0;
    if (b0 & 0x01) x += 1; if (b0 & 0x02) x -= 1; if (b0 & 0x04) x += 9; if (b0 & 0x08) x -= 9;
    if (b0 & 0x80) y += 1; if (b0 & 0x40) y -= 1; if (b0 & 0x20) y += 9; if (b0 & 0x10) y -= 9;
    if (b1 & 0x01) x += 3; if (b1 & 0x02) x -= 3; if (b1 & 0x04) x += 27; if (b1 & 0x08) x -= 27;
    if (b1 & 0x80) y += 3; if (b1 & 0x40) y -= 3; if (b1 & 0x20) y += 27; if (b1 & 0x10) y -= 27;
    if (b2 & 0x04) x += 81; if (b2 & 0x08) x -= 81; if (b2 & 0x20) y += 81; if (b2 & 0x10) y -= 81;
    if ((b2 & 0xc3) === 0xc3) { b.rel('jump', x, -y); b.mark('color'); colors++; }
    else if ((b2 & 0x43) === 0x43 || (b2 & 0x83) === 0x83) b.rel('jump', x, -y); // 0x43: sequin mode, a move here
    else b.rel('stitch', x, -y);
  }
  return { threads: Array.from({ length: colors }, (_, i) => thread(null, i)), cmds: markJumpRunTrims(b.cmds) };
}

// ---- JEF (Janome) ----
export function readJef(buf) {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stitchOffset = d.getUint32(0, true);
  const nColors = d.getUint32(24, true);
  const threads = [];
  for (let i = 0; i < nColors && 116 + i * 4 + 4 <= buf.length; i++) {
    const idx = Math.abs(d.getInt32(116 + i * 4, true));
    threads.push(thread(JEF_PALETTE[idx % JEF_PALETTE.length], i));
  }
  const b = new Builder();
  for (let p = stitchOffset; p + 1 < buf.length;) {
    const c0 = buf[p++], c1 = buf[p++];
    if (c0 !== 0x80) { b.rel('stitch', s8(c0), -s8(c1)); continue; }
    if (c1 === 0x10 || p + 1 >= buf.length) break;
    const x = s8(buf[p++]), y = -s8(buf[p++]);
    if (c1 === 0x02) b.rel('jump', x, y);
    else if (c1 === 0x01) b.mark('color');
    else break;
  }
  return { threads: threads.length ? threads : [thread(null, 0)], cmds: markJumpRunTrims(b.cmds) };
}

// ---- EXP (Melco) ----
export function readExp(buf, start = 0) {
  const b = new Builder();
  let colors = 1;
  for (let p = start; p + 1 < buf.length;) {
    const c0 = buf[p++], c1 = buf[p++];
    if (c0 !== 0x80) { b.rel('stitch', s8(c0), -s8(c1)); continue; }
    if (p + 1 >= buf.length) break;
    const x = s8(buf[p++]), y = -s8(buf[p++]);
    if (c1 === 0x01) { b.mark('color'); colors++; if (x || y) b.rel('jump', x, y); }
    else if (c1 === 0x04) b.rel('jump', x, y);
    else if (c1 === 0x02) b.rel('stitch', x, y);
    else if (c1 === 0x80) b.mark('trim');
    else break; // unknown control: stop, as pyembroidery does
  }
  return { threads: Array.from({ length: colors }, (_, i) => thread(null, i)), cmds: b.cmds };
}

// ---- VP3 (Pfaff / Husqvarna Viking), ported from pyembroidery's Vp3Reader (MIT) ----
export function readVp3(buf) {
  if (String.fromCharCode(...buf.subarray(0, 5)) !== '%vsm%') throw new Error('Not a VP3 file');
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let p = 6;
  const skipStr = () => { p += 2 + d.getUint16(p); };
  const str8 = () => { const n = d.getUint16(p); p += 2; const t = String.fromCharCode(...buf.subarray(p, p + n)); p += n; return t; };
  const i32 = () => { const v = d.getInt32(p); p += 4; return v; };
  skipStr(); p += 7; skipStr(); p += 32;
  const centreX = i32() / 100, centreY = -i32() / 100; // file units are 1/1000 mm
  p += 27; skipStr(); p += 24; skipStr();
  const nColors = d.getUint16(p); p += 2;
  const b = new Builder(), threads = [];
  for (let c = 0; c < nColors; c++) {
    p += 3;
    const end = d.getUint32(p) + p + 4; p += 4;
    const ax = i32() / 100 + centreX, ay = -i32() / 100 + centreY;
    if (ax !== 0 && ay !== 0) b.rel('jump', ax - b.x, ay - b.y);
    const nParts = buf[p]; p += 2;
    let rgb = 0;
    for (let m = 0; m < nParts; m++) { rgb = (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2]; p += 6; }
    p += 2;
    const code = str8(), desc = str8(); str8();
    threads.push({ rgb, name: desc || code || `Color ${c + 1}` });
    p += 18;
    while (p + 1 < end) {
      const x = s8(buf[p]), y = s8(buf[p + 1]); p += 2;
      if (buf[p - 2] !== 0x80) { b.rel('stitch', x, y); continue; }
      if (y === 0x01) { b.rel('stitch', d.getInt16(p), d.getInt16(p + 2)); p += 6; }
      else if (y === 0x03) b.mark('trim');
    }
    p = end;
    if (c + 1 < nColors) b.mark('color');
  }
  return { threads: threads.length ? threads : [thread(null, 0)], cmds: b.cmds };
}

// format registry: extension -> reader / writer (writers are registered in formats/writers.js)
const READERS = { pes: readPes, pec: readPec, dst: (b) => readDst(b), jef: readJef, exp: (b) => readExp(b), vp3: readVp3, ...MORE_READERS };
export const SUPPORTED_EXTENSIONS = Object.keys(READERS);

export function readEmbroidery(name, bytes) {
  const ext = name.split('.').pop().toLowerCase();
  const reader = READERS[ext];
  if (!reader) throw new Error(`Unsupported file type .${ext} (supported: ${SUPPORTED_EXTENSIONS.join(', ')})`);
  return reader(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}
