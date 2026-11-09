const { app, BrowserWindow, Menu, ipcMain, dialog, shell } = require('electron');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const extract = require('extract-zip');
const crypto = require('crypto');

// ====== এখানে আপনার লিংক বসান ======
const APACHE_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/httpd-2.4.70-261106-Win64-VS18.zip';
const NGINX_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/nginx-1.30.6.zip';
// PHP zip-এর আসল নাম দিন (Release-এ আপলোড করা ফাইলের নাম)
const PHP_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/php-8.5.12-1-nts-Win32-vs17-x64.zip';

// MySQL zip-এর আসল নাম দিন (Release-এ আপলোড করা ফাইলের নাম)
const MYSQL_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/mysql-8.4.13-winx64.zip';
// PostgreSQL zip-এর আসল নাম দিন (EDB-র "binaries" zip, Release-এ আপলোড করা ফাইলের নাম)
const POSTGRES_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/postgresql-18.6-5-windows-x64-binaries.zip';

// Adminer (একটা মাত্র PHP ফাইল): adminer.org থেকে adminer-5.5.1.php নামিয়ে Release-এ আপলোড করুন
const ADMINER_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/adminer-5.5.1.php';

// phpMyAdmin: phpmyadmin.net থেকে phpMyAdmin-5.2.3-all-languages.zip নামিয়ে Release-এ আপলোড করুন
const PMA_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/phpMyAdmin-5.2.3-all-languages.zip';

// Microsoft-এর স্থির লিংক: সর্বশেষ সাপোর্টেড VC++ Redistributable (x64)
const VCREDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';
// ====================================

// অ্যাপের নিজস্ব ডাটা ফোল্ডার: C:\Users\<name>\AppData\Roaming\my-laragon
// ইনস্টল ফোল্ডার (ROOT): এর ভেতরে tools\ (প্রোগ্রাম) ও data\ (ডাটাবেসের ডাটা) থাকে।
// ডিফল্ট: C:\Users\<n>\AppData\Roaming\my-laragon — ইউজার সেটিংস থেকে যেকোনো ফোল্ডারে সরাতে পারে।
// settings.json সবসময় ডিফল্ট জায়গাতেই থাকে (নাহলে ROOT কোথায় তা জানা যাবে না)।
const DEFAULT_ROOT = app.getPath('userData');
let ROOT_DIR, TOOLS_DIR, VCREDIST_PATH, ADMINER_DIR;

function applyRoot(root) {
  ROOT_DIR = root;
  TOOLS_DIR = path.join(root, 'tools');
  VCREDIST_PATH = path.join(TOOLS_DIR, 'vc_redist.x64.exe');
  // ডাটা tools-এর বাইরে থাকে (data\\ ফোল্ডারে), যাতে প্রোগ্রাম আবার নামালেও ডাটাবেস না হারায
  ADMINER_DIR = path.join(TOOLS_DIR, 'adminer');
}

// ---------- সেটিংস (www ফোল্ডার ইউজার বদলাতে পারবে) ----------
const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULT_WWW = path.join(app.getPath('documents'), 'my-laragon', 'www');

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(obj, null, 2));
}

const settings = loadSettings();

// UI ভাষা: settings.lang = 'bn' | 'en'। tr(বাংলা, English) বর্তমান ভাষার বার্তাটা দেয়।
function tr(bn, en) {
  return settings.lang === 'en' ? en : bn;
}
applyRoot(settings.rootDir || DEFAULT_ROOT);
let WWW_DIR = settings.wwwDir || DEFAULT_WWW; // ওয়েবসাইটের ফাইল রাখার ফোল্ডার

// ওয়েব সার্ভারের পোর্ট (ডিফল্ট ৮০)
function validPort(v) {
  const p = Number(v);
  return Number.isInteger(p) && p >= 1 && p <= 65535 ? p : null;
}
function getWebPort() {
  return validPort(settings.webPort) || 80;
}
function getDbPort(id) {
  const db = DATABASES[id];
  return validPort(settings[db.portKey]) || db.defaultPort;
}

// পোর্টটা খালি আছে কিনা দেখা
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

// খালি পোর্ট খুঁজে বের করা (৯০০০ অন্য কেউ নিয়ে রাখলে সমস্যা এড়াতে)
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// ---------- সার্ভিসের তালিকা ----------
// ---------- টুলের ভার্সন ----------
// প্রতিটা টুলের ডিফল্ট ভার্সন কোডে বসানো (TOOL_DEFAULTS)। ব্যবহারকারী "টুলস ও ভার্সন" পেজ থেকে নতুন ভার্সন যোগ করলে
// settings.toolVersions[id] = { active, items: { '<ভার্সন>': { folder, url } } } এ জমা হয়।
const TOOL_DEFAULTS = {}; // id -> { version, folder, url }

function toolState(id) {
  settings.toolVersions = settings.toolVersions || {};
  settings.toolVersions[id] = settings.toolVersions[id] || { active: null, items: {} };
  settings.toolVersions[id].items = settings.toolVersions[id].items || {};
  return settings.toolVersions[id];
}

function activeVersion(id) {
  const def = TOOL_DEFAULTS[id];
  const st = settings.toolVersions && settings.toolVersions[id];
  if (st && st.active && st.active !== def.version && st.items && st.items[st.active]) {
    const it = st.items[st.active];
    return { version: st.active, folder: it.folder, url: it.url || null, isDefault: false };
  }
  return { version: def.version, folder: def.folder, url: def.url, isDefault: true };
}

// ডাটাবেসের ডাটা ফোল্ডার: ডিফল্ট ভার্সনের জন্য আগের মতোই data\mysql; অন্য ভার্সনের জন্য আলাদা (data\mysql-8.0.40)
// কারণ ভার্সন বদলালে একই ডাটা ফোল্ডার খুললে ডাটাবেস নষ্ট হতে পারে।
function dataDirFor(id, legacyName) {
  const v = activeVersion(id);
  return path.join(ROOT_DIR, 'data', v.isDefault ? legacyName : `${legacyName}-${v.version}`);
}
const mysqlDataDir = () => dataDirFor('mysql', 'mysql');
const pgDataDir = () => dataDirFor('postgres', 'postgres');
const mysqlIni = () => {
  const v = activeVersion('mysql');
  return path.join(ROOT_DIR, 'data', v.isDefault ? 'my.ini' : `my-${v.version}.ini`);
};

function makeService(id, label, url, folder, exeRelPath, opts = {}) {
  TOOL_DEFAULTS[id] = { version: opts.version || '', folder, url };
  // dir/exe/url getter: ইনস্টল ফোল্ডার বা ভার্সন বদলালে নিজে থেকেই নতুন পথ পাওয়া যায়
  return {
    id,
    label,
    get url() {
      return activeVersion(id).url;
    },
    get dir() {
      return path.join(TOOLS_DIR, activeVersion(id).folder);
    },
    exeRel: exeRelPath,
    get exe() {
      return path.join(TOOLS_DIR, activeVersion(id).folder, exeRelPath);
    },
    needsVC: !!opts.needsVC,
    usesPHP: !!opts.usesPHP,
    phpViaCgi: !!opts.phpViaCgi,
    vhosts: !!opts.vhosts,
    afterExtract: opts.afterExtract || null,
    beforeStart: opts.beforeStart || null,
    args: opts.args || (() => []),
    reloadArgs: opts.reloadArgs || ['-s', 'reload'],
  };
}

// php.ini-তে দরকারি extension চালু করা (বারবার চালালেও একই ফল)
const PHP_EXTS = 'mbstring|openssl|curl|mysqli|pdo_mysql|pgsql|pdo_pgsql|fileinfo|gd|zip|intl';
function enableExtensions(txt) {
  txt = txt.replace(/^;\s*extension_dir\s*=\s*"ext"/m, 'extension_dir = "ext"');
  txt = txt.replace(new RegExp(`^;\\s*(extension=(${PHP_EXTS}))\\s*$`, 'gm'), '$1');
  txt = txt.replace(/^;date\.timezone =.*$/m, 'date.timezone = Asia/Dhaka');
  // বড় SQL ফাইল ইমপোর্টের জন্য (phpMyAdmin / Adminer)
  txt = txt.replace(/^upload_max_filesize\s*=.*$/m, 'upload_max_filesize = 128M');
  txt = txt.replace(/^post_max_size\s*=.*$/m, 'post_max_size = 128M');
  // সেশন ও আপলোডের অস্থায়ী ফোল্ডার: Apache-র php-cgi-তে TEMP ভ্যারিয়েবল থাকে না, তাই PHP C:\Windows-এ লিখতে গিয়ে
  // "Permission denied" পায়। নিজের লেখার-যোগ্য ফোল্ডার দিয়ে দিচ্ছি।
  const tmpBase = path.join(ROOT_DIR, 'data', 'php-tmp').replace(/\\/g, '/');
  fs.mkdirSync(tmpBase + '/sessions', { recursive: true });
  fs.mkdirSync(tmpBase + '/upload', { recursive: true });
  const setIni = (key, val) => {
    const re = new RegExp(`^;?\\s*${key.replace('.', '\\.')}\\s*=.*$`, 'm');
    const line = `${key} = "${val}"`;
    txt = re.test(txt) ? txt.replace(re, line) : txt + `\n${line}\n`;
  };
  setIni('session.save_path', tmpBase + '/sessions');
  setIni('upload_tmp_dir', tmpBase + '/upload');
  setIni('sys_temp_dir', tmpBase);
  // একই extension দুইবার লোড হওয়া এড়াতে ডুপ্লিকেট লাইন বাদ
  const seen = new Set();
  return txt
    .split('\n')
    .filter((line) => {
      const m = line.match(/^extension=(\w+)/);
      if (!m) return true;
      if (seen.has(m[1])) return false;
      seen.add(m[1]);
      return true;
    })
    .join('\n');
}

function setupPhpIni(dir) {
  const txt = fs.readFileSync(path.join(dir, 'php.ini-development'), 'utf8');
  fs.writeFileSync(path.join(dir, 'php.ini'), enableExtensions(txt));
}

// আগে থেকে তৈরি php.ini-তেও নতুন extension (যেমন pgsql) চালু করা
function refreshPhpIni(dir) {
  const ini = path.join(dir || SERVICES.php.dir, 'php.ini');
  if (!fs.existsSync(ini)) return;
  const txt = fs.readFileSync(ini, 'utf8');
  const next = enableExtensions(txt);
  if (next !== txt) fs.writeFileSync(ini, next);
}

// ---------- সাইট ধরে PHP ভার্সন ----------
// settings.sitePhp = { 'blog.test': '8.4.10', ... }। যে সাইটের নাম এখানে নেই সেটা ডিফল্ট (চালু) PHP ব্যবহার করে।
const phpSlug = (v) => String(v).replace(/[^0-9A-Za-z]+/g, '-');
// প্রতিটা PHP ভার্সনের জন্য কয়টা php-cgi worker চলবে (একটা php-cgi একসাথে একটাই রিকোয়েস্ট সামলায়)
const PHP_WORKERS_DEFAULT = 4;
const phpWorkerCount = () => {
  const n = parseInt(settings.phpWorkers, 10);
  return Number.isInteger(n) && n >= 1 && n <= 16 ? n : PHP_WORKERS_DEFAULT;
};
// Nginx upstream-এর নাম (ভার্সন ধরে)
const phpUpstream = (v) => `php_${phpSlug(v).replace(/-/g, '_')}`;
const defaultPhpVersion = () => activeVersion('php').version;

