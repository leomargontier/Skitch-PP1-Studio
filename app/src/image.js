// Image -> embroidery: reduce the picture to a few thread colours, then fill each colour area
// with rows of tatami fill stitches. Input pixels are already scaled so 1 px = PX units.
// Output is the same { threads, cmds } shape the file readers produce.
import { PEC_PALETTE } from './formats/palettes.js';

export const PX = 2; // 1 px = 0.2 mm

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// k-means on RGB. Seeds come from colours that cover a real share of the picture (so blended
// edge pixels can't become a thread) and are spread out by farthest-point picking: repeatable results.
export function kmeans(pixels, k, iterations = 12) {
  const step = Math.max(1, Math.floor(pixels.length / 20000));
  const sample = pixels.filter((_, i) => i % step === 0);
  const bins = new Map();
  for (const p of sample) {
    const key = ((p[0] >> 4) << 8) | ((p[1] >> 4) << 4) | (p[2] >> 4);
    const b = bins.get(key) || [0, 0, 0, 0];
    b[0] += p[0]; b[1] += p[1]; b[2] += p[2]; b[3]++;
    bins.set(key, b);
  }
  const all = [...bins.values()].sort((a, b) => b[3] - a[3]).map((b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3], b[3]]);
  const cand = all.filter((b) => b[3] >= sample.length * 0.005);
  const centres = [cand[0] || all[0]];
  while (centres.length < k) {
    let best = null, bestD = 0;
    for (const p of cand.length ? cand : all) { const d = Math.min(...centres.map((c) => dist2(p, c))); if (d > bestD) { bestD = d; best = p; } }
    if (!best) break;
    centres.push(best);
  }
  centres.forEach((c, i) => (centres[i] = c.slice(0, 3)));
  for (let it = 0; it < iterations; it++) {
    const acc = centres.map(() => [0, 0, 0, 0]);
    for (const p of sample) {
      const a = acc[nearest(centres, p)];
      a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++;
    }
    acc.forEach((a, i) => { if (a[3]) centres[i] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  return centres.map((c) => c.map(Math.round));
}
function nearest(centres, p) {
  let bi = 0, bd = Infinity;
  centres.forEach((c, i) => { const d = dist2(p, c); if (d < bd) { bd = d; bi = i; } });
  return bi;
}

// 4-connected components of equal labels; returns component id per pixel and the pixel lists
function components(label, w, h) {
  const comp = new Int32Array(w * h).fill(-1), list = [];
  for (let i = 0; i < w * h; i++) {
    if (label[i] < 0 || comp[i] >= 0) continue;
    const id = list.length, px = [], stack = [i];
    comp[i] = id;
    while (stack.length) {
      const j = stack.pop(); px.push(j);
      const x = j % w, y = (j / w) | 0;
      for (const n of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
        if (n >= 0 && comp[n] < 0 && label[n] === label[i]) { comp[n] = id; stack.push(n); }
      }
    }
    list.push({ label: label[i], px });
  }
  return { comp, list };
}

const toRgb = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
function threadFor(c) {
  let best = null, bd = Infinity;
  for (const e of PEC_PALETTE) {
    if (!e) continue;
    const d = dist2(c, [(e[0] >> 16) & 255, (e[0] >> 8) & 255, e[0] & 255]);
    if (d < bd) { bd = d; best = e; }
  }
  return { rgb: toRgb(c), name: best ? best[1] : '' };
}

/**
 * @param img {width, height, data: RGBA bytes}, 1 px = PX units
 * @param opts colors: thread count; removeBg: drop the colour that covers most of the border;
 *             spacing: row spacing (0.1 mm); stitch: max stitch length (0.1 mm); minArea: smallest area kept (px)
 */
export function imageToStitches(img, { colors = 4, removeBg = true, spacing = 4, stitch = 30, minArea = 25 } = {}) {
  const { width: w, height: h, data } = img;
  const opaque = [];
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 128) opaque.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
  if (!opaque.length) throw new Error('The image is empty');
  const hasAlpha = opaque.length < w * h * 0.98;
  const centres = kmeans(opaque, colors + (removeBg && !hasAlpha ? 1 : 0));

  const label = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 128) label[i] = nearest(centres, [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);

  if (removeBg && !hasAlpha) {
    const votes = new Array(centres.length).fill(0);
    for (let x = 0; x < w; x++) { votes[label[x]]++; votes[label[(h - 1) * w + x]]++; }
    for (let y = 0; y < h; y++) { votes[label[y * w]]++; votes[label[y * w + w - 1]]++; }
    const bg = votes.indexOf(Math.max(...votes));
    for (let i = 0; i < w * h; i++) if (label[i] === bg) label[i] = -1;
  }

  // one majority-vote pass removes the 1 px colour fringes left by anti-aliased edges
  const voted = label.slice();
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const count = new Map();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = label[(y + dy) * w + x + dx]; count.set(l, (count.get(l) || 0) + 1); }
    let best = label[y * w + x], bc = 0;
    for (const [l, c] of count) if (c > bc) { bc = c; best = l; }
    if (bc >= 5) voted[y * w + x] = best;
  }
  label.set(voted);

  // specks too small to sew take the colour of a neighbour (or vanish)
  for (const c of components(label, w, h).list) {
    if (c.px.length >= minArea) continue;
    const set = new Set(c.px);
    let to = -1;
    for (const j of c.px) {
      for (const n of [j - 1, j + 1, j - w, j + w]) if (n >= 0 && n < w * h && !set.has(n)) { to = label[n]; break; }
      if (to !== -1) break;
    }
    for (const j of c.px) label[j] = to;
  }

  const { comp, list } = components(label, w, h);
  const rowStep = Math.max(1, Math.round(spacing / PX));
  const cx = (w * PX) / 2, cy = (h * PX) / 2;
  const used = [...new Set(list.map((c) => c.label))]
    .map((l) => ({ l, area: list.filter((c) => c.label === l).reduce((s, c) => s + c.px.length, 0) }))
    .sort((a, b) => b.area - a.area); // big areas first, details sewn on top

  const threads = [], cmds = [];
  let pos = null;
  const stitchTo = (x, y) => {
    // split long travels into stitches no longer than `stitch`
    if (pos) {
      const n = Math.ceil(Math.hypot(x - pos[0], y - pos[1]) / stitch);
      for (let i = 1; i < n; i++) cmds.push({ t: 'stitch', x: Math.round(pos[0] + ((x - pos[0]) * i) / n), y: Math.round(pos[1] + ((y - pos[1]) * i) / n) });
    }
    cmds.push({ t: 'stitch', x, y }); pos = [x, y];
  };
  const goTo = (x, y) => {
    if (pos && Math.hypot(x - pos[0], y - pos[1]) <= stitch * 1.5) stitchTo(x, y);
    else { cmds.push({ t: 'jump', x, y }); pos = [x, y]; }
  };

  const sewRun = ({ a, b, y, row }, rightward) => {
    const uy = Math.round(y * PX + PX / 2 - cy), xa = a * PX - cx, xb = b * PX - cx;
    // tatami: stitch ends shift by a third each row so the fill shows no straight furrows
    const phase = ((row % 3) * stitch) / 3;
    const xs = [xa];
    for (let x = Math.floor((xa - phase) / stitch + 1) * stitch + phase; x < xb - 5; x += stitch) if (x > xa + 5) xs.push(x);
    xs.push(xb);
    if (!rightward) xs.reverse();
    goTo(Math.round(xs[0]), uy);
    for (const x of xs.slice(1)) stitchTo(Math.round(x), uy);
  };

  used.forEach(({ l }, ti) => {
    if (ti > 0) { cmds.push({ t: 'color', x: pos[0], y: pos[1] }); }
    threads.push(threadFor(centres[l]));
    list.forEach((c, id) => {
      if (c.label !== l) return;
      let ymin = h, ymax = 0;
      for (const j of c.px) { const y = (j / w) | 0; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
      // all horizontal runs of this area, one row every rowStep px
      const rows = [];
      for (let y = ymin, row = 0; y <= ymax; y += rowStep, row++) {
        const runs = [];
        let start = -1;
        for (let x = 0; x <= w; x++) {
          const inside = x < w && comp[y * w + x] === id;
          if (inside && start < 0) start = x;
          if (!inside && start >= 0) { runs.push({ a: start, b: x, y, row, done: false }); start = -1; }
        }
        rows.push(runs);
      }
      // serpentine down through overlapping runs; jump only when a branch ends
      // (a ring is sewn as two halves, not with a jump across the hole on every row)
      let left = rows.reduce((n, r) => n + r.length, 0), cur = null, rightward = true;
      while (left > 0) {
        const next = cur && rows[cur.row + 1]?.find((r) => !r.done && r.a < cur.b && r.b > cur.a);
        if (next) cur = next;
        else {
          let best = null, bd = Infinity;
          for (const r of rows.flat()) {
            if (r.done) continue;
            const d = pos ? Math.min(Math.hypot(r.a * PX - cx - pos[0], r.y * PX - cy - pos[1]), Math.hypot(r.b * PX - cx - pos[0], r.y * PX - cy - pos[1])) : r.row;
            if (d < bd) { bd = d; best = r; }
          }
          cur = best;
          if (pos) rightward = Math.abs(cur.a * PX - cx - pos[0]) <= Math.abs(cur.b * PX - cx - pos[0]);
        }
        cur.done = true; left--;
        sewRun(cur, rightward);
        rightward = !rightward;
      }
    });
  });
  if (!cmds.length) throw new Error('Nothing to stitch: try more colours or turn off background removal');
  return { threads, cmds };
}
