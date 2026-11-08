const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  startServer: (id) => ipcRenderer.invoke('service:start', id),
  stopServer: () => ipcRenderer.invoke('service:stop'),
  onStatus: (callback) => ipcRenderer.on('status', (_event, msg) => callback(msg)),
  getWww: () => ipcRenderer.invoke('www:get'),
  chooseWww: () => ipcRenderer.invoke('www:choose'),
  openWww: () => ipcRenderer.invoke('www:open'),
  onWwwChanged: (callback) => ipcRenderer.on('www:changed', (_event, p) => callback(p)),
  listSites: () => ipcRenderer.invoke('sites:list'),
  refreshSites: () => ipcRenderer.invoke('sites:refresh'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
});
