// Brother SKITCH PP1 Bluetooth LE protocol, reverse engineered from Brother Artspira 2.9.10
// (Asura.Core BLEDeviceManager / BLEServiceProvider). No account or cloud involved.
//
// Request : write  [cmd u16 BE][payload]   to WRITE characteristic (write with response)
// Response: read   [cmd u16 BE][status][...] from READ characteristic
export const SERVICE = 'a76eb9e0-f3ac-4990-84cf-3a94d2426b2b';
export const READ_CHAR = 'a76eb9e1-f3ac-4990-84cf-3a94d2426b2b';
export const WRITE_CHAR = 'a76eb9e2-f3ac-4990-84cf-3a94d2426b2b';

export const CMD = {
  MACHINE_INFO: 0x0000, MACHINE_STATE: 0x0001, SERVICE_COUNT: 0x0100, MAINTENANCE: 0x0103,
  EMB_ORIGIN: 0x0800, PATTERN_UUID_REQ: 0x0702, MASK_TRACE: 0x0704, LAYOUT: 0x0705,
  EMB_INFO: 0x0706, EMB_MONITOR: 0x0707, EMB_DELETE: 0x0708, NEEDLE_INDEX: 0x0709,
  EMB_UUID: 0x070a, RESUME_FLAG: 0x070b, RESUME: 0x070c, START_SEWING: 0x070e,
  HOOP_AVOIDANCE: 0x070f, MASK_TRACE_BOUNDS: 0x0710, SETTINGS_RESET: 0x0c00,
  SETTINGS_SET: 0x0c01, SETTINGS_GET: 0x0c02, DATA_INFO: 0x1200, DATA: 0x1201,
  CLEAR_ERROR: 0x1300, ERROR_LOG: 0x1301, FIRMWARE_START: 0x0b00,
};

export const STATUS = {
  0: 'Initial', 1: 'Lower thread', 16: 'Ready – no data', 17: 'Ready to sew', 18: 'Receiving data',
  32: 'Mask trace – press lock', 33: 'Mask tracing', 34: 'Mask trace finished', 48: 'Sewing',
  49: 'Sewing finished', 50: 'Sewing interrupted', 64: 'Thread change', 65: 'Paused', 66: 'Stopped',
  80: 'Hoop avoidance', 81: 'Moving hoop', 96: 'Receiving', 97: 'Received', 221: 'Unknown',
};

// 238 and 221 mean "no error"
export const ERRORS = {
  0: 'Needle position', 1: 'Safety device', 2: 'Bobbin safety', 3: 'Bobbin thread free',
  32: 'Needle plate', 33: 'Thread take-up lever', 96: 'Upper thread', 97: 'Bobbin thread',
  98: 'Upper thread at start', 99: 'Wiper', 112: 'Hoop', 113: 'No hoop attached', 114: 'Hoop position',
  128: 'Maintenance due', 152: 'Setting', 255: 'Other',
};
export const errorText = (c) => (c === 238 || c === 221 || c == null ? '' : ERRORS[c] || (c >= 16 && c <= 28 ? `Restart required (${c.toString(16)})` : `Error ${c}`));

// Pure helpers (unit tested) --------------------------------------------------------------
export function frame(cmd, payload = []) {
  const out = new Uint8Array(2 + payload.length);
  out[0] = (cmd >> 8) & 0xff; out[1] = cmd & 0xff;
  out.set(payload, 2);
  return out;
}

const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
const le32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
const sum = (bytes) => bytes.reduce((a, b) => a + b, 0);

// 0x1200 payload: [type][len u32 LE][byte sum u16 LE]; type 3 = stitch data, 4 = firmware
export const dataInfoPayload = (pen, type = 3) => [type, ...le32(pen.length), ...le16(sum(pen) & 0xffff)];

// Firmware (.upf) header: [count u8] then 9-byte entries whose first byte is the chip (1 main, 2 Bluetooth).
// 0x0B00 takes 1, 2 or 3 (both).
export function firmwareTarget(upf) {
  const types = new Set();
  for (let i = 0; i < upf[0]; i++) types.add(upf[1 + 9 * i]);
  return types.has(1) && types.has(2) ? 3 : types.has(1) ? 1 : types.has(2) ? 2 : 0;
}