function phpVersionList() {
  const def = TOOL_DEFAULTS.php;
  const items = (settings.toolVersions && settings.toolVersions.php && settings.toolVersions.php.items) || {};
  return [{ version: def.version, folder: def.folder }, ...Object.entries(items).map(([v, it]) => ({ version: v, folder: it.folder }))].map((x) => {
    const dir = path.join(TOOLS_DIR, x.folder);
    return { version: x.version, dir, installed: fs.existsSync(path.join(dir, 'php-cgi.exe')) };
  });
}
const phpDirOf = (v) => (phpVersionList().find((x) => x.version === v) || {}).dir || SERVICES.php.dir;

// সাইটের জন্য বাছা ভার্সন (নামানো না থাকলে বা মুছে ফেললে ডিফল্টে ফিরে যায়)
function pinnedPhp(domain) {
  const v = settings.sitePhp && settings.sitePhp[domain];
  return v && phpVersionList().some((x) => x.version === v && x.installed) ? v : '';
}
const sitePhpVersion = (domain) => pinnedPhp(domain) || defaultPhpVersion();
const phpOfSite = (s) => (s.system ? defaultPhpVersion() : sitePhpVersion(s.domain));
// এই সাইটগুলো চালাতে যে PHP ভার্সনগুলো লাগবে
const neededPhpVersions = (sites) => [...new Set([defaultPhpVersion(), ...sites.map(phpOfSite)])];

// Nginx-এর একটা server ব্লক (সাইটের জন্য)
function nginxServer(serverName, root, phpUp, isDefault, webPort, localOnly = false, extra = []) {
  const r = root.replace(/\\/g, '/');
  return [
    '  server {',
    `    listen ${webPort}${isDefault ? ' default_server' : ''};`,
    `    server_name ${serverName};`,
    // Adminer-এর মতো সিস্টেম সাইট শুধু এই কম্পিউটার থেকে খোলা যাবে (LAN থেকে নয়)
    ...(localOnly ? ['    allow 127.0.0.1;', '    allow ::1;', '    deny all;'] : []),
    `    root "${r}";`,
    '    index index.php index.html;',
    isDefault
      ? '    location / { try_files $uri $uri/ =404; }'
      : '    location / { try_files $uri $uri/ /index.php?$query_string; }',
    ...extra,
    '    location ~ \\.php$ {',
    `      fastcgi_pass ${phpUp};`,
    '      fastcgi_index index.php;',
    '      fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '      include fastcgi_params;',
    '      fastcgi_read_timeout 300;',
    '    }',
    '  }',
  ].join('\n');
}

// http://localhost/phpmyadmin ও http://localhost/adminer (শুধু এই কম্পিউটার থেকে)
// www ফোল্ডারে একই নামের ফোল্ডার থাকলে সেটাই অগ্রাধিকার পায়, তাই তখন যোগ করা হয় না
function toolLocations(phpUp) {
  const out = [];
  const taken = (n) => {
    try {
      return fs.readdirSync(WWW_DIR).some((e) => e.toLowerCase() === n);
    } catch {
      return false;
    }
  };
  const add = (name, dir) => {
    if (taken(name)) return;
    const d = dir.replace(/\\/g, '/').replace(/\/?$/, '/');
    out.push(
      `    location = /${name} { return 301 $scheme://$http_host/${name}/; }`,
      `    location ^~ /${name}/ {`,
      `      alias "${d}";`,
      '      index index.php;',
      '      allow 127.0.0.1;',
      '      allow ::1;',
      '      deny all;',
      '      location ~ \\.php$ {',
      `        fastcgi_pass ${phpUp};`,
      '        fastcgi_param SCRIPT_FILENAME $request_filename;',
      '        include fastcgi_params;',
      '        fastcgi_read_timeout 300;',
      '      }',
      '    }'
    );
  };
  if (pmaInstalled()) add('phpmyadmin', SERVICES.phpmyadmin.dir);
  if (adminerInstalled()) add('adminer', ADMINER_DIR);
  return out;
}

// Apache-এর একটা VirtualHost ব্লক (PHP চলে mod_proxy_fcgi দিয়ে, php-cgi-র সাথে)
function apacheServer(serverName, root, phpVer, webPort, localOnly = false, extra = []) {
  const r = root.replace(/\\/g, '/');
  return [
    `<VirtualHost *:${webPort}>`,
    `  ServerName ${serverName}`,
    `  DocumentRoot "${r}"`,
    '  DirectoryIndex index.php index.html',
    // এই সাইটের নিজের PHP ভার্সন (php-cgi ও php.ini আলাদা)
    `  SetEnv PHPRC "${phpDirOf(phpVer).replace(/\\/g, '/')}"`,
    `  Action application/x-httpd-php "/server360-php-${phpSlug(phpVer)}/php-cgi.exe"`,
    `  <Directory "${r}">`,
    '    Options Indexes FollowSymLinks',
    '    AllowOverride All',
    `    ${localOnly ? 'Require local' : 'Require all granted'}`,
    '  </Directory>',
    ...extra,
    '</VirtualHost>',
    '',
  ].join('\n');
}

// conf\server360.conf লেখা এবং httpd.conf-এ তার Include বসানো (বারবার চালালেও একই ফল)
function writeApacheConf(svc, _phpPorts, sites, webPort) {
  const f = (p) => p.replace(/\\/g, '/');
  const aliasLines = [];
  const taken = (n) => {
    try {
      return fs.readdirSync(WWW_DIR).some((e) => e.toLowerCase() === n);
    } catch {
      return false;
    }
  };
  const addAlias = (name, dir) => {
    if (taken(name)) return;
    aliasLines.push(
      `  Alias /${name} "${f(dir)}"`,
      `  <Directory "${f(dir)}">`,
      '    DirectoryIndex index.php',
      '    AllowOverride None',
      '    Require local',
      '  </Directory>'
    );
  };
  if (pmaInstalled()) addAlias('phpmyadmin', SERVICES.phpmyadmin.dir);
  if (adminerInstalled()) addAlias('adminer', ADMINER_DIR);

  // দরকারি মডিউল নিজেই লোড (আগে থেকে লোড থাকলে বাদ যায়, তাই দুবার লোডের এরর হয় না)
  const mods = [
    ['cgi_module', 'mod_cgi.so', true],
    ['actions_module', 'mod_actions.so', true],
    ['rewrite_module', 'mod_rewrite.so', true],
    ['env_module', 'mod_env.so', false],
    ['authz_host_module', 'mod_authz_host.so', false],
    ['alias_module', 'mod_alias.so', false],
    ['dir_module', 'mod_dir.so', false],
  ];
  const modLines = [];
  for (const [name, file, must] of mods) {
    if (!fs.existsSync(path.join(svc.dir, 'modules', file))) {
      if (must) throw new Error(tr(`Apache-এর modules\\${file} পাওয়া যায়নি (এই Apache ZIP-এ মডিউলটা নেই)`, `modules\\${file} not found (this Apache ZIP does not include the module)`));
      continue;
    }
    modLines.push(`<IfModule !${name}>`, `  LoadModule ${name} "${f(path.join(svc.dir, 'modules', file))}"`, '</IfModule>');
  }

  // যে যে PHP ভার্সন লাগবে, প্রতিটার জন্য আলাদা ScriptAlias (php.ini-ও ঠিক করে নেওয়া)
  const defVer = defaultPhpVersion();
  const phpBlocks = [];
  for (const v of neededPhpVersions(sites)) {
    const dir = f(phpDirOf(v));
    refreshPhpIni(phpDirOf(v));
    phpBlocks.push(
      `ScriptAlias /server360-php-${phpSlug(v)}/ "${dir}/"`,
      `<Directory "${dir}">`,
      '  AllowOverride None',
      '  Options None',
      '  Require all denied',
      '  <Files "php-cgi.exe">',
      '    Require all granted',
      '  </Files>',
      '</Directory>'
    );
  }

  const parts = [
    '# Generated by Server 360. Manual edits are overwritten on the next Start.',
    ...modLines,
    '',
    // PHP চলে php-cgi.exe দিয়ে (Windows-এ mod_proxy_fcgi-র পাথ বাগ এড়াতে)। PHPRC দিয়ে php.ini খুঁজে পায়।
    // প্রতিটা VirtualHost নিজের ভার্সনের Action দেয়; এখানকার Action ও PHPRC শুধু ডিফল্ট।
    `SetEnv PHPRC "${f(phpDirOf(defVer))}"`,
    ...phpBlocks,
    'AddType application/x-httpd-php .php',
    `Action application/x-httpd-php "/server360-php-${phpSlug(defVer)}/php-cgi.exe"`,
    '',
    apacheServer('localhost', WWW_DIR, defVer, webPort, false, aliasLines),
    ...sites.map((x) => apacheServer(x.domain, x.root, phpOfSite(x), webPort, !!x.system)),
  ];
  fs.writeFileSync(path.join(svc.dir, 'conf', 'server360.conf'), parts.join('\n'));

  const confPath = path.join(svc.dir, 'conf', 'httpd.conf');
  let conf = fs.readFileSync(confPath, 'utf8');
  conf = conf.replace(/\r?\n?# server360 begin[\s\S]*?# server360 end\r?\n?/g, '\n');
  conf = conf.replace(/^#(LoadModule (?:proxy_module|proxy_fcgi_module|rewrite_module) )/gm, '$1');
  conf = conf.trimEnd() + '\n\n# server360 begin\nInclude "${SRVROOT}/conf/server360.conf"\n# server360 end\n';
  fs.writeFileSync(confPath, conf);
}

// Nginx-এর কনফিগ প্রতিবার চালুর সময় (ও সাইট রিফ্রেশে) লেখা হয়
function writeNginxConf(svc, phpPorts, sites = [], webPort = 80) {
  const defVer = defaultPhpVersion();
  // প্রতিটা চলমান PHP ভার্সনের জন্য একটা upstream (একাধিক php-cgi worker, round-robin)
  const upstreams = Object.keys(phpPorts)
    .filter((v) => (phpPorts[v] || []).length)
    .map((v) => [`  upstream ${phpUpstream(v)} {`, ...phpPorts[v].map((p) => `    server 127.0.0.1:${p} max_fails=0;`), '  }'].join('\n'));
  const defUp = phpUpstream(defVer);
  const upOf = (s) => (phpPorts[phpOfSite(s)] && phpPorts[phpOfSite(s)].length ? phpUpstream(phpOfSite(s)) : defUp);
  const parts = [
    'worker_processes 1;',
    'events { worker_connections 1024; }',
    'http {',
    '  include mime.types;',
    '  default_type application/octet-stream;',
    '  sendfile on;',
    '  client_max_body_size 128m;',
    '  server_names_hash_bucket_size 64;',
    ...upstreams,
    nginxServer('localhost', WWW_DIR, defUp, true, webPort, false, toolLocations(defUp)),
    ...sites.map((s) => nginxServer(s.domain, s.root, upOf(s), false, webPort, !!s.system)),
    '}',
    '',
  ];
  fs.writeFileSync(path.join(svc.dir, 'conf', 'nginx.conf'), parts.join('\n'));
}

const SERVICES = {
  php: makeService('php', 'PHP', PHP_URL, 'php', 'php-cgi.exe', {
    version: '8.5.12',
    needsVC: true,
    afterExtract: setupPhpIni,
  }),
  mysql: makeService('mysql', 'MySQL', MYSQL_URL, 'mysql', path.join('bin', 'mysqld.exe'), {
    version: '8.4.13',
    needsVC: true,
  }),
  postgres: makeService('postgres', 'PostgreSQL', POSTGRES_URL, 'pgsql', path.join('bin', 'postgres.exe'), {
    version: '18.6',
    needsVC: true,
  }),
  phpmyadmin: makeService('phpmyadmin', 'phpMyAdmin', PMA_URL, 'phpmyadmin', 'index.php', {
    version: '5.2.3',
    afterExtract: (dir) => fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true }),
  }),
  apache: makeService('apache', 'Apache', APACHE_URL, 'Apache24', path.join('bin', 'httpd.exe'), {
    version: '2.4.70',
    needsVC: true,
    usesPHP: true,
    phpViaCgi: true,
    vhosts: true,
    reloadArgs: ['-k', 'restart'],
    afterExtract: (dir) => {
      const confPath = path.join(dir, 'conf', 'httpd.conf');
      let conf = fs.readFileSync(confPath, 'utf8');
      const root = dir.replace(/\\/g, '/');
      conf = conf.replace(/Define SRVROOT ".*"/, `Define SRVROOT "${root}"`);
      fs.writeFileSync(confPath, conf);
    },
    // পোর্ট বদলানো: Listen ও ServerName লাইন ঠিক করা
    beforeStart: (svc, phpPorts, sites, webPort) => {
      const confPath = path.join(svc.dir, 'conf', 'httpd.conf');
      let conf = fs.readFileSync(confPath, 'utf8');
      conf = conf.replace(/Define SRVROOT ".*"/, `Define SRVROOT "${svc.dir.replace(/\\/g, '/')}"`);
      conf = conf.replace(/^Listen\s+\S+/m, `Listen ${webPort}`);
      conf = conf.replace(/^#?ServerName\s.*$/m, `ServerName localhost:${webPort}`);
      fs.writeFileSync(confPath, conf);
      writeApacheConf(svc, phpPorts, sites, webPort);
    },
  }),
  nginx: makeService('nginx', 'Nginx', NGINX_URL, 'nginx', 'nginx.exe', {
    version: '1.30.6',
    usesPHP: true,
    vhosts: true,
    afterExtract: (dir) => {
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'temp'), { recursive: true });
    },
    beforeStart: writeNginxConf,
    args: (dir) => ['-p', dir.replace(/\\/g, '/') + '/'],
  }),
};

