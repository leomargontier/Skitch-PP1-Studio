const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openFile: () => ipcRenderer.invoke('open-file'),
  onBluetoothDevices: (fn) => ipcRenderer.on('bt-devices', (_e, list) => fn(list)),
  selectBluetooth: (id) => ipcRenderer.send('bt-select', id),
});
