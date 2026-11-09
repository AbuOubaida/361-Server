const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // ওয়েব সার্ভার
  startServer: (id) => ipcRenderer.invoke('service:start', id),
  stopServer: () => ipcRenderer.invoke('service:stop'),
  restartServer: () => ipcRenderer.invoke('service:restart'),
  onStatus: (callback) => ipcRenderer.on('status', (_event, msg) => callback(msg)),

  // সব একসাথে
  startAll: (webId) => ipcRenderer.invoke('all:start', webId),
  stopAll: () => ipcRenderer.invoke('all:stop'),
  restartAll: () => ipcRenderer.invoke('all:restart'),

  // ডাটাবেস (MySQL, PostgreSQL...)
  listDbs: () => ipcRenderer.invoke('db:list'),
  startDb: (id) => ipcRenderer.invoke('db:start', id),
  stopDb: (id) => ipcRenderer.invoke('db:stop', id),
  restartDb: (id) => ipcRenderer.invoke('db:restart', id),
  setDbAuto: (id, on) => ipcRenderer.invoke('db:setAuto', id, on),

  // Adminer (ব্রাউজারে ডাটাবেস)
  openAdminer: (kind) => ipcRenderer.invoke('adminer:open', kind),
  openPma: () => ipcRenderer.invoke('pma:open'),

  // টুলস ও ভার্সন
  listTools: () => ipcRenderer.invoke('tools:list'),
  addTool: (opts) => ipcRenderer.invoke('tools:add', opts),
  useTool: (id, version) => ipcRenderer.invoke('tools:use', id, version),
  removeTool: (id, version) => ipcRenderer.invoke('tools:remove', id, version),
  toolHelp: (id) => ipcRenderer.invoke('tools:help', id),

  // পোর্ট
  getPort: () => ipcRenderer.invoke('port:get'),
  setPort: (kind, value) => ipcRenderer.invoke('port:set', kind, value),

  // ওয়েব সার্ভারের অবস্থা
  webStatus: () => ipcRenderer.invoke('web:status'),

  // ইনস্টল ফোল্ডার
  getRoot: () => ipcRenderer.invoke('root:get'),
  chooseRoot: () => ipcRenderer.invoke('root:choose'),
  openRoot: () => ipcRenderer.invoke('root:open'),
  onRootChanged: (callback) => ipcRenderer.on('root:changed', (_event, p) => callback(p)),

  // www ফোল্ডার ও সাইট
  getWww: () => ipcRenderer.invoke('www:get'),
  chooseWww: () => ipcRenderer.invoke('www:choose'),
  openWww: () => ipcRenderer.invoke('www:open'),
  onWwwChanged: (callback) => ipcRenderer.on('www:changed', (_event, p) => callback(p)),
  listSites: () => ipcRenderer.invoke('sites:list'),
  refreshSites: () => ipcRenderer.invoke('sites:refresh'),
  createSite: (kind, name) => ipcRenderer.invoke('site:create', kind, name),
  setSiteSession: (domain, minutes) => ipcRenderer.invoke('site:setSession', domain, minutes),

  // PHP extension (ভার্সন ধরে)
  listExt: (version) => ipcRenderer.invoke('ext:list', version),
  setExt: (version, name, on) => ipcRenderer.invoke('ext:set', version, name, on),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),

  // সাইট ধরে PHP ভার্সন
  listPhp: () => ipcRenderer.invoke('php:list'),
  setSitePhp: (domain, version) => ipcRenderer.invoke('site:setPhp', domain, version),

  // ভাষা
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),
});
