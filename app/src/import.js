// Machine files as editable shapes (modelled on Ember's patternToImportShapes).
// A shape is one run of stitches between jumps, trims and colour changes:
//   { kind: 'file', rgb, name, stitches: [[x, y]], tieOn, tieOff, trimAfter, hidden }
// Its stitches are never re-digitized; only colour, order, visibility, ties and trims change.

const TIE = 8; // tie stitch: 0.8 mm out and back, like Artspira
const LOCK = 15; // a lock pattern stays within 1.5 mm of where it starts

// A lock is 5 points going back and forth around the first one: A B A B A.
// Returns true if pts (5 points) look like one.
function isLock(pts) {
  if (pts.length < 5) return false;
  const [a] = pts;
  if (pts.some(([x, y]) => Math.hypot(x - a[0], y - a[1]) > LOCK)) return false;
  let turns = 0;
  for (let i = 2; i < 5; i++) {
    const d1 = [pts[i - 1][0] - pts[i - 2][0], pts[i - 1][1] - pts[i - 2][1]], d2 = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    if (d1[0] * d2[0] + d1[1] * d2[1] < 0) turns++;
  }
  return turns >= 2;
}

/** Raw reader output { threads, cmds } -> shapes. */
export function patternToImportShapes({ threads, cmds }) {
  const shapes = [];
  let ci = 0, run = [], jumpTo = null;
  const thread = () => threads[Math.min(ci, threads.length - 1)] || { rgb: 0, name: '' };
  const close = (trimAfter) => {
    let pts = run, tieOn = false, tieOff = false;
    run = [];
    // keep the point sewing continues from; drop the 4 lock stitches around it
    if (pts.length >= 7 && isLock(pts.slice(0, 5))) { tieOn = true; pts = pts.slice(4); }
    if (pts.length >= 7 && isLock(pts.slice(-5).reverse())) { tieOff = true; pts = pts.slice(0, -4); }
    if (pts.length < 2) { if (trimAfter && shapes.length) shapes.at(-1).trimAfter = true; return; }
    const { rgb, name } = thread();
    shapes.push({ kind: 'file', rgb, name, stitches: pts, tieOn, tieOff, trimAfter, hidden: false });
  };
  for (const c of cmds) {
    if (c.t === 'stitch') {
      // the needle sits at the jump target: it is the run's first penetration (as in toPattern)
      if (jumpTo && !run.length && (jumpTo[0] !== c.x || jumpTo[1] !== c.y)) run.push(jumpTo);
      run.push([c.x, c.y]); jumpTo = null;
    } else if (c.t === 'trim') close(true);
    else if (c.t === 'jump') { if (run.length) close(false); jumpTo = [c.x, c.y]; }
    else if (c.t === 'color') { close(false); ci++; jumpTo = null; }
  }
  close(false);
  return shapes;
}

const unit = (a, b) => { const l = Math.hypot(b[0] - a[0], b[1] - a[1]); return l ? [(b[0] - a[0]) / l, (b[1] - a[1]) / l] : [1, 0]; };
const lock = (a, toward) => { const [ux, uy] = unit(a, toward), b = [Math.round(a[0] + ux * TIE), Math.round(a[1] + uy * TIE)]; return [a, b, a, b]; };

/** Shapes -> { threads, cmds }, the reader format. Stitch commands carry o: the shape index. */
export function fileObjectsToRaw(objects) {
  const threads = [], cmds = [];
  let lastRgb = null, trim = false;
  objects.forEach((o, idx) => {
    if (o.hidden || o.stitches.length < 2) return;
    if (o.rgb !== lastRgb) {
      if (lastRgb !== null) { cmds.push({ t: 'color', x: o.stitches[0][0], y: o.stitches[0][1] }); trim = false; }
      threads.push({ rgb: o.rgb, name: o.name });
      lastRgb = o.rgb;
    }
    if (trim) cmds.push({ t: 'trim', x: o.stitches[0][0], y: o.stitches[0][1] });
    cmds.push({ t: 'jump', x: o.stitches[0][0], y: o.stitches[0][1] });
    const pts = [
      ...(o.tieOn ? lock(o.stitches[0], o.stitches[1]) : []),
      ...o.stitches,
      ...(o.tieOff ? lock(o.stitches.at(-1), o.stitches.at(-2)).reverse() : []),
    ];
    for (const [x, y] of pts) cmds.push({ t: 'stitch', x, y, o: idx });
    trim = o.trimAfter;
  });
  return { threads, cmds };
}

/** Normalized pattern (blocks/segments) -> reader format, so combined designs can be split into shapes too. */
export function patternToRaw(pattern) {
  const threads = [], cmds = [];
  pattern.blocks.forEach((b, bi) => {
    threads.push(b.thread);
    if (bi) cmds.push({ t: 'color', x: b.segments[0].points[0][0], y: b.segments[0].points[0][1] });
    for (const s of b.segments) {
      const [x, y] = s.points[0];
      if (s.trim) cmds.push({ t: 'trim', x, y });
      cmds.push({ t: 'jump', x, y });
      for (const [px, py] of s.points) cmds.push({ t: 'stitch', x: px, y: py });
    }
  });
  return { threads, cmds };
}
