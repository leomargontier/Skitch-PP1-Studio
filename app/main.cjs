// Electron main process: one window, Web Bluetooth device chooser, file open dialog.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Web Bluetooth is behind this flag on Linux builds of Chromium.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-experimental-web-platform-features');

let win;
let pickBluetooth = null; // callback Chromium gave us for the pending requestDevice()

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600,
    title: 'Skitch Studio',
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
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: 'Tajima DST', extensions: ['dst'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  return path.basename(r.filePath);
});

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
