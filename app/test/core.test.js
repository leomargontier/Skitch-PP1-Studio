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
