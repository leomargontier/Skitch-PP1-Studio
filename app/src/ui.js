import { readEmbroidery } from './formats/readers.js';
import { toPattern, transform, bounds, stitchCount, stack } from './pattern.js';
import { buildRecords, encodeRecords, FX_COLOR } from './pen.js';
import { PP1, STATUS, errorText, isNewer } from './pp1.js';
import { writeDst } from './formats/dst-writer.js';
import { writePes } from './formats/pes-writer.js';
import { analyze, defaultObjects, stitchObjects, threadName, PX } from './image.js';
import { patternToImportShapes, fileObjectsToRaw, patternToRaw } from './import.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view'), ctx = canvas.getContext('2d');
const SEWING = new Set([17, 48, 49, 50, 64, 65, 66]);

const state = {
  file: null, raw: null, rotate: 0, flip: false, scale: 100, move: { x: 0, y: 0 }, resumable: false, image: null,
  pattern: null, bb: null, sent: null, // sent = {colorStops:[record index]} of the design on the machine
  jumpCut: 0, busy: false, monitorTimer: null, currentColor: -1,
};
const pp1 = new PP1(log);

function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent = `${t}  ${msg}\n` + $('log').textContent.slice(0, 20000);
}
const hoopMm = () => Number($('hoop').value);
// lighten (k > 0) or darken (k < 0) a 0xRRGGBB colour
const shade = (rgb, k) => '#' + [16, 8, 0].map((sh) => {
  const c = (rgb >> sh) & 255;
  return Math.round(k > 0 ? c + (255 - c) * k : c * (1 + k)).toString(16).padStart(2, '0');
}).join('');
const hex = (rgb) => '#' + rgb.toString(16).padStart(6, '0');
const mm = (v) => (v / 10).toFixed(1);

// ---------- design ----------
const IMAGE = /\.(png|jpe?g|bmp|gif|webp)$/i;

async function loadFile(name, bytes) {
  try {
    if (IMAGE.test(name)) return await loadImage(name, bytes);
    const objects = patternToImportShapes(readEmbroidery(name, bytes));
    setDesign(name, toPattern(fileObjectsToRaw(objects)), { model: null, objects, sel: -1 });
    log(`Opened ${name}: ${objects.length} shapes`);
  } catch (e) { state.adding = false; log(`Could not open ${name}: ${e.message}`); alert(e.message); }
}

// undo/redo: snapshots of what the user can change
const history = { past: [], future: [] };
const snapshot = () => ({ file: state.file, raw: state.raw, rotate: state.rotate, flip: state.flip, scale: state.scale, move: { ...state.move },
  edit: state.edit && { ...state.edit, objects: structuredClone(state.edit.objects) } });
function remember() {
  if (!state.raw) return;
  history.past.push(snapshot()); history.future = [];
  if (history.past.length > 50) history.past.shift();
  undoButtons();
}
function restore(from, to) {
  if (!from.length) return;
  to.push(snapshot());
  Object.assign(state, from.pop());
  $('angle').value = state.rotate; $('scale').value = state.scale;
  rebuild(); undoButtons();
}
const undoButtons = () => { $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length; };
$('undo').onclick = () => restore(history.past, history.future);
$('redo').onclick = () => restore(history.future, history.past);

// state.adding: the next design goes under the current one instead of replacing it
// edit: { model, objects, sel } when the design was made here (picture or lettering) and can be edited object by object
function setDesign(name, pat, edit = null) {
  if (!pat.blocks.length) throw new Error('No stitches found');
  const add = state.adding && state.pattern;
  state.adding = false;
  remember();
  if (add) { // combined designs are split into machine-file shapes, so they stay editable
    const objects = patternToImportShapes(patternToRaw(stack(state.pattern, pat)));
    pat = toPattern(fileObjectsToRaw(objects)); name = `${state.file} + ${name}`; edit = { model: null, objects, sel: -1 };
  }
  Object.assign(state, { file: name, raw: pat, rotate: 0, flip: false, scale: 100, move: add ? state.move : { x: 0, y: 0 }, edit });
  $('angle').value = 0; $('scale').value = 100;
  rebuild();
}

// picture -> stitches, settings asked in a dialog
async function loadImage(name, bytes) {
  state.image = { name, bmp: await createImageBitmap(new Blob([bytes])) };
  $('imgDlg').showModal();
}
$('imgCancel').onclick = () => { state.adding = false; $('imgDlg').close(); };

