const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ওয়েব সার্ভার
  startServer: (id) => ipcRenderer.invoke('service:start', id),
  stopServer: () => ipcRenderer.invoke('service:stop'),
  onStatus: (callback) => ipcRenderer.on('status', (_event, msg) => callback(msg)),

  // সব একসাথে
  startAll: (webId) => ipcRenderer.invoke('all:start', webId),
  stopAll: () => ipcRenderer.invoke('all:stop'),

  // ডাটাবেস (MySQL, PostgreSQL...)
  listDbs: () => ipcRenderer.invoke('db:list'),
  startDb: (id) => ipcRenderer.invoke('db:start', id),
  stopDb: (id) => ipcRenderer.invoke('db:stop', id),
  setDbAuto: (id, on) => ipcRenderer.invoke('db:setAuto', id, on),

  // পোর্ট
  getPort: () => ipcRenderer.invoke('port:get'),
  setPort: (kind, value) => ipcRenderer.invoke('port:set', kind, value),

  // www ফোল্ডার ও সাইট
  getWww: () => ipcRenderer.invoke('www:get'),
  chooseWww: () => ipcRenderer.invoke('www:choose'),
  openWww: () => ipcRenderer.invoke('www:open'),
  onWwwChanged: (callback) => ipcRenderer.on('www:changed', (_event, p) => callback(p)),
  listSites: () => ipcRenderer.invoke('sites:list'),
  refreshSites: () => ipcRenderer.invoke('sites:refresh'),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
});