// "1.04.00" vs "1.3.5": true when a is newer than b (numeric parts, like .NET Version)
export function isNewer(a, b) {
  const pa = String(a).split(/[.,]/).map(Number), pb = String(b).split(/[.,]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// 0x1201 payloads: [offset u32 LE][chunk][byte sum of chunk u8]
export function dataChunks(pen, chunkSize) {
  const out = [];
  for (let off = 0; off < pen.length; off += chunkSize) {
    const part = pen.subarray(off, off + chunkSize);
    out.push(Uint8Array.from([...le32(off), ...part, sum(part) & 0xff]));
  }
  return out;
}

// 0x0705 payload: MoveX, MoveY, SizeX%, SizeY%, Rotate (i16 LE), Flip u8, Frame u8 (0 = 70 mm, 1 = 100 mm)
// followed by the design box (top-left, bottom-right, centre) relative to the hoop centre, 0.1 mm.
export function layoutPayload({ moveX = 0, moveY = 0, frame = 1, box }) {
  const s16 = (v) => le16(Math.round(v) & 0xffff);
  return [
    ...s16(moveX), ...s16(moveY), ...s16(100), ...s16(100), ...s16(0), 0, frame,
    ...s16(box.x0), ...s16(box.y0), ...s16(box.x1), ...s16(box.y1),
    ...s16((box.x0 + box.x1) / 2), ...s16((box.y0 + box.y1) / 2),
  ];
}

export function parseMachineInfo(info) {
  if (!info || info.length < 52) return null;
  const d = info.subarray(2);
  const ascii = (o, n) => String.fromCharCode(...d.subarray(o, o + n)).replace(/\0.*$/, '').trim();
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    firmware: `${(dv.getInt16(0, false) / 100).toFixed(2)}.${dv.getInt16(35, false)}`,
    serial: ascii(2, 9),
    productId: d[11].toString(16),
    bluetoothVersion: dv.getInt16(24, false),
    model: d[26],
    oem: d[27],
    maxWidthMm: dv.getInt16(29, true) / 10,
    maxHeightMm: dv.getInt16(31, true) / 10,
    modelCode: ascii(39, 11),
  };
}

// 0x0C01 payload, as Artspira builds it: auto-cut, jump-cut, buzzer (always 1), foot height
// (1 standard, 2 high), sewing speed u16 LE (always 400)
export const settingsPayload = ({ autoCut, jumpCut, footHeight }) =>
  [autoCut ? 1 : 0, jumpCut ? 1 : 0, 1, footHeight === 2 ? 2 : 1, ...le16(400)];

export function parseSettings(r) {
  const d = r.subarray(2);
  return { autoCut: !!d[0], jumpCut: !!d[1], buzzer: d[2], footHeight: d[3] || 1 };
}

// 0x0100: stitches since last service, total stitches (u32 LE)
export function parseServiceCounts(r) {
  if (!r || r.length < 10) return null;
  const dv = new DataView(r.buffer, r.byteOffset + 2, r.byteLength - 2);
  return { sinceService: dv.getUint32(0, true), total: dv.getUint32(4, true) };
}

export const uuidHex = (r) => [...r.subarray(Math.max(0, r.length - 16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export function parseEmbInfo(r) {
  if (!r || r.length < 16) return null;
  const dv = new DataView(r.buffer, r.byteOffset + 2, r.byteLength - 2);
  return { totalTime: dv.getInt16(8, true), totalStitches: dv.getUint16(10, true), speed: dv.getInt16(12, true) };
}

export function parseMonitor(r) {
  if (!r || r.length < 12) return null;
  const dv = new DataView(r.buffer, r.byteOffset + 2, r.byteLength - 2);
  return { stitch: dv.getUint16(0, true), time: dv.getInt16(2, true), stopTime: dv.getInt16(4, true), x: dv.getInt16(6, true), y: dv.getInt16(8, true) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Device ----------------------------------------------------------------------------------
export class PP1 {
  constructor(log = () => {}) { this.log = log; this.queue = Promise.resolve(); this.device = null; }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] });
    this.device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    this.rx = await svc.getCharacteristic(READ_CHAR);
    this.tx = await svc.getCharacteristic(WRITE_CHAR);
    return this.device.name || 'SKITCH';
  }

  get connected() { return !!this.device?.gatt?.connected; }
  disconnect() { this.device?.gatt?.disconnect(); }

  // serialize all GATT traffic: one command, one response
  #locked(fn) { const p = this.queue.then(fn, fn); this.queue = p.catch(() => {}); return p; }
  async #write(bytes) { await this.tx.writeValueWithResponse(bytes); }
  async #read() { const v = await this.rx.readValue(); return new Uint8Array(v.buffer, v.byteOffset, v.byteLength); }

  command(cmd, payload = []) {
    return this.#locked(async () => { await this.#write(frame(cmd, payload)); return this.#read(); });
  }

  async info() { return parseMachineInfo(await this.command(CMD.MACHINE_INFO)); }
  async settings() { return parseSettings(await this.command(CMD.SETTINGS_GET)); }
  async saveSettings(s) { const r = await this.command(CMD.SETTINGS_SET, settingsPayload(s)); if (r[2] !== 0) throw new Error('Machine refused the settings'); }
  async resetSettings() { const r = await this.command(CMD.SETTINGS_RESET); if (r[2] !== 0) throw new Error('Machine refused the reset'); }
  async serviceCounts() { return parseServiceCounts(await this.command(CMD.SERVICE_COUNT)); }
  async maintenanceDue() { const r = await this.command(CMD.MAINTENANCE); return r.length >= 3 && r[2] === 1; }
  async errorLog() { return (await this.command(CMD.ERROR_LOG)).subarray(2); }
  // an interrupted job can be resumed when the flag is 1; the job uuid tells whose design it is
  async canResume() { const r = await this.command(CMD.RESUME_FLAG); return r.length >= 3 && r[2] === 1; }
  async jobId() { const r = await this.command(CMD.PATTERN_UUID_REQ); return r.length >= 16 ? uuidHex(r) : ''; }
  async resume() { const r = await this.command(CMD.RESUME); if (r[2] !== 0) throw new Error('Machine could not resume'); }
  async state() { const r = await this.command(CMD.MACHINE_STATE); return { status: r[2], error: r.length > 4 ? r[4] : 221 }; }
  async embInfo() { return parseEmbInfo(await this.command(CMD.EMB_INFO)); }
  async monitor() { return parseMonitor(await this.command(CMD.EMB_MONITOR)); }
  startSewing() { return this.command(CMD.START_SEWING); }
  hoopAvoidance() { return this.command(CMD.HOOP_AVOIDANCE); }
  clearError(code) { return this.command(CMD.CLEAR_ERROR, [code]); }
  setStartStitch(i) { return this.command(CMD.NEEDLE_INDEX, le16(i)); }

  // Trace the design outline with the needle so the user can check placement in the hoop.
  // Artspira sends a bare [0] when the machine's "jump cut" setting is on, else the design box.
  maskTrace(box, jumpCut) {
    if (jumpCut) return this.command(CMD.MASK_TRACE, [0]);
    const s16 = (v) => le16(Math.round(v) & 0xffff);
    return this.command(CMD.MASK_TRACE_BOUNDS, [...s16(box.x0), ...s16(box.y0), ...s16(box.x1), ...s16(box.y1), ...s16((box.x0 + box.x1) / 2), ...s16((box.y0 + box.y1) / 2)]);
  }

  // Full transfer as done by Artspira: delete -> info -> chunks -> wait -> layout -> job uuid
  // Firmware update as done by Artspira: data info type 4 -> chunks -> wait for the length echo -> 0x0B00.
  // The machine then reboots and drops the connection.
  async updateFirmware(upf, { chunkSize = 180, onProgress = () => {} } = {}) {
    const target = firmwareTarget(upf);
    if (!target) throw new Error('Not a SKITCH firmware file');
    const r = await this.command(CMD.DATA_INFO, dataInfoPayload(upf, 4));
    if (r.length < 3 || r[2] !== 0) throw new Error(`Machine refused the firmware (code ${r[2]})`);
    const chunks = dataChunks(upf, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      await this.#locked(() => this.#write(frame(CMD.DATA, chunks[i])));
      onProgress((i + 1) / chunks.length);
    }
    for (let tries = 0; ; tries++) {
      const s = await this.#locked(() => this.#read());
      if (s.length >= 3 && s[2] === 1) throw new Error('Machine rejected the firmware data');
      if (s.length >= 7 && s[2] === 0 && new DataView(s.buffer, s.byteOffset + 3, 4).getUint32(0, true) === upf.length) break;
      if (tries >= 20) throw new Error('Machine did not confirm the firmware data');
      await sleep(500);
    }
    const f = await this.command(CMD.FIRMWARE_START, [target]);
    if (f.length !== 3 || f[2] !== 0) throw new Error('Machine did not start the update');
  }

  async sendDesign(pen, layout, { chunkSize = 180, onProgress = () => {} } = {}) {
    await this.command(CMD.EMB_DELETE);
    const r = await this.command(CMD.DATA_INFO, dataInfoPayload(pen));
    if (r.length < 3 || r[2] !== 0) throw new Error(`Machine refused the design (code ${r[2]})`);
    const chunks = dataChunks(pen, chunkSize);
    for (let i = 0; i < chunks.length; i++) {
      await this.#locked(() => this.#write(frame(CMD.DATA, chunks[i])));
      onProgress((i + 1) / chunks.length);
    }
    for (let tries = 0; ; tries++) {
      const s = await this.#locked(() => this.#read());
      if (s.length >= 3 && s[2] === 0) break;
      if (s.length < 3 || s[2] === 1 || tries > 60) throw new Error('Machine reported a transfer error');
      await sleep(1000); // 2 = still processing
    }
    const l = await this.command(CMD.LAYOUT, layoutPayload(layout));
    if (l.length < 2) throw new Error('Layout was not accepted');
    const uuid = crypto.getRandomValues(new Uint8Array(16));
    const u = await this.command(CMD.EMB_UUID, [...uuid]);
    if (u.length < 3 || u[2] !== 0) throw new Error('Machine did not accept the job id');
    return uuidHex(uuid);
  }
}