// lettering: draw the text with an installed font, then stitch it like a picture
const textDlg = $('txtDlg');
$('text').onclick = () => { $('txtAdd').checked = !!state.pattern; $('txtAdd').disabled = !state.pattern; textDlg.showModal(); };
$('txtCancel').onclick = () => textDlg.close();
$('txtGo').onclick = () => {
  const text = $('txtText').value.trim();
  if (!text) return;
  try {
    const lines = text.split('\n');
    const px = Math.round(Number($('txtSize').value) * 10 / PX); // letter height in px
    const font = `${$('txtBold').checked ? 'bold ' : ''}${px}px ${$('txtFont').value}`;
    const probe = new OffscreenCanvas(1, 1).getContext('2d');
    probe.font = font;
    const w = Math.ceil(Math.max(...lines.map((l) => probe.measureText(l).width))) + 8, lh = Math.ceil(px * 1.25);
    const c = new OffscreenCanvas(w, lh * lines.length + 8), g = c.getContext('2d');
    g.font = font; g.fillStyle = $('txtColor').value; g.textBaseline = 'top';
    lines.forEach((l, i) => g.fillText(l, 4, 4 + i * lh));
    const model = analyze(g.getImageData(0, 0, c.width, c.height), { colors: 1, minArea: 4 });
    const edit = { model, objects: defaultObjects(model), sel: -1 };
    state.adding = $('txtAdd').checked;
    setDesign(`"${text.slice(0, 20)}"`, toPattern(stitchObjects(model, edit.objects)), edit);
    textDlg.close();
    log(`Lettering: ${stitchCount(state.pattern).toLocaleString()} stitches in total`);
  } catch (e) { log(`Lettering failed: ${e.message}`); alert(e.message); }
};
$('add').onclick = async () => { const f = await window.native.openFile(); if (f) { state.adding = true; loadFile(f.name, f.bytes); } };
$('imgGo').onclick = () => {
  const { name, bmp } = state.image;
  try {
    const maxPx = hoopMm() * 10 / PX; // design must fit the hoop
    let w = Math.round(Number($('imgWidth').value) * 10 / PX), h = Math.round(w * bmp.height / bmp.width);
    if (w > maxPx || h > maxPx) { const k = maxPx / Math.max(w, h); w = Math.round(w * k); h = Math.round(h * k); }
    const c = new OffscreenCanvas(w, h), g = c.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, w, h);
    const opts = {
      colors: Math.max(1, Math.min(12, Number($('imgColors').value) || 4)),
      removeBg: $('imgBg').checked, bgTolerance: Number($('imgBgTol').value), spacing: Number($('imgDensity').value),
      underlay: $('imgUnder').checked, outline: $('imgOutline').checked,
      angle: Number($('imgAngle').value), satin: $('imgSatin').checked,
    };
    const model = analyze(g.getImageData(0, 0, w, h), opts);
    const edit = { model, objects: defaultObjects(model, opts), sel: -1 };
    setDesign(name.replace(IMAGE, '') + ' (from picture)', toPattern(stitchObjects(model, edit.objects)), edit);
    $('imgDlg').close();
    log(`Made ${stitchCount(state.pattern).toLocaleString()} stitches from ${name}. Check it, then send it or save it as .pes`);
  } catch (e) { log(`Picture failed: ${e.message}`); alert(e.message); }
};

function rebuild() {
  state.pattern = transform(state.raw, { rotate: state.rotate, flip: state.flip, scale: state.scale });
  state.bb = bounds(state.pattern);
  ['rotL', 'rotR', 'flip', 'center', 'angle', 'scale', 'saveDst', 'savePes', 'add'].forEach((id) => ($(id).disabled = false));
  $('empty').hidden = true;
  const n = stitchCount(state.pattern), player = $('player');
  player.disabled = false; player.max = n; player.value = n; $('playerN').textContent = '';
  renderInfo();
  renderObjects();
  draw();
  updateButtons();
}

