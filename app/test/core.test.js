import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readEmbroidery } from '../src/formats/readers.js';
import { toPattern, transform, bounds } from '../src/pattern.js';
import { buildRecords, encodeRecords, decodePen, FX_COLOR, FX_END, FY_FEED, FY_CUT } from '../src/pen.js';
import { frame, dataInfoPayload, dataChunks, layoutPayload, parseMachineInfo } from '../src/pp1.js';

const fixture = (n) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const recordsOf = (name) => buildRecords(toPattern(readEmbroidery(name, fixture(name))));

// jumps.pen was produced by Brother's own libPP1_PESX_SharedLib from jumps.dst (via Artspira's importer).
test('PEN encoder matches Artspira output (except its tie-stitch offset bug at the tail)', () => {
  const mine = recordsOf('jumps.dst');
  const ref = decodePen(fixture('jumps.pen'));
  assert.deepEqual(mine.slice(0, 28), ref.slice(0, 28));
  assert.equal(mine.at(-1)[2], FX_END);
});

test('PEN encoder matches Artspira on a 3-colour design with hops and trims', () => {
  // identical through two colour changes; later tie-stitch counts follow Artspira heuristics we don't copy
  assert.deepEqual(recordsOf('big.dst').slice(0, 193), decodePen(fixture('big.pen')).slice(0, 193));
});

test('colour change, end, feed and cut flags', () => {
  const pat = { blocks: [
    { thread: { rgb: 0 }, segments: [{ trim: false, points: [[0, 0], [30, 0], [60, 0]] }, { trim: false, points: [[60, 200], [90, 200]] }] },
    { thread: { rgb: 0 }, segments: [{ trim: false, points: [[0, 100], [30, 100]] }] },
  ] };
  const r = buildRecords(pat);
  assert.equal(r[0][3], FY_FEED);
  const cutRec = r.find((x) => x[3] & FY_CUT);
  assert.ok(cutRec, 'long jump is cut');
  assert.equal(r.filter((x) => x[2] === FX_COLOR).length, 1);
  assert.equal(r.at(-1)[2], FX_END);
  // records are centred on the design
  const xs = r.map((x) => x[0]), ys = r.map((x) => x[1]);
  assert.equal(Math.min(...xs) + Math.max(...xs), 0);
  assert.equal(Math.min(...ys) + Math.max(...ys), 0);
});

test('record encoding round-trips negative coords and flags', () => {
  const recs = [[-50, -50, 0, 1], [-42, 7, 3, 2], [4095, -4096, 5, 0]];
  assert.deepEqual(decodePen(encodeRecords(recs)), recs);
  assert.deepEqual([...encodeRecords([[-50, -50, 0, 1]])], [0x70, 0xfe, 0x71, 0xfe]); // seen in Artspira output
});

test('PES reader agrees with DST reader on the same design', () => {
  const a = bounds(toPattern(readEmbroidery('sq.pes', fixture('sq.pes'))));
  const b = bounds(toPattern(readEmbroidery('sq.dst', fixture('sq.dst'))));
  assert.deepEqual([a.w, a.h], [b.w, b.h]);
  assert.equal(toPattern(readEmbroidery('sq.pes', fixture('sq.pes'))).blocks.length, 2);
});

test('transform centres, rotates and mirrors', () => {
  const pat = { blocks: [{ thread: {}, segments: [{ points: [[10, 10], [50, 10], [50, 30]] }] }] };
  const r = bounds(transform(pat, { rotate: 90 }));
  assert.deepEqual([r.w, r.h, r.x0 + r.x1, r.y0 + r.y1], [20, 40, 0, 0]);
  const f = transform(pat, { flip: true }).blocks[0].segments[0].points;
  assert.deepEqual(f[0], [20, -10]);
});

test('BLE framing: big-endian command, checksummed data', () => {
  assert.deepEqual([...frame(0x1201, [1, 2])], [0x12, 0x01, 1, 2]);
  const pen = Uint8Array.from([1, 2, 3, 250, 10]);
  assert.deepEqual(dataInfoPayload(pen), [3, 5, 0, 0, 0, 10, 1]); // sum 266 = 0x010a
  const c = dataChunks(pen, 3);
  assert.deepEqual([...c[0]], [0, 0, 0, 0, 1, 2, 3, 6]);
  assert.deepEqual([...c[1]], [3, 0, 0, 0, 250, 10, 4]); // 260 & 0xff
  const l = layoutPayload({ moveX: -10, moveY: 5, frame: 0, box: { x0: -60, y0: -45, x1: 40, y1: 55 } });
  assert.equal(l.length, 24);
  assert.deepEqual(l.slice(0, 12), [0xf6, 0xff, 5, 0, 100, 0, 100, 0, 0, 0, 0, 0]);
});

