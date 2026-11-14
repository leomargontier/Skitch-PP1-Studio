// Electron main process: one window, Web Bluetooth device chooser, file open dialog.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Web Bluetooth is behind this flag on Linux builds of Chromium.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let win;
let pickBluetooth = null; // callback Chromium gave us for the pending requestDevice()

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    title: 'Hoopbridge',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'index.html'));

  // Chromium asks the embedder to choose a device; forward the live list to the renderer.
  win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();
    pickBluetooth = callback;
    win.webContents.send('bt-devices', devices.map((d) => ({ id: d.deviceId, name: d.deviceName || 'Unknown device' })));
  });

  // Windows/Linux may ask to confirm pairing on first connect.
  win.webContents.session.setBluetoothPairingHandler((details, callback) => {
    if (details.pairingKind === 'confirm' || details.pairingKind === 'confirmPin') callback({ confirmed: true });
    else callback({ confirmed: false });
  });
}

ipcMain.on('bt-select', (_e, id) => { pickBluetooth?.(id || ''); pickBluetooth = null; });

ipcMain.handle('open-file', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [
      { name: 'Embroidery or image', extensions: ['pes', 'pec', 'dst', 'jef', 'exp', 'png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] },
      { name: 'Embroidery', extensions: ['pes', 'pec', 'dst', 'jef', 'exp'] },
      { name: 'Image', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'gif', 'webp'] },
    ],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  return { name: path.basename(p), bytes: fs.readFileSync(p) };
});

ipcMain.handle('save-file', async (_e, name, bytes) => {
  const pes = name.toLowerCase().endsWith('.pes');
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [pes ? { name: 'Brother PES', extensions: ['pes'] } : { name: 'Tajima DST', extensions: ['dst'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return path.basename(r.filePath);
});

// Firmware comes from Brother's public download server (the same files Artspira uses; no account).
const FIRMWARE_LIST = 'https://download.brother.com/pub/com/phc_pcs_oneclickupdate/frm/pp1/SewingMachine_upf.json';
ipcMain.handle('firmware-list', async () => {
  const r = await fetch(FIRMWARE_LIST);
  if (!r.ok) throw new Error(`Brother server answered ${r.status}`);
  return r.json();
});
ipcMain.handle('firmware-download', async (_e, url, md5) => {
  if (!String(url).startsWith('https://download.brother.com/')) throw new Error('Unexpected firmware URL');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Download failed (${r.status})`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (crypto.createHash('md5').update(bytes).digest('hex') !== String(md5).toLowerCase()) throw new Error('Firmware checksum does not match; not using it');
  return bytes;
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