// ---------- object editor (pictures and lettering made here) ----------
const TYPE_NAME = { auto: 'Auto', satin: 'Satin', fill: 'Fill', outline: 'Outline' };
const objOf = () => state.edit?.objects[state.edit.sel];
// picture/lettering objects are re-digitized; machine-file shapes replay their stitches
const restitch = (ed) => (ed.model ? stitchObjects(ed.model, ed.objects) : fileObjectsToRaw(ed.objects));
function renderObjects() {
  const ed = state.edit;
  $('objCard').hidden = !ed;
  if (!ed) return;
  $('objList').innerHTML = ed.objects.map((o, i) => {
    let label;
    if (o.kind === 'file') label = `${o.stitches.length.toLocaleString()} stitches${o.trimAfter ? ' · trim' : ''}`;
    else {
      const a = ed.model.areas[o.area], t = o.type === 'auto' ? (a.thin ? 'Satin' : 'Fill') : TYPE_NAME[o.type];
      label = `${t} · ${mm((a.box.x1 - a.box.x0 + 1) * PX)} × ${mm((a.box.y1 - a.box.y0 + 1) * PX)} mm`;
    }
    return `<li data-i="${i}" class="${i === ed.sel ? 'sel' : ''} ${o.hidden ? 'hid' : ''}"><input type="checkbox" data-show title="Show / hide" ${o.hidden ? '' : 'checked'}><span class="swatch" style="background:${hex(o.rgb)}"></span>${i + 1}. ${label}</li>`;
  }).join('');
  $('objList').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  const o = objOf();
  $('objProps').querySelectorAll('input,select,button').forEach((el) => (el.disabled = !o));
  ['objUp', 'objDown', 'objDel'].forEach((id) => ($(id).disabled = !o));
  $('remake').hidden = !ed.model; $('remake').disabled = !state.image;
  $('digiProps').hidden = !o || o.kind === 'file'; $('oApplyAll').hidden = !o || o.kind === 'file';
  $('fileProps').hidden = !o || o.kind !== 'file';
  if (!o) { $('oColorName').textContent = 'Click an object in the list or on the design'; return; }
  $('oColor').value = hex(o.rgb); $('oColorName').textContent = threadName(o.rgb);
  if (o.kind === 'file') { $('oTieOn').checked = o.tieOn; $('oTieOff').checked = o.tieOff; $('oTrim').checked = o.trimAfter; return; }
  $('oType').value = o.type; $('oAngle').value = o.angle; $('oSpacing').value = o.spacing / 10; $('oStitch').value = o.stitch / 10;
  $('oPull').value = o.pull / 10; $('oUnder').checked = o.underlay; $('oOutline').checked = o.outline;
}
// re-stitch after an edit; the untouched objects stay where they were on the fabric
function applyEdit(change) {
  remember();
  change(state.edit);
  const before = bounds(state.raw);
  let pat;
  try { pat = toPattern(restitch(state.edit)); } catch (e) { restore(history.past, []); alert(e.message); return; }
  if (!pat.blocks.length) { restore(history.past, []); alert('A design needs at least one object'); return; }
  const after = bounds(pat), k = state.scale / 100, a = (state.rotate * Math.PI) / 180;
  let dx = ((after.x0 + after.x1 - before.x0 - before.x1) / 2) * k, dy = ((after.y0 + after.y1 - before.y0 - before.y1) / 2) * k;
  if (state.flip) dx = -dx;
  state.move = { x: Math.round(state.move.x + dx * Math.cos(a) - dy * Math.sin(a)), y: Math.round(state.move.y + dx * Math.sin(a) + dy * Math.cos(a)) };
  state.raw = pat;
  rebuild();
}
const select = (i) => { if (!state.edit) return; state.edit.sel = i; renderObjects(); draw(); };
$('objList').onclick = (e) => {
  const li = e.target.closest('li');
  if (!li) return;
  const i = Number(li.dataset.i);
  if (e.target.matches('[data-show]')) applyEdit((ed) => { ed.objects[i].hidden = !e.target.checked; });
  else select(i);
};
$('objGroup').onclick = () => applyEdit((ed) => { // stable: colours in order of first use, shapes keep their order within a colour
  const first = new Map();
  ed.objects.forEach((o, i) => { if (!first.has(o.rgb)) first.set(o.rgb, i); });
  const cur = ed.objects[ed.sel];
  ed.objects = ed.objects.map((o, i) => [o, i]).sort((a, b) => first.get(a[0].rgb) - first.get(b[0].rgb) || a[1] - b[1]).map(([o]) => o);
  ed.sel = ed.objects.indexOf(cur);
});
$('oTieOn').onchange = () => setProp('tieOn', $('oTieOn').checked);
$('oTieOff').onchange = () => setProp('tieOff', $('oTieOff').checked);
$('oTrim').onchange = () => setProp('trimAfter', $('oTrim').checked);
const moveObj = (d) => applyEdit((ed) => {
  const j = ed.sel + d;
  if (j < 0 || j >= ed.objects.length) return;
  [ed.objects[ed.sel], ed.objects[j]] = [ed.objects[j], ed.objects[ed.sel]]; ed.sel = j;
});
$('objUp').onclick = () => moveObj(-1);
$('objDown').onclick = () => moveObj(1);
$('objDel').onclick = () => applyEdit((ed) => { ed.objects.splice(ed.sel, 1); ed.sel = Math.min(ed.sel, ed.objects.length - 1); });
$('remake').onclick = () => { if (state.image) $('imgDlg').showModal(); };
const setProp = (key, value) => applyEdit((ed) => { ed.objects[ed.sel][key] = value; });
const num = (id, lo, hi) => Math.max(lo, Math.min(hi, Number($(id).value) || lo));
$('oType').onchange = () => setProp('type', $('oType').value);
$('oAngle').onchange = () => setProp('angle', num('oAngle', -180, 180));
$('oSpacing').onchange = () => setProp('spacing', Math.round(num('oSpacing', 0.25, 1.5) * 10 * 10) / 10);
$('oStitch').onchange = () => setProp('stitch', Math.round(num('oStitch', 1, 7) * 10));
$('oPull').onchange = () => setProp('pull', Math.round(num('oPull', 0, 1) * 10));
$('oUnder').onchange = () => setProp('underlay', $('oUnder').checked);
$('oOutline').onchange = () => setProp('outline', $('oOutline').checked);
$('oColor').onchange = () => applyEdit((ed) => {
  const rgb = parseInt($('oColor').value.slice(1), 16), old = ed.objects[ed.sel].rgb;
  for (const o of $('oAllColor').checked ? ed.objects.filter((o) => o.rgb === old) : [ed.objects[ed.sel]]) { o.rgb = rgb; o.name = threadName(rgb); }
});
$('oApplyAll').onclick = () => applyEdit((ed) => {
  const { type, angle, spacing, stitch, pull, underlay, outline } = ed.objects[ed.sel];
  ed.objects.forEach((o) => { if (o.kind !== 'file') Object.assign(o, { type, angle, spacing, stitch, pull, underlay, outline }); });
});
$('player').oninput = () => {
  const n = Number($('player').value), max = Number($('player').max);
  $('playerN').textContent = n < max ? `${n.toLocaleString()} / ${max.toLocaleString()}` : '';
  draw();
};
// the object under a click: the nearest needle point that belongs to an object, within 2 mm
function hitObject(clientX, clientY) {
  const r = canvas.getBoundingClientRect(), { size, scale } = view();
  const k = canvas.width / r.width;
  const x = ((clientX - r.left) * k - size / 2) / scale - state.move.x, y = ((clientY - r.top) * k - size / 2) / scale - state.move.y;
  let best = -1, bd = 20 * 20;
  for (const b of state.pattern.blocks) for (const s of b.segments) for (const p of s.points) {
    if (p.length < 3) continue;
    const d = (p[0] - x) ** 2 + (p[1] - y) ** 2;
    if (d < bd) { bd = d; best = p[2]; }
  }
  return best;
}

