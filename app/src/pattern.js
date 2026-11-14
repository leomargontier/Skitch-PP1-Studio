// Normalized pattern: { blocks: [{ thread:{rgb,name}, segments: [{ trim:bool, points:[[x,y],...] }] }] }
// Units 0.1 mm, y down. A segment is a run of needle penetrations reached by a jump (or by a trim+jump).

export function toPattern({ threads, cmds }) {
  const blocks = [];
  let block = null, seg = null, pendingTrim = false, pendingJump = true, ci = 0;
  const newBlock = () => {
    block = { thread: threads[Math.min(ci, threads.length - 1)] || { rgb: 0, name: '' }, segments: [] };
    blocks.push(block);
    seg = null;
  };
  newBlock();
  let jumpTarget = null; // where an explicit jump left the needle
  for (const c of cmds) {
    if (c.t === 'color') { ci++; newBlock(); pendingJump = true; pendingTrim = false; jumpTarget = null; continue; }
    if (c.t === 'trim') { pendingTrim = true; pendingJump = true; continue; }
    if (c.t === 'jump') { pendingJump = true; jumpTarget = [c.x, c.y]; continue; }
    // stitch
    if (!seg || pendingJump) {
      // the needle sits at the jump target; it becomes the segment's first penetration
      seg = { trim: pendingTrim, points: [] };
      if (jumpTarget && (jumpTarget[0] !== c.x || jumpTarget[1] !== c.y)) seg.points.push(jumpTarget);
      block.segments.push(seg);
      pendingJump = false; pendingTrim = false;
    }
    seg.points.push([c.x, c.y]);
    jumpTarget = null;
  }
  for (const b of blocks) b.segments = b.segments.filter((s) => s.points.length > 1);
  return { blocks: blocks.filter((b) => b.segments.length) };
}

export function bounds(pattern) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of pattern.blocks) for (const s of b.segments) for (const [x, y] of s.points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return { x0: 0, y0: 0, x1: 0, y1: 0, w: 0, h: 0 };
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0 };
}

export function stitchCount(pattern) {
  let n = 0;
  for (const b of pattern.blocks) for (const s of b.segments) n += s.points.length;
  return n;
}

// Map every point; returns a new pattern.
export function mapPoints(pattern, fn) {
  return {
    blocks: pattern.blocks.map((b) => ({
      ...b,
      segments: b.segments.map((s) => ({ ...s, points: s.points.map(([x, y]) => fn(x, y)) })),
    })),
  };
}

// Recenter the design on (0,0), mirror horizontally, scale (percent) and rotate (degrees, clockwise).
// Scaling moves stitches apart or together; keep it near 100 % to keep the stitch density sane.
export function transform(pattern, { rotate = 0, flip = false, scale = 100 } = {}) {
  const bb = bounds(pattern);
  const cx = (bb.x0 + bb.x1) / 2, cy = (bb.y0 + bb.y1) / 2;
  const a = (rotate * Math.PI) / 180, k = scale / 100;
  const cos = Math.round(Math.cos(a) * 1e9) / 1e9, sin = Math.round(Math.sin(a) * 1e9) / 1e9;
  const out = mapPoints(pattern, (x, y) => {
    let px = (x - cx) * k, py = (y - cy) * k;
    if (flip) px = -px;
    return [px * cos - py * sin, px * sin + py * cos];
  });
  // odd angles leave the box off-centre: centre it again, then snap to 0.1 mm
  const r = bounds(out), ox = (r.x0 + r.x1) / 2, oy = (r.y0 + r.y1) / 2;
  return mapPoints(out, (x, y) => [Math.round(x - ox) || 0, Math.round(y - oy) || 0]);
}

// Combine two designs: b goes under a, centred, `gap` apart. Colours keep their order (a first).
export function stack(a, b, gap = 30) {
  const ba = bounds(a), bb = bounds(b);
  const dx = Math.round((ba.x0 + ba.x1) / 2 - (bb.x0 + bb.x1) / 2), dy = ba.y1 + gap - bb.y0;
  return { blocks: [...a.blocks, ...mapPoints(b, (x, y) => [x + dx, y + dy]).blocks] };
}