// ---------- Virtual host (blog.test) ----------
const TLD = 'test';
const HOSTS_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
const HOSTS_BEGIN = '# my-laragon begin';
const HOSTS_END = '# my-laragon end';

// www ফোল্ডারের প্রতিটা সাবফোল্ডার একটা সাইট। ভেতরে public ফোল্ডার থাকলে (Laravel) সেটাই root।
function scanSites() {
  let entries = [];
  try {
    entries = fs.readdirSync(WWW_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const sites = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const name = e.name.toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) continue; // ডোমেইনে চলে না এমন নাম বাদ
    const dir = path.join(WWW_DIR, e.name);
    const pub = path.join(dir, 'public');
    const hasPublic = fs.existsSync(pub) && fs.statSync(pub).isDirectory();
    sites.push({ name, domain: `${name}.${TLD}`, root: hasPublic ? pub : dir });
  }
  return sites;
}

// ---------- Adminer (ব্রাউজারে ডাটাবেস দেখার টুল) ----------
const ADMINER_DOMAIN = `adminer.${TLD}`;
const adminerInstalled = () => fs.existsSync(path.join(ADMINER_DIR, 'adminer.php'));

// index.php: পাসওয়ার্ড-ফাঁকা (root / postgres) ডাটাবেসে ঢোকার অনুমতি দেয়, কিন্তু শুধু localhost থেকে
const ADMINER_INDEX = `<?php
if (!in_array($_SERVER['REMOTE_ADDR'] ?? '', ['127.0.0.1', '::1'], true)) {
  http_response_code(403);
  exit('Forbidden');
}
function adminer_object() {
  $base = class_exists('Adminer\\\\Adminer') ? 'Adminer\\\\Adminer' : 'Adminer';
  eval('class MyLaragonAdminer extends ' . $base . ' { function login($login, $password) { return true; } }');
  return new MyLaragonAdminer;
}
include __DIR__ . '/adminer.php';
`;

async function ensureAdminer() {
  fs.mkdirSync(ADMINER_DIR, { recursive: true });
  const file = path.join(ADMINER_DIR, 'adminer.php');
  if (!fs.existsSync(file)) {
    sendStatus(tr('Adminer ডাউনলোড হচ্ছে...', 'Downloading Adminer...'));
    const part = file + '.part';
    await download(ADMINER_URL, part, tr('Adminer ডাউনলোড হচ্ছে', 'Downloading Adminer'));
    fs.renameSync(part, file);
  }
  fs.writeFileSync(path.join(ADMINER_DIR, 'index.php'), ADMINER_INDEX);
}

// ---------- phpMyAdmin (শুধু MySQL) ----------
const PMA_DOMAIN = `phpmyadmin.${TLD}`;
const pmaInstalled = () => fs.existsSync(SERVICES.phpmyadmin.exe);

// config.inc.php: root হিসেবে নিজে থেকে লগইন (পাসওয়ার্ড ফাঁকা)। পোর্ট বদলালে আবার লেখা হয়।
function writePmaConfig() {
  const dir = SERVICES.phpmyadmin.dir;
  if (!settings.pmaSecret) {
    settings.pmaSecret = crypto.randomBytes(16).toString('hex'); // ৩২ অক্ষর
    saveSettings(settings);
  }
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  const f = (p) => p.replace(/\\/g, '/');
  const cfg = [
    '<?php',
    `$cfg['blowfish_secret'] = '${settings.pmaSecret}';`,
    `$cfg['TempDir'] = '${f(path.join(dir, 'tmp'))}';`,
    '$i = 1;',
    `$cfg['Servers'][$i]['auth_type'] = 'config';`,
    `$cfg['Servers'][$i]['host'] = '127.0.0.1';`,
    `$cfg['Servers'][$i]['port'] = '${getDbPort('mysql')}';`,
    `$cfg['Servers'][$i]['user'] = 'root';`,
    `$cfg['Servers'][$i]['password'] = '';`,
    `$cfg['Servers'][$i]['AllowNoPassword'] = true;`,
    `$cfg['VersionCheck'] = false;`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'config.inc.php'), cfg);
}

async function ensurePhpMyAdmin() {
  await ensureService(SERVICES.phpmyadmin);
  writePmaConfig();
}

// ব্যবহারকারীর সাইটের সাথে adminer.test ও phpmyadmin.test যোগ করা
// (www-তে একই নামের ফোল্ডার থাকলে সেটাই অগ্রাধিকার পাবে)
function withToolSites(sites) {
  const extra = [];
  if (adminerInstalled()) extra.push({ name: 'adminer', domain: ADMINER_DOMAIN, root: ADMINER_DIR, system: true });
  if (pmaInstalled()) extra.push({ name: 'phpmyadmin', domain: PMA_DOMAIN, root: SERVICES.phpmyadmin.dir, system: true });
  return [...sites, ...extra.filter((e) => !sites.some((s) => s.domain === e.domain))];
}

function readHosts() {
  try {
    return fs.readFileSync(HOSTS_PATH, 'utf8');
  } catch {
    return '';
  }
}

function buildHostsContent(sites) {
  const stripped = readHosts()
    .replace(/\r?\n?# my-laragon begin[\s\S]*?# my-laragon end\r?\n?/g, '\r\n')
    .trimEnd();
  if (!sites.length) return stripped + '\r\n';
  const lines = [HOSTS_BEGIN, ...sites.map((s) => `127.0.0.1 ${s.domain}`), HOSTS_END];
  return stripped + '\r\n\r\n' + lines.join('\r\n') + '\r\n';
}

const normText = (t) => t.replace(/\r\n/g, '\n').trim();

// hosts ফাইলে শুধু আমাদের ব্লকটা বদলানো। পড়তে অনুমতি লাগে না, লিখতে Administrator (UAC) লাগে।
// বদল না থাকলে UAC পপআপ আসে না।
async function syncHosts(sites) {
  const next = buildHostsContent(sites);
  if (normText(readHosts()) === normText(next)) return { ok: true, changed: false };

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const src = path.join(TOOLS_DIR, 'hosts.new');
  const ps1 = path.join(TOOLS_DIR, 'apply-hosts.ps1');
  const q = (t) => t.replace(/'/g, "''");
  fs.writeFileSync(src, next, 'utf8');
  fs.writeFileSync(
    ps1,
    '\ufeff' + `Copy-Item -Force -LiteralPath '${q(src)}' -Destination '${q(HOSTS_PATH)}'\r\n`,
    'utf8'
  );

  sendStatus(tr('hosts ফাইল আপডেটের জন্য Administrator অনুমতি লাগবে (Yes চাপুন)...', 'Administrator permission is needed to update the hosts file (click Yes)...'));
  await new Promise((resolve) =>
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','"${q(ps1)}"'`,
      ],
      () => resolve()
    )
  );

  return { ok: normText(readHosts()) === normText(next), changed: true };
}

let win = null;
let running = null; // { id, procs: [...] } — একসময়ে একটাই সার্ভার চলবে (পোর্ট ৮০)
let busy = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 700,
    minWidth: 900,
    minHeight: 580,
    title: 'Server 360',
    backgroundColor: '#0f172a',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
}

function sendStatus(msg) {
  if (win) win.webContents.send('status', msg);
}

function killTree(pid) {
  exec(`taskkill /pid ${pid} /t /f`);
}

// আগের বার বন্ধ না হওয়া (লুকিয়ে চলা) nginx / php-cgi প্রসেস মেরে ফেলা।
// শুধু আমাদের tools ফোল্ডারের প্রসেসই মারা হয়, অন্য প্রোগ্রামের নয়।
// (Windows-এ দুটো nginx একই পোর্ট ৮০ নিতে পারে, তখন পুরনোটাই সাড়া দেয়)
function killStale(names = 'nginx,php-cgi,httpd') {
  const base = TOOLS_DIR.replace(/'/g, "''");
  const cmd =
    `powershell -NoProfile -Command "Get-Process ${names} -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -like '${base}*' } | Stop-Process -Force"`;
  return new Promise((resolve) => exec(cmd, () => setTimeout(resolve, 500)));
}

// ফাইল ডাউনলোড (রিডাইরেক্ট সহ)
function download(url, dest, label = tr('ডাউনলোড হচ্ছে', 'Downloading')) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          return download(next, dest, label).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(tr('ডাউনলোড ব্যর্থ, কোড: ', 'Download failed, code: ') + res.statusCode));
        }

        const partPath = dest + '.part';
        const file = fs.createWriteStream(partPath);
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;

        res.on('data', (chunk) => {
          done += chunk.length;
          if (total) sendStatus(`${label}... ${Math.round((done / total) * 100)}%`);
        });
        res.pipe(file);
        file.on('finish', () =>
          file.close(() => {
            try {
              fs.renameSync(partPath, dest);
              resolve();
            } catch (e) {
              reject(e);
            }
          })
        );
        file.on('error', reject);
        res.on('error', reject);
        res.on('aborted', () => reject(new Error(tr('ডাউনলোড মাঝপথে থেমে গেছে', 'Download was interrupted'))));
      })
      .on('error', reject);
  });
}

// ---------- Visual C++ ----------
function isVCInstalled() {
  return new Promise((resolve) => {
    exec(
      'reg query "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64" /v Installed',
      (err, stdout) => resolve(!err && /0x1/.test(stdout))
    );
  });
}