test('machine info parsing', () => {
  const info = new Uint8Array(54);
  info.set([0, 0], 0); info.set([0x00, 0x96], 2); // firmware 1.50
  info.set([...'B12345678'].map((c) => c.charCodeAt(0)), 4);
  const m = parseMachineInfo(info);
  assert.equal(m.firmware.startsWith('1.50'), true);
  assert.equal(m.serial, 'B12345678');
});

import { writeDst } from '../src/formats/dst-writer.js';
import { imageToStitches, PX } from '../src/image.js';
import { settingsPayload, parseServiceCounts, uuidHex } from '../src/pp1.js';

test('DST writer round-trips through the DST reader', () => {
  const src = toPattern(readEmbroidery('big.dst', fixture('big.dst')));
  const back = toPattern(readEmbroidery('x.dst', writeDst(src, 'big')));
  assert.equal(back.blocks.length, src.blocks.length);
  assert.deepEqual(bounds(back), bounds(src));
  // long stitches are split, never dropped: every source point is still a needle position
  const pts = (p) => new Set(p.blocks.flatMap((b) => b.segments.flatMap((s) => s.points.map(String))));
  const b = pts(back);
  for (const p of pts(src)) assert.ok(b.has(p), p);
  assert.deepEqual(back.blocks.map((x) => x.segments.length), src.blocks.map((x) => x.segments.length));
});

test('image generator: two shapes on white give two fill colours that cover them', () => {
  const w = 100, h = 60, data = new Uint8Array(w * h * 4).fill(255);
  const paint = (x0, y0, x1, y1, rgb) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.set([...rgb, 255], (y * w + x) * 4); };
  paint(10, 10, 40, 50, [220, 20, 20]);  // red 30x40 px
  paint(60, 20, 90, 40, [20, 40, 200]);  // blue 30x20 px
  data.set([0, 0, 0, 255], (5 * w + 5) * 4); // a 1 px speck: dropped
  const raw = imageToStitches({ width: w, height: h, data }, { colors: 2 });
  const pat = toPattern(raw);
  assert.equal(pat.blocks.length, 2);
  assert.ok(raw.threads[0].rgb >> 16 > 150, 'larger red area is sewn first');
  const bb = bounds(pat);
  assert.ok(Math.abs(bb.w - 80 * PX) <= 8 && Math.abs(bb.h - 40 * PX) <= 8, JSON.stringify(bb)); // pull compensation widens a little
  for (const b of pat.blocks) for (const s of b.segments) for (let i = 1; i < s.points.length; i++) {
    const [a, c] = [s.points[i - 1], s.points[i]];
    assert.ok(Math.hypot(c[0] - a[0], c[1] - a[1]) <= 75, 'stitch length bounded (satin up to 7 mm + pull compensation)');
  }
  assert.ok(buildRecords(pat).length > 100);
});

test('settings, service counter and job id helpers', () => {
  assert.deepEqual(settingsPayload({ autoCut: true, jumpCut: false, footHeight: 2 }), [1, 0, 1, 2, 0x90, 0x01]);
  assert.deepEqual(parseServiceCounts(Uint8Array.from([1, 0, 0x10, 0x27, 0, 0, 0xa0, 0x86, 1, 0])), { sinceService: 10000, total: 100000 });
  assert.equal(uuidHex(Uint8Array.from([7, 2, ...Array(15).fill(0), 255])), '0'.repeat(30) + 'ff');
});

test('image generator sews a ring in a few passes, not with a cut on every row', () => {
  const w = 120, h = 120, data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const r = Math.hypot(x - 60, y - 60);
    if (r < 55 && r > 30) data.set([200, 30, 30, 255], (y * w + x) * 4);
  }
  const recs = buildRecords(toPattern(imageToStitches({ width: w, height: h, data }, { colors: 1 })));
  const cuts = recs.filter((r) => r[3] & FY_CUT).length;
  assert.ok(cuts <= 4, `cuts: ${cuts}`);
});

import { stack } from '../src/pattern.js';
test('stack puts the second design under the first, centred', () => {
  const a = { blocks: [{ thread: {}, segments: [{ points: [[0, 0], [100, 50]] }] }] };
  const b = { blocks: [{ thread: {}, segments: [{ points: [[500, 500], [540, 520]] }] }] };
  const s = stack(a, b, 30);
  assert.equal(s.blocks.length, 2);
  assert.deepEqual(s.blocks[1].segments[0].points, [[30, 80], [70, 100]]);
});

