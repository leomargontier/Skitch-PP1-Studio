// Image -> embroidery.
// 1. Reduce the picture to a few thread colours (k-means in Lab, so shades split the way the eye sees them).
// 2. Clean up: majority vote against anti-aliasing fringes, tiny specks merged into a neighbour.
// 3. Per area: thin parts (strokes, letters) become satin columns stitched across their narrow width;
//    wide parts become tatami fill at the chosen angle over a cross-hatched underlay, with an edge outline.
// Pull compensation lengthens every row a little because the fabric pulls stitches inward.
// Input pixels are already scaled so 1 px = PX units (0.1 mm). Output is { threads, cmds } like the readers.
import { PEC_PALETTE } from './formats/palettes.js';

export const PX = 2; // 1 px = 0.2 mm

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

// sRGB 0-255 -> CIE Lab, shifted so every channel sits in 0-255 (L 0-100, a/b +128)
export function lab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047), fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B), fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy) + 128, 200 * (fy - fz) + 128];
}

// k-means. Seeds come from colours that cover a real share of the picture (so blended edge
// pixels can't become a thread) and are spread out by farthest-point picking: repeatable results.
export function kmeans(pixels, k, iterations = 12) {
  const step = Math.max(1, Math.floor(pixels.length / 20000));
  const sample = pixels.filter((_, i) => i % step === 0);
  const bins = new Map();
  for (const p of sample) {
    const q = p.map((v) => Math.max(0, Math.min(255, v | 0)) >> 4);
    const key = (q[0] << 8) | (q[1] << 4) | q[2];
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
  return centres;
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

// chamfer distance (3 per px step, 4 diagonal) from each pixel to the nearest pixel of another label
function distanceToEdge(label, w, h) {
  const d = new Float32Array(w * h).fill(1e9);
  const pass = (ys, xs, nbrs) => {
    for (const y of ys) for (const x of xs) {
      const i = y * w + x;
      if (label[i] < 0) { d[i] = 0; continue; }
      for (const [dx, dy, c] of nbrs) {
        const nx = x + dx, ny = y + dy;
        const v = nx < 0 || ny < 0 || nx >= w || ny >= h || label[ny * w + nx] !== label[i] ? c : d[ny * w + nx] + c;
        if (v < d[i]) d[i] = v;
      }
    }
  };
  const fwd = [...Array(h).keys()], fx = [...Array(w).keys()];
  pass(fwd, fx, [[-1, 0, 3], [0, -1, 3], [-1, -1, 4], [1, -1, 4]]);
  pass(fwd.slice().reverse(), fx.slice().reverse(), [[1, 0, 3], [0, 1, 3], [1, 1, 4], [-1, 1, 4]]);
  return d; // in thirds of a pixel
}

function threadFor(rgb) {
  let best = null, bd = Infinity;
  const l = lab([(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255]);
  for (const e of PEC_PALETTE) {
    if (!e) continue;
    const d = dist2(l, lab([(e[0] >> 16) & 255, (e[0] >> 8) & 255, e[0] & 255]));
    if (d < bd) { bd = d; best = e; }
  }
  return { rgb, name: best ? best[1] : '' };
}
export const threadName = (rgb) => threadFor(rgb).name;

const SATIN_MAX = 70; // longer satin stitches snag; longer rows fall back to tatami

/**
 * Picture -> areas (one per connected patch of one thread colour).
 * @param img {width, height, data: RGBA bytes}, 1 px = PX units
 * @param opts colors: thread count; removeBg: leave the background unstitched;
 *   bgTolerance: how different (CIE Lab distance) a pixel may be from the border colours and still count as background;
 *   minArea: smallest area kept (px); satin: thin parts as satin columns; satinWidth: widest part sewn as satin (0.1 mm)
 */
export function analyze(img, { colors = 4, removeBg = true, bgTolerance = 18, minArea = 25, satin = true, satinWidth = 50 } = {}) {
  const { width: w, height: h, data } = img;
  const labCache = new Map();
  const labAt = (i) => {
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    let v = labCache.get(key);
    if (!v) { v = lab([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]); labCache.set(key, v); }
    return v;
  };
  const label = new Int32Array(w * h).fill(-1);
  let opaqueCount = 0;
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 128) { label[i] = 0; opaqueCount++; }
  if (!opaqueCount) throw new Error('The image is empty');
  const hasAlpha = opaqueCount < w * h * 0.98;

  // background: every pixel close to one of the border's main colours (also the holes in letters and rings).
  // A tolerance handles off-white, JPEG noise, soft shadows and gradients.
  let refs = [];
  if (removeBg && !hasAlpha) {
    const border = [];
    for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) border.push(y * w, y * w + w - 1);
    const t2 = bgTolerance ** 2, bl = border.map(labAt);
    refs = kmeans(bl, 3).filter((c) => bl.filter((p) => dist2(c, p) <= t2).length >= bl.length * 0.1);
    for (let i = 0; i < w * h; i++) if (label[i] === 0 && refs.some((c) => dist2(c, labAt(i)) <= t2)) label[i] = -1;
  }
  const fg = [];
  for (let i = 0; i < w * h; i++) if (label[i] === 0) fg.push(labAt(i));
  if (!fg.length) throw new Error('Everything looks like background: lower the background tolerance');
  const centres = kmeans(fg, colors);
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== 0) continue;
    const p = labAt(i), l = nearest(centres, p);
    // anti-aliased edge pixels nearer the background than any thread are background
    label[i] = refs.some((c) => dist2(c, p) < dist2(centres[l], p)) ? -1 : l;
  }

  // thread colour = average picture colour of the pixels it covers
  const rgbSum = centres.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < w * h; i++) if (label[i] >= 0) { const s = rgbSum[label[i]]; s[0] += data[i * 4]; s[1] += data[i * 4 + 1]; s[2] += data[i * 4 + 2]; s[3]++; }
  const rgbOf = (l) => { const [r, g, b] = rgbSum[l].slice(0, 3).map((v) => Math.round(v / Math.max(1, rgbSum[l][3]))); return (r << 16) | (g << 8) | b; };

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
  const edge = distanceToEdge(label, w, h);
  const cx = (w * PX) / 2, cy = (h * PX) / 2;
  const areas = list.map((c, id) => {
    const box = { x0: w, y0: h, x1: 0, y1: 0 };
    let maxEdge = 0, sx = 0, sy = 0;
    for (const j of c.px) {
      const x = j % w, y = (j / w) | 0;
      if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x; if (y < box.y0) box.y0 = y; if (y > box.y1) box.y1 = y;
      if (edge[j] > maxEdge) maxEdge = edge[j];
      sx += x; sy += y;
    }
    const widthUnits = ((2 * maxEdge) / 3) * PX;
    return { id, rgb: rgbOf(c.label), box, area: c.px.length, thin: satin && widthUnits <= satinWidth, widthUnits, centre: [(sx / c.px.length) * PX - cx, (sy / c.px.length) * PX - cy] };
  });
  return { w, h, comp, edge, areas };
}