// design box relative to the hoop centre, 0.1 mm
function placedBox() {
  const { w, h } = state.bb, { x, y } = state.move;
  return { x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2 };
}
const fits = (box, sizeMm) => Math.max(-box.x0, box.x1, -box.y0, box.y1) <= sizeMm * 5;

function renderInfo() {
  const p = state.pattern, bb = state.bb, box = placedBox();
  const ok = fits(box, hoopMm());
  $('designInfo').innerHTML = `
    <dt>File</dt><dd>${escapeHtml(state.file)}</dd>
    <dt>Size</dt><dd>${mm(bb.w)} × ${mm(bb.h)} mm</dd>
    <dt>Stitches</dt><dd>${stitchCount(p).toLocaleString()} · about ${sewMinutes(p)} min</dd>
    <dt>Colours</dt><dd>${p.blocks.length}</dd>
    <dt>Position</dt><dd>${mm(state.move.x)}, ${mm(state.move.y)} mm</dd>
    <dt>Fits hoop</dt><dd style="color:var(${ok ? '--ok' : '--danger'})">${ok ? 'Yes' : 'No – move or use a smaller design'}</dd>`;
  $('colors').innerHTML = p.blocks.map((b, i) =>
    `<li class="${i === state.currentColor ? 'current' : ''}"><span class="swatch" style="background:${hex(b.thread.rgb)}"></span>${i + 1}. ${escapeHtml(b.thread.name || 'Thread')}</li>`).join('');
}
// the PP1 sews at 400 stitches/min; add about a minute per thread change
const sewMinutes = (p) => Math.max(1, Math.round(stitchCount(p) / 400 + (p.blocks.length - 1)));
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function view() {
  const size = canvas.width, pad = 20, hoop = hoopMm() * 10;
  const scale = (size - pad * 2) / hoop;
  return { size, scale, toPx: (x, y) => [size / 2 + x * scale, size / 2 + y * scale] };
}

