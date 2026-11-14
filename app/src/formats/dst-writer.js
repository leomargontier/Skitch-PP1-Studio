// Tajima DST writer for a normalized pattern (0.1 mm units, y down).
// Trims are written as 3+ jump records, the usual DST convention (our reader reads them back as trims).

const MAX = 121;

// balanced ternary digits for 1, 3, 9, 27, 81
function digits(v) {
  const d = [];
  for (let i = 0; i < 5; i++) {
    let r = ((v % 3) + 3) % 3;
    if (r === 2) r = -1;
    d.push(r); v = (v - r) / 3;
  }
  return d;
}

// one record; type: 0 stitch, 1 jump, 2 colour change
function record(dx, dy, type) {
  const x = digits(dx), y = digits(-dy); // DST y points up
  let b0 = 0, b1 = 0, b2 = 0x03;
  const set = (d, pos, neg) => (d > 0 ? pos : d < 0 ? neg : 0);
  b0 |= set(x[0], 0x01, 0x02) | set(x[2], 0x04, 0x08) | set(y[0], 0x80, 0x40) | set(y[2], 0x20, 0x10);
  b1 |= set(x[1], 0x01, 0x02) | set(x[3], 0x04, 0x08) | set(y[1], 0x80, 0x40) | set(y[3], 0x20, 0x10);
  b2 |= set(x[4], 0x04, 0x08) | set(y[4], 0x20, 0x10);
  if (type === 1) b2 |= 0x80;
  if (type === 2) b2 |= 0xc0;
  return [b0, b1, b2];
}

export function writeDst(pattern, name = 'design') {
  const recs = [];
  let cx = 0, cy = 0, stitches = 0, x0 = 0, x1 = 0, y0 = 0, y1 = 0;
  const move = (x, y, type) => {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x - cx), Math.abs(y - cy)) / MAX));
    const sx = cx, sy = cy;
    for (let i = 1; i <= n; i++) {
      const nx = Math.round(sx + ((x - sx) * i) / n), ny = Math.round(sy + ((y - sy) * i) / n);
      recs.push(record(nx - cx, ny - cy, type));
      cx = nx; cy = ny;
      if (type === 0) stitches++;
    }
    x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
  };
  const jump = (x, y, trim) => {
    const before = recs.length;
    move(x, y, 1);
    if (trim) while (recs.length - before < 3) recs.push(record(0, 0, 1));
  };

  pattern.blocks.forEach((b, bi) => {
    if (bi > 0) recs.push(record(0, 0, 2));
    b.segments.forEach((s, si) => {
      jump(s.points[0][0], s.points[0][1], (si > 0 && s.trim) || (bi > 0 && si === 0));
      for (const [x, y] of s.points.slice(1)) move(x, y, 0);
    });
  });
  recs.push([0x00, 0x00, 0xf3]);

  const pad = (v, n) => String(v).padStart(n, ' ');
  const head = [
    `LA:${name.slice(0, 16).padEnd(16, ' ')}`, `ST:${pad(stitches, 7)}`, `CO:${pad(pattern.blocks.length - 1, 3)}`,
    `+X:${pad(x1, 5)}`, `-X:${pad(-x0, 5)}`, `+Y:${pad(-y0, 5)}`, `-Y:${pad(y1, 5)}`,
    `AX:+${pad(Math.abs(cx), 5)}`, `AY:+${pad(Math.abs(cy), 5)}`, 'MX:+    0', 'MY:+    0', 'PD:******',
  ].join('\r') + '\r\x1a';
  const out = new Uint8Array(512 + recs.length * 3).fill(0x20, 0, 512);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i) & 0x7f;
  recs.forEach((r, i) => out.set(r, 512 + i * 3));
  return out;
}
