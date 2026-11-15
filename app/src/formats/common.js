// Shared by the embroidery readers.
export const thread = (entry, i) =>
  entry ? { rgb: entry[0], name: entry[1] } : { rgb: [0x000000, 0xff0000, 0x00a000, 0x0000ff][i % 4], name: `Color ${i + 1}` };

export class Builder {
  constructor() { this.x = 0; this.y = 0; this.cmds = []; }
  rel(t, dx, dy) { this.x += dx; this.y += dy; this.cmds.push({ t, x: this.x, y: this.y }); }
  mark(t) { this.cmds.push({ t, x: this.x, y: this.y }); }
}

export const s8 = (b) => (b > 127 ? b - 256 : b);


// DST/JEF have no trim command: by convention a run of 3+ jumps means "trim here".
export function markJumpRunTrims(cmds) {
  const out = [];
  for (let i = 0; i < cmds.length; i++) {
    if (cmds[i].t === 'jump' && (i === 0 || cmds[i - 1].t !== 'jump')) {
      let n = 0;
      while (cmds[i + n] && cmds[i + n].t === 'jump') n++;
      if (n >= 3) out.push({ t: 'trim', x: cmds[i].x, y: cmds[i].y });
    }
    out.push(cmds[i]);
  }
  return out;
}

