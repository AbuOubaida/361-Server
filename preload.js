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
  setSitePhpIni: (domain, cfg) => ipcRenderer.invoke('site:setPhpIni', domain, cfg),
  setSiteShare: (domain, on, port) => ipcRenderer.invoke('site:setShare', domain, on, port),
  setSitePublic: (domain, text) => ipcRenderer.invoke('site:setPublic', domain, text),
  checkSitePublic: (text) => ipcRenderer.invoke('site:checkPublic', text),
  acmeStatus: (domain) => ipcRenderer.invoke('acme:status', domain),
  acmeInstall: () => ipcRenderer.invoke('acme:install'),
  acmeIssue: (domain, email, staging) => ipcRenderer.invoke('acme:issue', domain, email, staging),
  acmeAutoRenew: () => ipcRenderer.invoke('acme:autoRenew'),
  acmeFolder: () => ipcRenderer.invoke('acme:folder'),
  netInfo: () => ipcRenderer.invoke('net:info'),
  allowFirewall: () => ipcRenderer.invoke('fw:allow'),
  allowPublicFirewall: () => ipcRenderer.invoke('fw:allowPublic'),
  setSiteEnabled: (domain, on) => ipcRenderer.invoke('site:setEnabled', domain, on),
  openSiteConf: (domain, webId) => ipcRenderer.invoke('site:openConf', domain, webId),
  addSiteExtra: (domain, webId, name) => ipcRenderer.invoke('site:addExtra', domain, webId, name),
  openSiteExtras: (domain, webId) => ipcRenderer.invoke('site:openExtras', domain, webId),
  confState: (webId) => ipcRenderer.invoke('sites:confState', webId),
  keepSiteConf: (domain, webId) => ipcRenderer.invoke('site:keepConf', domain, webId),
  resetSiteConf: (domain, webId) => ipcRenderer.invoke('site:resetConf', domain, webId),
  resetAllConf: (webId) => ipcRenderer.invoke('sites:resetAll', webId),
  openSitesDir: (webId) => ipcRenderer.invoke('sites:openDir', webId),
  openSiteFolder: (domain) => ipcRenderer.invoke('site:openFolder', domain),

  // PHP extension (ভার্সন ধরে)
  listExt: (version) => ipcRenderer.invoke('ext:list', version),
  setExt: (version, name, on) => ipcRenderer.invoke('ext:set', version, name, on),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  openPath: (p) => ipcRenderer.invoke('path:open', p),

  // সাইট ধরে PHP ভার্সন
  listPhp: () => ipcRenderer.invoke('php:list'),
  setSitePhp: (domain, version) => ipcRenderer.invoke('site:setPhp', domain, version),

  // Node.js সাইট
  listNodeSites: () => ipcRenderer.invoke('node:list'),
  startNode: (domain) => ipcRenderer.invoke('node:start', domain),
  stopNode: (domain) => ipcRenderer.invoke('node:stop', domain),
  restartNode: (domain) => ipcRenderer.invoke('node:restart', domain),
  installNode: (domain) => ipcRenderer.invoke('node:install', domain),
  configNode: (domain, cfg) => ipcRenderer.invoke('node:config', domain, cfg),
  nodeLog: (domain) => ipcRenderer.invoke('node:log', domain),

  // MySQL root পাসওয়ার্ড
  mysqlPwState: () => ipcRenderer.invoke('mysql:pwState'),
  mysqlSetPassword: (pw) => ipcRenderer.invoke('mysql:setPassword', pw),
  pgPwState: () => ipcRenderer.invoke('pg:pwState'),
  pgSetPassword: (pw, reset) => ipcRenderer.invoke('pg:setPassword', pw, reset),
  mysqlResetPassword: (pw) => ipcRenderer.invoke('mysql:resetPassword', pw),
  getDbPw: (kind) => ipcRenderer.invoke('db:getPw', kind),

  // কনফিগ ফাইল (php.ini, my.ini, postgresql.conf ...)
  cfgList: () => ipcRenderer.invoke('cfg:list'),
  cfgOpen: (id) => ipcRenderer.invoke('cfg:open', id),
  cfgFolder: (id) => ipcRenderer.invoke('cfg:folder', id),

  // Backup
  backupGetConfig: () => ipcRenderer.invoke('backup:getConfig'),
  backupSetConfig: (cfg, secrets) => ipcRenderer.invoke('backup:setConfig', cfg, secrets),
  backupRun: () => ipcRenderer.invoke('backup:run'),
  backupStatus: () => ipcRenderer.invoke('backup:status'),
  backupEnsure7z: () => ipcRenderer.invoke('backup:ensure7z'),
  backupChooseFolder: () => ipcRenderer.invoke('backup:chooseFolder'),
  backupFolderSize: (dir) => ipcRenderer.invoke('backup:folderSize', dir),
  backupOpenLogs: () => ipcRenderer.invoke('backup:openLogs'),
  backupTaskState: () => ipcRenderer.invoke('backup:taskState'),
  backupTaskInstall: (user, pw) => ipcRenderer.invoke('backup:taskInstall', user, pw),
  backupTaskRemove: () => ipcRenderer.invoke('backup:taskRemove'),
  restoreList: (customDir) => ipcRenderer.invoke('restore:list', customDir),
  restoreWwwInfo: (dir) => ipcRenderer.invoke('restore:wwwInfo', dir),
  restoreWww: (opts) => ipcRenderer.invoke('restore:www', opts),
  restoreDbInfo: (dir) => ipcRenderer.invoke('restore:dbInfo', dir),
  restoreDb: (opts) => ipcRenderer.invoke('restore:db', opts),
  restorePgInfo: (opts) => ipcRenderer.invoke('restore:pgInfo', opts),
  restorePg: (opts) => ipcRenderer.invoke('restore:pg', opts),
  restoreFixDb: (opts) => ipcRenderer.invoke('restore:fixDb', opts),
  restoreOtherInfo: (dir) => ipcRenderer.invoke('restore:otherInfo', dir),
  restoreOther: (opts) => ipcRenderer.invoke('restore:other', opts),
  restoreSettingsInfo: (dir) => ipcRenderer.invoke('restore:settingsInfo', dir),
  restoreSettings: (opts) => ipcRenderer.invoke('restore:settings', opts),

  // অ্যাপ চালু থাকা / অটো-স্টার্ট (ট্রে)
  appGetBehavior: () => ipcRenderer.invoke('app:getBehavior'),
  appSetBehavior: (b) => ipcRenderer.invoke('app:setBehavior', b),
  onAutoStartAll: (callback) => ipcRenderer.on('auto:startAll', () => callback()),

  // ভাষা
  getLang: () => ipcRenderer.invoke('lang:get'),
  setLang: (lang) => ipcRenderer.invoke('lang:set', lang),
  onLangChanged: (callback) => ipcRenderer.on('lang:changed', (_event, l) => callback(l)),
});