function draw() {
  const css = getComputedStyle(document.documentElement);
  const { size, scale, toPx } = view();
  ctx.clearRect(0, 0, size, size);
  // hoop + 10 mm grid
  const half = hoopMm() * 5 * scale;
  ctx.fillStyle = css.getPropertyValue('--hoop');
  ctx.fillRect(size / 2 - half, size / 2 - half, half * 2, half * 2);
  ctx.strokeStyle = css.getPropertyValue('--line'); ctx.lineWidth = 1;
  for (let g = -hoopMm() / 2; g <= hoopMm() / 2; g += 10) {
    const p = size / 2 + g * 10 * scale;
    ctx.beginPath(); ctx.moveTo(p, size / 2 - half); ctx.lineTo(p, size / 2 + half);
    ctx.moveTo(size / 2 - half, p); ctx.lineTo(size / 2 + half, p); ctx.stroke();
  }
  if (!state.pattern) return;
  const { x: mx, y: my } = state.move;
  // thread look: each stitch is a shaded strand (dark edge, light centre), about 0.4 mm wide
  const tw = Math.max(1.2, scale * 4);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  let left = Number($('player').value); // stitch player: draw only the first stitches
  const sel = state.edit ? state.edit.sel : -1, selPath = new Path2D();
  for (const b of state.pattern.blocks) {
    if (left <= 0) break;
    const path = new Path2D();
    for (const s of b.segments) {
      let prevSel = false;
      s.points.forEach(([x, y, o], i) => {
        if (left-- <= 0) return;
        const [px, py] = toPx(x + mx, y + my);
        i ? path.lineTo(px, py) : path.moveTo(px, py);
        if (o === sel && sel >= 0) { prevSel ? selPath.lineTo(px, py) : selPath.moveTo(px, py); prevSel = true; } else prevSel = false;
      });
    }
    ctx.lineWidth = tw; ctx.strokeStyle = shade(b.thread.rgb, -0.25); ctx.stroke(path);
    ctx.lineWidth = tw * 0.6; ctx.strokeStyle = hex(b.thread.rgb); ctx.stroke(path);
    if (tw >= 2.5) { ctx.lineWidth = tw * 0.2; ctx.strokeStyle = shade(b.thread.rgb, 0.35); ctx.stroke(path); }
  }
  if (sel >= 0) { // selected object: a bright line over its stitches
    ctx.lineWidth = Math.max(2, tw * 0.5); ctx.strokeStyle = css.getPropertyValue('--accent'); ctx.globalAlpha = 0.85;
    ctx.stroke(selPath); ctx.globalAlpha = 1;
  }
  const box = placedBox(), [ax, ay] = toPx(box.x0, box.y0), [bx, by] = toPx(box.x1, box.y1);
  ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  ctx.strokeStyle = fits(box, hoopMm()) ? css.getPropertyValue('--accent') : css.getPropertyValue('--danger');
  ctx.strokeRect(ax, ay, bx - ax, by - ay); ctx.setLineDash([]);
  // where sewing will start when "Start at stitch" is set
  const r = state.sent?.recs?.[state.startAt];
  if (state.startAt > 0 && r) {
    const [px, py] = toPx(r[0] + state.sent.move.x, r[1] + state.sent.move.y);
    ctx.fillStyle = css.getPropertyValue('--danger');
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fill();
  }
}