function runInstaller(exePath, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(exePath, args);
    p.on('error', reject);
    p.on('exit', (code) => {
      if (code === 0 || code === 3010) resolve();
      else reject(new Error(tr('VC++ ইনস্টল ব্যর্থ, কোড: ', 'VC++ install failed, code: ') + code));
    });
  });
}

async function ensureVCRedist() {
  if (await isVCInstalled()) return;

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  sendStatus(tr('Visual C++ পাওয়া যায়নি, ডাউনলোড হচ্ছে...', 'Visual C++ not found, downloading...'));
  await download(VCREDIST_URL, VCREDIST_PATH, tr('Visual C++ ডাউনলোড হচ্ছে', 'Downloading Visual C++'));

  sendStatus(tr('Visual C++ ইনস্টল হচ্ছে (Yes চাপুন)...', 'Installing Visual C++ (click Yes)...'));
  await runInstaller(VCREDIST_PATH, ['/install', '/quiet', '/norestart']);
  fs.unlinkSync(VCREDIST_PATH);
}

// ---------- সার্ভিস ইনস্টল ----------
function findTopDir(parent) {
  const entry = fs.readdirSync(parent, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!entry) throw new Error(tr('zip-এর ভেতরে কোনো ফোল্ডার পাওয়া যায়নি', 'No folder found inside the zip'));
  return path.join(parent, entry.name);
}

// ZIP খোলা: আগে Windows-এর নিজস্ব tar.exe (দ্রুত ও নির্ভরযোগ্য), না হলে extract-zip।
// extract-zip বড় ZIP-এ (যেমন PostgreSQL) নীরবে আটকে যেতে পারে, তাই সময়সীমা দেওয়া আছে।
function extractWithTar(zipPath, dir) {
  return new Promise((resolve, reject) => {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (!fs.existsSync(tar)) return reject(new Error(tr('tar.exe পাওয়া যায়নি', 'tar.exe not found')));
    fs.mkdirSync(dir, { recursive: true });
    execFile(tar, ['-xf', zipPath, '-C', dir], { timeout: 15 * 60 * 1000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err, _o, stderr) => {
      if (err) reject(new Error('tar: ' + (String(stderr || '').trim().slice(-200) || err.message)));
      else resolve();
    });
  });
}
async function extractZipSafe(zipPath, dir) {
  try {
    await extractWithTar(zipPath, dir);
    return;
  } catch (e) {
    sendStatus(tr('tar দিয়ে হয়নি, অন্য পদ্ধতিতে খোলা হচ্ছে...', 'tar failed, trying another method...'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error(tr('ZIP খুলতে অনেক সময় লাগছে (আটকে গেছে)। ', 'Extracting the ZIP is taking too long (stuck). ') + path.basename(zipPath) + tr(' ফাইলটা নষ্ট হতে পারে, মুছে আবার চেষ্টা করুন', ' may be corrupted, delete it and try again'))), 10 * 60 * 1000);
  });
  try {
    await Promise.race([extract(zipPath, { dir }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// zip (ডাউনলোড করে বা পিসির ফাইল থেকে) খুলে destDir-এ বসানো। ভুল zip হলে exe না পেয়ে এরর দেয়।
async function installInto(svc, destDir, { url, zipFile } = {}) {
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const name = path.basename(destDir);
  const zipPath = zipFile || path.join(TOOLS_DIR, name + '.zip');
  const tmpDir = path.join(TOOLS_DIR, '_tmp_' + name);

  if (!zipFile) {
    if (fs.existsSync(zipPath)) {
      sendStatus(tr(`${svc.label}-এর ZIP আগেই নামানো আছে, সরাসরি খোলা হচ্ছে...`, `${svc.label} ZIP is already downloaded, extracting directly...`));
    } else {
      if (!url) throw new Error(tr(`${svc.label}-এর এই ভার্সনের ফাইল নেই আর ডাউনলোড লিংকও নেই। "টুলস ও ভার্সন" পেজ থেকে আবার যোগ করুন`, `The files for this ${svc.label} version are missing and there is no download link. Add it again from the "Tools & Versions" page`));
      sendStatus(tr(`${svc.label} পাওয়া যায়নি, ডাউনলোড শুরু হচ্ছে...`, `${svc.label} not found, starting download...`));
      await download(url, zipPath, tr(`${svc.label} ডাউনলোড হচ্ছে`, `Downloading ${svc.label}`));
    }
  }

  sendStatus(tr('ফাইল খোলা হচ্ছে (বড় ফাইলে কিছুক্ষণ লাগে)...', 'Extracting files (large files take a while)...'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await extractZipSafe(zipPath, tmpDir);

  // exe সরাসরি উপরে থাকলে (যেমন PHP) ওটাই আসল ফোল্ডার,
  // নাহলে ভেতরের প্রথম ফোল্ডারটা (যেমন nginx-1.30.6, Apache24)
  let source;
  try {
    source = fs.existsSync(path.join(tmpDir, svc.exeRel)) ? tmpDir : findTopDir(tmpDir);
    if (!fs.existsSync(path.join(source, svc.exeRel))) {
      throw new Error(tr(`এটা সঠিক ${svc.label} ZIP নয় (${svc.exeRel} পাওয়া যায়নি)`, `This is not a valid ${svc.label} ZIP (${svc.exeRel} not found)`));
    }
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (!zipFile) fs.rmSync(zipPath, { force: true }); // ভুল ফাইল জমিয়ে না রাখা
    throw err;
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.renameSync(source, destDir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (!zipFile) fs.rmSync(zipPath, { force: true });

  if (svc.afterExtract) svc.afterExtract(destDir);
}

async function ensureService(svc) {
  if (fs.existsSync(svc.exe)) return;
  await installInto(svc, svc.dir, { url: svc.url });
  sendStatus(tr(`${svc.label} ইনস্টল সম্পন্ন`, `${svc.label} installed`));
}

// www ফোল্ডার ও টেস্ট ফাইল
function ensureWww() {
  fs.mkdirSync(WWW_DIR, { recursive: true });
  // ফোল্ডার একদম খালি হলেই টেস্ট ফাইল বানানো (ইউজারের নিজের ফোল্ডারে বাড়তি ফাইল ফেলব না)
  if (fs.readdirSync(WWW_DIR).length === 0) {
    fs.writeFileSync(path.join(WWW_DIR, 'index.php'), '<?php phpinfo();\n');
  }
}

// প্রসেস চালিয়ে ১.৫ সেকেন্ড দেখা: এর মধ্যে বন্ধ হয়ে গেলে ব্যর্থ
function spawnChecked(exe, args, options) {
  return new Promise((resolve) => {
    const proc = spawn(exe, args, { windowsHide: true, ...options });
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));
    proc.once('error', (e) => resolve({ proc, failed: e.message, output }));
    proc.once('exit', (code) => resolve({ proc, failed: tr(`বন্ধ হয়ে গেছে (কোড ${code})`, `exited (code ${code})`), output }));
    setTimeout(() => resolve({ proc, failed: null, output }), 1500);
  });
}

// ---------- ডাটাবেস (MySQL, PostgreSQL...) ----------
// নতুন ডাটাবেস (MariaDB, MongoDB...) যোগ করতে নিচের DATABASES-এ একটা এন্ট্রি বাড়ালেই হবে।

// MySQL-এর my.ini: ডাটা ফোল্ডার tools-এর বাইরে, যাতে নতুন করে নামালেও ডাটা না হারায়
function writeMysqlIni(svc, port) {
  fs.mkdirSync(path.dirname(mysqlIni()), { recursive: true });
  const f = (p) => p.replace(/\\/g, '/');
  const ini = [
    '[mysqld]',
    `basedir=${f(svc.dir)}`,
    `datadir=${f(mysqlDataDir())}`,
    `port=${port}`,
    'bind-address=127.0.0.1',
    'mysqlx=OFF',
    'character-set-server=utf8mb4',
    'max_allowed_packet=64M',
    '',
    '[client]',
    `port=${port}`,
    '',
  ].join('\n');
  fs.writeFileSync(mysqlIni(), ini);
}

// একটা টুল চালিয়ে শেষ হওয়া পর্যন্ত অপেক্ষা (ডাটাবেস প্রথমবার তৈরির জন্য)
function runTool(exe, args, cwd) {
  return new Promise((resolve, reject) =>
    execFile(exe, args, { cwd, timeout: 300000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || stdout || err.message).trim().slice(-300)));
      else resolve();
    })
  );
}

function tcpCheck(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('error', () => {
      sock.destroy();
      resolve(false);
    });
  });
}

const DATABASES = {
  mysql: {
    id: 'mysql',
    label: 'MySQL',
    svcId: 'mysql',
    portKey: 'mysqlPort',
    defaultPort: 3306,
    autoDefault: true,
    stale: 'mysqld',
    get dataDir() {
      return mysqlDataDir();
    },
    get info() {
      return tr('হোস্ট: 127.0.0.1 · ইউজার: root · পাসওয়ার্ড: ফাঁকা', 'Host: 127.0.0.1 · User: root · Password: empty');
    },
    prepare: (svc, port) => writeMysqlIni(svc, port),
    isInitialized: () => fs.existsSync(path.join(mysqlDataDir(), 'mysql')),
    // root-এর পাসওয়ার্ড ফাঁকা (Laragon-এর মতো)
    init: (svc) => runTool(svc.exe, [`--defaults-file=${mysqlIni()}`, '--initialize-insecure', '--console'], svc.dir),
    spawnArgs: () => [`--defaults-file=${mysqlIni()}`, '--console'],
    check: (svc, port) => tcpCheck(port),
    shutdownCmd: (svc, port) => ({
      exe: path.join(svc.dir, 'bin', 'mysqladmin.exe'),
      args: ['--no-defaults', '-u', 'root', '--protocol=tcp', '-h', '127.0.0.1', `--port=${port}`, 'shutdown'],
    }),
  },
  postgres: {
    id: 'postgres',
    label: 'PostgreSQL',
    svcId: 'postgres',
    portKey: 'postgresPort',
    defaultPort: 5432,
    autoDefault: false,
    stale: 'postgres',
    get dataDir() {
      return pgDataDir();
    },
    get info() {
      return tr('হোস্ট: 127.0.0.1 · ইউজার: postgres · পাসওয়ার্ড: ফাঁকা', 'Host: 127.0.0.1 · User: postgres · Password: empty');
    },
    prepare: () => fs.mkdirSync(path.dirname(pgDataDir()), { recursive: true }),
    isInitialized: () => fs.existsSync(path.join(pgDataDir(), 'PG_VERSION')),
    // শুধু নিজের কম্পিউটার থেকে ঢোকা যায় (trust), পাসওয়ার্ড লাগে না
    init: (svc) =>
      runTool(
        path.join(svc.dir, 'bin', 'initdb.exe'),
        ['-D', pgDataDir(), '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'],
        svc.dir
      ),
    spawnArgs: (svc, port) => ['-D', pgDataDir(), '-p', String(port), '-c', 'listen_addresses=127.0.0.1'],
    check: (svc, port) =>
      new Promise((resolve) =>
        execFile(
          path.join(svc.dir, 'bin', 'pg_isready.exe'),
          ['-h', '127.0.0.1', '-p', String(port)],
          { timeout: 5000, windowsHide: true },
          (err) => resolve(!err)
        )
      ),
    shutdownCmd: (svc) => ({
      exe: path.join(svc.dir, 'bin', 'pg_ctl.exe'),
      args: ['stop', '-D', pgDataDir(), '-m', 'fast', '-w', '-t', '20'],
    }),
  },
};

// চালু থাকা ডাটাবেস: { mysql: { proc, port }, ... }
const dbRun = {};

// প্রসেসের পোর্ট সাড়া দেওয়া পর্যন্ত অপেক্ষা (প্রসেস বন্ধ হয়ে গেলে ব্যর্থ)
async function waitDbReady(db, svc, port, proc, timeoutMs = 90000) {
  let exited = null;
  proc.once('exit', (code) => (exited = code === null ? tr('অজানা', 'unknown') : code));
  proc.once('error', (e) => (exited = e.message));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exited !== null) return { ok: false, reason: tr(`বন্ধ হয়ে গেছে (কোড ${exited})`, `exited (code ${exited})`) };
    if (await db.check(svc, port)) return { ok: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: tr('সময় শেষ হয়ে গেছে', 'timed out') };
}