/**
 * Default sewing plan: one object per area, largest colour first (details sewn on top), nearest area next.
 * An object is { area, rgb, type: 'auto'|'satin'|'fill'|'outline', angle, spacing, stitch, pull, underlay, outline } (0.1 mm units).
 */
export function defaultObjects(model, { spacing = 4, stitch = 30, underlay = true, outline = true, angle = 45, pull = 2 } = {}) {
  const byColour = new Map();
  for (const a of model.areas) byColour.set(a.rgb, (byColour.get(a.rgb) || 0) + a.area);
  const objects = [];
  let at = null;
  for (const [rgb] of [...byColour].sort((p, q) => q[1] - p[1])) {
    const todo = model.areas.filter((a) => a.rgb === rgb);
    while (todo.length) {
      let k = 0;
      if (at) todo.forEach((a, i) => { if (Math.hypot(a.centre[0] - at[0], a.centre[1] - at[1]) < Math.hypot(todo[k].centre[0] - at[0], todo[k].centre[1] - at[1])) k = i; });
      const a = todo.splice(k, 1)[0];
      at = a.centre;
      objects.push({ area: a.id, rgb, type: 'auto', angle, spacing, stitch, pull, underlay, outline });
    }
  }
  return objects;
}

export function imageToStitches(img, opts = {}) {
  const model = analyze(img, opts);
  return stitchObjects(model, defaultObjects(model, opts));
}