function setMove(x, y) {
  state.move = { x: Math.round(x), y: Math.round(y) };
  renderInfo(); draw(); updateButtons();
}

// drag to move
let drag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (!state.pattern) return;
  canvas.setPointerCapture(e.pointerId); canvas.classList.add('dragging');
  remember();
  drag = { x: e.clientX, y: e.clientY, mx: state.move.x, my: state.move.y, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
  drag.moved = true;
  const k = canvas.width / canvas.getBoundingClientRect().width / view().scale;
  setMove(drag.mx + (e.clientX - drag.x) * k, drag.my + (e.clientY - drag.y) * k);
});
canvas.addEventListener('pointerup', (e) => {
  if (drag && !drag.moved) { history.past.pop(); undoButtons(); if (state.edit) select(hitObject(e.clientX, e.clientY)); }
  drag = null; canvas.classList.remove('dragging');
});
window.addEventListener('keydown', (e) => {
  if (e.target.closest('input,textarea,select,dialog')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); $('undo').click(); return; }
  if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); $('redo').click(); return; }
  if (!state.pattern) return;
  if (state.edit && (e.key === 'Delete' || e.key === 'Backspace') && objOf()) { e.preventDefault(); $('objDel').click(); return; }
  if (state.edit && e.key === 'Tab') { e.preventDefault(); const n = state.edit.objects.length; select(((state.edit.sel + (e.shiftKey ? -1 : 1)) % n + n) % n); return; }
  if (state.edit && e.key === 'Escape') { select(-1); return; }
  const step = e.shiftKey ? 1 : 10;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); if (!e.repeat) remember(); setMove(state.move.x + d[0], state.move.y + d[1]); }
});

$('open').onclick = async () => { const f = await window.native.openFile(); if (f) loadFile(f.name, f.bytes); };
const setAngle = (a) => { remember(); state.rotate = ((Math.round(a) % 360) + 360) % 360; $('angle').value = state.rotate; rebuild(); };
$('rotL').onclick = () => setAngle(state.rotate - 90);
$('rotR').onclick = () => setAngle(state.rotate + 90);
$('angle').onchange = () => setAngle(Number($('angle').value) || 0);
$('scale').onchange = () => {
  remember();
  state.scale = Math.max(80, Math.min(120, Math.round(Number($('scale').value) || 100)));
  $('scale').value = state.scale; rebuild();
};
const save = async (ext, write) => {
  const base = state.file.replace(/\.[^.]*$/, '').replace(/[\\/:*?"<>|]/g, '_');
  const saved = await window.native.saveFile(`${base}.${ext}`, write(state.pattern, base));
  if (saved) log(`Saved ${saved}`);
};
$('savePes').onclick = () => save('pes', writePes);
$('saveDst').onclick = () => save('dst', writeDst);
$('flip').onclick = () => { remember(); state.flip = !state.flip; rebuild(); };
$('center').onclick = () => { remember(); setMove(0, 0); };
$('hoop').onchange = () => { if (state.pattern) { renderInfo(); updateButtons(); } draw(); };

const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('dragover'); });
drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
drop.addEventListener('drop', async (e) => {
  e.preventDefault(); drop.classList.remove('dragover');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f.name, new Uint8Array(await f.arrayBuffer()));
});

// ---------- machine ----------
const picker = $('picker');
window.native.onBluetoothDevices((list) => {
  if (!picker.open) picker.showModal();
  $('devices').innerHTML = '';
  for (const d of list) {
    const li = document.createElement('li'), b = document.createElement('button');
    b.textContent = d.name; b.onclick = () => { picker.close(); window.native.selectBluetooth(d.id); };
    li.append(b); $('devices').append(li);
  }
});
$('pickCancel').onclick = () => { picker.close(); window.native.selectBluetooth(''); };

pp1.onDisconnect = () => { log('Disconnected'); setConnected(false); };

function setConnected(on, name = '') {
  $('conn').textContent = on ? name : 'Not connected';
  $('conn').className = `pill ${on ? 'on' : 'off'}`;
  $('connect').textContent = on ? 'Disconnect' : 'Connect';
  clearInterval(state.monitorTimer);
  if (on) state.monitorTimer = setInterval(poll, 3000);
  else { $('status').textContent = '—'; $('error').textContent = ''; $('machineInfo').innerHTML = ''; }
  updateButtons();
}