async function startDatabase(id) {
  const db = DATABASES[id];
  if (!db) return tr('সমস্যা: অজানা ডাটাবেস', 'Error: unknown database');
  const svc = SERVICES[db.svcId];
  if (busy) return tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...');
  if (dbRun[id]) return tr(`${db.label} আগে থেকেই চলছে`, `${db.label} is already running`);

  busy = true;
  try {
    await ensureVCRedist();
    await ensureService(svc);
    await killStale(db.stale);

    const port = getDbPort(id);
    if (!(await isPortFree(port))) {
      return tr(`সমস্যা: ${db.label}-এর পোর্ট ${port} অন্য কেউ ব্যবহার করছে (আসল ${db.label} বা Laragon হতে পারে)। ওই ডাটাবেসের পোর্ট ঘরে অন্য সংখ্যা দিন।`, `Error: ${db.label} port ${port} is used by something else (maybe a real ${db.label} or Laragon). Enter a different number in that database's port field.`);
    }

    db.prepare(svc, port);
    if (!db.isInitialized()) {
      sendStatus(tr(`${db.label} ডাটাবেস প্রথমবার তৈরি হচ্ছে (১-২ মিনিট লাগতে পারে)...`, `Creating the ${db.label} database for the first time (may take 1-2 minutes)...`));
      try {
        await db.init(svc, port);
      } catch (err) {
        fs.rmSync(db.dataDir, { recursive: true, force: true }); // আধা-তৈরি ডাটা মুছে যাতে আবার চেষ্টা করা যায়
        throw new Error(tr(`${db.label} সেটআপ ব্যর্থ: ${err.message}`, `${db.label} setup failed: ${err.message}`));
      }
    }

    sendStatus(tr(`${db.label} চালু হচ্ছে...`, `Starting ${db.label}...`));
    const proc = spawn(svc.exe, db.spawnArgs(svc, port), { cwd: svc.dir, windowsHide: true });
    let out = '';
    const collect = (d) => (out = (out + d).slice(-2000));
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    const r = await waitDbReady(db, svc, port, proc);
    if (!r.ok) {
      killTree(proc.pid);
      return tr(`সমস্যা: ${db.label} চালু হয়নি, ${r.reason}. ${out.trim().slice(-300)}`, `Error: ${db.label} failed to start, ${r.reason}. ${out.trim().slice(-300)}`);
    }

    dbRun[id] = { proc, port };
    proc.on('exit', () => {
      if (dbRun[id] && dbRun[id].proc === proc) delete dbRun[id];
    });
    return tr(`${db.label} চালু হয়েছে (পোর্ট ${port})। ${db.info}`, `${db.label} started (port ${port}). ${db.info}`);
  } catch (err) {
    return tr('সমস্যা: ', 'Error: ') + err.message;
  } finally {
    busy = false;
  }
}

