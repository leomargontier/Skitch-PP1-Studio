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
  const l = lab(rgb);
  for (const e of PEC_PALETTE) {
    if (!e) continue;
    const d = dist2(l, lab([(e[0] >> 16) & 255, (e[0] >> 8) & 255, e[0] & 255]));
    if (d < bd) { bd = d; best = e; }
  }
  return { rgb: (rgb[0] << 16) | (rgb[1] << 8) | rgb[2], name: best ? best[1] : '' };
}

/**
 * @param img {width, height, data: RGBA bytes}, 1 px = PX units
 * @param opts colors: thread count; removeBg: drop the colour that covers most of the border;
 *   spacing: row spacing (0.1 mm); stitch: tatami stitch length (0.1 mm); minArea: smallest area kept (px);
 *   underlay: stitches sewn first to hold the fabric; outline: running stitch around fill areas;
 *   angle: fill direction in degrees; satin: thin parts as satin columns;
 *   satinWidth: widest part sewn as satin (0.1 mm); pull: pull compensation per row end (0.1 mm)
 */
export function imageToStitches(img, {
  colors = 4, removeBg = true, spacing = 4, stitch = 30, minArea = 25, underlay = true, outline = true,
  angle = 45, satin = true, satinWidth = 50, pull = 2,
} = {}) {
  const { width: w, height: h, data } = img;
  const SATIN_MAX = 70; // longer satin stitches snag; longer rows fall back to tatami

  // --- colours ---
  const labCache = new Map();
  const labAt = (i) => {
    const key = (data[i * 4] << 16) | (data[i * 4 + 1] << 8) | data[i * 4 + 2];
    let v = labCache.get(key);
    if (!v) { v = lab([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]); labCache.set(key, v); }
    return v;
  };
  const opaque = [];
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 128) opaque.push(labAt(i));
  if (!opaque.length) throw new Error('The image is empty');
  const hasAlpha = opaque.length < w * h * 0.98;
  const centres = kmeans(opaque, colors + (removeBg && !hasAlpha ? 1 : 0));

  const label = new Int32Array(w * h).fill(-1);
  for (let i = 0; i < w * h; i++) if (data[i * 4 + 3] >= 128) label[i] = nearest(centres, labAt(i));

  // thread colour = average picture colour of the pixels it covers
  const rgbSum = centres.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < w * h; i++) if (label[i] >= 0) { const s = rgbSum[label[i]]; s[0] += data[i * 4]; s[1] += data[i * 4 + 1]; s[2] += data[i * 4 + 2]; s[3]++; }
  const rgbOf = (l) => rgbSum[l].slice(0, 3).map((v) => Math.round(v / Math.max(1, rgbSum[l][3])));

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
  const edge = distanceToEdge(label, w, h);
  const cx = (w * PX) / 2, cy = (h * PX) / 2;

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

  // --- areas, colour by colour (largest colour first, details sewn on top) ---
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
    return { id, label: c.label, box, area: c.px.length, thin: satin && widthUnits <= satinWidth, widthUnits, centre: [(sx / c.px.length) * PX - cx, (sy / c.px.length) * PX - cy] };
  });
  const used = [...new Set(areas.map((a) => a.label))]
    .map((l) => ({ l, area: areas.filter((a) => a.label === l).reduce((s, a) => s + a.area, 0) }))
    .sort((a, b) => b.area - a.area);

  const gap = spacing / PX, pullPx = pull / PX;
  used.forEach(({ l }, ti) => {
    if (ti > 0) cmds.push({ t: 'color', x: pos[0], y: pos[1] });
    threads.push(threadFor(rgbOf(l)));
    const todo = areas.filter((a) => a.label === l);
    while (todo.length) {
      // nearest area next: less travel, fewer cuts
      let k = 0;
      if (pos) todo.forEach((a, i) => { if (Math.hypot(...sub(a.centre, pos)) < Math.hypot(...sub(todo[k].centre, pos))) k = i; });
      const a = todo.splice(k, 1)[0];
      area = a.id;
      const sat = a.thin ? bestSatinAngle(a.id, a.box) : null;
      if (sat && sat.long <= 0.1) {
        // straight-ish stroke: one satin direction across it
        const deg = sat.deg;
        if (underlay && a.widthUnits >= 15) fill(scan(a.id, a.box, deg, 10, 1.5, 0), stitch, SATIN_MAX); // zigzag underlay
        fill(scan(a.id, a.box, deg, gap, 0, pullPx * 1.5), stitch, SATIN_MAX);
      } else if (sat) {
        // curved stroke: 4 mm tiles, each with the satin direction that crosses the stroke there
        satinTiles(a);
      } else {
        if (underlay && a.area >= 100) fill(scan(a.id, a.box, angle + 90, 20 / PX, 2, 0), 40, 0);
        fill(scan(a.id, a.box, angle, gap, 0, pullPx), stitch, 0);
        if (outline) sewOutline(outlineOf(a.id, a.box));
      }
    }
  });
  if (!cmds.length) throw new Error('Nothing to stitch: try more colours or turn off background removal');
  return { threads, cmds };
}