$('connect').onclick = async () => {
  if (pp1.connected) { pp1.disconnect(); return; }
  try {
    const name = await pp1.connect();
    log(`Connected to ${name}`);
    setConnected(true, name);
    const info = await pp1.info();
    state.info = info;
    let html = '';
    if (info) {
      html = `<dt>Model</dt><dd>${escapeHtml(info.modelCode || info.model)}</dd>
        <dt>Serial</dt><dd>${escapeHtml(info.serial)}</dd><dt>Firmware</dt><dd>${escapeHtml(info.firmware)}</dd>`;
    }
    try {
      const c = await pp1.serviceCounts();
      if (c) html += `<dt>Stitches sewn</dt><dd>${c.total.toLocaleString()} (${c.sinceService.toLocaleString()} since service)</dd>`;
      const due = await pp1.maintenanceDue();
      html += `<dt>Maintenance</dt><dd style="color:var(${due ? '--danger' : '--ok'})">${due ? 'Due: clean and oil the machine (see manual)' : 'OK'}</dd>`;
    } catch { /* not answered by older firmware */ }
    $('machineInfo').innerHTML = html;
    await loadSettings();
    await checkResume();
    poll();
  } catch (e) {
    picker.close();
    if (e.name !== 'NotFoundError') { log(`Connect failed: ${e.message}`); alert(`Could not connect: ${e.message}`); }
  }
};

async function loadSettings() {
  try {
    const s = await pp1.settings();
    state.jumpCut = s.jumpCut;
    $('setAutoCut').checked = s.autoCut; $('setJumpCut').checked = s.jumpCut; $('setFoot').value = String(s.footHeight === 2 ? 2 : 1);
  } catch { /* older firmware */ }
}

// The machine keeps an interrupted job. If it is the one this app sent, restore its colour tracking too.
async function checkResume() {
  try {
    state.resumable = await pp1.canResume();
    if (!state.resumable || state.sent) return;
    const id = await pp1.jobId();
    const last = JSON.parse(localStorage.getItem('lastJob') || 'null');
    if (last && id && last.uuid === id) { state.sent = { ...last, recs: null }; log(`The machine still holds "${last.file}"; you can resume it`); }
  } catch { state.resumable = false; }
}

async function poll() {
  if (!pp1.connected || state.busy) return;
  try {
    const { status, error } = await pp1.state();
    if (status !== state.status && (status === 50 || status === 66)) await checkResume();
    state.status = status;
    $('status').textContent = STATUS[status] ?? `Status ${status}`;
    $('error').textContent = errorText(error);
    if (SEWING.has(status)) {
      const [info, mon] = [await pp1.embInfo(), await pp1.monitor()];
      if (info?.totalStitches && mon) {
        $('progress').value = mon.stitch / info.totalStitches;
        trackColor(mon.stitch);
      }
    }
    updateButtons();
  } catch (e) { log(`Status error: ${e.message}`); }
}

// which colour is the machine on, from the stitch index it reports
function trackColor(stitch) {
  if (!state.sent) return;
  const i = state.sent.colorStops.findIndex((r) => stitch <= r);
  const c = i === -1 ? state.sent.colorStops.length : i;
  if (c !== state.currentColor) {
    state.currentColor = c;
    if (state.pattern) renderInfo();
    if (state.status === 64 && state.pattern?.blocks[c]) log(`Change thread to colour ${c + 1}: ${state.pattern.blocks[c].thread.name}`);
  }
}

function updateButtons() {
  const on = pp1.connected, idle = !state.busy;
  const placeable = state.pattern && fits(placedBox(), hoopMm());
  $('send').disabled = !(on && idle && placeable);
  $('trace').disabled = !(on && idle && state.sent);
  $('start').disabled = !(on && idle && state.sent && state.status === 17);
  $('avoid').disabled = !(on && idle);
  $('resume').disabled = !(on && idle && state.resumable);
  $('startAt').disabled = $('setStart').disabled = !(on && idle && state.sent);
  for (const id of ['setAutoCut', 'setJumpCut', 'setFoot', 'saveSettings', 'resetSettings']) $(id).disabled = !(on && idle && state.status !== 48);
  $('errorLog').disabled = !(on && idle);
  $('firmware').disabled = !(on && idle && state.info && ![18, 33, 48, 81, 96].includes(state.status));
}