async function stopDatabase(id) {
  const db = DATABASES[id];
  const run = dbRun[id];
  if (!db || !run) return tr(`${db ? db.label : 'ডাটাবেস'} চলছে না`, `${db ? db.label : 'Database'} is not running`);
  const svc = SERVICES[db.svcId];
  sendStatus(tr(`${db.label} নিরাপদে বন্ধ হচ্ছে...`, `Stopping ${db.label} safely...`));

  // আগে নিয়ম মেনে shutdown, না হলে (যেমন পাসওয়ার্ড দেওয়া থাকলে) জোর করে বন্ধ
  const cmd = db.shutdownCmd(svc, run.port);
  await new Promise((resolve) =>
    execFile(cmd.exe, cmd.args, { timeout: 30000, windowsHide: true }, () => resolve())
  );
  await new Promise((resolve) => {
    if (run.proc.exitCode !== null) return resolve();
    const t = setTimeout(resolve, 10000);
    run.proc.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  if (run.proc.exitCode === null) killTree(run.proc.pid);
  delete dbRun[id];
  return tr(`${db.label} বন্ধ হয়েছে`, `${db.label} stopped`);
}

// যে ভার্সনের php-cgi এখনো চলছে না, সেগুলো চালু করা। প্রতিটা ভার্সনে কয়েকটা worker চলে (phpWorkerCount)।
// ports: ভার্সন -> [পোর্ট, ...], procs: চলমান প্রসেসের তালিকা
async function startPhpCgis(versions, ports, procs) {
  for (const v of versions) {
    if (ports[v] && ports[v].length) continue;
    const dir = phpDirOf(v);
    refreshPhpIni(dir);
    const used = new Set(Object.values(ports).flat());
    const mine = [];
    for (let i = 0; i < phpWorkerCount(); i++) {
      let port = await getFreePort();
      while (used.has(port)) port = await getFreePort();
      used.add(port);
      mine.push(port);
    }
    // worker-গুলো একসাথে চালু (প্রতিটা ১.৫ সেকেন্ড টিকতে হয়, তাই পরপর চালালে দেরি হতো)
    const results = await Promise.all(
      mine.map((port) =>
        spawnChecked(path.join(dir, 'php-cgi.exe'), ['-b', `127.0.0.1:${port}`], {
          cwd: dir,
          env: { ...process.env, PHP_FCGI_MAX_REQUESTS: '0', PHPRC: dir },
        })
      )
    );
    // যেগুলো চালু হয়েছে সেগুলো আগে procs-এ রাখি, যাতে ব্যর্থ হলে abort() সবগুলো মেরে দেয়
    results.forEach((r) => {
      if (!r.failed) procs.push(r.proc);
    });
    const bad = results.find((r) => r.failed);
    if (bad) throw new Error(tr(`PHP ${v} চালু হয়নি, ${bad.failed}. `, `PHP ${v} failed to start, ${bad.failed}. `) + bad.output.trim().slice(0, 200));
    ports[v] = mine;
  }
}

// চলমান ওয়েব সার্ভারে নতুন সাইট/PHP ভার্সনের কনফিগ লোড করা
async function reloadRunning(sites) {
  const svc = running && SERVICES[running.id];
  if (!svc || !svc.vhosts) return false;
  if (svc.usesPHP && !svc.phpViaCgi) await startPhpCgis(neededPhpVersions(sites), running.phpPorts, running.procs);
  svc.beforeStart(svc, running.phpPorts, sites, running.webPort);
  await new Promise((resolve) => execFile(svc.exe, [...svc.args(svc.dir), ...svc.reloadArgs], { cwd: svc.dir }, () => resolve()));
  return true;
}

// ---------- IPC ----------
async function startWebServer(id) {
  const svc = SERVICES[id];
  if (!svc || !['apache', 'nginx'].includes(id)) return tr('সমস্যা: অজানা সার্ভার', 'Error: unknown server');
  if (busy) return tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...');
  if (running) {
    return running.id === id
      ? tr(`${svc.label} আগে থেকেই চলছে`, `${svc.label} is already running`)
      : tr(`আগে ${SERVICES[running.id].label} বন্ধ করুন (দুটো একসাথে পোর্ট ৮০ নিতে পারে না)`, `Stop ${SERVICES[running.id].label} first (two servers cannot share the same port)`);
  }

  busy = true;
  const procs = [];
  const abort = () => procs.forEach((p) => killTree(p.pid));
  try {
    if (svc.needsVC || svc.usesPHP) await ensureVCRedist();
    if (svc.usesPHP) {
      await ensureService(SERVICES.php);
      refreshPhpIni();
    }
    await ensureService(svc);
    ensureWww();
    await killStale();

    const webPort = getWebPort();
    if (!(await isPortFree(webPort))) {
      return tr(`সমস্যা: পোর্ট ${webPort} অন্য কেউ ব্যবহার করছে (IIS, Skype বা আসল Laragon হতে পারে)। নিচের "পোর্ট" ঘরে অন্য সংখ্যা দিন, যেমন 8080।`, `Error: port ${webPort} is used by something else (IIS, Skype or a real Laragon, maybe). Enter a different number in the "Port" field, e.g. 8080.`);
    }
    const phpPorts = {}; // PHP ভার্সন -> php-cgi পোর্টের তালিকা (শুধু Nginx-এ)
    let sites = [];
    let hostsNote = '';
    if (svc.vhosts) {
      try {
        await ensureAdminer();
      } catch (err) {
        hostsNote += tr(` ⚠ Adminer নামানো যায়নি (${err.message})।`, ` ⚠ Could not download Adminer (${err.message}).`);
      }
      try {
        await ensurePhpMyAdmin();
      } catch (err) {
        hostsNote += tr(` ⚠ phpMyAdmin নামানো যায়নি (${err.message})।`, ` ⚠ Could not download phpMyAdmin (${err.message}).`);
      }
      sites = withToolSites(scanSites());
      const h = await syncHosts(sites);
      if (!h.ok) hostsNote += tr(' ⚠ hosts ফাইল আপডেট হয়নি (Administrator অনুমতি দিন), তাই শুধু localhost কাজ করবে।', ' ⚠ The hosts file was not updated (allow Administrator access), so only localhost will work.');
    }
    // Nginx-এর জন্য আগে দরকারি প্রতিটা PHP ভার্সনের php-cgi চালু করা (Apache নিজেই প্রতি রিকোয়েস্টে php-cgi চালায়)
    if (svc.usesPHP && !svc.phpViaCgi) await startPhpCgis(neededPhpVersions(sites), phpPorts, procs);
    if (svc.beforeStart) svc.beforeStart(svc, phpPorts, sites, webPort);

    const r = await spawnChecked(svc.exe, svc.args(svc.dir), { cwd: svc.dir });
    if (r.failed) {
      abort();
      const logPath = path.join(svc.dir, 'logs', 'error.log');
      return tr(`সমস্যা: ${svc.label} চালু হয়নি, ${r.failed}. ${r.output.trim().slice(0, 200)} লগ: ${logPath}`, `Error: ${svc.label} failed to start, ${r.failed}. ${r.output.trim().slice(0, 200)} Log: ${logPath}`);
    }
    procs.push(r.proc);

    running = { id, procs, phpPorts, webPort };
    r.proc.on('exit', () => {
      if (running && running.procs.includes(r.proc)) {
        abort();
        running = null;
      }
    });
    const nSites = sites.filter((x) => !x.system).length;
    return tr(
      `${svc.label} চালু হয়েছে${svc.usesPHP ? ' (PHP সহ)' : ''}${svc.vhosts ? `, ${nSites}টা সাইট` : ''}। খুলুন: ${siteUrl('localhost')}${hostsNote}`,
      `${svc.label} started${svc.usesPHP ? ' (with PHP)' : ''}${svc.vhosts ? `, ${nSites} site(s)` : ''}. Open: ${siteUrl('localhost')}${hostsNote}`
    );
  } catch (err) {
    abort();
    return tr('সমস্যা: ', 'Error: ') + err.message;
  } finally {
    busy = false;
  }
}

ipcMain.handle('service:start', (_event, id) => startWebServer(id));
function stopWebServer() {
  if (!running) return tr('কোনো ওয়েব সার্ভার চলছে না', 'No web server is running');
  const { id, procs } = running;
  running = null;
  procs.forEach((p) => killTree(p.pid));
  return tr(`${SERVICES[id].label} বন্ধ হয়েছে`, `${SERVICES[id].label} stopped`);
}

ipcMain.handle('service:stop', () => stopWebServer());

ipcMain.handle('web:status', () => (running ? { id: running.id, port: running.webPort } : null));

// ---------- ইনস্টল ফোল্ডার (ROOT) ----------
const isInside = (parent, child) => {
  const r = path.relative(path.resolve(parent), path.resolve(child));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};
const ROOT_PARTS = ['tools', 'data'];

// পুরনো ROOT থেকে নতুন ফোল্ডারে tools ও data কপি করে সুইচ করা; সফল হলে পুরনোগুলো মোছা হয়
async function moveRoot(target) {
  const from = ROOT_DIR;
  const to = path.resolve(target);
  if (path.resolve(from).toLowerCase() === to.toLowerCase()) {
    return { ok: false, path: from, message: tr('এটাই এখনকার ইনস্টল ফোল্ডার', 'This is already the current install folder') };
  }
  if (isInside(from, to) || isInside(to, from)) {
    return { ok: false, path: from, message: tr('নতুন ফোল্ডার পুরনো ফোল্ডারের ভেতরে বা বাইরে (একটা আরেকটার অংশ) হতে পারবে না', 'The new folder cannot be inside or outside the old folder (one cannot contain the other)') };
  }
  busy = true;
  const copied = [];
  try {
    fs.mkdirSync(to, { recursive: true });
    const destHas = ROOT_PARTS.some((n) => fs.existsSync(path.join(to, n)));
    const srcParts = ROOT_PARTS.filter((n) => fs.existsSync(path.join(from, n)));
    if (!destHas) {
      for (const n of srcParts) {
        sendStatus(tr(`"${n}" ফোল্ডার নতুন জায়গায় কপি হচ্ছে (বড় ফাইলে কিছুক্ষণ লাগে)...`, `Copying "${n}" folder to the new location (large files take a while)...`));
        copied.push(n);
        await fs.promises.cp(path.join(from, n), path.join(to, n), { recursive: true });
      }
    }
    settings.rootDir = to;
    saveSettings(settings);
    applyRoot(to);
    let note = '';
    if (!destHas) {
      sendStatus(tr('পুরনো ফাইল মোছা হচ্ছে...', 'Deleting old files...'));
      for (const n of srcParts) {
        try {
          await fs.promises.rm(path.join(from, n), { recursive: true, force: true });
        } catch {
          note = tr(` (পুরনো জায়গার "${n}" ফোল্ডার মোছা যায়নি, নিজে মুছে দিন: ${from})`, ` (could not delete the old "${n}" folder, delete it yourself: ${from})`);
        }
      }
    }
    return { ok: true, path: to, message: tr(`ইনস্টল ফোল্ডার বদলে গেছে: ${to}${note}`, `Install folder changed: ${to}${note}`) };
  } catch (err) {
    // আধা-কপি হওয়া ফাইল সরিয়ে ফেলা, যাতে আবার চেষ্টা করা যায়
    for (const n of copied) fs.rmSync(path.join(to, n), { recursive: true, force: true });
    return { ok: false, path: ROOT_DIR, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
}

ipcMain.handle('root:get', () => ROOT_DIR);
ipcMain.handle('root:open', () => {
  fs.mkdirSync(ROOT_DIR, { recursive: true });
  return shell.openPath(ROOT_DIR);
});
ipcMain.handle('root:choose', async () => {
  if (busy) return { ok: false, path: ROOT_DIR, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  if (running || Object.keys(dbRun).length) {
    return { ok: false, path: ROOT_DIR, message: tr('আগে সব সার্ভার বন্ধ করুন (Stop All), তারপর ফোল্ডার বদলান', 'Stop all servers first (Stop All), then change the folder') };
  }
  const r = await dialog.showOpenDialog(win, {
    title: tr('ইনস্টল ফোল্ডার বেছে নিন (প্রোগ্রাম ও ডাটাবেস ডাটা এখানে থাকবে)', 'Choose the install folder (programs and database data will live here)'),
    defaultPath: ROOT_DIR,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, path: ROOT_DIR };
  const to = path.resolve(r.filePaths[0]);
  const destHas = ROOT_PARTS.some((n) => fs.existsSync(path.join(to, n)));
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: tr('ইনস্টল ফোল্ডার বদলানো', 'Change install folder'),
    message: tr(`ইনস্টল ফোল্ডার বদলে এখানে করবেন?\n${to}`, `Change the install folder to this?\n${to}`),
    detail: destHas
      ? tr('ওই ফোল্ডারে আগে থেকেই tools/data আছে। সেগুলোই ব্যবহার করা হবে, পুরনো জায়গার ফাইল মোছা হবে না।', 'That folder already has tools/data. They will be used, and the old files will not be deleted.')
      : tr('পুরনো জায়গার tools ও data (ডাটাবেস সহ) নতুন ফোল্ডারে সরানো হবে। বড় হলে কিছুক্ষণ লাগবে, এর মধ্যে অ্যাপ বন্ধ করবেন না।', 'The old tools and data (including databases) will be moved to the new folder. This may take a while for large data, so do not close the app.'),
    buttons: [tr('হ্যাঁ, বদলান', 'Yes, change'), tr('বাতিল', 'Cancel')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) return { ok: false, path: ROOT_DIR };
  return moveRoot(to);
});

// ---------- সাইট ----------
const siteUrl = (domain) => `http://${domain}${getWebPort() === 80 ? '' : ':' + getWebPort()}`;
const publicSites = (sites) => [
  { name: 'localhost', domain: 'localhost', root: WWW_DIR, system: false, url: siteUrl('localhost'), php: defaultPhpVersion(), phpPinned: '' },
  ...sites.map(({ name, domain, root, system }) => ({
    name,
    domain,
    root,
    system: !!system,
    url: siteUrl(domain),
    php: system ? defaultPhpVersion() : sitePhpVersion(domain),
    phpPinned: system ? '' : pinnedPhp(domain),
  })),
];

ipcMain.handle('sites:list', () => publicSites(withToolSites(scanSites())));

// সাইটের তালিকার ড্রপডাউনের জন্য: নামানো PHP ভার্সনগুলো ও ডিফল্ট
ipcMain.handle('php:list', () => ({
  def: defaultPhpVersion(),
  versions: phpVersionList().filter((v) => v.installed).map((v) => v.version),
}));

ipcMain.handle('sites:refresh', async () => {
  if (busy) return { sites: publicSites(withToolSites(scanSites())), message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  busy = true;
  try {
    const sites = withToolSites(scanSites());
    const h = await syncHosts(sites);
    const n = sites.filter((x) => !x.system).length;
    let message;
    if (await reloadRunning(sites)) {
      message = tr(`${n}টা সাইট লোড হয়েছে`, `${n} site(s) loaded`);
    } else {
      message = tr(`${n}টা সাইট পাওয়া গেছে (ওয়েব সার্ভার চালু করলে কাজ করবে)`, `${n} site(s) found (they will work once a web server is started)`);
    }
    if (!h.ok) message += tr(' ⚠ hosts আপডেট হয়নি (Administrator অনুমতি দিন)', ' ⚠ hosts file was not updated (allow Administrator access)');
    return { sites: publicSites(sites), message };
  } catch (err) {
    return { sites: publicSites(withToolSites(scanSites())), message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});


// ---------- নতুন সাইট: খালি / WordPress ----------
const WP_URL = 'https://wordpress.org/latest.zip';
const siteSlug = (n) => String(n || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');

async function installWordPress(dest, dbName) {
  if (!dbRun.mysql) throw new Error(tr('আগে MySQL চালু করুন (সার্ভিস পেজ)', 'Start MySQL first (Services page)'));
  const mysqlExe = path.join(SERVICES.mysql.dir, 'bin', 'mysql.exe');
  if (!fs.existsSync(mysqlExe)) throw new Error(tr('mysql.exe পাওয়া যায়নি', 'mysql.exe not found'));
  const port = getDbPort('mysql');
  // WordPress zip একবার নামিয়ে ক্যাশে রাখা (পরের বার আর নামাতে হবে না)
  const cacheDir = path.join(ROOT_DIR, 'data', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, 'wordpress-latest.zip');
  if (!fs.existsSync(zip)) await download(WP_URL, zip, tr('WordPress নামছে', 'Downloading WordPress'));
  const tmp = path.join(cacheDir, '_wp_tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  sendStatus(tr('WordPress খোলা হচ্ছে...', 'Extracting WordPress...'));
  try {
    await extractZipSafe(zip, tmp);
  } catch (e) {
    fs.rmSync(zip, { force: true }); // নষ্ট ক্যাশ ফেলে দিই, পরের বার আবার নামবে
    throw e;
  }
  const src = path.join(tmp, 'wordpress');
  if (!fs.existsSync(path.join(src, 'wp-config-sample.php'))) throw new Error(tr('WordPress zip ঠিক নেই', 'The WordPress zip looks wrong'));
  fs.cpSync(src, dest, { recursive: true });
  fs.rmSync(tmp, { recursive: true, force: true });
  // ডাটাবেস বানানো (root, খালি পাসওয়ার্ড)
  sendStatus(tr('ডাটাবেস বানানো হচ্ছে...', 'Creating database...'));
  await new Promise((resolve, reject) =>
    execFile(mysqlExe, ['-u', 'root', '-h', '127.0.0.1', '-P', String(port), '-e', `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`], { timeout: 30000, windowsHide: true }, (err, _o, stderr) =>
      err ? reject(new Error(tr('ডাটাবেস বানানো যায়নি: ', 'Could not create the database: ') + String(stderr || err.message).trim().slice(0, 200))) : resolve()
    )
  );
  // wp-config.php
  let cfg = fs.readFileSync(path.join(dest, 'wp-config-sample.php'), 'utf8');
  cfg = cfg
    .replace('database_name_here', dbName)
    .replace('username_here', 'root')
    .replace("'password_here'", "''")
    .replace("'localhost'", `'127.0.0.1:${port}'`)
    .replace(/define\(\s*'(AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT)',\s*'put your unique phrase here'\s*\);/g, (_m, k) => `define( '${k}', '${crypto.randomBytes(32).toString('hex')}' );`);
  fs.writeFileSync(path.join(dest, 'wp-config.php'), cfg);
}

ipcMain.handle('site:create', async (_event, kind, rawName) => {
  const fail = (m) => ({ ok: false, message: m });
  if (busy) return fail(tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...'));
  const name = siteSlug(rawName);
  if (!name) return fail(tr('সমস্যা: সাইটের নাম দিন (a-z, 0-9, -)', 'Error: enter a site name (a-z, 0-9, -)'));
  if (!['blank', 'wordpress'].includes(kind)) return fail(tr('সমস্যা: অজানা ধরন', 'Error: unknown type'));
  const dest = path.join(WWW_DIR, name);
  if (fs.existsSync(dest)) return fail(tr(`সমস্যা: ${name} নামে ফোল্ডার আগে থেকেই আছে`, `Error: a folder named ${name} already exists`));
  busy = true;
  try {
    fs.mkdirSync(WWW_DIR, { recursive: true });
    if (kind === 'blank') {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'index.php'), `<?php\necho '<h1>${name}.test</h1><p>PHP ' . PHP_VERSION . '</p>';\n`);
    } else {
      try {
        await installWordPress(dest, name.replace(/-/g, '_'));
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true }); // আধা-তৈরি ফোল্ডার রেখে যাব না
        throw e;
      }
    }
    const sites = withToolSites(scanSites());
    const h = await syncHosts(sites);
    const live = await reloadRunning(sites);
    let message = tr(`${name}.test তৈরি হয়েছে`, `${name}.test created`);
    if (!live) message += tr(' (ওয়েব সার্ভার চালু করলে কাজ করবে)', ' (it will work once a web server is started)');
    if (!h.ok) message += tr(' ⚠ hosts আপডেট হয়নি (Administrator অনুমতি দিন)', ' ⚠ hosts file was not updated (allow Administrator access)');
    if (kind === 'wordpress') message += tr('। ডাটাবেস: ' + name.replace(/-/g, '_') + ' (root, খালি পাসওয়ার্ড)', '. Database: ' + name.replace(/-/g, '_') + ' (root, empty password)');
    return { ok: true, message, url: live ? siteUrl(`${name}.test`) : '', sites: publicSites(sites) };
  } catch (err) {
    return fail(tr('সমস্যা: ', 'Error: ') + err.message);
  } finally {
    busy = false;
  }
});

// একটা সাইটের PHP ভার্সন বদলানো (version = '' মানে ডিফল্ট)
ipcMain.handle('site:setPhp', async (_event, domain, version) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const sites = withToolSites(scanSites());
  if (!sites.some((s) => s.domain === domain && !s.system)) {
    return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  }
  version = String(version || '');
  if (version && !phpVersionList().some((x) => x.version === version && x.installed)) {
    return { ok: false, message: tr(`সমস্যা: PHP ${version} নামানো নেই। আগে "টুলস ও ভার্সন" পেজ থেকে যোগ করুন`, `Error: PHP ${version} is not installed. Add it from the "Tools & Versions" page first`) };
  }
  busy = true;
  try {
    settings.sitePhp = { ...(settings.sitePhp || {}) };
    if (version) settings.sitePhp[domain] = version;
    else delete settings.sitePhp[domain];
    saveSettings(settings);
    const label = version ? `PHP ${version}` : tr(`ডিফল্ট PHP ${defaultPhpVersion()}`, `default PHP ${defaultPhpVersion()}`);
    const live = await reloadRunning(sites);
    return {
      ok: true,
      message: live
        ? tr(`${domain} এখন ${label} ব্যবহার করছে`, `${domain} now uses ${label}`)
        : tr(`${domain}-এর জন্য ${label} সেভ হয়েছে। সার্ভার চালু করলে কাজ করবে`, `${label} saved for ${domain}. It will apply when the server starts`),
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// ---------- ভাষা ----------
ipcMain.handle('lang:get', () => (settings.lang === 'en' ? 'en' : 'bn'));
ipcMain.handle('lang:set', (_event, lang) => {
  settings.lang = lang === 'en' ? 'en' : 'bn';
  saveSettings(settings);
  return settings.lang;
});

// ---------- পোর্ট ----------
ipcMain.handle('port:get', () => getWebPort());

// kind = 'web' অথবা ডাটাবেসের id (mysql, postgres...)
ipcMain.handle('port:set', (_event, kind, value) => {
  const db = DATABASES[kind];
  const label = db ? db.label : tr('ওয়েব', 'Web');
  const current = db ? getDbPort(kind) : getWebPort();
  if (db ? dbRun[kind] : running) {
    return { ok: false, port: current, message: tr('আগে সার্ভার বন্ধ করুন, তারপর পোর্ট বদলান', 'Stop the server first, then change the port') };
  }
  const p = validPort(value);
  if (!p) {
    return { ok: false, port: current, message: tr('পোর্ট ১ থেকে ৬৫৫৩৫-র মধ্যে একটা সংখ্যা হতে হবে', 'Port must be a number between 1 and 65535') };
  }
  const others = [kind === 'web' ? null : getWebPort(), ...Object.keys(DATABASES).filter((k) => k !== kind).map(getDbPort)];
  if (others.includes(p)) {
    return { ok: false, port: current, message: tr(`পোর্ট ${p} আরেকটা সার্ভিসে দেওয়া আছে, অন্য সংখ্যা দিন`, `Port ${p} is already assigned to another service, use a different number`) };
  }
  settings[db ? db.portKey : 'webPort'] = p;
  saveSettings(settings);
  return { ok: true, port: p, message: tr(`${label} পোর্ট ${p} সেভ হয়েছে।`, `${label} port ${p} saved.`) };
});

// ---------- ডাটাবেস চালু/বন্ধ ----------
const autoStartOf = (id) => (settings.autoStart && id in settings.autoStart ? !!settings.autoStart[id] : DATABASES[id].autoDefault);

ipcMain.handle('db:list', () =>
  Object.values(DATABASES).map((db) => ({
    id: db.id,
    label: db.label,
    port: getDbPort(db.id),
    running: !!dbRun[db.id],
    version: activeVersion(db.svcId).version,
    info: db.info,
    auto: autoStartOf(db.id),
  }))
);
ipcMain.handle('db:start', (_event, id) => startDatabase(id));
ipcMain.handle('db:stop', (_event, id) => stopDatabase(id));
ipcMain.handle('db:setAuto', (_event, id, on) => {
  if (!DATABASES[id]) return false;
  settings.autoStart = { ...(settings.autoStart || {}), [id]: !!on };
  saveSettings(settings);
  return true;
});

// ---------- Start All / Stop All ----------
// নির্বাচিত ওয়েব সার্ভার + "Start All-এ যুক্ত" টিক দেওয়া ডাটাবেসগুলো একসাথে চালু
ipcMain.handle('all:start', async (_event, webId) => {
  const lines = [await startWebServer(webId)];
  for (const id of Object.keys(DATABASES)) {
    if (autoStartOf(id)) lines.push(await startDatabase(id));
  }
  return lines.join('\n');
});

ipcMain.handle('all:stop', async () => {
  const lines = [];
  if (running) lines.push(stopWebServer());
  for (const id of Object.keys(DATABASES)) {
    if (dbRun[id]) lines.push(await stopDatabase(id));
  }
  return lines.length ? lines.join('\n') : tr('কিছুই চলছে না', 'Nothing is running');
});

// ---------- Adminer খোলা ----------
// kind = ডাটাবেসের id (mysql / postgres)। লগইন ফর্মে সার্ভার-পোর্ট ও ইউজার আগে থেকে বসানো থাকে।
ipcMain.handle('adminer:open', async (_event, kind) => {
  if (!running) {
    return tr('Adminer চালাতে আগে ওয়েব সার্ভার (Nginx বা Apache) চালু করুন (Start All বা Start)।', 'Start a web server (Nginx or Apache) first to use Adminer (Start All or Start).');
  }
  if (!adminerInstalled()) {
    return tr('Adminer এখনো নামানো হয়নি। ওয়েব সার্ভার একবার বন্ধ করে আবার চালু করুন।', 'Adminer has not been downloaded yet. Stop the web server and start it again.');
  }
  const db = DATABASES[kind];
  let query = '';
  if (db) {
    const server = encodeURIComponent(`127.0.0.1:${getDbPort(kind)}`);
    query = kind === 'postgres' ? `?pgsql=${server}&username=postgres` : `?server=${server}&username=root`;
  }
  await shell.openExternal(siteUrl(ADMINER_DOMAIN) + '/' + query);
  const warn = db && !dbRun[kind] ? tr(` (সতর্কতা: ${db.label} এখন চালু নেই, আগে Start করুন)`, ` (warning: ${db.label} is not running, start it first)`) : '';
  return tr(`Adminer ব্রাউজারে খোলা হয়েছে${warn}। লগইন ফর্মে শুধু "Login" চাপুন।`, `Adminer opened in the browser${warn}. Just click "Login" on the form.`);
});

// ---------- phpMyAdmin খোলা ----------
ipcMain.handle('pma:open', async () => {
  if (!running) {
    return tr('phpMyAdmin চালাতে আগে ওয়েব সার্ভার (Nginx বা Apache) চালু করুন (Start All বা Start)।', 'Start a web server (Nginx or Apache) first to use phpMyAdmin (Start All or Start).');
  }
  if (!pmaInstalled()) {
    return tr('phpMyAdmin এখনো নামানো হয়নি। ওয়েব সার্ভার একবার বন্ধ করে আবার চালু করুন।', 'phpMyAdmin has not been downloaded yet. Stop the web server and start it again.');
  }
  writePmaConfig(); // MySQL-এর পোর্ট বদলে থাকলে ঠিক করে নেওয়া
  await shell.openExternal(siteUrl(PMA_DOMAIN) + '/');
  const warn = dbRun.mysql ? '' : tr(' (সতর্কতা: MySQL এখন চালু নেই, আগে Start করুন)', ' (warning: MySQL is not running, start it first)');
  return tr(`phpMyAdmin ব্রাউজারে খোলা হয়েছে${warn}। নিজে থেকেই root হিসেবে লগইন হবে।`, `phpMyAdmin opened in the browser${warn}. It logs in as root automatically.`);
});

// শুধু localhost ও *.test লিংক খোলা যাবে
ipcMain.handle('open:url', (_event, url) => {
  if (/^http:\/\/(localhost|[a-z0-9-]+\.test)(:\d{1,5})?\/?$/.test(url)) return shell.openExternal(url);
});


// ---------- টুলস ও ভার্সন ----------
const TOOL_ORDER = ['php', 'nginx', 'apache', 'mysql', 'postgres', 'phpmyadmin'];
const TOOL_HELP = {
  php: 'https://windows.php.net/download/',
  nginx: 'https://nginx.org/en/download.html',
  apache: 'https://www.apachelounge.com/download/',
  mysql: 'https://dev.mysql.com/downloads/mysql/',
  postgres: 'https://www.enterprisedb.com/download-postgresql-binaries',
  phpmyadmin: 'https://www.phpmyadmin.net/downloads/',
};
const TOOL_HINT = {
  php: ['Thread Safe নয় এমন (NTS) x64 ZIP নামান', 'Download the Non-Thread-Safe (NTS) x64 ZIP'],
  nginx: ['Windows-এর ZIP নামান', 'Download the Windows ZIP'],
  apache: ['Win64 ZIP নামান (Apache Lounge)', 'Download the Win64 ZIP (Apache Lounge)'],
  mysql: ['"ZIP Archive" (Windows x64) নামান, MSI নয়', 'Download the "ZIP Archive" (Windows x64), not the MSI'],
  postgres: ['EDB-র "Windows x86-64" binaries ZIP নামান', 'Download the EDB "Windows x86-64" binaries ZIP'],
  phpmyadmin: ['all-languages.zip নামান', 'Download all-languages.zip'],
};
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,30}$/;
// কোনো টুল চলার সময় ভার্সন বদলানো যাবে না
const toolInUse = (id) => (id === 'mysql' || id === 'postgres' ? !!dbRun[id] : !!running);

ipcMain.handle('tools:list', () =>
  TOOL_ORDER.map((id) => {
    const svc = SERVICES[id];
    const def = TOOL_DEFAULTS[id];
    const act = activeVersion(id);
    const items = (settings.toolVersions && settings.toolVersions[id] && settings.toolVersions[id].items) || {};
    const all = [
      { version: def.version, folder: def.folder, isDefault: true, source: 'built-in' },
      ...Object.entries(items).map(([v, it]) => ({ version: v, folder: it.folder, isDefault: false, source: it.url ? 'url' : 'local' })),
    ];
    return {
      id,
      label: svc.label,
      hint: tr(...TOOL_HINT[id]),
      isDb: id === 'mysql' || id === 'postgres',
      active: act.version,
      inUse: toolInUse(id),
      versions: all.map((v) => ({
        ...v,
        active: v.version === act.version,
        installed: fs.existsSync(path.join(TOOLS_DIR, v.folder, svc.exeRel)),
      })),
    };
  })
);

ipcMain.handle('tools:help', (_event, id) => (TOOL_HELP[id] ? shell.openExternal(TOOL_HELP[id]) : undefined));

ipcMain.handle('tools:use', (_event, id, version) => {
  const def = TOOL_DEFAULTS[id];
  if (!def) return { ok: false, message: tr('সমস্যা: অজানা টুল', 'Error: unknown tool') };
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  if (toolInUse(id)) return { ok: false, message: tr(`আগে ${SERVICES[id].label} বন্ধ করুন (Stop), তারপর ভার্সন বদলান`, `Stop ${SERVICES[id].label} first (Stop), then change the version`) };
  const st = toolState(id);
  if (version !== def.version && !st.items[version]) return { ok: false, message: tr('সমস্যা: এই ভার্সন তালিকায় নেই', 'Error: this version is not in the list') };
  st.active = version === def.version ? null : version;
  saveSettings(settings);
  const installed = fs.existsSync(SERVICES[id].exe);
  return {
    ok: true,
    message: tr(
      `${SERVICES[id].label} এখন ${version} ভার্সন ব্যবহার করবে।${installed ? '' : ' (ফাইল এখনো নামানো নেই, Start চাপলে নামবে)'}`,
      `${SERVICES[id].label} will now use version ${version}.${installed ? '' : ' (files are not downloaded yet, they will download on Start)'}`
    ),
  };
});

ipcMain.handle('tools:add', async (_event, opts = {}) => {
  const { id, local } = opts;
  const def = TOOL_DEFAULTS[id];
  if (!def) return { ok: false, message: tr('সমস্যা: অজানা টুল', 'Error: unknown tool') };
  const svc = SERVICES[id];
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };

  let zipFile = null;
  let url = null;
  if (local) {
    const r = await dialog.showOpenDialog(win, {
      title: tr(`${svc.label}-এর ZIP ফাইল বেছে নিন`, `Choose the ${svc.label} ZIP file`),
      properties: ['openFile'],
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, cancelled: true, message: '' };
    zipFile = r.filePaths[0];
  } else {
    url = String(opts.url || '').trim();
    if (!/^https:\/\/\S+$/i.test(url)) return { ok: false, message: tr('সমস্যা: ZIP ফাইলের https লিংক দিন (যেমন https://.../php-8.4.10-nts-Win32-vs17-x64.zip)', 'Error: enter an https link to the ZIP file (e.g. https://.../php-8.4.10-nts-Win32-vs17-x64.zip)') };
  }

  let version = String(opts.version || '').trim();
  if (!version) {
    const m = /(\d+\.\d+(?:\.\d+)*)/.exec(path.basename(zipFile || url));
    if (m) version = m[1];
  }
  if (!VERSION_RE.test(version)) {
    return { ok: false, message: tr('সমস্যা: ভার্সন নম্বর দিন (শুধু অক্ষর, সংখ্যা, . - _ চলবে), যেমন 8.4.10', 'Error: enter a version number (only letters, digits, . - _ allowed), e.g. 8.4.10') };
  }
  const st = toolState(id);
  if (version === def.version || st.items[version]) return { ok: false, message: tr(`সমস্যা: ${svc.label} ${version} আগে থেকেই তালিকায় আছে`, `Error: ${svc.label} ${version} is already in the list`) };

  const folder = `${def.folder}-${version}`;
  const destDir = path.join(TOOLS_DIR, folder);
  busy = true;
  try {
    if (svc.needsVC) await ensureVCRedist();
    await installInto(svc, destDir, { url, zipFile });
    st.items[version] = { folder, url, added: new Date().toISOString() };
    saveSettings(settings);
    return { ok: true, version, message: tr(`${svc.label} ${version} যোগ হয়েছে। ব্যবহার করতে "ব্যবহার করুন" চাপুন।`, `${svc.label} ${version} added. Click "Use" to switch to it.`) };
  } catch (err) {
    fs.rmSync(destDir, { recursive: true, force: true });
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

ipcMain.handle('tools:remove', (_event, id, version) => {
  const def = TOOL_DEFAULTS[id];
  if (!def) return { ok: false, message: tr('সমস্যা: অজানা টুল', 'Error: unknown tool') };
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const st = toolState(id);
  const it = st.items[version];
  if (!it) return { ok: false, message: tr('সমস্যা: এই ভার্সন তালিকায় নেই (ডিফল্ট ভার্সন মোছা যায় না)', 'Error: this version is not in the list (the built-in version cannot be removed)') };
  if (activeVersion(id).version === version) return { ok: false, message: tr('চালু ভার্সন মোছা যায় না, আগে অন্য ভার্সনে যান', 'The active version cannot be removed, switch to another version first') };
  // চলমান সার্ভারের php-cgi ফাইল আটকে রাখতে পারে, তাই PHP মোছার আগে সার্ভার বন্ধ থাকতে হবে
  if (id === 'php' && running) {
    return { ok: false, message: tr('আগে ওয়েব সার্ভার বন্ধ করুন, তারপর PHP ভার্সন মুছুন', 'Stop the web server first, then remove a PHP version') };
  }
  fs.rmSync(path.join(TOOLS_DIR, it.folder), { recursive: true, force: true });
  delete st.items[version];
  // যে সাইটগুলো এই PHP ভার্সনে বাঁধা ছিল সেগুলো ডিফল্টে ফিরে যাবে
  let phpNote = '';
  if (id === 'php' && settings.sitePhp) {
    const moved = Object.keys(settings.sitePhp).filter((d) => settings.sitePhp[d] === version);
    moved.forEach((d) => delete settings.sitePhp[d]);
    if (moved.length) phpNote = tr(` (${moved.length}টা সাইট ডিফল্ট PHP-তে ফিরেছে)`, ` (${moved.length} site(s) went back to the default PHP)`);
  }
  saveSettings(settings);
  const dbNote = id === 'mysql' || id === 'postgres' ? tr(' (ওই ভার্সনের ডাটাবেস ডাটা data ফোল্ডারে রয়ে গেছে)', ' (that version\'s database data remains in the data folder)') : '';
  return { ok: true, message: tr(`${SERVICES[id].label} ${version} মুছে ফেলা হয়েছে${dbNote}${phpNote}`, `${SERVICES[id].label} ${version} removed${dbNote}${phpNote}`) };
});

// ---------- www ফোল্ডার ----------
ipcMain.handle('www:get', () => WWW_DIR);

ipcMain.handle('www:choose', async () => {
  if (running) {
    return { ok: false, path: WWW_DIR, message: tr('আগে সার্ভার বন্ধ করুন, তারপর ফোল্ডার বদলান', 'Stop the server first, then change the folder') };
  }
  const r = await dialog.showOpenDialog(win, {
    title: tr('ওয়েবসাইটের ফোল্ডার বেছে নিন', 'Choose the website folder'),
    defaultPath: WWW_DIR,
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, path: WWW_DIR };
  WWW_DIR = r.filePaths[0];
  settings.wwwDir = WWW_DIR;
  saveSettings(settings);
  return { ok: true, path: WWW_DIR };
});

ipcMain.handle('www:open', () => {
  fs.mkdirSync(WWW_DIR, { recursive: true });
  return shell.openPath(WWW_DIR);
});

// প্রথমবার চালালে www ফোল্ডার কোথায় হবে জিজ্ঞেস করা
// (async: window পুরো লোড হওয়ার পর দেখানো হয়, নাহলে window ফাঁকা থাকে)
async function askWwwFolderFirstRun() {
  // ধাপ ১: প্রোগ্রাম ও ডাটাবেসের ডাটা কোথায় থাকবে
  const first = await dialog.showMessageBox(win, {
    type: 'question',
    title: tr('ইনস্টল ফোল্ডার', 'Install folder'),
    message: tr('Apache, PHP, MySQL ইত্যাদি প্রোগ্রাম ও ডাটাবেসের ডাটা কোন ফোল্ডারে রাখবেন?', 'Which folder should hold programs (Apache, PHP, MySQL...) and database data?'),
    detail: tr(`ডিফল্ট: ${DEFAULT_ROOT}\n\nঅন্য ড্রাইভে (যেমন I:\\my-laragon-app) রাখতে চাইলে "অন্য ফোল্ডার" চাপুন। পরে সেটিংস থেকেও বদলানো যাবে।`, `Default: ${DEFAULT_ROOT}\n\nTo use another drive (e.g. I:\\my-laragon-app) choose "Other folder". You can change it later in Settings.`),
    buttons: [tr('ডিফল্ট রাখুন', 'Keep default'), tr('অন্য ফোল্ডার বেছে নিন', 'Choose another folder')],
    defaultId: 0,
    cancelId: 0,
  });
  if (first.response === 1) {
    const r = await dialog.showOpenDialog(win, {
      title: tr('ইনস্টল ফোল্ডার বেছে নিন', 'Choose the install folder'),
      defaultPath: DEFAULT_ROOT,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) {
      settings.rootDir = path.resolve(r.filePaths[0]); // এখনো কিছু নামানো হয়নি, তাই কপি লাগবে না
      applyRoot(settings.rootDir);
    }
  }
  win.webContents.send('root:changed', ROOT_DIR);

  // ধাপ ২: ওয়েবসাইটের ফাইল কোথায় থাকবে
  const suggested = settings.rootDir ? path.join(ROOT_DIR, 'www') : DEFAULT_WWW;
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: tr('ওয়েবসাইটের ফোল্ডার', 'Website folder'),
    message: tr('আপনার ওয়েবসাইটের ফাইল কোন ফোল্ডারে রাখবেন?', 'Which folder should hold your website files?'),
    detail: tr(`ডিফল্ট: ${suggested}\n\nপরে যেকোনো সময় বদলানো যাবে।`, `Default: ${suggested}\n\nYou can change it any time later.`),
    buttons: [tr('ডিফল্ট রাখুন', 'Keep default'), tr('অন্য ফোল্ডার বেছে নিন', 'Choose another folder')],
    defaultId: 0,
    cancelId: 0,
  });
  WWW_DIR = suggested;
  if (response === 1) {
    const r = await dialog.showOpenDialog(win, {
      title: tr('ওয়েবসাইটের ফোল্ডার বেছে নিন', 'Choose the website folder'),
      defaultPath: suggested,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) WWW_DIR = r.filePaths[0];
  }
  settings.wwwDir = WWW_DIR;
  saveSettings(settings);
  win.webContents.send('www:changed', WWW_DIR);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  if (!settings.wwwDir) {
    win.webContents.once('did-finish-load', () => askWwwFolderFirstRun());
  }
});

app.on('before-quit', () => {
  if (running) running.procs.forEach((p) => killTree(p.pid));
  // ডাটাবেসকে আগে নিয়ম মেনে বন্ধ করার চেষ্টা (ডাটা নিরাপদ রাখতে)
  for (const [id, run] of Object.entries(dbRun)) {
    const cmd = DATABASES[id].shutdownCmd(SERVICES[DATABASES[id].svcId], run.port);
    try {
      execFileSync(cmd.exe, cmd.args, { timeout: 15000, windowsHide: true });
    } catch {}
    killTree(run.proc.pid);
  }
});