import { firmwareTarget, isNewer } from '../src/pp1.js';
test('firmware helpers', () => {
  assert.equal(isNewer('1.04.00', '1.03.5'), true);
  assert.equal(isNewer('1.04.00', '1.04.0'), false);
  assert.equal(isNewer('1.4', '1.10'), false);
  const two = new Uint8Array(19); two[0] = 2; two[1] = 1; two[10] = 2;
  assert.equal(firmwareTarget(two), 3);
  assert.equal(firmwareTarget(Uint8Array.from([1, 2, 0, 0, 0, 0, 0, 0, 0, 0])), 2);
  assert.equal(firmwareTarget(Uint8Array.from([0])), 0);
  assert.deepEqual(dataInfoPayload(Uint8Array.from([1, 2]), 4), [4, 2, 0, 0, 0, 3, 0]);
});

test('image generator: underlay and outline add stitches but stay inside the shape', () => {
  const w = 80, h = 80, data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 10; y < 70; y++) for (let x = 10; x < 70; x++) data.set([20, 120, 40, 255], (y * w + x) * 4);
  const img = { width: w, height: h, data };
  const plain = toPattern(imageToStitches(img, { colors: 1, underlay: false, outline: false }));
  const full = toPattern(imageToStitches(img, { colors: 1 }));
  assert.ok(stitchCountOf(full) > stitchCountOf(plain));
  const a = bounds(plain), b = bounds(full);
  assert.ok(b.w <= a.w + 2 && b.h <= a.h + 4, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
  assert.ok(buildRecords(full).filter((r) => r[3] & FY_CUT).length <= 1, 'underlay, fill and outline join without cuts');
});
const stitchCountOf = (p) => p.blocks.reduce((n, b) => n + b.segments.reduce((m, s) => m + s.points.length, 0), 0);

import { writePes } from '../src/formats/pes-writer.js';
test('PES writer round-trips through the PES reader, centred, with colours', () => {
  const src = toPattern(readEmbroidery('big.dst', fixture('big.dst')));
  src.blocks.forEach((b, i) => (b.thread = { rgb: [0x000000, 0xed171f, 0x2f7e20][i] }));
  const out = writePes(src, 'big');
  assert.equal(String.fromCharCode(...out.subarray(0, 8)), '#PES0001');
  const back = toPattern(readEmbroidery('x.pes', out));
  assert.equal(back.blocks.length, 3);
  assert.deepEqual(back.blocks.map((b) => b.thread.rgb), [0x000000, 0xed171f, 0x2f7e20]);
  const a = bounds(src), b = bounds(back);
  assert.deepEqual([b.w, b.h, b.x0 + b.x1, b.y0 + b.y1], [a.w, a.h, 0, 0]);
  assert.equal(stitchCountOf(back), stitchCountOf(src));
});

test('image generator: a thin ring is satin that crosses the stroke, stitches stay on the ring', () => {
  const w = 150, h = 150, data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = Math.hypot(x - 75, y - 75); if (r > 55 && r < 66) data.set([30, 30, 30, 255], (y * w + x) * 4); }
  const { cmds } = imageToStitches({ width: w, height: h, data }, { colors: 1, pull: 0 });
  const st = cmds.filter((c) => c.t === 'stitch');
  // every needle point within 0.6 mm of the ring band (radius 11-13.2 mm), most stitches roughly radial
  for (const c of st) { const r = Math.hypot(c.x, c.y); assert.ok(r > 104 && r < 138, `r ${r}`); }
  let radial = 0;
  for (let i = 1; i < st.length; i++) {
    const dx = st[i].x - st[i - 1].x, dy = st[i].y - st[i - 1].y, L = Math.hypot(dx, dy);
    if (L > 15 && Math.abs(dx * st[i].x + dy * st[i].y) / (L * Math.hypot(st[i].x, st[i].y)) > 0.9) radial++;
  }
  assert.ok(radial > st.length * 0.3, `radial ${radial}/${st.length}`);
  assert.ok(cmds.filter((c) => c.t === 'jump').length <= 3);
});

test('background removal: a noisy grey-to-white gradient is left unstitched, holes too', () => {
  const w = 120, h = 100, data = new Uint8Array(w * h * 4);
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 12;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const g = 200 + (55 * x) / w + rnd(), r = Math.hypot(x - 60, y - 50);
    data.set(r < 30 && r > 12 ? [30, 60, 170, 255] : [g, g, g - 4, 255], (y * w + x) * 4);
  }
  const { threads, cmds } = imageToStitches({ width: w, height: h, data }, { colors: 2 });
  for (const c of cmds.filter((c) => c.t === 'stitch')) { const r = Math.hypot(c.x, c.y) / PX; assert.ok(r > 9 && r < 33, `stitch at r=${r} px`); }
  assert.ok(threads.every((t) => (t.rgb & 255) > 120), 'only blue threads');
});