async function busy(label, fn) {
  state.busy = true; updateButtons();
  try { await fn(); } catch (e) { log(`${label} failed: ${e.message}`); alert(`${label} failed: ${e.message}`); }
  finally { state.busy = false; updateButtons(); }
}

$('send').onclick = () => busy('Send', async () => {
  const recs = buildRecords(state.pattern);
  const pen = encodeRecords(recs);
  const box = placedBox();
  const layout = { moveX: state.move.x, moveY: state.move.y, frame: fits(box, 70) ? 0 : 1, box };
  log(`Sending ${recs.length} records (${pen.length} bytes)…`);
  $('progress').value = 0;
  const uuid = await pp1.sendDesign(pen, layout, { onProgress: (f) => ($('progress').value = f) });
  state.sent = { colorStops: recs.flatMap((r, i) => (r[2] === FX_COLOR ? [i] : [])), box, move: { ...state.move }, file: state.file, uuid };
  try { localStorage.setItem('lastJob', JSON.stringify(state.sent)); } catch { /* resume info is a convenience */ }
  state.sent.recs = recs; state.startAt = 0; state.resumable = false;
  $('startAt').max = recs.length - 1; $('startAt').value = 0;
  state.currentColor = 0; renderInfo(); draw();
  log('Design sent. Trace the outline to check placement, then start sewing.');
});
$('trace').onclick = () => busy('Trace', async () => { await pp1.maskTrace(state.sent.box, state.jumpCut); log('Tracing outline – follow the prompts on the machine'); });
$('start').onclick = () => busy('Start', async () => { await pp1.startSewing(); log('Sewing started'); });
$('avoid').onclick = () => busy('Move hoop', async () => { await pp1.hoopAvoidance(); });
$('resume').onclick = () => busy('Resume', async () => { await pp1.resume(); state.resumable = false; log('Job resumed – press start on the machine if it asks'); });
$('startAt').oninput = () => { state.startAt = Math.max(0, Math.round(Number($('startAt').value) || 0)); draw(); };
$('setStart').onclick = () => busy('Start stitch', async () => {
  const n = Math.min(state.startAt || 0, (state.sent.recs?.length || 65536) - 1);
  await pp1.setStartStitch(n); log(`Sewing will start at stitch ${n}`);
});
$('saveSettings').onclick = () => busy('Save settings', async () => {
  await pp1.saveSettings({ autoCut: $('setAutoCut').checked, jumpCut: $('setJumpCut').checked, footHeight: Number($('setFoot').value) });
  state.jumpCut = $('setJumpCut').checked; log('Settings saved on the machine');
});
$('resetSettings').onclick = () => busy('Reset settings', async () => {
  if (!confirm('Reset the machine settings to factory defaults?')) return;
  await pp1.resetSettings(); await loadSettings(); log('Settings reset to defaults');
});
$('firmware').onclick = () => busy('Firmware update', async () => {
  const { firmware, model, oem } = state.info;
  const list = await window.native.firmwareList();
  const latest = list.filter((f) => f.type === (model || 2) && f.oem === (oem || 1))
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1))[0];
  if (!latest) { alert('Brother lists no firmware for this machine.'); return; }
  if (!isNewer(latest.version, firmware)) { alert(`Firmware ${firmware} is up to date (latest ${latest.version}).`); return; }
  if (!confirm(`Update the machine from ${firmware} to ${latest.version}?\n\n` +
    'Keep the machine switched on and close to this computer, and do not close the app until it finishes. ' +
    'Interrupting a firmware update can leave the machine unusable. This updater has not been tested on a real machine.')) return;
  log(`Downloading firmware ${latest.version}…`);
  const upf = await window.native.firmwareDownload(latest.dl_url, latest.filemd5);
  log(`Sending firmware (${upf.length} bytes)…`);
  $('progress').value = 0;
  await pp1.updateFirmware(upf, { onProgress: (f) => ($('progress').value = f) });
  log('Firmware sent. The machine restarts to install it: wait about 30 s, then connect again and check the version.');
});
$('errorLog').onclick = () => busy('Error log', async () => {
  const b = await pp1.errorLog();
  log(`Error log (${b.length} bytes): ${[...b].map((x) => x.toString(16).padStart(2, '0')).join(' ') || 'empty'}`);
});

draw();
