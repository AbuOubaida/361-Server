const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startServer: (id) => ipcRenderer.invoke('service:start', id),
  stopServer: () => ipcRenderer.invoke('service:stop'),
  onStatus: (callback) => ipcRenderer.on('status', (_event, msg) => callback(msg)),
});
