import { readEmbroidery } from './formats/readers.js';
import { toPattern, transform, bounds, stitchCount } from './pattern.js';
import { buildRecords, encodeRecords, FX_COLOR } from './pen.js';
import { PP1, STATUS, errorText } from './pp1.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view'), ctx = canvas.getContext('2d');
const SEWING = new Set([17, 48, 49, 50, 64, 65, 66]);

const state = {
  file: null, raw: null, rotate: 0, flip: false, move: { x: 0, y: 0 },
  pattern: null, bb: null, sent: null, // sent = {colorStops:[record index]} of the design on the machine
  jumpCut: 0, busy: false, monitorTimer: null, currentColor: -1,
};
const pp1 = new PP1(log);

function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent = `${t}  ${msg}\n` + $('log').textContent.slice(0, 20000);
}
const hoopMm = () => Number($('hoop').value);
const hex = (rgb) => '#' + rgb.toString(16).padStart(6, '0');
const mm = (v) => (v / 10).toFixed(1);

// ---------- design ----------
async function loadFile(name, bytes) {
  try {
    const raw = readEmbroidery(name, bytes);
    const pat = toPattern(raw);
    if (!pat.blocks.length) throw new Error('No stitches found');
    Object.assign(state, { file: name, raw: pat, rotate: 0, flip: false, move: { x: 0, y: 0 } });
    rebuild();
    log(`Opened ${name}`);
  } catch (e) { log(`Could not open ${name}: ${e.message}`); alert(e.message); }
}

function rebuild() {
  state.pattern = transform(state.raw, { rotate: state.rotate, flip: state.flip });
  state.bb = bounds(state.pattern);
  ['rotL', 'rotR', 'flip', 'center'].forEach((id) => ($(id).disabled = false));
  $('empty').hidden = true;
  renderInfo();
  draw();
  updateButtons();
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
    <dt>Stitches</dt><dd>${stitchCount(p).toLocaleString()}</dd>
    <dt>Colours</dt><dd>${p.blocks.length}</dd>
    <dt>Position</dt><dd>${mm(state.move.x)}, ${mm(state.move.y)} mm</dd>
    <dt>Fits hoop</dt><dd style="color:var(${ok ? '--ok' : '--danger'})">${ok ? 'Yes' : 'No – move or use a smaller design'}</dd>`;
  $('colors').innerHTML = p.blocks.map((b, i) =>
    `<li class="${i === state.currentColor ? 'current' : ''}"><span class="swatch" style="background:${hex(b.thread.rgb)}"></span>${i + 1}. ${escapeHtml(b.thread.name || 'Thread')}</li>`).join('');
}
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
  ctx.lineWidth = Math.max(1, scale * 3); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const b of state.pattern.blocks) {
    ctx.strokeStyle = hex(b.thread.rgb);
    ctx.beginPath();
    for (const s of b.segments) s.points.forEach(([x, y], i) => { const [px, py] = toPx(x + mx, y + my); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  const box = placedBox(), [ax, ay] = toPx(box.x0, box.y0), [bx, by] = toPx(box.x1, box.y1);
  ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
  ctx.strokeStyle = fits(box, hoopMm()) ? css.getPropertyValue('--accent') : css.getPropertyValue('--danger');
  ctx.strokeRect(ax, ay, bx - ax, by - ay); ctx.setLineDash([]);
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
  drag = { x: e.clientX, y: e.clientY, mx: state.move.x, my: state.move.y };
});
canvas.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const k = canvas.width / canvas.getBoundingClientRect().width / view().scale;
  setMove(drag.mx + (e.clientX - drag.x) * k, drag.my + (e.clientY - drag.y) * k);
});
canvas.addEventListener('pointerup', () => { drag = null; canvas.classList.remove('dragging'); });
window.addEventListener('keydown', (e) => {
  if (!state.pattern || e.target.closest('select,dialog')) return;
  const step = e.shiftKey ? 1 : 10;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (d) { e.preventDefault(); setMove(state.move.x + d[0], state.move.y + d[1]); }
});

$('open').onclick = async () => { const f = await window.native.openFile(); if (f) loadFile(f.name, f.bytes); };
$('rotL').onclick = () => { state.rotate -= 90; rebuild(); };
$('rotR').onclick = () => { state.rotate += 90; rebuild(); };
$('flip').onclick = () => { state.flip = !state.flip; rebuild(); };
$('center').onclick = () => setMove(0, 0);
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
    if (info) {
      $('machineInfo').innerHTML = `<dt>Model</dt><dd>${escapeHtml(info.modelCode || info.model)}</dd>
        <dt>Serial</dt><dd>${escapeHtml(info.serial)}</dd><dt>Firmware</dt><dd>${escapeHtml(info.firmware)}</dd>`;
    }
    try { state.jumpCut = (await pp1.settings()).jumpCut; } catch { /* older firmware */ }
    poll();
  } catch (e) {
    picker.close();
    if (e.name !== 'NotFoundError') { log(`Connect failed: ${e.message}`); alert(`Could not connect: ${e.message}`); }
  }
};

async function poll() {
  if (!pp1.connected || state.busy) return;
  try {
    const { status, error } = await pp1.state();
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
  await pp1.sendDesign(pen, layout, { onProgress: (f) => ($('progress').value = f) });
  state.sent = { colorStops: recs.flatMap((r, i) => (r[2] === FX_COLOR ? [i] : [])), box };
  state.currentColor = 0; renderInfo();
  log('Design sent. Trace the outline to check placement, then start sewing.');
});
$('trace').onclick = () => busy('Trace', async () => { await pp1.maskTrace(state.sent.box, state.jumpCut); log('Tracing outline – follow the prompts on the machine'); });
$('start').onclick = () => busy('Start', async () => { await pp1.startSewing(); log('Sewing started'); });
$('avoid').onclick = () => busy('Move hoop', async () => { await pp1.hoopAvoidance(); });

draw();
