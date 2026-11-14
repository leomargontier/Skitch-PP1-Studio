const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openFile: () => ipcRenderer.invoke('open-file'),
  firmwareList: () => ipcRenderer.invoke('firmware-list'),
  firmwareDownload: (url, md5) => ipcRenderer.invoke('firmware-download', url, md5),
  saveFile: (name, bytes) => ipcRenderer.invoke('save-file', name, bytes),
  onBluetoothDevices: (fn) => ipcRenderer.on('bt-devices', (_e, list) => fn(list)),
  selectBluetooth: (id) => ipcRenderer.send('bt-select', id),
});
