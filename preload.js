const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startApache: () => ipcRenderer.invoke('apache:start'),
  stopApache: () => ipcRenderer.invoke('apache:stop'),
  onStatus: (callback) => ipcRenderer.on('status', (_event, msg) => callback(msg)),
});