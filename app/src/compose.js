// One design made of objects from different sources, sewn in list order:
//  - digitized areas: { area, model?, offset? , type, angle, ... } re-stitched from their picture/drawing model
//  - machine-file shapes: { kind: 'file', stitches, tieOn, tieOff, trimAfter } replayed as they are
// edit = { model (default model for areas without their own), objects, sel }
import { stitchObjects, threadName } from './image.js';
import { fileObjectsToRaw, patternToImportShapes, patternToRaw } from './import.js';

/** edit -> { threads, cmds } (reader format). Stitch commands carry o: the object's index. */
export function compose(ed) {
  const threads = [], cmds = [];
  let last = null, trimNext = false;
  ed.objects.forEach((o, i) => {
    if (o.hidden) return;
    let part;
    try { part = o.kind === 'file' ? fileObjectsToRaw([o]) : stitchObjects(o.model || ed.model, [o]); } catch { return; } // nothing to sew
    const pc = part.cmds.filter((c) => c.t !== 'color');
    if (!pc.some((c) => c.t === 'stitch')) return;
    const [dx, dy] = o.offset || [0, 0];
    if (o.rgb !== last) {
      if (last !== null) cmds.push({ t: 'color', x: pc[0].x + dx, y: pc[0].y + dy });
      threads.push({ rgb: o.rgb, name: o.name || threadName(o.rgb) });
      last = o.rgb; trimNext = false;
    }
    if (trimNext) cmds.push({ t: 'trim', x: pc[0].x + dx, y: pc[0].y + dy });
    for (const c of pc) cmds.push(c.t === 'stitch' ? { t: 'stitch', x: c.x + dx, y: c.y + dy, o: i } : { t: c.t, x: c.x + dx, y: c.y + dy });
    trimNext = o.kind === 'file' && o.trimAfter;
  });
  return { threads, cmds };
}

/** objects that each carry their own model, so they can join another design */
export const lift = (ed) => ed.objects.map((o) => (o.kind === 'file' ? o : { ...o, model: o.model || ed.model }));

/** a finished pattern as machine-file shapes */
export const fileObjects = (pattern) => patternToImportShapes(patternToRaw(pattern));

/** move an object by (dx, dy) in 0.1 mm */
export function shift(o, dx, dy) {
  if (o.kind === 'file') return { ...o, stitches: o.stitches.map(([x, y]) => [x + dx, y + dy]) };
  const [ox, oy] = o.offset || [0, 0];
  return { ...o, offset: [ox + dx, oy + dy] };
}
