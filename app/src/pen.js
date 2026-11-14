// PEN stitch stream for the Brother SKITCH PP1, reverse engineered from libPP1_PESX_SharedLib.so
// (ConvertPesx) in Brother Artspira 2.9.10 and checked against its output.
//
// One 4-byte record per needle position, absolute coords in 0.1 mm relative to the design centre:
//   u16le X = (x << 3) | xflag   xflag: 3 = last stitch of a colour, 5 = last stitch of the design
//   u16le Y = (y << 3) | yflag   yflag bit0 = FEED (move here without sewing), bit1 = CUT before moving
import { bounds } from './pattern.js';

export const FX_COLOR = 3, FX_END = 5, FY_FEED = 1, FY_CUT = 2;
const TIE = 8; // tie stitch length used by Artspira: 0.8 mm
const CUT_JUMP = 51; // Artspira cuts the thread before any jump of 5.1 mm or more

function unit(dx, dy) {
  const l = Math.hypot(dx, dy);
  return l ? [dx / l, dy / l] : [1, 0];
}

// Returns records [[x, y, xflag, yflag]] with integer coords centred on the design.
export function buildRecords(pattern) {
  const bb = bounds(pattern);
  const cx = bb.x0 + bb.w / 2, cy = bb.y0 + bb.h / 2;
  const recs = [];
  const push = (x, y, fy = 0) => recs.push([Math.round(x - cx), Math.round(y - cy), 0, fy]);
  let prevSeg = null; // points of the previously sewn segment

  const tieOff = () => {
    if (!prevSeg) return;
    const n = prevSeg.length, [lx, ly] = prevSeg[n - 1];
    const [ux, uy] = unit(prevSeg[n - 2][0] - lx, prevSeg[n - 2][1] - ly);
    push(lx + Math.trunc(ux * TIE), ly + Math.trunc(uy * TIE)); // Artspira truncates tie offsets
    push(lx, ly);
  };
  const tieIn = (pts) => {
    const [x, y] = pts[0];
    const [ux, uy] = unit(pts[1][0] - x, pts[1][1] - y);
    for (let i = 0; i < 2; i++) { push(x + Math.trunc(ux * TIE), y + Math.trunc(uy * TIE)); push(x, y); }
  };

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let lastPt = null;
  pattern.blocks.forEach((block, bi) => {
    block.segments.forEach((seg, si) => {
      const pts = seg.points;
      const jump = lastPt ? dist(pts[0], lastPt) : 0;
      if (si === 0) {
        // colour start: feed in, cutting first if the hop is long
        push(pts[0][0], pts[0][1], FY_FEED | (jump >= CUT_JUMP ? FY_CUT : 0));
        tieIn(pts);
      } else if (jump >= CUT_JUMP) {
        // Artspira only cuts (and ties) for hops of 5.1 mm or more, even when the file asked for a trim
        if (!seg.trim) recs[recs.length - 1][3] |= FY_FEED;
        tieOff();
        push(pts[0][0], pts[0][1], FY_FEED | FY_CUT);
        tieIn(pts);
      } else {
        if (!seg.trim) recs[recs.length - 1][3] |= FY_FEED; // Artspira flags both ends of a plain hop
        push(pts[0][0], pts[0][1], FY_FEED);
      }
      for (let i = 1; i < pts.length; i++) push(pts[i][0], pts[i][1]);
      prevSeg = pts;
      lastPt = pts[pts.length - 1];
    });
    // tie off before each colour change (twice when the next colour starts with a cut), not at the very end
    if (bi < pattern.blocks.length - 1) {
      tieOff();
      if (dist(pattern.blocks[bi + 1].segments[0].points[0], lastPt) >= CUT_JUMP) tieOff();
      recs[recs.length - 1][2] = FX_COLOR;
    }
  });
  if (recs.length) recs[recs.length - 1][2] = FX_END;
  return recs;
}

export function encodeRecords(recs) {
  const out = new Uint8Array(recs.length * 4);
  const dv = new DataView(out.buffer);
  recs.forEach(([x, y, fx, fy], i) => {
    if (x < -4096 || x > 4095 || y < -4096 || y > 4095) throw new Error('Design too large for PEN coordinates');
    dv.setUint16(i * 4, ((x << 3) | fx) & 0xffff, true);
    dv.setUint16(i * 4 + 2, ((y << 3) | fy) & 0xffff, true);
  });
  return out;
}

export const encodePen = (pattern) => encodeRecords(buildRecords(pattern));

export function decodePen(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const recs = [];
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const x = dv.getInt16(i, true), y = dv.getInt16(i + 2, true);
    recs.push([x >> 3, y >> 3, x & 7, y & 7]);
  }
  return recs;
}