/** Objects -> { threads, cmds }. Each stitch command carries o: the index of the object it belongs to. */
export function stitchObjects(model, objects) {
  const { w, h, comp, edge, areas } = model;
  const cx = (w * PX) / 2, cy = (h * PX) / 2;
  let gap = 2, pullPx = 1, stitch = 30, underlay = true; // set per object below

  // --- stitch output ---
  const threads = [], cmds = [];
  let pos = null;
  const stitchTo = (x, y, maxLen = stitch) => {
    if (pos) {
      const len = Math.hypot(x - pos[0], y - pos[1]);
      if (len < 3) return; // a stitch under 0.3 mm only knots the thread
      const n = Math.ceil(len / maxLen);
      for (let i = 1; i < n; i++) cmds.push({ t: 'stitch', x: Math.round(pos[0] + ((x - pos[0]) * i) / n), y: Math.round(pos[1] + ((y - pos[1]) * i) / n) });
    }
    cmds.push({ t: 'stitch', x, y }); pos = [x, y];
  };
  // travel by stitching only when the straight path stays inside the area being sewn
  // (a travel stitch over bare fabric would show); otherwise jump
  let area = -1;
  const insideUnits = (ux, uy) => {
    const x = Math.floor((ux + cx) / PX), y = Math.floor((uy + cy) / PX);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h && comp[yy * w + xx] === area) return true;
    }
    return false;
  };
  const pathInside = (x, y) => {
    const n = Math.ceil(Math.hypot(x - pos[0], y - pos[1]) / 5);
    for (let i = 1; i < n; i++) if (!insideUnits(pos[0] + ((x - pos[0]) * i) / n, pos[1] + ((y - pos[1]) * i) / n)) return false;
    return true;
  };
  const goTo = (x, y) => {
    if (pos && Math.hypot(x - pos[0], y - pos[1]) <= stitch * 1.5 && pathInside(x, y)) stitchTo(x, y);
    else { cmds.push({ t: 'jump', x, y }); pos = [x, y]; }
  };
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];

  // --- scanning an area along parallel lines at any angle ---
  // A run is one straight stretch inside the area: points t*n + s*d for s in [a, b] (px).
  const at = (r, s) => [Math.round((r.t * r.n[0] + s * r.d[0]) * PX - cx), Math.round((r.t * r.n[1] + s * r.d[1]) * PX - cy)];
  const scan = (id, box, deg, gap, inset, comp_) => {
    const th = (deg * Math.PI) / 180, d = [Math.cos(th), Math.sin(th)], n = [-d[1], d[0]];
    const corners = [[box.x0, box.y0], [box.x1 + 1, box.y0], [box.x0, box.y1 + 1], [box.x1 + 1, box.y1 + 1]];
    const ts = corners.map(([x, y]) => x * n[0] + y * n[1]), ss = corners.map(([x, y]) => x * d[0] + y * d[1]);
    const [t0, t1, s0, s1] = [Math.min(...ts), Math.max(...ts), Math.min(...ss), Math.max(...ss)];
    const rows = [];
    for (let t = t0 + gap / 2, row = 0; t < t1; t += gap, row++) {
      const runs = [];
      let start = null, last = null;
      for (let s = s0; s <= s1 + 2; s += 0.5) {
        const x = Math.floor(t * n[0] + s * d[0]), y = Math.floor(t * n[1] + s * d[1]);
        const inside = x >= box.x0 && y >= box.y0 && x <= box.x1 && y <= box.y1 && comp[y * w + x] === id; // box also clips
        if (inside) { if (start === null) start = s; last = s; }
        else if (start !== null && s - last > 1) { // diagonal lines graze pixel corners: bridge 1 px gaps
          const a = start + inset, b = last + 0.5 - inset;
          if (b - a > 1.5) runs.push({ a: a - comp_, b: b + comp_, t, d, n, row, done: false }); // drop slivers under 0.3 mm
          start = null;
        }
      }
      rows.push(runs);
    }
    return rows;
  };

  // serpentine through overlapping runs of consecutive lines; jump only when a branch ends
  // (a ring is sewn as two halves, not with a jump across the hole on every row)
  const fill = (rows, len, satinMax) => {
    let left = rows.reduce((k, r) => k + r.length, 0), cur = null, forward = true;
    while (left > 0) {
      const next = cur && rows[cur.row + 1]?.find((r) => !r.done && r.a < cur.b && r.b > cur.a);
      if (next) cur = next;
      else {
        let best = null, bd = Infinity;
        for (const r of rows.flat()) {
          if (r.done) continue;
          const dd = pos ? Math.min(Math.hypot(...sub(at(r, r.a), pos)), Math.hypot(...sub(at(r, r.b), pos))) : r.row;
          if (dd < bd) { bd = dd; best = r; }
        }
        cur = best;
        if (pos) forward = Math.hypot(...sub(at(cur, cur.a), pos)) <= Math.hypot(...sub(at(cur, cur.b), pos));
      }
      cur.done = true; left--;
      sewRun(cur, forward, len, satinMax);
      forward = !forward;
    }
  };
  const sewRun = (r, forward, len, satinMax) => {
    let ps;
    if ((r.b - r.a) * PX <= satinMax) ps = [r.a, r.b]; // one satin stitch across
    else {
      // tatami: stitch ends shift by a third each row so the fill shows no straight furrows
      const step = len / PX, phase = ((r.row % 3) * step) / 3;
      ps = [r.a];
      for (let p = Math.floor((r.a - phase) / step + 1) * step + phase; p < r.b - 2.5; p += step) if (p > r.a + 2.5) ps.push(p);
      ps.push(r.b);
    }
    if (!forward) ps.reverse();
    goTo(...at(r, ps[0]));
    for (const p of ps.slice(1)) stitchTo(...at(r, p), Math.max(len, satinMax));
  };

  // mean run length along each angle: satin goes the way that crosses the stroke.
  // Also returns the share of rows too long for satin (a curved ring has many: it is sewn as fill).
  const bestSatinAngle = (id, box) => {
    let best = { deg: 0, mean: Infinity, long: 1 };
    for (let deg = 0; deg < 180; deg += 22.5) {
      const runs = scan(id, box, deg, 3, 0, 0).flat();
      if (!runs.length) continue;
      const mean = runs.reduce((s, r) => s + r.b - r.a, 0) / runs.length;
      if (mean < best.mean) best = { deg, mean, long: runs.filter((r) => (r.b - r.a) * PX > SATIN_MAX).length / runs.length };
    }
    return best;
  };

  // outer edge of an area as a running stitch (Moore-neighbour contour trace), for crisp borders
  const outlineOf = (id, box) => {
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && comp[y * w + x] === id;
    let sx = -1;
    for (let x = box.x0; x <= box.x1 && sx < 0; x++) if (inside(x, box.y0)) sx = x;
    const dirs = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    const pts = [[sx, box.y0]];
    let [x, y] = [sx, box.y0], d = 6;
    for (let guard = 0; guard < 16 * (box.x1 - box.x0 + box.y1 - box.y0 + 4); guard++) {
      let moved = false;
      for (let k = 0; k < 8; k++) {
        const nd = (d + 6 + k) % 8, nx = x + dirs[nd][0], ny = y + dirs[nd][1];
        if (inside(nx, ny)) { x = nx; y = ny; d = nd; moved = true; break; }
      }
      if (!moved || (x === sx && y === box.y0)) break;
      pts.push([x, y]);
    }
    return pts.map(([px, py]) => [Math.round(px * PX + PX / 2 - cx), Math.round(py * PX + PX / 2 - cy)]);
  };
  const sewOutline = (pts) => {
    if (pts.length < 4) return;
    // start where the needle is closest, walk the loop once, about 2 mm a stitch
    let k = 0, bd = Infinity;
    pts.forEach((p, i) => { const dd = pos ? Math.hypot(...sub(p, pos)) : 0; if (dd < bd) { bd = dd; k = i; } });
    const loop = [...pts.slice(k), ...pts.slice(0, k + 1)];
    goTo(...loop[0]);
    let last = loop[0];
    for (const p of loop.slice(1)) if (Math.hypot(...sub(p, last)) >= 20) { stitchTo(...p); last = p; }
    stitchTo(...loop.at(-1));
  };

  const satinTiles = (a) => {
    const T = 20, tiles = [];
    for (let y0 = a.box.y0; y0 <= a.box.y1; y0 += T) for (let x0 = a.box.x0; x0 <= a.box.x1; x0 += T) {
      const box = { x0, y0, x1: Math.min(x0 + T - 1, a.box.x1), y1: Math.min(y0 + T - 1, a.box.y1) };
      let n = 0;
      for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) if (comp[y * w + x] === a.id) n++;
      if (n) tiles.push({ box, centre: [((x0 + T / 2) * PX) - cx, ((y0 + T / 2) * PX) - cy] });
    }
    while (tiles.length) {
      let k = 0;
      if (pos) tiles.forEach((t, i) => { if (Math.hypot(...sub(t.centre, pos)) < Math.hypot(...sub(tiles[k].centre, pos))) k = i; });
      const t = tiles.splice(k, 1)[0];
      // judge the direction on a wider window so a tile sees the stroke, not just its own corner of it
      const win = { x0: Math.max(a.box.x0, t.box.x0 - T / 2), y0: Math.max(a.box.y0, t.box.y0 - T / 2), x1: Math.min(a.box.x1, t.box.x1 + T / 2), y1: Math.min(a.box.y1, t.box.y1 + T / 2) };
      fill(scan(a.id, t.box, bestSatinAngle(a.id, win).deg, gap, 0, 0), stitch, SATIN_MAX);
    }
  };

  // --- satin that follows the stroke: stitches cross the centreline at right angles ---
  // Zhang-Suen thinning gives the centreline; it is split into branches at forks, each branch is
  // walked with a centre-run underlay one way and satin back. Returns false if the area has no usable centreline.
  const N8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  const skeletonSatin = (a) => {
    const { box } = a, bw = box.x1 - box.x0 + 3, bh = box.y1 - box.y0 + 3;
    const m = new Uint8Array(bw * bh);
    for (let y = box.y0; y <= box.y1; y++) for (let x = box.x0; x <= box.x1; x++) if (comp[y * w + x] === a.id) m[(y - box.y0 + 1) * bw + x - box.x0 + 1] = 1;
    const nb = (i) => N8.map(([dx, dy]) => m[i + dy * bw + dx]);
    const crossings = (v) => v.reduce((k, p, j) => k + (!p && v[(j + 1) % 8] ? 1 : 0), 0);
    for (let changed = true; changed;) {
      changed = false;
      for (const pass of [0, 1]) {
        const del = [];
        for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
          const i = y * bw + x;
          if (!m[i]) continue;
          const v = nb(i), n = v.reduce((s, p) => s + p, 0);
          if (n < 2 || n > 6 || crossings(v) !== 1) continue;
          if (pass === 0 ? v[0] * v[2] * v[4] || v[2] * v[4] * v[6] : v[0] * v[2] * v[6] || v[0] * v[4] * v[6]) continue;
          del.push(i);
        }
        for (const i of del) m[i] = 0;
        if (del.length) changed = true;
      }
    }
    // branches between end points / forks (a pixel is a node unless exactly two runs of neighbours touch it)
    const pts = [];
    for (let i = 0; i < m.length; i++) if (m[i]) pts.push(i);
    if (!pts.length) return false;
    const node = (i) => crossings(nb(i)) !== 2;
    const seen = new Uint8Array(m.length), branches = [];
    const walk = (from, first) => {
      const path = [from];
      let cur = first, prev = from;
      while (true) {
        path.push(cur);
        if (node(cur) && cur !== from) break;
        seen[cur] = 1;
        const nexts = N8.map(([dx, dy]) => cur + dy * bw + dx).filter((j) => m[j] && j !== prev && (!seen[j] || (node(j) && j !== from) || (j === from && path.length > 3)));
        if (!nexts.length) break;
        const next = nexts.find((j) => node(j) || j === from) ?? nexts.sort((p, q) => Math.abs(p - cur) % bw === 0 || Math.abs(p - cur) === 1 ? -1 : 1)[0];
        prev = cur; cur = next;
        if (cur === from) { path.push(cur); break; }
      }
      return path;
    };
    for (const i of pts) if (node(i)) for (const [dx, dy] of N8) { const j = i + dy * bw + dx; if (m[j] && !seen[j]) { const p = walk(i, j); if (!node(j)) branches.push(p); else if (i < j) branches.push(p); } }
    for (const i of pts) if (!seen[i] && !node(i)) { seen[i] = 1; const j = N8.map(([dx, dy]) => i + dy * bw + dx).find((k) => m[k]); if (j != null) branches.push(walk(i, j)); }
    const toPx = (i) => [(i % bw) + box.x0 - 1 + 0.5, ((i / bw) | 0) + box.y0 - 1 + 0.5];
    const inside = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y); return xi >= 0 && yi >= 0 && xi < w && yi < h && comp[yi * w + xi] === a.id; };
    const half = (x, y) => edge[Math.min(h - 1, Math.max(0, Math.floor(y))) * w + Math.min(w - 1, Math.max(0, Math.floor(x)))] / 3;
    const ray = (x, y, dx, dy, lim) => { let s = 0, last = 0; while (s < lim) { s += 0.25; if (inside(x + dx * s, y + dy * s)) last = s; else if (s - last > 1) break; } return last + 0.25; };
    const maxHalf = a.widthUnits / PX / 2;
    // spurs shorter than the stroke is wide are thinning noise
    let lines = branches.map((b) => b.map(toPx)).filter((b, k) => b.length > 1 && (branches.length === 1 || (!node(branches[k][0]) || !node(branches[k].at(-1)) ? b.length > maxHalf * 1.5 : true)));
    const total = lines.reduce((s, b) => s + b.length, 0);
    if (!lines.length || total < maxHalf * 3) return false; // a blob, not a stroke
    const ends = new Set(pts.filter((i) => crossings(nb(i)) === 1).map((i) => toPx(i).join()));
    const sewn = [];
    for (let b of lines) {
      // smooth (5-point mean) so pixel steps don't wobble the stitch angle; reach out to stroke tips
      const closed = b.length > 3 && b[0].join() === b.at(-1).join();
      b = b.map((p, k) => { let sx = 0, sy = 0, n = 0; for (let j = k - 2; j <= k + 2; j++) { const q = closed ? b[(j + b.length - 1) % (b.length - 1)] : b[j]; if (q) { sx += q[0]; sy += q[1]; n++; } } return k === 0 || k === b.length - 1 ? (closed ? [sx / n, sy / n] : p) : [sx / n, sy / n]; });
      if (!closed) for (const end of [0, 1]) {
        const p = end ? b.at(-1) : b[0], q = end ? b[Math.max(0, b.length - 4)] : b[Math.min(b.length - 1, 3)];
        if (!ends.has(`${Math.floor(p[0]) + 0.5},${Math.floor(p[1]) + 0.5}`) && !ends.has(p.join())) continue;
        const L = Math.hypot(p[0] - q[0], p[1] - q[1]) || 1, dx = (p[0] - q[0]) / L, dy = (p[1] - q[1]) / L;
        const reach = ray(p[0], p[1], dx, dy, maxHalf * 2 + 2) - 0.75;
        for (let s = 1; s <= reach; s++) { const e = [p[0] + dx * s, p[1] + dy * s]; end ? b.push(e) : b.unshift(e); }
      }
      // resample every row gap along the centreline
      const samples = [b[0]];
      let acc = 0;
      for (let k = 1; k < b.length; k++) {
        let [x0, y0] = b[k - 1]; const [x1, y1] = b[k], L = Math.hypot(x1 - x0, y1 - y0);
        let t = 0;
        while (acc + (L - t) >= gap) { t += gap - acc; acc = 0; samples.push([x0 + ((x1 - x0) * t) / L, y0 + ((y1 - y0) * t) / L]); }
        acc += L - t;
      }
      const rows = [];
      samples.forEach((p, k) => {
        const q0 = samples[Math.max(0, k - 2)], q1 = samples[Math.min(samples.length - 1, k + 2)];
        const L = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]) || 1, nx = -(q1[1] - q0[1]) / L, ny = (q1[0] - q0[0]) / L;
        const lim = Math.min(maxHalf, half(...p)) * 1.4 + 1.5; // forks: don't run down the other branch
        const s0 = ray(p[0], p[1], -nx, -ny, lim) + pullPx, s1 = ray(p[0], p[1], nx, ny, lim) + pullPx;
        if (s0 + s1 < 1.5) return;
        rows.push({ c: p, A: [p[0] - nx * s0, p[1] - ny * s0], B: [p[0] + nx * s1, p[1] + ny * s1] });
      });
      if (rows.length) sewn.push(rows);
    }
    if (!sewn.length) return false;
    const U = ([x, y]) => [Math.round(x * PX - cx), Math.round(y * PX - cy)];
    while (sewn.length) {
      let k = 0, rev = false, bd = Infinity;
      sewn.forEach((r, i) => [0, 1].forEach((e) => { const d = pos ? Math.hypot(...sub(U((e ? r.at(-1) : r[0]).c), pos)) : i; if (d < bd) { bd = d; k = i; rev = !!e; } }));
      let rows = sewn.splice(k, 1)[0];
      if (rev) rows = rows.reverse();
      const width = Math.max(...rows.map((r) => Math.hypot(...sub(r.A, r.B)))) * PX;
      if (underlay && width >= 15 && rows.length > 2) { // centre run there, satin back over it
        goTo(...U(rows[0].c));
        for (const r of rows) stitchTo(...U(r.c), 20);
        rows = rows.reverse();
      }
      rows.forEach((r, i) => {
        const [p, q] = i % 2 ? [r.B, r.A] : [r.A, r.B];
        if (i === 0) goTo(...U(p)); else stitchTo(...U(p), SATIN_MAX);
        stitchTo(...U(q), SATIN_MAX);
      });
    }
    return true;
  };

  // --- objects in order; a new thread whenever the colour changes ---
  let lastRgb = null;
  objects.forEach((o, idx) => {
    const a = areas[o.area];
    if (!a) return;
    if (o.rgb !== lastRgb) {
      if (lastRgb !== null && pos) cmds.push({ t: 'color', x: pos[0], y: pos[1] });
      threads.push(threadFor(o.rgb));
      lastRgb = o.rgb;
    }
    gap = o.spacing / PX; pullPx = o.pull / PX; stitch = o.stitch; underlay = o.underlay;
    area = a.id;
    const start = cmds.length;
    const thin = o.type === 'satin' || (o.type === 'auto' && a.thin);
    if (o.type === 'outline') sewOutline(outlineOf(a.id, a.box));
    else if (thin) {
      const sat = skeletonSatin(a) ? null : bestSatinAngle(a.id, a.box); // strokes follow their centreline
      if (sat && sat.long <= 0.1) {
        // a blob too short for a centreline: one satin direction across it
        if (underlay && a.widthUnits >= 15) fill(scan(a.id, a.box, sat.deg, 10, 1.5, 0), stitch, SATIN_MAX); // zigzag underlay
        fill(scan(a.id, a.box, sat.deg, gap, 0, pullPx * 1.5), stitch, SATIN_MAX);
      } else if (sat) satinTiles(a); // 4 mm tiles, each with the satin direction that crosses the stroke there
    } else {
      if (underlay && a.area >= 100) fill(scan(a.id, a.box, o.angle + 90, 20 / PX, 2, 0), 40, 0);
      fill(scan(a.id, a.box, o.angle, gap, 0, pullPx), stitch, 0);
      if (o.outline) sewOutline(outlineOf(a.id, a.box));
    }
    for (let k = start; k < cmds.length; k++) cmds[k].o = idx;
  });
  if (!cmds.length) throw new Error('Nothing to stitch: try more colours or a lower background tolerance');
  return { threads, cmds };
}
