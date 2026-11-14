import { readEmbroidery } from './formats/readers.js';
import { toPattern, transform, bounds, stitchCount, stack } from './pattern.js';
import { buildRecords, encodeRecords, FX_COLOR } from './pen.js';
import { PP1, STATUS, errorText, isNewer } from './pp1.js';
import { writeDst } from './formats/dst-writer.js';
import { imageToStitches, PX } from './image.js';

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
const hex = (rgb) => '#' + rgb.toString(16).padStart(6, '0');
const mm = (v) => (v / 10).toFixed(1);

// ---------- design ----------
const IMAGE = /\.(png|jpe?g|bmp|gif|webp)$/i;

async function loadFile(name, bytes) {
  try {
    if (IMAGE.test(name)) return await loadImage(name, bytes);
    setDesign(name, toPattern(readEmbroidery(name, bytes)));
    log(`Opened ${name}`);
  } catch (e) { state.adding = false; log(`Could not open ${name}: ${e.message}`); alert(e.message); }
}

// state.adding: the next design goes under the current one instead of replacing it
function setDesign(name, pat) {
  if (!pat.blocks.length) throw new Error('No stitches found');
  const add = state.adding && state.pattern;
  state.adding = false;
  if (add) { pat = stack(state.pattern, pat); name = `${state.file} + ${name}`; }
  Object.assign(state, { file: name, raw: pat, rotate: 0, flip: false, scale: 100, move: add ? state.move : { x: 0, y: 0 } });
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
    const raw = imageToStitches(g.getImageData(0, 0, c.width, c.height), { colors: 1, minArea: 4 });
    state.adding = $('txtAdd').checked;
    setDesign(`"${text.slice(0, 20)}"`, toPattern(raw));
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
    const raw = imageToStitches(g.getImageData(0, 0, w, h), {
      colors: Math.max(1, Math.min(12, Number($('imgColors').value) || 4)),
      removeBg: $('imgBg').checked, spacing: Number($('imgDensity').value),
    });
    setDesign(name.replace(IMAGE, '') + ' (from picture)', toPattern(raw));
    $('imgDlg').close();
    log(`Made ${stitchCount(state.pattern).toLocaleString()} stitches from ${name}. Check it, then send or save as .dst`);
  } catch (e) { log(`Picture failed: ${e.message}`); alert(e.message); }
};

function rebuild() {
  state.pattern = transform(state.raw, { rotate: state.rotate, flip: state.flip, scale: state.scale });
  state.bb = bounds(state.pattern);
  ['rotL', 'rotR', 'flip', 'center', 'angle', 'scale', 'saveDst', 'add'].forEach((id) => ($(id).disabled = false));
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
const setAngle = (a) => { state.rotate = ((Math.round(a) % 360) + 360) % 360; $('angle').value = state.rotate; rebuild(); };
$('rotL').onclick = () => setAngle(state.rotate - 90);
$('rotR').onclick = () => setAngle(state.rotate + 90);
$('angle').onchange = () => setAngle(Number($('angle').value) || 0);
$('scale').onchange = () => {
  state.scale = Math.max(80, Math.min(120, Math.round(Number($('scale').value) || 100)));
  $('scale').value = state.scale; rebuild();
};
$('saveDst').onclick = async () => {
  const base = state.file.replace(/\.[^.]*$/, '');
  const saved = await window.native.saveFile(`${base}.dst`, writeDst(state.pattern, base));
  if (saved) log(`Saved ${saved}`);
};
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
