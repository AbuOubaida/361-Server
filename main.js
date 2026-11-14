const { app, BrowserWindow, Menu, ipcMain, dialog, shell, Tray, nativeImage } = require('electron');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const net = require('net');
const extract = require('extract-zip');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const os = require('os');
const dns = require('dns');

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

// Node.js (LTS): nodejs.org/dist থেকে node-v24.x.y-win-x64.zip নামিয়ে Release-এ আপলোড করুন
const NODE_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/node-v24.22.2-win-x64.zip';

// win-acme (Let's Encrypt সার্টিফিকেট, Step B2): win-acme.v2.2.9.1701.x64.pluggable.zip Release-এ আপলোড করা আছে
const WINACME_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/win-acme.v2.2.9.1701.x64.pluggable.zip';

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
// আপনার নিজের MySQL সেটিং: my.ini প্রতিবার নতুন লেখা হয়, কিন্তু এই ফাইল অ্যাপ কখনো বদলায় না (my.ini এটাকে !include করে)
const mysqlExtraIni = () => {
  const v = activeVersion('mysql');
  return path.join(ROOT_DIR, 'data', v.isDefault ? 'my-extra.ini' : `my-extra-${v.version}.ini`);
};
function ensureMysqlExtra() {
  const f = mysqlExtraIni();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  if (!fs.existsSync(f)) {
    fs.writeFileSync(
      f,
      [
        '# Server 360 - your own MySQL settings. The app never changes this file.',
        '# (my.ini is rewritten on every MySQL start and includes this file at the end.)',
        '# Write options under [mysqld], save, then restart MySQL.',
        '# A mistake here (or changing datadir/port) can stop MySQL from starting.',
        '[mysqld]',
        '# max_connections=200',
        '# max_allowed_packet=256M',
        '# innodb_buffer_pool_size=512M',
        '# sql_mode=STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION',
        '',
      ].join('\n')
    );
  }
  return f;
}

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
  setIni('auto_prepend_file', ensureSitePrepend(tmpBase));
  setIni('user_ini.cache_ttl', '5');
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

// (নিচের phpSlug/phpVersionList ফাংশন কল হওয়ার সময় তৈরি থাকবে)
// আগে থেকে তৈরি php.ini-তেও নতুন extension (যেমন pgsql) চালু করা
function refreshPhpIni(dir) {
  const ini = path.join(dir || SERVICES.php.dir, 'php.ini');
  if (!fs.existsSync(ini)) return;
  const txt = fs.readFileSync(ini, 'utf8');
  const next = applyExtOverrides(enableExtensions(txt), path.dirname(ini));
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

// ---------- PHP extension (ভার্সন ধরে) ও সাইট ধরে সেশন সময় ----------
// settings.phpExt = { '<ভার্সন>': { '<extension>': true|false } } : ব্যবহারকারীর বাছাই, প্রতিবার php.ini-তে বসে।
// settings.siteSession = { '<domain>': <মিনিট> } : সেই সাইটের সেশনের মেয়াদ (নেই মানে PHP-র ডিফল্ট)।
const extKey = (name) => (name === 'opcache' ? 'zend_extension' : 'extension');
const extLineRe = (name, flags = 'm') => new RegExp(`^;?[ \\t]*${extKey(name)}[ \\t]*=[ \\t]*"?(php_)?${name}(\\.dll)?"?[ \\t]*$`, flags);
function applyExtOverrides(txt, dir) {
  const v = phpVersionList().find((x) => path.resolve(x.dir) === path.resolve(dir));
  const ov = (v && settings.phpExt && settings.phpExt[v.version]) || {};
  for (const [name, on] of Object.entries(ov)) {
    if (!/^[a-z0-9_]+$/.test(name)) continue;
    // ওই extension-এর সব লাইন (কমেন্ট করা সহ) সরিয়ে, চালু হলে একটা পরিষ্কার লাইন শেষে বসাই
    txt = txt.split('\n').filter((l) => !extLineRe(name).test(l.replace(/\r$/, ''))).join('\n');
    if (on) txt = txt.replace(/\s*$/, '\n') + `${extKey(name)}=${name}\n`;
  }
  return txt;
}
function phpExtList(version) {
  const v = phpVersionList().find((x) => x.version === version && x.installed);
  if (!v) return null;
  let names = [];
  try {
    names = fs.readdirSync(path.join(v.dir, 'ext')).filter((f) => /^php_[a-z0-9_]+\.dll$/i.test(f)).map((f) => f.slice(4, -4).toLowerCase());
  } catch {}
  names = names.filter((n) => !/^(oci8|pdo_oci|pdo_firebird)/.test(n)).sort();
  let ini = '';
  try {
    ini = fs.readFileSync(path.join(v.dir, 'php.ini'), 'utf8');
  } catch {}
  const live = (n) => ini.split('\n').some((l) => /^[ \t]*[a-z_]/.test(l) && extLineRe(n).test(l.replace(/\r$/, '')));
  return { dir: v.dir, items: names.map((n) => ({ name: n, enabled: live(n) })) };
}
const siteSessionMin = (domain) => {
  const n = parseInt(settings.siteSession && settings.siteSession[domain], 10);
  return Number.isInteger(n) && n >= 1 ? n : 0;
};
// সাইট ধরে PHP সীমা: settings.sitePhpIni = { '<domain>': { max_execution_time, max_input_time, memory_limit, display_errors } }
// শুধু যেগুলো ini_set দিয়ে বদলানো যায় (upload_max_filesize/post_max_size এখানে নেই, ওগুলো PHP স্ক্রিপ্ট চলার আগেই পড়া হয়)।
const PHP_INI_KEYS = {
  max_execution_time: /^\d{1,6}$/,
  max_input_time: /^(-1|\d{1,6})$/,
  memory_limit: /^(-1|\d{1,5}[KMGkmg])$/,
  display_errors: /^(On|Off)$/,
};
const siteIni = (domain) => {
  const cur = (settings.sitePhpIni && settings.sitePhpIni[domain]) || {};
  const out = {};
  for (const [k, re] of Object.entries(PHP_INI_KEYS)) {
    if (cur[k] !== undefined && re.test(String(cur[k]))) out[k] = String(cur[k]);
  }
  return out;
};
const siteIniEnv = (domain) =>
  Object.entries(siteIni(domain))
    .map(([k, v]) => `${k}=${v}`)
    .join(';');
// Nginx-এর fastcgi_read_timeout যেন max_execution_time-এর আগে অনুরোধ না কাটে
const siteReadTimeout = (domain) => {
  const ini = siteIni(domain);
  if (ini.max_execution_time === undefined) return 300;
  const n = parseInt(ini.max_execution_time, 10);
  return n === 0 ? 3600 : Math.max(300, n + 30);
};

// ---------- পাবলিক ডোমেইন (সাইট ধরে, Step B1: শুধু server_name/ServerAlias; SSL পরের ধাপে) ----------
// settings.sitePublic = { '<domain>': ['360.example.com', ...] }
const PUBLIC_HOST_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PUBLIC_BAD_TLD = /\.(test|local|localhost|internal|lan|invalid|example)$/;
const sitePublicNames = (domain) => {
  const cur = settings.sitePublic && settings.sitePublic[domain];
  return Array.isArray(cur) ? cur.filter((h) => typeof h === 'string' && PUBLIC_HOST_RE.test(h) && !PUBLIC_BAD_TLD.test(h)) : [];
};
// ---------- Let's Encrypt / win-acme (Step B2) ----------
// http-01 যাচাই: Let's Encrypt http://<নাম>/.well-known/acme-challenge/<token> খোলে। সব পাবলিক সাইটের পোর্ট-৮০ ব্লকে
// ওই পথটা একটা অভিন্ন ফোল্ডার (data\acme-webroot) থেকে দেওয়া হয়; win-acme সেখানে token ফাইল লেখে।
const fwdSlash = (p) => p.replace(/\\/g, '/');
const winAcmeDir = () => path.join(TOOLS_DIR, 'win-acme');
const winAcmeExe = () => path.join(winAcmeDir(), 'wacs.exe');
const acmeWebroot = () => path.join(ROOT_DIR, 'data', 'acme-webroot');
const certsDir = () => path.join(ROOT_DIR, 'data', 'certs');
const ACME_TASK = 'Server 360 - win-acme renew';
const EMAIL_RE = /^[^\s@,;<>"'\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,63}$/;

// সাইটের মূল (শেয়ার নয় এমন) server ব্লকে পাবলিক নামগুলো যোগ করে (সাথে ACME challenge পথ)
const withPublicNames = (text, domain) => {
  const names = sitePublicNames(domain);
  if (!names.length) return text;
  const web = fwdSlash(acmeWebroot());
  const ngChallenge = `    location ^~ /.well-known/acme-challenge/ { root "${web}"; default_type text/plain; try_files $uri =404; }`;
  const apChallenge = [
    '  <IfModule proxy_module>',
    '    ProxyPass /.well-known/acme-challenge/ !',
    '  </IfModule>',
    `  Alias /.well-known/acme-challenge/ "${web}/.well-known/acme-challenge/"`,
    `  <Directory "${web}/.well-known/acme-challenge">`,
    '    AllowOverride None',
    '    Options None',
    '    Require all granted',
    '    ForceType text/plain',
    '  </Directory>',
  ].join('\n');
  // B3 (শুধু Nginx): বৈধ সার্টিফিকেট থাকলে (১) 443 ssl ব্লক, (২) পোর্ট ৮০-তে পাবলিক নামগুলো আলাদা ব্লকে: challenge পথ + https-এ 301
  const port = (/^\s*listen (\d+)/m.exec(text) || [])[1];
  const tls = text.includes('server_name') ? tlsFor(names) : null;
  if (tls) {
    const https = text
      .replace(/^(\s*)listen \d+;/m, '$1listen 443 ssl;')
      .replace(`    server_name ${domain};`, () => `    server_name ${tls.hosts.join(' ')};\n    ssl_certificate \"${tls.crt}\";\n    ssl_certificate_key \"${tls.key}\";\n    ssl_protocols TLSv1.2 TLSv1.3;\n    ssl_session_cache shared:SSL:10m;\n    ssl_session_timeout 10m;`);
    if (port === '80') {
      const redirect = ['  server {', '    listen 80;', `    server_name ${names.join(' ')};`, ngChallenge, '    location / { return 301 https://$host$request_uri; }', '  }'].join('\n');
      return text + '\n' + redirect + '\n' + https;
    }
    return text.replace(`    server_name ${domain};`, () => `    server_name ${domain} ${names.join(' ')};\n${ngChallenge}`) + '\n' + https;
  }
  return text
    .replace(`    server_name ${domain};`, () => `    server_name ${domain} ${names.join(' ')};\n${ngChallenge}`)
    .replace(`  ServerName ${domain}\n`, () => `  ServerName ${domain}\n  ServerAlias ${names.join(' ')}\n${apChallenge}\n`);
};

// সার্টিফিকেট ফোল্ডারের *-crt.pem ফাইল পড়ে (নাম win-acme-র ওপর নির্ভর না করে ভেতরের SAN/মেয়াদ দেখে)
function certScan() {
  let files = [];
  try {
    files = fs.readdirSync(certsDir()).filter((f) => /-crt\.pem$/i.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const x = new crypto.X509Certificate(fs.readFileSync(path.join(certsDir(), f)));
      const names = String(x.subjectAltName || '').split(/,\s*/).map((v) => v.replace(/^DNS:/i, '').trim().toLowerCase()).filter(Boolean);
      const end = new Date(x.validTo);
      if (isNaN(end.getTime())) continue;
      const issuer = String(x.issuer || '').replace(/\s*\n\s*/g, ', ');
      out.push({ file: f, names, end, issuer, staging: /staging|fake/i.test(issuer) });
    } catch {}
  }
  return out;
}
function certFor(host) {
  let best = null;
  for (const c of certScan()) if (c.names.includes(host) && (!best || c.end > best.end)) best = c;
  return best;
}
// B3: পাবলিক নামের জন্য বৈধ সার্টিফিকেট + key থাকলে Nginx-এর https ব্লকের ফাইল/নাম (না থাকলে null)
// win-acme pemfiles: <base>-crt.pem (শুধু সার্টিফিকেট), <base>-chain.pem (পূর্ণ চেইন, না থাকলে crt), <base>-key.pem
function tlsFor(names) {
  if (!names || !names.length) return null;
  const c = certFor(names[0]);
  if (!c || c.end.getTime() < Date.now()) return null;
  const base = c.file.replace(/-crt\.pem$/i, '');
  const key = path.join(certsDir(), base + '-key.pem');
  const chain = path.join(certsDir(), base + '-chain.pem');
  const crt = fs.existsSync(chain) ? chain : path.join(certsDir(), c.file);
  if (!fs.existsSync(key) || !fs.existsSync(crt)) return null;
  const hosts = names.filter((n) => c.names.includes(n));
  return hosts.length ? { crt: fwdSlash(crt), key: fwdSlash(key), hosts } : null;
}
function acmeTaskExists() {
  return new Promise((resolve) => execFile('schtasks.exe', ['/Query', '/TN', ACME_TASK], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err)));
}

// upload_max_filesize / post_max_size / max_input_vars: PHP স্ক্রিপ্ট চলার আগেই পড়া হয়, তাই ini_set চলে না।
// সাইটের public ফোল্ডারে অ্যাপের চিহ্নিত .user.ini লেখা হয় (php-cgi এটা পড়ে; php.ini-তে user_ini.cache_ttl = 5)।
// নিজের .user.ini থাকলে (চিহ্ন ছাড়া) অ্যাপ সেটা ছোঁয় না।
const PHP_USER_INI_KEYS = {
  upload_max_filesize: /^(0|\d{1,6}[KMGkmg]?)$/,
  post_max_size: /^(0|\d{1,6}[KMGkmg]?)$/,
  max_input_vars: /^\d{1,6}$/,
};
const USER_INI_MARK = '; Server 360 managed file';
const siteUserIni = (domain) => {
  const cur = (settings.sitePhpIni && settings.sitePhpIni[domain]) || {};
  const out = {};
  for (const [k, re] of Object.entries(PHP_USER_INI_KEYS)) {
    if (cur[k] !== undefined && re.test(String(cur[k]))) out[k] = String(cur[k]);
  }
  return out;
};
const sizeBytes = (v) => {
  const m = /^(\d+)([KMGkmg]?)$/.exec(String(v));
  if (!m) return NaN;
  return Number(m[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()]);
};
// Nginx-এর client_max_body_size: সাইটে post_max_size বসানো থাকলে সেটাই (php location-এ)
const siteBodyLimit = (domain) => siteUserIni(domain).post_max_size || '';
function userIniText(ini) {
  return [USER_INI_MARK + ' (do not edit; change it on the Sites page, PHP limits)', ...Object.entries(ini).map(([k, v]) => `${k} = ${v}`), ''].join('\r\n');
}
// প্রতিটা সাইটের root-এ .user.ini মিলিয়ে রাখা (বসানো/বদলানো/মুছে ফেলা)। নিজের (চিহ্নহীন) ফাইল ছোঁয়া হয় না।
function syncUserIni(sites) {
  const conflicts = [];
  for (const x of sites) {
    if (x.system || x.node || x.disabled || !x.root) continue;
    try {
      const f = path.join(x.root, '.user.ini');
      const want = siteUserIni(x.domain);
      let cur = null;
      try {
        cur = fs.readFileSync(f, 'utf8');
      } catch {}
      const ours = cur !== null && cur.startsWith(USER_INI_MARK);
      if (Object.keys(want).length) {
        if (cur !== null && !ours) conflicts.push(x.domain);
        else if (cur !== userIniText(want)) fs.writeFileSync(f, userIniText(want));
      } else if (ours) {
        fs.rmSync(f, { force: true });
      }
    } catch {}
  }
  return conflicts;
}
// সাইট ধরে সেশন সময়: php-cgi PHP_VALUE মানে না (ওটা শুধু php-fpm-এর), তাই প্রতিটা রিকোয়েস্টের শুরুতে একটা ছোট
// auto_prepend_file স্ক্রিপ্ট চলে। সার্ভার (Nginx fastcgi_param / Apache SetEnv) S360_SESSION (সেকেন্ড) পাঠায়, স্ক্রিপ্ট ini_set করে।
// সাইটের নিজের sessions সাবফোল্ডার ব্যবহার হয়, নইলে অন্য সাইটের GC বেশি মেয়াদি সেশন মুছে ফেলত।
function ensureSitePrepend(tmpBase) {
  const dir = path.join(ROOT_DIR, 'data', 'php-prepend');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'server360.php');
  const base = (tmpBase + '/sessions').replace(/['\\]/g, '\\$&');
  const code = [
    '<?php',
    '// Server 360: per-site session lifetime (written by the app, do not edit)',
    "if (!empty($_SERVER['S360_SESSION']) && ctype_digit((string)$_SERVER['S360_SESSION'])) {",
    "    $s = (int)$_SERVER['S360_SESSION'];",
    '    if ($s > 0) {',
    `        $d = '${base}/' . preg_replace('/[^A-Za-z0-9.-]/', '_', (string)($_SERVER['SERVER_NAME'] ?? 'site'));`,
    '        if (!is_dir($d)) { @mkdir($d, 0777, true); }',
    "        if (is_dir($d)) { ini_set('session.save_path', $d); }",
    "        ini_set('session.gc_maxlifetime', (string)$s);",
    "        ini_set('session.cookie_lifetime', (string)$s);",
    '    }',
    '}',
    "if (!empty($_SERVER['S360_INI'])) {",
    "    foreach (explode(';', (string)$_SERVER['S360_INI']) as $kv) {",
    "        $p = explode('=', $kv, 2);",
    "        if (count($p) === 2 && in_array($p[0], ['max_execution_time', 'max_input_time', 'memory_limit', 'display_errors'], true) && preg_match('/^[A-Za-z0-9-]+$/', $p[1])) { @ini_set($p[0], $p[1]); }",
    '    }',
    '}',
    '',
  ].join('\n');
  let cur = '';
  try {
    cur = fs.readFileSync(file, 'utf8');
  } catch {}
  if (cur !== code) fs.writeFileSync(file, code);
  return file.replace(/\\/g, '/');
}

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
const neededPhpVersions = (sites) => [...new Set([defaultPhpVersion(), ...sites.filter((s) => !s.disabled && !s.node).map(phpOfSite)])];

// Nginx-এর একটা server ব্লক (সাইটের জন্য)
function nginxServer(serverName, root, phpUp, isDefault, webPort, localOnly = false, extra = [], sessionMin = 0) {
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
    '    location = /.user.ini { return 404; }',
    '    location ~ \\.php$ {',
    `      fastcgi_pass ${phpUp};`,
    '      fastcgi_index index.php;',
    '      fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '      include fastcgi_params;',
    `      fastcgi_read_timeout ${siteReadTimeout(serverName)};`,
    ...(siteBodyLimit(serverName) ? [`      client_max_body_size ${siteBodyLimit(serverName)};`] : []),
    ...(sessionMin ? [`      fastcgi_param S360_SESSION ${sessionMin * 60};`] : []),
    ...(siteIniEnv(serverName) ? [`      fastcgi_param S360_INI "${siteIniEnv(serverName)}";`] : []),
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
function apacheServer(serverName, root, phpVer, webPort, localOnly = false, extra = [], sessionMin = 0) {
  const r = root.replace(/\\/g, '/');
  return [
    `<VirtualHost *:${webPort}>`,
    `  ServerName ${serverName}`,
    `  DocumentRoot "${r}"`,
    '  DirectoryIndex index.php index.html',
    // এই সাইটের নিজের PHP ভার্সন (php-cgi ও php.ini আলাদা)
    `  SetEnv PHPRC "${phpDirOf(phpVer).replace(/\\/g, '/')}"`,
    ...(sessionMin ? [`  SetEnv S360_SESSION ${sessionMin * 60}`] : []),
    ...(siteIniEnv(serverName) ? [`  SetEnv S360_INI "${siteIniEnv(serverName)}"`] : []),
    `  Action application/x-httpd-php "/server360-php-${phpSlug(phpVer)}/php-cgi.exe"`,
    `  <Directory "${r}">`,
    '    Options Indexes FollowSymLinks',
    '    AllowOverride All',
    `    ${localOnly ? 'Require local' : 'Require all granted'}`,
    '  </Directory>',
    '  <Files ".user.ini">',
    '    Require all denied',
    '  </Files>',
    ...extra,
    '</VirtualHost>',
    '',
  ].join('\n');
}

// ---------- Node.js সাইটের reverse proxy ----------
// settings.nodeSites = { '<domain>': { cmd?: 'npm start', port?: 3100, manual?: true } }
const nodeCfg = (domain) => (settings.nodeSites && settings.nodeSites[domain]) || {};
// সাইটের স্থির পোর্ট (কনফিগে বসে, তাই অ্যাপ বন্ধ থাকলেও proxy একই পোর্টে যায়)। প্রথমবার 3100 থেকে খালি নম্বর বাছা হয়
function nodePortOf(domain) {
  const cfg = nodeCfg(domain);
  if (validPort(cfg.port)) return validPort(cfg.port);
  const used = new Set(Object.values(settings.nodeSites || {}).map((c) => c && c.port));
  let p = 3100;
  while (used.has(p)) p++;
  settings.nodeSites = { ...(settings.nodeSites || {}), [domain]: { ...cfg, port: p } };
  saveSettings(settings);
  return p;
}

// asHost: LAN শেয়ার-পোর্টে অ্যাপকে সবসময় .test নামে দেখাই (Host ও Origin), নইলে Next/Vite dev সার্ভার অচেনা IP:পোর্ট origin আটকায়
function nginxNodeServer(domain, port, webPort, extra = [], asHost = '') {
  return [
    '  server {',
    `    listen ${webPort};`,
    `    server_name ${domain};`,
    ...extra,
    '    location / {',
    `      proxy_pass http://127.0.0.1:${port};`,
    '      proxy_http_version 1.1;',
    asHost ? `      proxy_set_header Host ${asHost};` : '      proxy_set_header Host $http_host;',
    ...(asHost ? [`      proxy_set_header Origin http://${asHost};`] : []),
    '      proxy_set_header X-Real-IP $remote_addr;',
    '      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '      proxy_set_header X-Forwarded-Proto $scheme;',
    '      proxy_set_header Upgrade $http_upgrade;',
    '      proxy_set_header Connection $connection_upgrade;',
    '      proxy_read_timeout 3600s;',
    '      proxy_send_timeout 3600s;',
    '    }',
    '  }',
  ].join('\n');
}

// Apache: mod_proxy_http (+ WebSocket-এর জন্য mod_proxy_wstunnel) থাকলে কাজ করে; না থাকলে IfModule-এ বাদ যায়, Apache চালু হতে বাধা পায় না
function apacheNodeServer(domain, port, webPort, extra = [], asHost = '') {
  const up = `http://127.0.0.1:${port}`;
  return [
    `<VirtualHost *:${webPort}>`,
    `  ServerName ${domain}`,
    '  <IfModule proxy_http_module>',
    '    ProxyPreserveHost On',
    ...(asHost ? ['    <IfModule headers_module>', `      RequestHeader set Host "${asHost}"`, `      RequestHeader set Origin "http://${asHost}"`, '    </IfModule>'] : []),
    '    ProxyTimeout 3600',
    '    <IfModule proxy_wstunnel_module>',
    '      RewriteEngine On',
    '      RewriteCond %{HTTP:Upgrade} =websocket [NC]',
    `      RewriteRule ^/?(.*)$ ws://127.0.0.1:${port}/$1 [P,L]`,
    '    </IfModule>',
    `    ProxyPass / ${up}/`,
    `    ProxyPassReverse / ${up}/`,
    '  </IfModule>',
    ...extra,
    '</VirtualHost>',
    '',
  ].join('\n');
}

// ---------- সাইট ধরে আলাদা কনফিগ ফাইল (Laragon-এর sites-enabled-এর মতো) ----------
// <সার্ভার>\conf\sites-enabled\<domain>.conf। ফাইলের প্রথম লাইন AUTO_MARK হলে অ্যাপ সেটা প্রতিবার আবার লেখে।
// ব্যবহারকারী প্রথম লাইনটা মুছে দিলে ফাইলটা তার নিজের: অ্যাপ আর ছোঁয় না (কিন্তু সাইট বন্ধ করলে .disabled নাম হয়ে সরে যায়)।
const AUTO_MARK = '# Server 360 [auto]';
const AUTO_HEADER = AUTO_MARK + ' - generated by the app and rewritten on every start. Delete this line to keep your own edits.\n';
const sitesEnabledDir = (svc) => path.join(svc.dir, 'conf', 'sites-enabled');

// প্রতিটা সাইটের এক্সট্রা ফোল্ডার: sites-enabled\<domain>.d\*.conf -- সাইটের server ব্লকের ভেতরে include হয়।
// এই ফোল্ডারের ফাইল অ্যাপ কখনো লেখে বা মোছে না (cors.conf, rewrite.conf ইত্যাদি নিজের মতো রাখা যায়)।
const extrasDir = (svc, domain) => path.join(sitesEnabledDir(svc), `${domain}.d`);
const nginxExtraInclude = (domain) => `    include sites-enabled/${domain}.d/*.conf;`;
const apacheExtraInclude = (domain) => '  IncludeOptional "${SRVROOT}/conf/sites-enabled/' + domain + '.d/*.conf"';

function writeSiteFiles(svc, entries, sites) {
  syncUserIni(sites);
  const dir = sitesEnabledDir(svc);
  fs.mkdirSync(dir, { recursive: true });
  const keep = new Set(entries.map((e) => e.file));
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  // বন্ধ সাইটের ফাইল: অ্যাপের বানানোটা মুছে ফেলি, ব্যবহারকারীর নিজেরটা .disabled নামে সরিয়ে রাখি
  for (const x of sites.filter((s) => s.disabled && !s.system)) {
    const f = path.join(dir, `${x.domain}.conf`);
    const cur = read(f);
    if (cur === null) continue;
    if (cur.startsWith(AUTO_MARK)) fs.rmSync(f, { force: true });
    else fs.renameSync(f, f + '.disabled');
  }
  // আর দরকার নেই এমন auto ফাইল (মুছে ফেলা সাইট ইত্যাদি) সরানো; ব্যবহারকারীর নিজের ফাইলে হাত দিই না
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.conf') || keep.has(f)) continue;
    const full = path.join(dir, f);
    const cur = read(full);
    if (cur !== null && cur.startsWith(AUTO_MARK)) fs.rmSync(full, { force: true });
  }
  // প্রতিটা (সিস্টেম নয় এমন) সাইটের এক্সট্রা ফোল্ডার আগে থেকে বানানো, যাতে include-এর পথ সবসময় থাকে
  for (const e of entries) if (e.extras) fs.mkdirSync(path.join(dir, `${e.extras}.d`), { recursive: true });
  for (const e of entries) {
    const full = path.join(dir, e.file);
    // আগে বন্ধ করা নিজের ফাইল থাকলে ফিরিয়ে আনি
    if (!fs.existsSync(full) && fs.existsSync(full + '.disabled')) fs.renameSync(full + '.disabled', full);
    const cur = read(full);
    if (cur !== null && !cur.startsWith(AUTO_MARK)) continue; // ব্যবহারকারীর নিজের ফাইল
    const text = AUTO_HEADER + e.text + '\n';
    if (cur !== text) fs.writeFileSync(full, text);
  }
}

// http://localhost/<প্রজেক্ট>/ (যে প্রজেক্টের root আসলে public\, যেমন Laravel) -- দুই রকম আচরণ:
//  1) এই কম্পিউটার থেকে (Host = localhost / 127.0.0.1): <প্রজেক্ট>.test-এ 302 redirect (hosts লাইন শুধু এখানেই আছে)।
//  2) অন্য কম্পিউটার থেকে (Host = 192.168.x.x ইত্যাদি, LAN): redirect নয়, প্রজেক্টের public\ ফোল্ডার সরাসরি /<প্রজেক্ট>/ নামে চালানো হয়,
//     কারণ অন্য PC-র hosts ফাইলে <প্রজেক্ট>.test নেই (DNS_PROBE_FINISHED_NXDOMAIN আসত)।
// localhost-এর root পুরো www ফোল্ডার, সেখানে প্রজেক্টের মূল ফোল্ডারে index.php নেই। /public লিখলেও একই জায়গায় যায়।
// kind = 'nginx' | 'apache'; শুধু চালু সাইটের জন্য। upOf(site) = Nginx-এ সাইটের PHP upstream
function publicRedirects(sites, webPort, kind, upOf) {
  const out = [];
  let n = 0;
  for (const x of sites) {
    if (x.system || x.disabled || path.basename(x.root).toLowerCase() !== 'public') continue;
    const folder = path.basename(path.dirname(x.root));
    if (!/^[A-Za-z0-9._-]+$/.test(folder)) continue;
    n++;
    const target = `http://${x.domain}${webPort === 80 ? '' : ':' + webPort}/`;
    const esc = folder.replace(/\./g, '\\.');
    const pub = x.root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (kind === 'nginx') {
      const up = upOf(x);
      const name = `s360_${n}_${folder.replace(/[^A-Za-z0-9_]/g, '_')}`;
      const isLocal = 'if ($host ~* "^(localhost|127\\.0\\.0\\.1)$")';
      const sess = siteSessionMin(x.domain);
      const common = [
        `      fastcgi_pass ${up};`,
        '      include fastcgi_params;',
        `      fastcgi_param DOCUMENT_ROOT "${pub}";`,
        `      fastcgi_read_timeout ${siteReadTimeout(x.domain)};`,
        ...(siteBodyLimit(x.domain) ? [`      client_max_body_size ${siteBodyLimit(x.domain)};`] : []),
        ...(sess ? [`      fastcgi_param S360_SESSION ${sess * 60};`] : []),
        ...(siteIniEnv(x.domain) ? [`      fastcgi_param S360_INI "${siteIniEnv(x.domain)}";`] : []),
      ];
      out.push(
        `    location = /${folder} {`,
        `      ${isLocal} { return 302 ${target}; }`,
        `      return 302 $scheme://$http_host/${folder}/;`,
        '    }',
        `    location ^~ /${folder}/ {`,
        `      ${isLocal} { rewrite ^/${esc}/(?:public(?:/|$))?(.*)$ ${target}$1 redirect; }`,
        `      alias "${pub}/";`,
        '      index index.php index.html;',
        `      try_files $uri $uri/ @${name};`,
        '      location ~ \\.php$ {',
        ...common.map((l) => '  ' + l),
        '        fastcgi_param SCRIPT_FILENAME $request_filename;',
        '      }',
        '    }',
        `    location @${name} {`,
        ...common,
        `      fastcgi_param SCRIPT_FILENAME "${pub}/index.php";`,
        `      fastcgi_param SCRIPT_NAME /${folder}/index.php;`,
        '    }'
      );
    } else {
      out.push(
        '  RewriteEngine On',
        '  RewriteCond %{HTTP_HOST} ^(localhost|127\\.0\\.0\\.1)(:\\d+)?$ [NC]',
        `  RewriteRule ^/${esc}(?:/(?:public(?:/|$))?(.*))?$ ${target}$1 [R=302,L]`,
        `  Alias /${folder} "${pub}"`,
        `  <Directory "${pub}">`,
        '    Options FollowSymLinks',
        '    AllowOverride All',
        '    Require all granted',
        '    DirectoryIndex index.php index.html',
        `    RewriteBase /${folder}/`,
        '  </Directory>'
      );
    }
  }
  return out;
}

// বন্ধ (disabled) সাইটের ফোল্ডার localhost দিয়ে আর খোলা যাবে না: http://localhost/<ফোল্ডার>/... (এবং /public) -> 404 (Nginx) / 403 (Apache)।
// localhost-এর root পুরো www ফোল্ডার, তাই আগে বন্ধ সাইটও এই পথে খোলা যেত। Apache-এর ফোল্ডার-তালিকা থেকেও লুকানো হয় (IndexIgnore)।
function disabledBlocks(sites, kind) {
  const out = [];
  for (const x of sites) {
    // বন্ধ সাইট, আর Node সাইট (এর ফোল্ডারে server.js, .env, node_modules আছে, সেগুলো localhost/<ফোল্ডার> দিয়ে খোলা উচিত নয়; অ্যাপ <নাম>.test দিয়ে খোলে)
    if (x.system || !(x.disabled || x.node)) continue;
    const folder = path.basename(path.basename(x.root).toLowerCase() === 'public' ? path.dirname(x.root) : x.root);
    if (!/^[A-Za-z0-9._ -]+$/.test(folder)) continue;
    const esc = folder.replace(/\./g, '\\.');
    if (kind === 'nginx') out.push(`    location ~* "^/${esc}(/|$)" { return 404; }`);
    else out.push(`  <LocationMatch "(?i)^/${esc}(/|$)">`, '    Require all denied', '  </LocationMatch>', `  IndexIgnore "${folder}"`);
  }
  return out;
}

const pubN = (text, s) => (s.system ? text : withPublicNames(text, s.domain));

// B5: কোনো সাইটে পাবলিক নাম থাকলে অচেনা Host/IP-র (যেমন সরাসরি পাবলিক IP) ডিফল্ট সাইট শুধু এই PC ও LAN থেকে খোলা থাকে,
// ইন্টারনেট থেকে এলে 403 (নামী সাইটগুলোর নিজের server ব্লক আগের মতো খোলা)। https-এ অচেনা নামের TLS handshake-ই ফিরিয়ে দেওয়া হয়।
const publicSiteList = (sites) => sites.filter((x) => !x.system && !x.disabled && sitePublicNames(x.domain).length);
const hasPublicSites = (sites) => publicSiteList(sites).length > 0;
const anyTlsSites = (sites) => publicSiteList(sites).some((x) => !!tlsFor(sitePublicNames(x.domain)));
const NG_LAN_ONLY = ['    allow 127.0.0.0/8;', '    allow ::1;', '    allow 10.0.0.0/8;', '    allow 172.16.0.0/12;', '    allow 192.168.0.0/16;', '    allow fc00::/7;', '    allow fe80::/10;', '    deny all;'];
const NG_TLS_CATCHALL = ['  server {', '    listen 443 ssl default_server;', '    server_name _;', '    ssl_reject_handshake on;', '  }'].join('\n');
// Apache: <If> শুধু ইন্টারনেটের ক্লায়েন্টে চলে, তাই আগের Require (যেমন phpMyAdmin-এর Require local) বদলায় না
const AP_LAN_ONLY = ['  <If "%{REMOTE_ADDR} !~ /^(127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|::1$|fe80:|f[cd][0-9a-f]{2}:)/i">', '    Require all denied', '  </If>'];

function nginxEntries(sites, webPort, upOf) {
  const defUp = phpUpstream(defaultPhpVersion());
  return [
    { file: '00-default.conf', extras: 'localhost', text: nginxServer('localhost', WWW_DIR, defUp, true, webPort, false, [...toolLocations(defUp), ...publicRedirects(sites, webPort, 'nginx', upOf), ...disabledBlocks(sites, 'nginx'), nginxExtraInclude('localhost'), ...(hasPublicSites(sites) ? NG_LAN_ONLY : [])]) + (webPort === 80 && anyTlsSites(sites) ? '\n' + NG_TLS_CATCHALL : '') },
    ...sites
      .filter((s) => !s.disabled)
      .map((s) => {
        const mk = (port, shared = false) => (s.node ? nginxNodeServer(s.domain, nodePortOf(s.domain), port, [nginxExtraInclude(s.domain)], shared ? s.domain : '') : nginxServer(s.domain, s.root, upOf(s), false, port, !!s.system, s.system ? [] : [nginxExtraInclude(s.domain)], s.system ? 0 : siteSessionMin(s.domain)));
        // LAN শেয়ার চালু থাকলে একই সাইটের আরেকটা server ব্লক শেয়ার-পোর্টে
        return { file: `${s.domain}.conf`, extras: s.system ? '' : s.domain, text: shareable(s) ? pubN(mk(webPort), s) + '\n' + mk(sharePortOf(s.domain), true) : pubN(mk(webPort), s) };
      }),
  ];
}

function apacheAliasLines() {
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
  return aliasLines;
}

function apacheEntries(sites, webPort) {
  const defVer = defaultPhpVersion();
  return [
    { file: '00-default.conf', extras: 'localhost', text: apacheServer('localhost', WWW_DIR, defVer, webPort, false, [...apacheAliasLines(), ...publicRedirects(sites, webPort, 'apache'), ...disabledBlocks(sites, 'apache'), apacheExtraInclude('localhost'), ...(hasPublicSites(sites) ? AP_LAN_ONLY : [])]) },
    ...sites
      .filter((x) => !x.disabled)
      .map((x) => {
        const mk = (port, shared = false) => (x.node ? apacheNodeServer(x.domain, nodePortOf(x.domain), port, [apacheExtraInclude(x.domain)], shared ? x.domain : '') : apacheServer(x.domain, x.root, phpOfSite(x), port, !!x.system, x.system ? [] : [apacheExtraInclude(x.domain)], x.system ? 0 : siteSessionMin(x.domain)));
        return { file: `${x.domain}.conf`, extras: x.system ? '' : x.domain, text: shareable(x) ? pubN(mk(webPort), x) + '\n' + mk(sharePortOf(x.domain), true) : pubN(mk(webPort), x) };
      }),
  ];
}

// conf\server360.conf লেখা এবং httpd.conf-এ তার Include বসানো (বারবার চালালেও একই ফল)
function writeApacheConf(svc, _phpPorts, sites, webPort) {
  const f = (p) => p.replace(/\\/g, '/');
  const aliasLines = apacheAliasLines();

  // দরকারি মডিউল নিজেই লোড (আগে থেকে লোড থাকলে বাদ যায়, তাই দুবার লোডের এরর হয় না)
  const mods = [
    ['cgi_module', 'mod_cgi.so', true],
    ['actions_module', 'mod_actions.so', true],
    ['rewrite_module', 'mod_rewrite.so', true],
    // Node.js সাইটের reverse proxy (না থাকলে Node সাইট কাজ করবে না, কিন্তু Apache চালু হবে)
    ['proxy_module', 'mod_proxy.so', false],
    ['proxy_http_module', 'mod_proxy_http.so', false],
    ['proxy_wstunnel_module', 'mod_proxy_wstunnel.so', false],
    ['headers_module', 'mod_headers.so', false],
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

  writeSiteFiles(svc, apacheEntries(sites, webPort), sites);
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
    // LAN-এ শেয়ার করা সাইটের পোর্ট
    ...sharedPorts(sites).map((p) => `Listen ${p}`),
    // প্রতিটা সাইটের VirtualHost আলাদা ফাইলে: conf\sites-enabled\*.conf (00-default.conf আগে লোড হয়, তাই localhost ডিফল্ট)
    'IncludeOptional "${SRVROOT}/conf/sites-enabled/*.conf"',
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
  writeSiteFiles(svc, nginxEntries(sites, webPort, upOf), sites);
  const parts = [
    'worker_processes 1;',
    'events { worker_connections 1024; }',
    'http {',
    '  include mime.types;',
    '  default_type application/octet-stream;',
    '  sendfile on;',
    '  client_max_body_size 128m;',
    '  server_names_hash_bucket_size 64;',
    // Node.js সাইটের WebSocket-এর জন্য
    "  map $http_upgrade $connection_upgrade { default upgrade; '' close; }",
    ...upstreams,
    // প্রতিটা সাইটের server ব্লক আলাদা ফাইলে: conf\sites-enabled\*.conf (00-default.conf-এ localhost)
    '  include sites-enabled/*.conf;',
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
  // Node.js runtime: node.exe zip-এর ভেতরের node-v...-win-x64 ফোল্ডারে থাকে (installInto নিজে ওই ফোল্ডার বেছে নেয়)
  node: makeService('node', 'Node.js', NODE_URL, 'node', 'node.exe', {
    version: '24.22.2',
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
    const domain = `${name}.${TLD}`;
    // Node.js সাইট: package.json আছে, কিন্তু PHP/Laravel/WordPress-এর চিহ্ন (index.php, artisan, composer.json, wp-config.php) নেই
    const has = (f) => fs.existsSync(path.join(dir, f));
    const isNode = has('package.json') && !has('index.php') && !has('artisan') && !has('composer.json') && !has('wp-config.php') && !(hasPublic && fs.existsSync(path.join(pub, 'index.php')));
    sites.push({ name, domain, root: isNode ? dir : hasPublic ? pub : dir, node: isNode, disabled: !!(settings.siteDisabled && settings.siteDisabled[domain]) });
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

// ---------- MySQL root পাসওয়ার্ড ----------
// settings.mysqlRootPw = { '<MySQL ভার্সন>': 'পাসওয়ার্ড' } (প্রতি ভার্সনের ডাটা আলাদা, তাই পাসওয়ার্ডও আলাদা)।
// settings.json-এ সাধারণ লেখায় থাকে (অ্যাপ নিজে WordPress/Laravel/phpMyAdmin সেট করতে ও ডাটাবেস বন্ধ করতে এটা লাগে)।
let mysqlReset = null; // { ver, pw, file, result } — শুধু রিসেটের সময় মেমরিতে থাকে
const mysqlRootPw = () => (settings.mysqlRootPw && settings.mysqlRootPw[activeVersion('mysql').version]) || '';
const mysqlEnv = (pw = mysqlRootPw()) => ({ ...process.env, ...(pw ? { MYSQL_PWD: pw } : {}) });
const phpStr = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// PostgreSQL postgres পাসওয়ার্ড: settings.pgPw = { '<PostgreSQL ভার্সন>': 'পাসওয়ার্ড' }
const pgPw = () => (settings.pgPw && settings.pgPw[activeVersion('postgres').version]) || '';
const pgEnv = (pw = pgPw()) => ({ ...process.env, ...(pw ? { PGPASSWORD: pw } : {}) });
// PostgreSQL-এ (standard_conforming_strings চালু) শুধু ' দ্বিগুণ করতে হয়, \ সাধারণ অক্ষর
const pgStr = (v) => `'${String(v).replace(/'/g, "''")}'`;
const sqlStr = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
// Laravel .env-এর মান: সাধারণ অক্ষর হলে যেমন আছে, নইলে "..." দিয়ে (\\ " $ এড়িয়ে)
const envVal = (v) => (v === '' || /^[A-Za-z0-9_.@:+-]+$/.test(v) ? v : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`);

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
    `$cfg['Servers'][$i]['password'] = ${phpStr(mysqlRootPw())};`,
    `$cfg['Servers'][$i]['AllowNoPassword'] = ${mysqlRootPw() ? 'false' : 'true'};`,
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
  sites = sites.filter((s) => !s.disabled); // বন্ধ সাইটের hosts লাইন থাকে না
  const stripped = readHosts()
    .replace(/\r?\n?# my-laragon begin[\s\S]*?# my-laragon end\r?\n?/g, '\r\n')
    .trimEnd();
  if (!sites.length) return stripped + '\r\n';
  const lines = [HOSTS_BEGIN, ...sites.map((s) => `127.0.0.1 ${s.domain}`), HOSTS_END];
  return stripped + '\r\n\r\n' + lines.join('\r\n') + '\r\n';
}

const normText = (t) => t.replace(/\r\n/g, '\n').trim();

// PowerShell বন্ধ/ব্লক করা পিসি পরীক্ষার জন্য: S360_NO_POWERSHELL=1 npm start দিলে অ্যাপ ধরে নেয় PowerShell নেই
const NO_PS = process.env.S360_NO_POWERSHELL === '1';
let psBroken = NO_PS; // একবার ধরা পড়লে (দ্রুত ব্যর্থ) বাকি সময় PowerShell আর চেষ্টা করা হয় না
let lastManualShown = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHosts(next, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (normText(readHosts()) === normText(next)) return true;
    await sleep(500);
  }
  return normText(readHosts()) === normText(next);
}

// hosts ফাইলে শুধু আমাদের ব্লকটা বদলানো। পড়তে অনুমতি লাগে না, লিখতে Administrator (UAC) লাগে।
// বদল না থাকলে UAC পপআপ আসে না। ধাপগুলো (একটা কাজ করলেই থামে):
//   ১) সরাসরি লেখা (অ্যাপ Administrator হিসেবে চললে)
//   ২) PowerShell দিয়ে Administrator অনুমতি
//   ৩) PowerShell না থাকলে VBScript (wscript) দিয়ে cmd Administrator মোডে
//   ৪) সবই ব্যর্থ হলে apply-hosts.cmd বানিয়ে দেওয়া (ডান-ক্লিক > Run as administrator) ও বার্তা
async function syncHosts(sites) {
  const next = buildHostsContent(sites);
  if (normText(readHosts()) === normText(next)) return { ok: true, changed: false };

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const src = path.join(TOOLS_DIR, 'hosts.new');
  const ps1 = path.join(TOOLS_DIR, 'apply-hosts.ps1');
  const vbs = path.join(TOOLS_DIR, 'apply-hosts.vbs');
  const cmdFile = path.join(TOOLS_DIR, 'apply-hosts.cmd');
  const q = (t) => t.replace(/'/g, "''");
  fs.writeFileSync(src, next, 'utf8');

  // ১) সরাসরি লেখা (পরীক্ষার জন্য S360_NO_DIRECT_HOSTS=1 দিলে এই ধাপ বাদ)
  if (process.env.S360_NO_DIRECT_HOSTS !== '1') {
    try {
      fs.writeFileSync(HOSTS_PATH, next, 'utf8');
    } catch {}
  }
  if (normText(readHosts()) === normText(next)) return { ok: true, changed: true, how: 'direct' };

  // ২) PowerShell
  if (!psBroken) {
    fs.writeFileSync(ps1, '\ufeff' + `Copy-Item -Force -LiteralPath '${q(src)}' -Destination '${q(HOSTS_PATH)}'\r\n`, 'utf8');
    sendStatus(tr('hosts ফাইল আপডেটের জন্য Administrator অনুমতি লাগবে (Yes চাপুন)...', 'Administrator permission is needed to update the hosts file (click Yes)...'));
    const t0 = Date.now();
    const psErr = await new Promise((resolve) =>
      execFile(
        'powershell',
        ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','\"${q(ps1)}\"'`],
        { windowsHide: true },
        (err) => resolve(err)
      )
    );
    if (normText(readHosts()) === normText(next)) return { ok: true, changed: true, how: 'powershell' };
    // দুই সেকেন্ডের আগেই ব্যর্থ = PowerShell নেই/ব্লক করা (ইউজার No চাপলে সাধারণত বেশি সময় লাগে, তখন আবার প্রশ্ন করি না)
    if (psErr && Date.now() - t0 < 2000) psBroken = true;
    else if (psErr) return failHosts(next, src, cmdFile);
  }

  // ৩) VBScript দিয়ে cmd (Administrator)
  if (psBroken) {
    const vq = (t) => t.replace(/"/g, '""');
    fs.writeFileSync(
      vbs,
      `CreateObject("Shell.Application").ShellExecute "cmd.exe", "/c copy /y ""${vq(src)}"" ""${vq(HOSTS_PATH)}""", "", "runas", 0\r\n`,
      'utf8'
    );
    sendStatus(tr('hosts ফাইল আপডেটের জন্য Administrator অনুমতি লাগবে (Yes চাপুন)...', 'Administrator permission is needed to update the hosts file (click Yes)...'));
    await new Promise((resolve) => execFile('wscript', ['//nologo', vbs], { windowsHide: true }, () => resolve()));
    if (await waitHosts(next, 30000)) return { ok: true, changed: true, how: 'vbscript' };
  }

  return failHosts(next, src, cmdFile);
}

// ৪) শেষ উপায়: apply-hosts.cmd বানিয়ে ফোল্ডার দেখানো, কী করতে হবে বার্তায় জানানো
function failHosts(next, src, cmdFile) {
  try {
    const log = path.join(path.dirname(cmdFile), 'apply-hosts.log'); // জানালা চোখে না পড়লেও এই লগে দেখা যায় কী হয়েছিল
    fs.writeFileSync(
      cmdFile,
      [
        '@echo off',
        'net session >nul 2>&1',
        'if errorlevel 1 (',
        '  echo Right-click this file and choose "Run as administrator".',
        `  echo %date% %time% NOT-ADMIN>> "${log}"`,
        '  pause',
        '  exit /b 1',
        ')',
        `copy /y "${src}" "${HOSTS_PATH}" >nul && (echo Done: hosts file updated. & echo %date% %time% OK>> "${log}") || (echo Failed to update the hosts file. & echo %date% %time% FAILED>> "${log}")`,
        'pause',
        '',
      ].join('\r\n'),
      'utf8'
    );
    const key = crypto.createHash('md5').update(next).digest('hex');
    if (key !== lastManualShown) {
      lastManualShown = key;
      shell.showItemInFolder(cmdFile);
    }
  } catch {}
  return { ok: false, changed: true, manual: cmdFile };
}

// hosts আপডেট ব্যর্থ হলে বার্তার অংশ
function hostsFailNote(h) {
  const f = (h && h.manual) || 'apply-hosts.cmd';
  return tr(
    ` ⚠ hosts ফাইল আপডেট হয়নি, তাই শুধু localhost কাজ করবে। ${f} ফাইলে ডান-ক্লিক করে "Run as administrator" দিন, তারপর Sites পেজে Refresh চাপুন।`,
    ` ⚠ The hosts file was not updated, so only localhost works. Right-click ${f} and choose "Run as administrator", then press Refresh on the Sites page.`
  );
}

let win = null;
let tray = null; // সিস্টেম ট্রে আইকন (উইন্ডো বন্ধ করলে অ্যাপ ও সার্ভার এখানে চলতে থাকে)
let quitting = false; // true হলে উইন্ডো বন্ধ মানে সত্যিই বেরিয়ে যাওয়া (ট্রের Quit, Windows শাটডাউন)
const START_HIDDEN = process.argv.includes('--hidden'); // Windows লগইনে অ্যাপ উইন্ডো ছাড়া ট্রেতে চালু হয়
const keepRunningOn = () => settings.keepRunning !== false; // ডিফল্ট চালু
let running = null; // { id, procs: [...] } — একসময়ে একটাই সার্ভার চলবে (পোর্ট ৮০)
let busy = false;

function createWindow() {
  win = new BrowserWindow({
    width: 1060,
    height: 700,
    minWidth: 520,
    minHeight: 480,
    title: 'Server 360',
    backgroundColor: '#0f172a',
    // লগইনে --hidden দিয়ে চালু হলে (আর ফোল্ডার আগে ঠিক করা থাকলে) উইন্ডো দেখানো হয় না, শুধু ট্রে
    show: !(START_HIDDEN && keepRunningOn() && settings.wwwDir),
    // উইন্ডো লুকানো থাকলেও পেজের টাইমার (অটো-স্টার্ট, স্ট্যাটাস) যেন ধীর না হয়
    webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  // Windows বন্ধ/লগ-অফ হলে ট্রেতে লুকানো উইন্ডো যেন শাটডাউন আটকে না রাখে ('session-end' BrowserWindow-এর ইভেন্ট)
  win.on('session-end', () => {
    quitting = true;
  });
  // X চাপলে অ্যাপ বন্ধ না করে ট্রেতে লুকিয়ে যায় (সেটিং বন্ধ থাকলে, বা ট্রে বানানো না গেলে, আগের মতো বন্ধ হয়)
  win.on('close', (e) => {
    if (quitting || !keepRunningOn() || !tray || tray.isDestroyed()) return;
    e.preventDefault();
    win.hide();
    if (!settings.trayHintShown) {
      settings.trayHintShown = true;
      saveSettings(settings);
      try {
        tray.displayBalloon({
          title: 'Server 360',
          content: tr('অ্যাপ ট্রেতে চলছে, সার্ভারগুলো চালু আছে। পুরো বন্ধ করতে ট্রে আইকনে ডান-ক্লিক করে Quit দিন।', 'The app keeps running in the tray and your servers stay on. To quit completely, right-click the tray icon and choose Quit.'),
        });
      } catch {}
    }
  });
  // ডায়াগনস্টিক: পেজ ক্র্যাশ/ঝুলে গেলে userData\\crash.log-এ লেখা, ক্র্যাশ হলে পেজ নিজে থেকে আবার লোড; F12 বা Ctrl+Shift+I = DevTools
  const crashLog = (what, extra) => {
    try {
      fs.appendFileSync(path.join(app.getPath('userData'), 'crash.log'), `${new Date().toISOString()} ${what} ${extra ? JSON.stringify(extra) : ''}\n`);
    } catch {}
  };
  win.webContents.on('render-process-gone', (_e, details) => {
    crashLog('render-process-gone', details);
    setTimeout(() => {
      try {
        win.reload();
      } catch {}
    }, 500);
  });
  win.webContents.on('unresponsive', () => crashLog('unresponsive'));
  win.webContents.on('did-fail-load', (_e, code, desc) => crashLog('did-fail-load', { code, desc }));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 3) crashLog('renderer-error', { message, line, source }); // শুধু error
  });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && String(input.key).toUpperCase() === 'I'))) win.webContents.toggleDevTools();
  });
}

function sendStatus(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('status', msg);
}

// ---------- ট্রে আইকন ----------
// ৩২x৩২ আইকন সরাসরি কোডে (আলাদা ফাইল লাগে না)
const TRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAASklEQVR42mNgGAVoQDX59X9a4sHrAFpbTNAhow4YdQA+xeSC4eeAAY+CUQeM5oIBcwCpeNQBw88Bo7lgtD0w6oBh1T8Y/F2zEQcAB87wUsIIlngAAAAASUVORK5CYII=';
function showMainWindow() {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function buildTray() {
  try {
    if (!tray || tray.isDestroyed()) {
      tray = new Tray(nativeImage.createFromBuffer(Buffer.from(TRAY_PNG, 'base64')));
      tray.on('click', showMainWindow);
      tray.on('double-click', showMainWindow);
    }
    tray.setToolTip('Server 360');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: tr('Server 360 খুলুন', 'Open Server 360'), click: showMainWindow },
        { type: 'separator' },
        {
          label: tr('বন্ধ করুন (সব সার্ভার বন্ধ হবে)', 'Quit (stops all servers)'),
          click: () => {
            quitting = true;
            app.quit();
          },
        },
      ])
    );
  } catch (err) {
    tray = null; // ট্রে না থাকলে X চাপলে অ্যাপ আগের মতো বন্ধ হবে, যেন অ্যাপ হারিয়ে না যায়
  }
}
function applyLoginItem() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.openAtLogin,
      path: process.execPath,
      args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
    });
  } catch {}
}
ipcMain.handle('app:getBehavior', () => ({
  keepRunning: keepRunningOn(),
  openAtLogin: !!settings.openAtLogin,
  startAllOnLaunch: !!settings.startAllOnLaunch,
}));
ipcMain.handle('app:setBehavior', (_e, b) => {
  b = b || {};
  settings.keepRunning = !!b.keepRunning;
  settings.openAtLogin = !!b.openAtLogin;
  settings.startAllOnLaunch = !!b.startAllOnLaunch;
  saveSettings(settings);
  applyLoginItem();
  return { keepRunning: keepRunningOn(), openAtLogin: !!settings.openAtLogin, startAllOnLaunch: !!settings.startAllOnLaunch };
});

function killTree(pid) {
  exec(`taskkill /pid ${pid} /t /f`);
}

// ---- চালানো প্রসেসের PID তালিকা (tools\pids.json): PowerShell না থাকলে আটকে থাকা প্রসেস মারতে এটা কাজে লাগে ----
// রিবুটের পর PID বদলে যায়, তাই বুট-সময় মিলিয়ে দেখা হয় (না মিললে তালিকা বাতিল)
const bootMin = () => Math.round((Date.now() - os.uptime() * 1000) / 60000);
const pidFile = () => path.join(TOOLS_DIR, 'pids.json');
function readPidReg() {
  try {
    const j = JSON.parse(fs.readFileSync(pidFile(), 'utf8'));
    if (j && j.pids && Math.abs((j.boot || 0) - bootMin()) <= 2) return j;
  } catch {}
  return { boot: bootMin(), pids: {} };
}
function writePidReg(reg) {
  try {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    fs.writeFileSync(pidFile(), JSON.stringify(reg));
  } catch {}
}
// kind = প্রসেসের নাম (nginx, httpd, php-cgi, mysqld, postgres, node), image = আসল .exe-র নাম (যাচাইয়ের জন্য)
function trackPid(proc, kind, image) {
  if (!proc || !proc.pid) return;
  const pid = String(proc.pid);
  const reg = readPidReg();
  reg.pids[pid] = { kind: kind.toLowerCase(), image: (image || kind + '.exe').toLowerCase() };
  writePidReg(reg);
  proc.once('exit', () => {
    const r = readPidReg();
    delete r.pids[pid];
    for (const [k, e] of Object.entries(r.pids)) if (e.owner === pid) delete r.pids[k];
    writePidReg(r);
  });
}

// পোর্টে আসলে কে শুনছে (LISTENING) তার PID। nginx/mysqld-এর ক্ষেত্রে চালানো প্রসেসের PID আর আসল শ্রোতার PID আলাদা হতে পারে
// (পরীক্ষায় তাই হয়েছিল), তাই সার্ভার তৈরি হলে এই PID-ও তালিকায় রাখি
function listenerPid(port) {
  return new Promise((resolve) =>
    exec('netstat -ano -p tcp', { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      for (const line of String(out).split(/\r?\n/)) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
        if (m && Number(m[1]) === Number(port) && m[2] !== '0') return resolve(m[2]);
      }
      resolve(null);
    })
  );
}
async function trackListener(owner, port, kind, image) {
  try {
    for (let i = 0; i < 6; i++) {
      const pid = await listenerPid(port);
      if (pid) {
        const img = (await imageOfPid(pid)) || String(image).toLowerCase();
        const reg = readPidReg();
        if (!reg.pids[pid]) {
          reg.pids[pid] = { kind: String(kind).toLowerCase(), image: img, owner: owner && owner.pid ? String(owner.pid) : undefined };
          writePidReg(reg);
        }
        return;
      }
      await sleep(500);
    }
  } catch {}
}
const exeKind = (exe) => path.basename(exe, '.exe').toLowerCase();

function imageOfPid(pid) {
  return new Promise((resolve) =>
    exec(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, { windowsHide: true }, (err, out) => {
      const m = !err && String(out).match(/^"([^"]+)","(\d+)"/m);
      resolve(m && m[2] === String(pid) ? m[1].toLowerCase() : null);
    })
  );
}

// PowerShell ছাড়া: তালিকার PID-গুলো (নাম মিললে) taskkill দিয়ে মারা
async function killStaleByPid(names) {
  const want = String(names).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const reg = readPidReg();
  for (const [pid, e] of Object.entries(reg.pids)) {
    if (!want.includes(e.kind)) continue;
    const img = await imageOfPid(pid); // PID অন্য প্রোগ্রাম নিয়ে নিলে (নাম না মিললে) মারা হয় না
    if (img && img === e.image) await new Promise((r) => exec(`taskkill /pid ${pid} /t /f`, { windowsHide: true }, () => r()));
    delete reg.pids[pid];
  }
  writePidReg(reg);
  await sleep(500);
}

// আগের বার বন্ধ না হওয়া (লুকিয়ে চলা) nginx / php-cgi প্রসেস মেরে ফেলা।
// শুধু আমাদের tools ফোল্ডারের প্রসেসই মারা হয়, অন্য প্রোগ্রামের নয়।
// (Windows-এ দুটো nginx একই পোর্ট ৮০ নিতে পারে, তখন পুরনোটাই সাড়া দেয়)
// প্রথমে PowerShell; সেটা না থাকলে/ব্লক করা থাকলে PID তালিকা ধরে taskkill।
function killStale(names = 'nginx,php-cgi,httpd') {
  if (psBroken) return killStaleByPid(names);
  const base = TOOLS_DIR.replace(/'/g, "''");
  const cmd =
    `powershell -NoProfile -Command "Get-Process ${names} -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path -like '${base}*' } | Stop-Process -Force"`;
  return new Promise((resolve) =>
    exec(cmd, { windowsHide: true }, (err) => {
      if (err) return killStaleByPid(names).then(resolve);
      setTimeout(resolve, 500);
    })
  );
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
    trackPid(proc, exeKind(exe));
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
    '!include ' + f(ensureMysqlExtra()),
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
      return mysqlRootPw() ? tr('হোস্ট: 127.0.0.1 · ইউজার: root · পাসওয়ার্ড: সেট করা (Settings-এ বদলান)', 'Host: 127.0.0.1 · User: root · Password: set (change it in Settings)') : tr('হোস্ট: 127.0.0.1 · ইউজার: root · পাসওয়ার্ড: ফাঁকা', 'Host: 127.0.0.1 · User: root · Password: empty');
    },
    prepare: (svc, port) => writeMysqlIni(svc, port),
    isInitialized: () => fs.existsSync(path.join(mysqlDataDir(), 'mysql')),
    // root-এর পাসওয়ার্ড ফাঁকা (Laragon-এর মতো)
    init: (svc) => runTool(svc.exe, [`--defaults-file=${mysqlIni()}`, '--initialize-insecure', '--console'], svc.dir),
    spawnArgs: () => [
      `--defaults-file=${mysqlIni()}`,
      '--console',
      // পাসওয়ার্ড রিসেটের সময় শুধু একবার: শুরুতে ALTER USER চালায় (বর্তমান পাসওয়ার্ড লাগে না)
      ...(mysqlReset && fs.existsSync(mysqlReset.file) ? [`--init-file=${mysqlReset.file.replace(/\\/g, '/')}`] : []),
    ],
    check: (svc, port) => tcpCheck(port),
    shutdownCmd: (svc, port) => ({
      exe: path.join(svc.dir, 'bin', 'mysqladmin.exe'),
      args: ['--no-defaults', '-u', 'root', '--protocol=tcp', '-h', '127.0.0.1', `--port=${port}`, 'shutdown'],
      env: mysqlEnv(),
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
      return pgPw() ? tr('হোস্ট: 127.0.0.1 · ইউজার: postgres · পাসওয়ার্ড: সেট করা (Settings-এ বদলান)', 'Host: 127.0.0.1 · User: postgres · Password: set (change it in Settings)') : tr('হোস্ট: 127.0.0.1 · ইউজার: postgres · পাসওয়ার্ড: ফাঁকা', 'Host: 127.0.0.1 · User: postgres · Password: empty');
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

// PostgreSQL: postgres.exe পূর্ণ admin token-এ চালালে নিজে চলতে রাজি হয় না ("Execution of PostgreSQL by a user with
// administrative permissions is not permitted"); Task Scheduler-এর backup এই অবস্থায় পড়ে। pg_ctl Windows-এ নিজেই
// restricted token বানিয়ে postgres চালায়, তাই ওই ভুলে পড়লে `pg_ctl start` দিয়ে আবার চেষ্টা করি।
// pg_ctl-এর চালানো প্রসেস আমাদের child নয়, তাই postmaster.pid থেকে PID নিয়ে একটা "নকল proc" (pid + exit ইভেন্ট) বানাই,
// যাতে stopDatabase / before-quit / waitDbReady আগের মতোই কাজ করে।
const PG_ADMIN_ERR = /administrative permissions|unprivileged user|root privileges/i;
function pidProxy(pid) {
  const proc = new EventEmitter();
  proc.pid = pid;
  proc.exitCode = null;
  const timer = setInterval(() => {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = e.code === 'EPERM';
    }
    if (!alive) {
      clearInterval(timer);
      proc.exitCode = 0;
      proc.emit('exit', 0);
    }
  }, 1000);
  timer.unref();
  return proc;
}
async function startPostgresViaPgCtl(svc, port) {
  const dataDir = pgDataDir();
  const logFile = path.join(path.dirname(dataDir), 'pg_ctl-start.log');
  const lastLog = () => {
    try {
      return fs.readFileSync(logFile, 'utf8').trim().slice(-300);
    } catch {
      return '';
    }
  };
  // execFile নয়: চালু হওয়া postgres.exe stdout/stderr pipe ধরে রাখে, তখন execFile-এর callback timeout পর্যন্ত (৯০ সেকেন্ড) আটকে থাকে
  // (14:14 রানে প্রমাণিত)। stdio 'ignore' দিয়ে spawn করলে pg_ctl শেষ হওয়া মাত্রই ফেরে।
  const res = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const child = spawn(
      path.join(svc.dir, 'bin', 'pg_ctl.exe'),
      ['start', '-w', '-t', '60', '-D', dataDir, '-l', logFile, '-o', `-p ${port} -c listen_addresses=127.0.0.1`],
      { stdio: 'ignore', windowsHide: true }
    );
    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ err: tr('pg_ctl সময়মতো শেষ হয়নি', 'pg_ctl did not finish in time') });
    }, 90000);
    child.on('error', (e) => finish({ err: e.message }));
    child.on('exit', (code) => finish(code === 0 ? {} : { err: `exit code ${code}` }));
  });
  if (res.err) return { ok: false, reason: `pg_ctl: ${res.err.slice(-200)} ${lastLog()}`.trim() };
  let pid = 0;
  try {
    pid = parseInt(fs.readFileSync(path.join(dataDir, 'postmaster.pid'), 'utf8').split(/\r?\n/)[0], 10) || 0;
  } catch {}
  if (!pid) return { ok: false, reason: tr('postmaster.pid পাওয়া যায়নি', 'postmaster.pid not found') + ' ' + lastLog() };
  return { ok: true, proc: pidProxy(pid) };
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
      if (id === 'postgres' && settings.pgPw) {
        // নতুন ডাটা ফোল্ডার = trust, পাসওয়ার্ড ফাঁকা; পুরনো সেভ করা পাসওয়ার্ড রাখলে অ্যাপ আর ঢুকতে পারবে না
        delete settings.pgPw[activeVersion('postgres').version];
        saveSettings(settings);
      }
      if (id === 'mysql' && settings.mysqlRootPw) {
        // নতুন ডাটা ফোল্ডার = root পাসওয়ার্ড ফাঁকা; পুরনো সেভ করা পাসওয়ার্ড রাখলে অ্যাপ আর ঢুকতে পারবে না
        delete settings.mysqlRootPw[activeVersion('mysql').version];
        saveSettings(settings);
      }
    }

    sendStatus(tr(`${db.label} চালু হচ্ছে...`, `Starting ${db.label}...`));
    const proc = spawn(svc.exe, db.spawnArgs(svc, port), { cwd: svc.dir, windowsHide: true });
    trackPid(proc, db.stale, path.basename(svc.exe));
    let out = '';
    const collect = (d) => (out = (out + d).slice(-2000));
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    let r = await waitDbReady(db, svc, port, proc);
    let runProc = proc;
    if (!r.ok && id === 'postgres' && PG_ADMIN_ERR.test(out)) {
      // admin token সমস্যা: pg_ctl দিয়ে restricted token-এ আবার চেষ্টা
      sendStatus(tr('PostgreSQL admin অধিকারে চলতে চায় না, pg_ctl দিয়ে আবার চেষ্টা হচ্ছে...', 'PostgreSQL refuses to run with admin rights, retrying through pg_ctl...'));
      const pr = await startPostgresViaPgCtl(svc, port);
      if (pr.ok) {
        runProc = pr.proc;
        trackPid(runProc, db.stale, path.basename(svc.exe));
        r = { ok: true };
      } else {
        out = (out + ' | ' + pr.reason).slice(-600);
      }
    }
    if (!r.ok) {
      killTree(proc.pid);
      return tr(`সমস্যা: ${db.label} চালু হয়নি, ${r.reason}. ${out.trim().slice(-300)}`, `Error: ${db.label} failed to start, ${r.reason}. ${out.trim().slice(-300)}`);
    }

    await trackListener(runProc, port, db.stale, path.basename(svc.exe));
    dbRun[id] = { proc: runProc, port };
    runProc.on('exit', () => {
      if (dbRun[id] && dbRun[id].proc === runProc) delete dbRun[id];
    });
    let extra = '';
    if (id === 'mysql' && mysqlReset) extra = await finishMysqlReset(port);
    return tr(`${db.label} চালু হয়েছে (পোর্ট ${port})। ${db.info}${extra}`, `${db.label} started (port ${port}). ${db.info}${extra}`);
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
    execFile(cmd.exe, cmd.args, { timeout: 30000, windowsHide: true, env: cmd.env || process.env }, () => resolve())
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
  // Windows-এ Apache-র `-k restart` কনসোল মোডে কাজ করে না, তাই Apache-তে নিজেরাই বন্ধ করে আবার চালু করি (Nginx রিলোডই যথেষ্ট)
  if (running.id === 'apache') {
    const msg = await restartWebCore();
    if (!running) throw new Error(msg);
    return true;
  }
  if (svc.usesPHP && !svc.phpViaCgi) await startPhpCgis(neededPhpVersions(sites), running.phpPorts, running.procs);
  svc.beforeStart(svc, running.phpPorts, sites, running.webPort);
  await new Promise((resolve) => execFile(svc.exe, [...svc.args(svc.dir), ...svc.reloadArgs], { cwd: svc.dir }, () => resolve()));
  return true;
}

// চলমান ওয়েব সার্ভার বন্ধ করে (পোর্ট খালি হওয়া পর্যন্ত অপেক্ষা করে) আবার চালু করা। busy আগে থেকেই true থাকতে হবে।
async function restartWebCore() {
  const id = running.id;
  const port = running.webPort;
  stopWebServer();
  for (let i = 0; i < 40; i++) {
    if (await isPortFree(port)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return startWebServer(id, true);
}

// ---------- IPC ----------
async function startWebServer(id, keepBusy = false) {
  const svc = SERVICES[id];
  if (!svc || !['apache', 'nginx'].includes(id)) return tr('সমস্যা: অজানা সার্ভার', 'Error: unknown server');
  if (busy && !keepBusy) return tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...');
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
      if (!h.ok) hostsNote += hostsFailNote(h);
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
    await trackListener(r.proc, webPort, exeKind(svc.exe), path.basename(svc.exe));

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
    if (!keepBusy) busy = false;
  }
}

async function restartWebServer() {
  if (!running) return tr('কোনো ওয়েব সার্ভার চলছে না', 'No web server is running');
  if (busy) return tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...');
  busy = true;
  try {
    return await restartWebCore();
  } catch (err) {
    return tr('সমস্যা: ', 'Error: ') + err.message;
  } finally {
    busy = false;
  }
}
ipcMain.handle('service:restart', () => restartWebServer());

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


// ---------- MySQL root পাসওয়ার্ড বদলানো ----------
// এই পাসওয়ার্ড বসে WordPress/Laravel (নতুন সাইট), phpMyAdmin ও MySQL বন্ধ করার কমান্ডে। পুরনো সাইটের wp-config.php/.env-ও নিজে ঠিক করে।
function updateSitePasswords(newPw) {
  let wp = 0;
  let lv = 0;
  for (const s of withToolSites(scanSites()).filter((x) => !x.system)) {
    try {
      const wpf = path.join(s.root, 'wp-config.php');
      if (fs.existsSync(wpf)) {
        const txt = fs.readFileSync(wpf, 'utf8');
        if (/define\(\s*'DB_USER'\s*,\s*'root'\s*\)/.test(txt)) {
          const next = txt.replace(/(define\(\s*'DB_PASSWORD'\s*,\s*)'(?:[^'\\]|\\.)*'(\s*\))/, (_m, a, b) => a + phpStr(newPw) + b);
          if (next !== txt) {
            fs.writeFileSync(wpf, next);
            wp++;
          }
        }
      }
      const proj = laravelProjectOf(s);
      if (proj) {
        const envFile = path.join(proj, '.env');
        const txt = fs.readFileSync(envFile, 'utf8');
        if (/^DB_CONNECTION=mysql\s*$/m.test(txt) && /^DB_USERNAME=root\s*$/m.test(txt)) {
          fs.writeFileSync(envFile, setEnvValues(txt, { DB_PASSWORD: envVal(newPw) }));
          lv++;
        }
      }
    } catch {}
  }
  return { wp, lv };
}

ipcMain.handle('mysql:pwState', () => ({ hasPw: !!mysqlRootPw(), running: !!dbRun.mysql }));

ipcMain.handle('mysql:setPassword', async (_event, newPw) => {
  const fail = (m) => ({ ok: false, message: m });
  newPw = String(newPw === undefined || newPw === null ? '' : newPw);
  if (newPw.length > 64 || /[\r\n\0]/.test(newPw)) return fail(tr('সমস্যা: পাসওয়ার্ড সর্বোচ্চ ৬৪ অক্ষর, নতুন লাইন চলবে না', 'Error: the password may have up to 64 characters and no line breaks'));
  if (!dbRun.mysql) return fail(tr('আগে MySQL চালু করুন (সার্ভিস পেজ)', 'Start MySQL first (Services page)'));
  if (busy) return fail(tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...'));
  busy = true;
  try {
    const mysqlExe = path.join(SERVICES.mysql.dir, 'bin', 'mysql.exe');
    if (!fs.existsSync(mysqlExe)) throw new Error(tr('mysql.exe পাওয়া যায়নি', 'mysql.exe not found'));
    const port = getDbPort('mysql');
    // পাসওয়ার্ড কমান্ড-লাইনে না দিয়ে stdin দিয়ে পাঠাই
    await new Promise((resolve, reject) => {
      const ch = execFile(mysqlExe, ['--no-defaults', '-u', 'root', '-h', '127.0.0.1', '-P', String(port)], { env: mysqlEnv(), timeout: 30000, windowsHide: true }, (err, _o, stderr) => {
        if (!err) return resolve();
        const msg = String(stderr || err.message);
        reject(new Error(/Access denied/i.test(msg) ? tr('MySQL-এর বর্তমান পাসওয়ার্ড অ্যাপে রাখা পাসওয়ার্ডের সাথে মেলেনি (বাইরে থেকে বদলানো হয়েছে?)', "MySQL's current password does not match the one the app has stored (changed outside the app?)") : msg.trim().slice(0, 200)));
      });
      ch.stdin.end(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${sqlStr(newPw)};\n`);
    });
    const ver = activeVersion('mysql').version;
    settings.mysqlRootPw = { ...(settings.mysqlRootPw || {}) };
    if (newPw) settings.mysqlRootPw[ver] = newPw;
    else delete settings.mysqlRootPw[ver];
    saveSettings(settings);
    if (pmaInstalled()) writePmaConfig();
    const { wp, lv } = updateSitePasswords(newPw);
    let message = newPw ? tr('MySQL root পাসওয়ার্ড বদলানো হয়েছে', 'MySQL root password changed') : tr('MySQL root পাসওয়ার্ড সরানো হয়েছে (ফাঁকা)', 'MySQL root password removed (empty)');
    if (wp || lv) message += tr(` · সাইট ঠিক করা হয়েছে: WordPress ${wp}, Laravel ${lv}`, ` · sites updated: WordPress ${wp}, Laravel ${lv}`);
    if (newPw) message += tr(' · Adminer-এ লগইনে এই পাসওয়ার্ড দিন', ' · enter this password when logging in to Adminer');
    return { ok: true, message };
  } catch (err) {
    return fail(tr('সমস্যা: ', 'Error: ') + err.message);
  } finally {
    busy = false;
  }
});

// ---------- MySQL root পাসওয়ার্ড রিসেট (ভুলে গেলে) ও পাসওয়ার্ড দেখা ----------
// MySQL বন্ধ থাকলে: একটা ছোট SQL ফাইল (ALTER USER) বানিয়ে mysqld-কে --init-file দিয়ে চালু করি; সার্ভার চালুর সময় এটা চালায়, বর্তমান পাসওয়ার্ড লাগে না।
// তারপর নতুন পাসওয়ার্ডে ঢুকে যাচাই করি, সেটিংস/phpMyAdmin/সাইট ঠিক করি, আর SQL ফাইল মুছে দিই।
function mysqlRun(sql, pw, port) {
  return new Promise((resolve, reject) => {
    const exe = path.join(SERVICES.mysql.dir, 'bin', 'mysql.exe');
    const ch = execFile(exe, ['--no-defaults', '-u', 'root', '-h', '127.0.0.1', '-P', String(port)], { env: mysqlEnv(pw), timeout: 30000, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve()));
    ch.stdin.end(sql);
  });
}

async function finishMysqlReset(port) {
  const rs = mysqlReset;
  mysqlReset = null;
  try {
    let ok = false;
    let lastErr = '';
    for (let i = 0; i < 8 && !ok; i++) {
      try {
        await mysqlRun('SELECT 1;\n', rs.pw, port);
        ok = true;
      } catch (e) {
        lastErr = e.message;
        await sleep(1000);
      }
    }
    if (!ok) throw new Error(lastErr);
    settings.mysqlRootPw = { ...(settings.mysqlRootPw || {}) };
    if (rs.pw) settings.mysqlRootPw[rs.ver] = rs.pw;
    else delete settings.mysqlRootPw[rs.ver];
    saveSettings(settings);
    if (pmaInstalled()) writePmaConfig();
    const { wp, lv } = updateSitePasswords(rs.pw);
    rs.result = { ok: true };
    return tr(` · root পাসওয়ার্ড রিসেট হয়েছে (সাইট ঠিক করা হয়েছে: WordPress ${wp}, Laravel ${lv})`, ` · root password reset (sites updated: WordPress ${wp}, Laravel ${lv})`);
  } catch (e) {
    rs.result = { ok: false };
    return tr(' · সতর্কতা: পাসওয়ার্ড রিসেট যাচাই করা যায়নি: ', ' · warning: could not verify the password reset: ') + e.message;
  }
}

ipcMain.handle('mysql:resetPassword', async (_event, newPw) => {
  const fail = (m) => ({ ok: false, message: m });
  newPw = String(newPw === undefined || newPw === null ? '' : newPw);
  if (newPw.length > 64 || /[\r\n\0]/.test(newPw)) return fail(tr('সমস্যা: পাসওয়ার্ড সর্বোচ্চ ৬৪ অক্ষর, নতুন লাইন চলবে না', 'Error: the password may have up to 64 characters and no line breaks'));
  if (dbRun.mysql) return fail(tr('আগে MySQL বন্ধ করুন (সার্ভিস পেজ), রিসেটের জন্য MySQL-কে নতুন করে চালু করতে হয়', 'Stop MySQL first (Services page), the reset needs a fresh start of MySQL'));
  if (busy) return fail(tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...'));
  if (!fs.existsSync(SERVICES.mysql.exe) || !DATABASES.mysql.isInitialized()) return fail(tr('MySQL-এর ডাটা এখনো তৈরি হয়নি, রিসেট করার কিছু নেই (আগে MySQL একবার চালান)', 'MySQL data has not been created yet, nothing to reset (start MySQL once first)'));
  const ver = activeVersion('mysql').version;
  const file = path.join(ROOT_DIR, 'data', `mysql-reset-${ver}.sql`);
  const rs = { ver, pw: newPw, file, result: null };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `ALTER USER 'root'@'localhost' IDENTIFIED BY ${sqlStr(newPw)};\n`);
    mysqlReset = rs;
    const msg = await startDatabase('mysql');
    return { ok: !!(rs.result && rs.result.ok), message: msg };
  } catch (err) {
    return fail(tr('সমস্যা: ', 'Error: ') + err.message);
  } finally {
    mysqlReset = null;
    try {
      fs.rmSync(file, { force: true });
    } catch {}
  }
});

// অ্যাপে সেভ করা পাসওয়ার্ড দেখা/কপির জন্য (ফাঁকা হলে '')
ipcMain.handle('db:getPw', (_event, kind) => (kind === 'postgres' ? pgPw() : kind === 'mysql' ? mysqlRootPw() : ''));

// ---------- কনফিগ ফাইল (php.ini, my.ini, postgresql.conf ...) ----------
// renderer শুধু id পাঠায়; পথ এখানে ঠিক করা হয়।
function cfgResolve(id) {
  id = String(id || '');
  if (id.startsWith('php:')) {
    const v = phpVersionList().find((x) => x.version === id.slice(4) && x.installed);
    return v ? { file: path.join(v.dir, 'php.ini'), kind: 'php' } : null;
  }
  if (id === 'mysql:ini') return { file: mysqlIni(), kind: 'mysqlini' };
  if (id === 'mysql:extra') return { file: mysqlExtraIni(), kind: 'mysqlextra' };
  if (id === 'pg:conf') return { file: path.join(pgDataDir(), 'postgresql.conf'), kind: 'pgconf' };
  if (id === 'pg:hba') return { file: path.join(pgDataDir(), 'pg_hba.conf'), kind: 'pghba' };
  return null;
}

ipcMain.handle('cfg:list', () => {
  const out = [];
  const add = (id, label, kind, note) => {
    const r = cfgResolve(id);
    if (!r) return;
    out.push({ id, label, kind, note, file: r.file, exists: fs.existsSync(r.file), canOpen: fs.existsSync(r.file) || id === 'mysql:extra' });
  };
  for (const v of phpVersionList().filter((x) => x.installed)) {
    add('php:' + v.version, `php.ini (PHP ${v.version})`, 'mixed', tr('প্রতি Start-এ রিসেট হয়: extension টগল, upload_max_filesize/post_max_size (128M), session.save_path, upload_tmp_dir, sys_temp_dir, auto_prepend_file। বাকি (memory_limit, max_execution_time, display_errors, opcache ...) আপনার। বদলের পর ওয়েব সার্ভার Stop/Start করুন।', 'Reset on every start: extension toggles, upload_max_filesize/post_max_size (128M), session.save_path, upload_tmp_dir, sys_temp_dir, auto_prepend_file. The rest (memory_limit, max_execution_time, display_errors, opcache ...) is yours. Stop/Start the web server after a change.'));
  }
  const my = activeVersion('mysql').version;
  add('mysql:ini', `my.ini (MySQL ${my})`, 'auto', tr('প্রতিবার MySQL চালুর সময় পুরো ফাইল নতুন করে লেখা হয়, এখানে বদল রাখলে হারাবে। নিজের সেটিং নিচের my-extra.ini-তে লিখুন।', 'The whole file is rewritten every time MySQL starts, edits here are lost. Put your own settings in my-extra.ini below.'));
  add('mysql:extra', `my-extra.ini (MySQL ${my})`, 'yours', tr('আপনার ফাইল, অ্যাপ বদলায় না; my.ini এটা শেষে include করে। [mysqld] এর নিচে লিখুন, সেভ করে MySQL Restart করুন। ভুল লিখলে MySQL চালু নাও হতে পারে।', 'Your file, the app never changes it; my.ini includes it at the end. Write under [mysqld], save and restart MySQL. A mistake can stop MySQL from starting.'));
  const pg = activeVersion('postgres').version;
  add('pg:conf', `postgresql.conf (PostgreSQL ${pg})`, 'yours', tr('আপনার ফাইল, অ্যাপ এটা ছোঁয় না। বদলের পর PostgreSQL Restart করুন।', 'Your file, the app does not touch it. Restart PostgreSQL after a change.'));
  add('pg:hba', `pg_hba.conf (PostgreSQL ${pg})`, 'mixed', tr('পাসওয়ার্ড বসালে/সরালে অ্যাপ শুধু শেষ কলামের trust ↔ scram-sha-256 বদলায়, বাকি লাইন আপনার। ভুল করলে ঢোকা যাবে না, আসল কপি pg_hba.conf.server360-bak।', 'When you set/remove the password the app only swaps trust ↔ scram-sha-256 in the last column, other lines are yours. A mistake can lock you out, the original copy is pg_hba.conf.server360-bak.'));
  return out;
});

ipcMain.handle('cfg:open', (_event, id) => {
  const r = cfgResolve(id);
  if (!r) return { ok: false, message: tr('সমস্যা: ফাইলটা পাওয়া যায়নি', 'Error: file not found') };
  try {
    if (r.kind === 'mysqlextra') ensureMysqlExtra();
    if (!fs.existsSync(r.file)) {
      return { ok: false, message: tr(`${r.file} এখনো তৈরি হয়নি (সংশ্লিষ্ট প্রোগ্রাম একবার চালালে তৈরি হবে)`, `${r.file} does not exist yet (it is created the first time the program runs)`) };
    }
    const child = spawn('notepad.exe', [r.file], { detached: true, stdio: 'ignore' });
    child.on('error', () => shell.showItemInFolder(r.file));
    child.unref();
    const warn = r.kind === 'mysqlini' ? tr(' · সাবধান: এটা প্রতিবার নতুন লেখা হয়, নিজের সেটিং my-extra.ini-তে দিন', ' · note: this file is rewritten every start, put your own settings in my-extra.ini') : '';
    return { ok: true, message: tr(`${r.file} খোলা হয়েছে${warn}`, `${r.file} opened${warn}`) };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

ipcMain.handle('cfg:folder', (_event, id) => {
  const r = cfgResolve(id);
  if (!r) return;
  if (fs.existsSync(r.file)) shell.showItemInFolder(r.file);
  else if (fs.existsSync(path.dirname(r.file))) shell.openPath(path.dirname(r.file));
});

// ---------- PostgreSQL postgres পাসওয়ার্ড বদলানো ----------
// initdb -A trust মানে pg_hba.conf-এ সব লাইন trust। পাসওয়ার্ড বসালে role-এ পাসওয়ার্ড দিই এবং pg_hba.conf-এর trust -> scram-sha-256 করে
// pg_ctl reload দিই; সরালে উল্টোটা। pg_hba.conf-এর প্রথম ব্যাকআপ থাকে pg_hba.conf.server360-bak নামে।
// পাসওয়ার্ড সংশোধন psql-এ stdin দিয়ে যায় (কমান্ড-লাইনে নয়), বর্তমান পাসওয়ার্ড PGPASSWORD env-এ।
function pgHbaSwap(txt, to) {
  const from = to === 'trust' ? 'scram-sha-256' : 'trust';
  const eol = txt.includes('\r\n') ? '\r\n' : '\n';
  let swapped = 0;
  let already = 0;
  const out = txt.split(/\r?\n/).map((line) => {
    const code = line.replace(/#.*$/, '');
    const toks = [...code.matchAll(/\S+/g)];
    if (!toks.length) return line;
    const idx = toks[0][0] === 'local' ? 3 : /^host/.test(toks[0][0]) ? 4 : -1;
    if (idx < 0 || !toks[idx]) return line;
    const cur = toks[idx][0];
    if (cur === to) already++;
    if (cur !== from) return line;
    swapped++;
    return line.slice(0, toks[idx].index) + to + line.slice(toks[idx].index + cur.length);
  });
  return { text: out.join(eol), swapped, already };
}

const pgBin = (n) => path.join(SERVICES.postgres.dir, 'bin', n);
function runPsql(input, pw) {
  return new Promise((resolve, reject) => {
    const args = ['-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', String(getDbPort('postgres')), '-U', 'postgres', '-d', 'postgres'];
    const ch = execFile(pgBin('psql.exe'), args, { env: pgEnv(pw), timeout: 30000, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve()));
    ch.stdin.end(input);
  });
}
function pgReload() {
  return new Promise((resolve, reject) =>
    execFile(pgBin('pg_ctl.exe'), ['reload', '-D', pgDataDir()], { timeout: 15000, windowsHide: true }, (err, _o, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve()))
  );
}
// pg_hba.conf লিখে reload করা; ফেরত: false হলে আগের অবস্থা ফিরিয়ে দেওয়ার জন্য মূল লেখা আছে
async function pgSetAuth(to) {
  const f = path.join(pgDataDir(), 'pg_hba.conf');
  const before = fs.readFileSync(f, 'utf8');
  const r = pgHbaSwap(before, to);
  if (!r.swapped && !r.already) throw new Error(tr('pg_hba.conf-এর লাইন চেনা গেল না (হাতে বদলানো?), অ্যাপ এটা বদলাতে পারছে না', 'Could not recognize the lines in pg_hba.conf (edited by hand?), the app cannot change it'));
  const bak = f + '.server360-bak';
  if (!fs.existsSync(bak)) fs.copyFileSync(f, bak);
  if (r.swapped) fs.writeFileSync(f, r.text);
  await pgReload();
  return { f, before };
}
const pgRevert = async (st) => {
  try {
    if (st) {
      fs.writeFileSync(st.f, st.before);
      await pgReload();
    }
  } catch {}
};
const pgAuthErr = (m) => /password|authentication|no password supplied/i.test(m);

ipcMain.handle('pg:pwState', () => ({ hasPw: !!pgPw(), running: !!dbRun.postgres }));

ipcMain.handle('pg:setPassword', async (_event, newPw, reset) => {
  const fail = (m) => ({ ok: false, message: m });
  newPw = String(newPw === undefined || newPw === null ? '' : newPw);
  if (newPw.length > 64 || /[\r\n\0]/.test(newPw)) return fail(tr('সমস্যা: পাসওয়ার্ড সর্বোচ্চ ৬৪ অক্ষর, নতুন লাইন চলবে না', 'Error: the password may have up to 64 characters and no line breaks'));
  if (!dbRun.postgres) return fail(tr('আগে PostgreSQL চালু করুন (সার্ভিস পেজ)', 'Start PostgreSQL first (Services page)'));
  if (busy) return fail(tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...'));
  busy = true;
  let hba = null; // প্রথম বদলানোর আগের pg_hba.conf (ব্যর্থ হলে ফেরানোর জন্য)
  const waitOpen = async () => {
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      try {
        await runPsql('SELECT 1;\n', '');
        return true;
      } catch {}
    }
    return false;
  };
  try {
    if (!fs.existsSync(pgBin('psql.exe'))) throw new Error(tr('psql.exe পাওয়া যায়নি', 'psql.exe not found'));
    if (!fs.existsSync(path.join(pgDataDir(), 'pg_hba.conf'))) throw new Error(tr('pg_hba.conf পাওয়া যায়নি', 'pg_hba.conf not found'));
    const ver = activeVersion('postgres').version;
    const oldPw = pgPw();
    const save = () => {
      settings.pgPw = { ...(settings.pgPw || {}) };
      if (newPw) settings.pgPw[ver] = newPw;
      else delete settings.pgPw[ver];
      saveSettings(settings);
    };
    const mismatch = () => new Error(tr('PostgreSQL-এর বর্তমান পাসওয়ার্ড অ্যাপে রাখা পাসওয়ার্ডের সাথে মেলেনি (বাইরে থেকে বদলানো হয়েছে?)। "ভুলে গেছেন? রিসেট" ব্যবহার করুন', "PostgreSQL's current password does not match the one the app has stored (changed outside the app?). Use \"Forgot? Reset\""));
    let warn = '';

    // trust করে নিয়ে ঢোকা (সরানো ও রিসেটের জন্য: বর্তমান পাসওয়ার্ড না জানলেও কাজ করে)
    const openUp = async () => {
      const st = await pgSetAuth('trust');
      hba = hba || st;
      if (!(await waitOpen())) throw new Error(tr('pg_hba.conf reload হয়নি, PostgreSQL একবার Restart করে আবার চেষ্টা করুন', 'pg_hba.conf was not reloaded, restart PostgreSQL once and try again'));
    };

    if (newPw) {
      // ১) role-এ পাসওয়ার্ড: রিসেট হলে আগে trust করে (পুরনো পাসওয়ার্ড লাগে না), নইলে এখনকার অবস্থায় ঢুকে
      if (reset) {
        await openUp();
        await runPsql(`ALTER ROLE postgres WITH PASSWORD ${pgStr(newPw)};\n`, '');
      } else {
        try {
          await runPsql(`ALTER ROLE postgres WITH PASSWORD ${pgStr(newPw)};\n`, oldPw);
        } catch (e) {
          throw pgAuthErr(e.message) ? mismatch() : e;
        }
      }
      save();
      // ২) pg_hba.conf: trust -> scram-sha-256 + reload
      const st2 = await pgSetAuth('scram-sha-256');
      hba = hba || st2;
      // ৩) যাচাই: ভুল পাসওয়ার্ড ফিরে যাবে, ঠিকটা ঢুকবে
      let enforced = false;
      for (let i = 0; i < 10 && !enforced; i++) {
        await sleep(500);
        try {
          await runPsql('SELECT 1;\n', newPw + '_wrong');
        } catch {
          enforced = true;
        }
      }
      try {
        await runPsql('SELECT 1;\n', newPw);
      } catch (e) {
        await pgRevert(hba);
        throw new Error(tr('নতুন পাসওয়ার্ডে ঢোকা গেল না, pg_hba.conf আগের অবস্থায় ফেরানো হয়েছে: ', 'Could not log in with the new password, pg_hba.conf was restored: ') + e.message);
      }
      if (!enforced) warn = tr(' · সতর্কতা: পাসওয়ার্ড এখনো বাধ্যতামূলক হয়নি মনে হচ্ছে, PostgreSQL একবার Restart করুন', ' · warning: the password does not seem to be enforced yet, restart PostgreSQL once');
    } else {
      // সরানো: আগে trust, তারপর role-এর পাসওয়ার্ড মুছি (সেভ করা পাসওয়ার্ড না মিললেও কাজ হয়)
      await openUp();
      await runPsql('ALTER ROLE postgres WITH PASSWORD NULL;\n', '');
      save();
    }
    const done = newPw ? (reset ? tr('PostgreSQL পাসওয়ার্ড রিসেট হয়েছে (ইউজার postgres)', 'PostgreSQL password reset (user postgres)') : tr('PostgreSQL পাসওয়ার্ড বদলানো হয়েছে (ইউজার postgres)', 'PostgreSQL password changed (user postgres)')) : tr('PostgreSQL পাসওয়ার্ড সরানো হয়েছে (ফাঁকা)', 'PostgreSQL password removed (empty)');
    return { ok: true, message: done + (newPw ? tr(' · Adminer-এ লগইনে এই পাসওয়ার্ড দিন', ' · enter this password when logging in to Adminer') : '') + warn };
  } catch (err) {
    // সরানো বা রিসেট মাঝপথে থামলে pg_hba.conf আগের অবস্থায় (সাধারণত scram) ফেরানো
    if (hba && (!newPw || reset)) await pgRevert(hba);
    return fail(tr('সমস্যা: ', 'Error: ') + err.message);
  } finally {
    busy = false;
  }
});

// ---------- LAN-এ শেয়ার (অন্য পিসি/ফোন থেকে http://<LAN-IP>:<পোর্ট>) ----------
// settings.siteShare = { '<domain>': { on: true|false, port: <n> } }
// শেয়ার চালু থাকলে ওই সাইটের server ব্লক আরেকটা পোর্টেও শোনে (Nginx: নতুন server ব্লক, Apache: নতুন Listen + VirtualHost)।
// Node সাইট একই reverse proxy দিয়ে যায়। Adminer/phpMyAdmin/localhost কখনো শেয়ার হয় না।
const SHARE_BASE = 8100;
const shareCfg = (d) => (settings.siteShare && settings.siteShare[d]) || null;
const sharePortOf = (d) => {
  const c = shareCfg(d);
  return c && c.on && Number.isInteger(c.port) ? c.port : 0;
};
const shareable = (s) => !s.system && !s.disabled && sharePortOf(s.domain) > 0;
const sharedPorts = (sites) => [...new Set(sites.filter(shareable).map((s) => sharePortOf(s.domain)))];
function sharePortTaken(port, exceptDomain) {
  if (port === getWebPort()) return true;
  if (Object.keys(DATABASES).some((id) => getDbPort(id) === port)) return true;
  if (Object.values(settings.nodeSites || {}).some((c) => c && c.port === port)) return true;
  return Object.entries(settings.siteShare || {}).some(([d, c]) => d !== exceptDomain && c && c.port === port);
}
async function pickSharePort(domain) {
  for (let p = SHARE_BASE; p < SHARE_BASE + 500; p++) {
    if (!sharePortTaken(p, domain) && (await isPortFree(p))) return p;
  }
  throw new Error(tr('শেয়ারের জন্য খালি পোর্ট পাওয়া যায়নি', 'No free port found for sharing'));
}
// এই পিসির LAN IP (প্রাইভেট রেঞ্জ আগে; 169.254.* বাদ)
function lanIps() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.')) out.push({ name, ip: i.address });
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.ip) - rank(b.ip));
}
const fwRuleName = (exe) => `Server 360 - ${path.basename(exe)}`;
const webExes = () => ['nginx', 'apache'].map((id) => SERVICES[id].exe).filter((e) => e && fs.existsSync(e));
function fwRuleExists(name) {
  return new Promise((resolve) => execFile('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], { windowsHide: true, timeout: 10000 }, (err) => resolve(!err)));
}
async function fwState() {
  const exes = webExes();
  if (!exes.length) return { known: false, ok: false };
  const all = await Promise.all(exes.map((e) => fwRuleExists(fwRuleName(e))));
  return { known: true, ok: all.every(Boolean) };
}

ipcMain.handle('net:info', async () => ({ ips: lanIps().map((x) => x.ip), fw: await fwState() }));

// Windows Firewall-এ Nginx/Apache-র জন্য ইনবাউন্ড নিয়ম (প্রাইভেট ও ডোমেইন নেটওয়ার্ক)। UAC লাগে; না হলে .cmd ফাইল হাতে চালাতে হয়।
ipcMain.handle('fw:allow', async () => {
  const exes = webExes();
  if (!exes.length) return { ok: false, message: tr('আগে একটা ওয়েব সার্ভার একবার চালু করুন (নামাতে হবে)', 'Start a web server once first (it must be downloaded)') };
  const cmdFile = path.join(TOOLS_DIR, 'allow-firewall.cmd');
  const lines = [
    '@echo off',
    'net session >nul 2>&1',
    'if errorlevel 1 ( echo Run this file as Administrator. & pause & exit /b 1 )',
    ...exes.flatMap((e) => [`netsh advfirewall firewall delete rule name="${fwRuleName(e)}" >nul 2>&1`, `netsh advfirewall firewall add rule name="${fwRuleName(e)}" dir=in action=allow program="${e}" enable=yes profile=private,domain`]),
    'echo Done.',
  ];
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(cmdFile, lines.join('\r\n') + '\r\n');
  await new Promise((resolve) =>
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c','"${cmdFile}"' -Verb RunAs -Wait`], { windowsHide: true, timeout: 120000 }, () => resolve())
  );
  const st = await fwState();
  if (st.ok) return { ok: true, message: tr('Firewall-এ অনুমতি দেওয়া হয়েছে (প্রাইভেট/ডোমেইন নেটওয়ার্ক)', 'Firewall rule added (private/domain networks)') };
  shell.showItemInFolder(cmdFile);
  return { ok: false, message: tr(`Firewall নিয়ম বসানো যায়নি। Explorer-এ খোলা ${path.basename(cmdFile)} ফাইলে ডান ক্লিক করে "Run as administrator" দিন`, `Could not add the firewall rule. In the Explorer window, right-click ${path.basename(cmdFile)} and choose "Run as administrator"`) };
});

// B4: পাবলিক সার্ভারের জন্য TCP 80 + 443 ইনবাউন্ড নিয়ম (সব প্রোফাইল, প্রোগ্রাম নির্বিশেষে)। UAC লাগে; না হলে .cmd ফাইল হাতে চালাতে হয়।
const PUBLIC_FW_RULE = 'Server 360 - Public web 80,443';
ipcMain.handle('fw:allowPublic', async () => {
  const cmdFile = path.join(TOOLS_DIR, 'allow-firewall-public.cmd');
  const lines = [
    '@echo off',
    'net session >nul 2>&1',
    'if errorlevel 1 ( echo Run this file as Administrator. & pause & exit /b 1 )',
    `netsh advfirewall firewall delete rule name=\"${PUBLIC_FW_RULE}\" >nul 2>&1`,
    `netsh advfirewall firewall add rule name=\"${PUBLIC_FW_RULE}\" dir=in action=allow protocol=TCP localport=80,443 enable=yes profile=any`,
    'echo Done.',
  ];
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(cmdFile, lines.join('\r\n') + '\r\n');
  await new Promise((resolve) =>
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c','\"${cmdFile}\"' -Verb RunAs -Wait`], { windowsHide: true, timeout: 120000 }, () => resolve())
  );
  if (await fwRuleExists(PUBLIC_FW_RULE)) return { ok: true, message: tr('Firewall-এ পোর্ট ৮০ ও ৪৪৩ খোলা হয়েছে', 'Firewall: ports 80 and 443 are now allowed') };
  shell.showItemInFolder(cmdFile);
  return { ok: false, message: tr(`Firewall নিয়ম বসানো যায়নি। Explorer-এ খোলা ${path.basename(cmdFile)} ফাইলে ডান ক্লিক করে \"Run as administrator\" দিন`, `Could not add the firewall rule. In the Explorer window, right-click ${path.basename(cmdFile)} and choose \"Run as administrator\"`) };
});

ipcMain.handle('site:setShare', async (_event, domain, on, portRaw) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const sites = withToolSites(scanSites());
  const site = sites.find((s) => s.domain === domain);
  if (!site || site.system) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  busy = true;
  try {
    const old = shareCfg(domain);
    let port = old && Number.isInteger(old.port) ? old.port : 0;
    const raw = String(portRaw === undefined || portRaw === null ? '' : portRaw).trim();
    if (raw !== '') {
      const n = /^\d+$/.test(raw) ? parseInt(raw, 10) : 0;
      if (n < 1024 || n > 65535) throw new Error(tr('পোর্ট ১০২৪ থেকে ৬৫৫৩৫-এর মধ্যে হতে হবে', 'The port must be between 1024 and 65535'));
      if (sharePortTaken(n, domain)) throw new Error(tr(`পোর্ট ${n} অন্য কাজে ব্যবহৃত (ওয়েব/ডাটাবেস/Node/অন্য শেয়ার)`, `Port ${n} is already used (web/database/Node/another share)`));
      port = n;
    }
    if (on) {
      const wasLive = old && old.on && old.port === port;
      if (!port) port = await pickSharePort(domain);
      else if (!wasLive && !(await isPortFree(port))) throw new Error(tr(`পোর্ট ${port} অন্য প্রোগ্রাম ব্যবহার করছে, আরেকটা দিন`, `Port ${port} is used by another program, choose another`));
    }
    settings.siteShare = { ...(settings.siteShare || {}), [domain]: { on: !!on, port } };
    saveSettings(settings);
    const live = await reloadRunning(withToolSites(scanSites()));
    const ip = (lanIps()[0] || {}).ip || '<IP>';
    let message = on ? tr(`${domain} শেয়ার চালু: http://${ip}:${port}`, `${domain} is shared: http://${ip}:${port}`) : tr(`${domain}-এর শেয়ার বন্ধ`, `Sharing of ${domain} is off`);
    if (on && !live) message += tr(' (ওয়েব সার্ভার চালু করলে কাজ করবে)', ' (it will work once a web server is started)');
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

const publicSites = (sites) => [
  { name: 'localhost', domain: 'localhost', root: WWW_DIR, system: false, url: siteUrl('localhost'), php: defaultPhpVersion(), phpPinned: '', sessionMin: 0, phpIni: {}, enabled: true },
  ...sites.map(({ name, domain, root, system, disabled, node }) => ({
    name,
    node: !!node,
    enabled: !disabled,
    domain,
    root,
    system: !!system,
    url: siteUrl(domain),
    php: system ? defaultPhpVersion() : sitePhpVersion(domain),
    phpPinned: system ? '' : pinnedPhp(domain),
    sessionMin: system ? 0 : siteSessionMin(domain),
    phpIni: system ? {} : { ...siteIni(domain), ...siteUserIni(domain) },
    publicNames: system ? [] : sitePublicNames(domain),
    share: system ? { on: false, port: 0 } : { on: sharePortOf(domain) > 0, port: (shareCfg(domain) || {}).port || 0 },
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
    const n = sites.filter((x) => !x.system && !x.disabled).length;
    let message;
    if (await reloadRunning(sites)) {
      message = tr(`${n}টা সাইট লোড হয়েছে`, `${n} site(s) loaded`);
    } else {
      message = tr(`${n}টা সাইট পাওয়া গেছে (ওয়েব সার্ভার চালু করলে কাজ করবে)`, `${n} site(s) found (they will work once a web server is started)`);
    }
    if (!h.ok) message += hostsFailNote(h);
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
  // async: হাজার হাজার ছোট ফাইল কপি/মোছার সময় sync কল পুরো উইন্ডো আটকে দিত ("Not Responding")
  await fs.promises.cp(src, dest, { recursive: true });
  await fs.promises.rm(tmp, { recursive: true, force: true });
  // ডাটাবেস বানানো (root, খালি পাসওয়ার্ড)
  sendStatus(tr('ডাটাবেস বানানো হচ্ছে...', 'Creating database...'));
  await createMysqlDb(mysqlExe, port, dbName);
  // wp-config.php
  let cfg = fs.readFileSync(path.join(dest, 'wp-config-sample.php'), 'utf8');
  cfg = cfg
    .replace('database_name_here', dbName)
    .replace('username_here', 'root')
    .replace("'password_here'", () => phpStr(mysqlRootPw()))
    .replace("'localhost'", `'127.0.0.1:${port}'`)
    .replace(/define\(\s*'(AUTH_KEY|SECURE_AUTH_KEY|LOGGED_IN_KEY|NONCE_KEY|AUTH_SALT|SECURE_AUTH_SALT|LOGGED_IN_SALT|NONCE_SALT)',\s*'put your unique phrase here'\s*\);/g, (_m, k) => `define( '${k}', '${crypto.randomBytes(32).toString('hex')}' );`);
  fs.writeFileSync(path.join(dest, 'wp-config.php'), cfg);
}


// MySQL-এ ডাটাবেস বানানো (root, খালি পাসওয়ার্ড); WordPress ও Laravel দুটোই এটা ব্যবহার করে
function createMysqlDb(mysqlExe, port, dbName) {
  return new Promise((resolve, reject) =>
    execFile(mysqlExe, ['-u', 'root', '-h', '127.0.0.1', '-P', String(port), '-e', `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`], { timeout: 30000, windowsHide: true, env: mysqlEnv() }, (err, _o, stderr) =>
      err ? reject(new Error(tr('ডাটাবেস বানানো যায়নি: ', 'Could not create the database: ') + String(stderr || err.message).trim().slice(0, 200))) : resolve()
    )
  );
}

// ---------- Laravel (Composer দিয়ে) ----------
const COMPOSER_URL = 'https://getcomposer.org/download/latest-stable/composer.phar';
// Laravel চালাতে যেগুলো লাগে (ব্যবহারকারী বন্ধ করে রাখলে ইনস্টলের সময় নিজে চালু করে দিই)
const LARAVEL_EXTS = ['mbstring', 'openssl', 'pdo_mysql', 'fileinfo', 'curl', 'zip'];
const LARAVEL_DEFAULT_SESSION_MIN = 120; // Laravel-এর নিজের ডিফল্ট

// .env ফাইলে key=value বসানো (থাকলে বদলায়, কমেন্ট করা থাকলে চালু করে, না থাকলে শেষে যোগ করে)
function setEnvValues(txt, values) {
  for (const [k, v] of Object.entries(values)) {
    const re = new RegExp(`^#?[ \\t]*${k}=.*$`, 'm');
    const line = `${k}=${v}`;
    txt = re.test(txt) ? txt.replace(re, () => line) : txt.replace(/\s*$/, '\n') + line + '\n'; // () => line: পাসওয়ার্ডের $& / $' যেন বিশেষ চিহ্ন না হয়
  }
  return txt;
}

// সাইটটা Laravel হলে তার প্রজেক্ট ফোল্ডার (public-এর একধাপ উপরে), নাহলে ''
function laravelProjectOf(site) {
  if (!site) return '';
  const dir = path.basename(site.root).toLowerCase() === 'public' ? path.dirname(site.root) : site.root;
  return fs.existsSync(path.join(dir, 'artisan')) && fs.existsSync(path.join(dir, '.env')) ? dir : '';
}

function ensureLaravelExts(ver) {
  refreshPhpIni(phpDirOf(ver));
  const l = phpExtList(ver);
  if (!l) return [];
  const off = LARAVEL_EXTS.filter((n) => l.items.some((i) => i.name === n && !i.enabled));
  if (!off.length) return [];
  settings.phpExt = { ...(settings.phpExt || {}) };
  settings.phpExt[ver] = { ...(settings.phpExt[ver] || {}) };
  off.forEach((n) => (settings.phpExt[ver][n] = true));
  saveSettings(settings);
  refreshPhpIni(phpDirOf(ver));
  return off;
}

// php.exe দিয়ে কমান্ড চালানো; শেষ লাইন স্ট্যাটাস বারে দেখায়, ব্যর্থ হলে শেষের কিছু লাইন সহ এরর দেয়
function runPhp(phpExe, args, { cwd, env, label, timeoutMs = 20 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(phpExe, args, { cwd, env, windowsHide: true });
    let tail = '';
    let last = 0;
    const onData = (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      const line = s.split(/[\r\n]+/).map((x) => x.trim()).filter(Boolean).pop();
      if (line && Date.now() - last > 400) {
        last = Date.now();
        sendStatus(`${label}: ${line.slice(0, 90)}`);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    const timer = setTimeout(() => {
      killTree(proc.pid);
      reject(new Error(tr('অনেক সময় লাগছে, বন্ধ করা হলো (ইন্টারনেট ঠিক আছে কিনা দেখুন)', 'Took too long and was stopped (check your internet connection)')));
    }, timeoutMs);
    proc.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(tail);
      const lines = tail.trim().split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(-6).join(' | ');
      reject(new Error(tr(`কমান্ড ব্যর্থ (কোড ${code}): `, `Command failed (code ${code}): `) + lines.slice(-400)));
    });
  });
}

async function installLaravel(dest, name, dbName) {
  if (!dbRun.mysql) throw new Error(tr('আগে MySQL চালু করুন (সার্ভিস পেজ)', 'Start MySQL first (Services page)'));
  const mysqlExe = path.join(SERVICES.mysql.dir, 'bin', 'mysql.exe');
  if (!fs.existsSync(mysqlExe)) throw new Error(tr('mysql.exe পাওয়া যায়নি', 'mysql.exe not found'));
  const port = getDbPort('mysql');

  // PHP (CLI) ও Visual C++ নিশ্চিত করা; php.exe-ই Composer চালাবে
  await ensureVCRedist();
  await ensureService(SERVICES.php);
  const ver = defaultPhpVersion();
  const phpDir = phpDirOf(ver);
  const phpExe = path.join(phpDir, 'php.exe');
  if (!fs.existsSync(phpExe)) throw new Error(tr('php.exe পাওয়া যায়নি', 'php.exe not found'));
  const turnedOn = ensureLaravelExts(ver);

  // Composer একবার নামিয়ে ক্যাশে রাখা
  const cacheDir = path.join(ROOT_DIR, 'data', 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const phar = path.join(cacheDir, 'composer.phar');
  if (!fs.existsSync(phar) || fs.statSync(phar).size < 500 * 1024) {
    await download(COMPOSER_URL, phar, tr('Composer নামছে', 'Downloading Composer'));
  }

  sendStatus(tr('ডাটাবেস বানানো হচ্ছে...', 'Creating database...'));
  await createMysqlDb(mysqlExe, port, dbName);

  // Composer প্রসেসের জন্য DB সেটিং env হিসেবে দিই: তাহলে Laravel-এর নিজের post-create migrate সরাসরি MySQL-এ চলে
  const env = {
    ...process.env,
    PHPRC: phpDir,
    COMPOSER_HOME: path.join(ROOT_DIR, 'data', 'composer-home'),
    COMPOSER_MEMORY_LIMIT: '-1',
    COMPOSER_NO_INTERACTION: '1',
    COMPOSER_DISABLE_XDEBUG_WARN: '1',
    DB_CONNECTION: 'mysql',
    DB_HOST: '127.0.0.1',
    DB_PORT: String(port),
    DB_DATABASE: dbName,
    DB_USERNAME: 'root',
    DB_PASSWORD: mysqlRootPw(),
  };
  fs.mkdirSync(env.COMPOSER_HOME, { recursive: true });
  const label = tr('Laravel বানানো হচ্ছে', 'Creating Laravel');
  sendStatus(label + '... ' + tr('(প্রথমবার কয়েক মিনিট লাগতে পারে)', '(the first time can take a few minutes)'));
  await runPhp(phpExe, [phar, 'create-project', 'laravel/laravel', dest, '--prefer-dist', '--no-interaction', '--no-progress'], { cwd: WWW_DIR, env, label });

  // .env ঠিক করা: ডাটাবেস, APP_URL, সেশনের মেয়াদ
  const envFile = path.join(dest, '.env');
  if (!fs.existsSync(envFile) && fs.existsSync(path.join(dest, '.env.example'))) fs.copyFileSync(path.join(dest, '.env.example'), envFile);
  if (!fs.existsSync(envFile)) throw new Error(tr('.env ফাইল তৈরি হয়নি', 'The .env file was not created'));
  const domain = `${name}.${TLD}`;
  const sessMin = siteSessionMin(domain) || LARAVEL_DEFAULT_SESSION_MIN;
  fs.writeFileSync(
    envFile,
    setEnvValues(fs.readFileSync(envFile, 'utf8'), {
      APP_URL: siteUrl(domain),
      DB_CONNECTION: 'mysql',
      DB_HOST: '127.0.0.1',
      DB_PORT: port,
      DB_DATABASE: dbName,
      DB_USERNAME: 'root',
      DB_PASSWORD: envVal(mysqlRootPw()),
      SESSION_LIFETIME: sessMin,
    })
  );

  // APP_KEY না থাকলে বানানো, তারপর টেবিল (migrate) নিশ্চিত করা। না হলেও সাইট রেখে দিই, শুধু সতর্কবার্তা দিই।
  const warnings = [];
  const artisan = (args) => runPhp(phpExe, ['artisan', ...args], { cwd: dest, env: { ...process.env, PHPRC: phpDir }, label, timeoutMs: 5 * 60 * 1000 });
  try {
    if (!/^APP_KEY=base64:/m.test(fs.readFileSync(envFile, 'utf8'))) await artisan(['key:generate', '--force', '--no-interaction']);
    await artisan(['migrate', '--force', '--no-interaction']);
  } catch (e) {
    warnings.push(tr('⚠ migrate চালানো যায়নি, পরে সাইট ফোল্ডারে "php artisan migrate" চালান', '⚠ migrate could not run, run "php artisan migrate" in the site folder later'));
  }
  return { turnedOn, warnings, sessMin };
}

// ---------- Node.js স্টার্টার টেমপ্লেট ----------
// basic = কোনো প্যাকেজ লাগে না (সরাসরি node server.js), express, vite, next = npm install লাগে।
// ফাইলগুলো সাধারণ টেক্সট; তৈরির পর www\<নাম> ফোল্ডারে থাকে, ইচ্ছামতো বদলানো যায়।
const NODE_KINDS = ['node-basic', 'node-express', 'node-vite', 'node-next'];
function writeNodeTemplate(kind, dest, name) {
  const w = (rel, text) => {
    const f = path.join(dest, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text.replace(/^\n/, ''));
  };
  const pkg = (extra) => JSON.stringify({ name, version: '1.0.0', private: true, ...extra }, null, 2) + '\n';
  w('.gitignore', 'node_modules/\n.next/\ndist/\n.env\n');
  if (kind === 'node-basic') {
    w('package.json', pkg({ scripts: { start: 'node server.js' } }));
    w('server.js', `
// Server 360 starter (basic): no packages needed.
// Server 360 gives the port in the PORT variable.
const http = require('http');
const port = process.env.PORT || 3000;
let hits = 0;
http
  .createServer((req, res) => {
    hits++;
    if (req.url === '/api/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, node: process.version, hits }));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>${name}.test</h1><p>Node ' + process.version + ' &middot; hits: ' + hits + '</p><p><a href="/api/hello">/api/hello</a></p>');
  })
  .listen(port, () => console.log('${name} listening on port ' + port + ' (Node ' + process.version + ')'));
`);
  } else if (kind === 'node-express') {
    w('package.json', pkg({ scripts: { start: 'node server.js' }, dependencies: { express: '^4.21.2' } }));
    w('server.js', `
// Server 360 starter (Express). Run "npm install" first.
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('<h1>${name}.test</h1><p>Express on Node ' + process.version + '</p><p><a href="/api/hello">/api/hello</a></p>'));
app.get('/api/hello', (req, res) => res.json({ ok: true, node: process.version, time: new Date().toISOString() }));
app.listen(port, () => console.log('${name} (Express) listening on port ' + port + ' (Node ' + process.version + ')'));
`);
  } else if (kind === 'node-vite') {
    w('package.json', pkg({ type: 'module', scripts: { dev: 'vite', build: 'vite build' }, devDependencies: { vite: '^6.0.0' } }));
    // host 127.0.0.1: Nginx/Apache proxy 127.0.0.1-এ পাঠায়; allowedHosts: .test ঠিকানা মানার জন্য
    w('vite.config.js', `
import { defineConfig } from 'vite';

// Server 360: the port comes in PORT; the proxy talks to 127.0.0.1; *.test hosts must be allowed.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    allowedHosts: ['.test'],
  },
});
`);
    w('index.html', `
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${name}.test</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.js"></script>
  </body>
</html>
`);
    w('main.js', `
const app = document.getElementById('app');
app.innerHTML = '<h1>${name}.test</h1><p>Vite is running. Edit <code>main.js</code> and save: the page updates by itself.</p>';
`);
  } else if (kind === 'node-next') {
    w('package.json', pkg({ scripts: { dev: 'next dev', build: 'next build', start: 'next start' }, dependencies: { next: '^15.1.0', react: '^19.0.0', 'react-dom': '^19.0.0' } }));
    w('next.config.mjs', `
// Server 360: allow the *.test address in dev mode.
export default { allowedDevOrigins: ['*.test'] };
`);
    w('app/layout.js', `
export const metadata = { title: '${name}.test' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`);
    w('app/page.js', `
export default function Home() {
  return (
    <main>
      <h1>${name}.test</h1>
      <p>Next.js is running. Edit app/page.js and save.</p>
    </main>
  );
}
`);
  }
}

ipcMain.handle('site:create', async (_event, kind, rawName) => {
  const fail = (m) => ({ ok: false, message: m });
  if (busy) return fail(tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...'));
  const name = siteSlug(rawName);
  if (!name) return fail(tr('সমস্যা: সাইটের নাম দিন (a-z, 0-9, -)', 'Error: enter a site name (a-z, 0-9, -)'));
  if (!['blank', 'wordpress', 'laravel', ...NODE_KINDS].includes(kind)) return fail(tr('সমস্যা: অজানা ধরন', 'Error: unknown type'));
  const dest = path.join(WWW_DIR, name);
  if (fs.existsSync(dest)) return fail(tr(`সমস্যা: ${name} নামে ফোল্ডার আগে থেকেই আছে`, `Error: a folder named ${name} already exists`));
  busy = true;
  let laravelInfo = null;
  try {
    fs.mkdirSync(WWW_DIR, { recursive: true });
    if (kind === 'blank') {
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'index.php'), `<?php\necho '<h1>${name}.test</h1><p>PHP ' . PHP_VERSION . '</p>';\n`);
    } else if (NODE_KINDS.includes(kind)) {
      fs.mkdirSync(dest, { recursive: true });
      try {
        writeNodeTemplate(kind, dest, name);
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true });
        throw e;
      }
      // Next-এ scripts.start = production মোড (build লাগে), তাই ডেভ কমান্ড আগে থেকেই বসিয়ে দেওয়া
      if (kind === 'node-next') {
        settings.nodeSites = { ...(settings.nodeSites || {}), [`${name}.${TLD}`]: { cmd: 'npm run dev' } };
        saveSettings(settings);
      }
    } else if (kind === 'wordpress') {
      try {
        await installWordPress(dest, name.replace(/-/g, '_'));
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true }); // আধা-তৈরি ফোল্ডার রেখে যাব না
        throw e;
      }
    } else {
      try {
        laravelInfo = await installLaravel(dest, name, name.replace(/-/g, '_'));
      } catch (e) {
        fs.rmSync(dest, { recursive: true, force: true }); // আধা-তৈরি ফোল্ডার রেখে যাব না
        throw e;
      }
    }
    const sites = withToolSites(scanSites());
    const h = await syncHosts(sites);
    const live = await reloadRunning(sites);
    let message = tr(`${name}.test তৈরি হয়েছে`, `${name}.test created`);
    if (NODE_KINDS.includes(kind)) {
      message += kind === 'node-basic' ? tr('। নিচের Node.js কার্ডে ▶ চালু চাপুন', '. Click ▶ Start in the Node.js card below') : tr('। npm install চলবে, শেষ হলে ▶ চালু চাপুন', '. npm install will run, then click ▶ Start');
      if (!live) message += tr(' (.test ঠিকানার জন্য ওয়েব সার্ভারও চালু করুন)', ' (also start a web server for the .test address)');
    } else if (!live) message += tr(' (ওয়েব সার্ভার চালু করলে কাজ করবে)', ' (it will work once a web server is started)');
    if (!h.ok) message += hostsFailNote(h);
    if (kind === 'wordpress' || kind === 'laravel') message += tr('। ডাটাবেস: ' + name.replace(/-/g, '_') + (mysqlRootPw() ? ' (root, সেট করা পাসওয়ার্ড)' : ' (root, খালি পাসওয়ার্ড)'), '. Database: ' + name.replace(/-/g, '_') + (mysqlRootPw() ? ' (root, the password you set)' : ' (root, empty password)'));
    if (laravelInfo) {
      message += tr(`। Laravel .env-এ SESSION_LIFETIME=${laravelInfo.sessMin} মিনিট`, `. Laravel .env has SESSION_LIFETIME=${laravelInfo.sessMin} min`);
      if (laravelInfo.turnedOn.length) message += tr(`। চালু করা হয়েছে: ${laravelInfo.turnedOn.join(', ')} (ওয়েব সার্ভার একবার বন্ধ করে চালু করুন)`, `. Turned on: ${laravelInfo.turnedOn.join(', ')} (stop and start the web server once)`);
      if (laravelInfo.warnings.length) message += ' ' + laravelInfo.warnings.join(' ');
    }
    const isNodeKind = NODE_KINDS.includes(kind);
    return { ok: true, message, url: !isNodeKind && live ? siteUrl(`${name}.test`) : '', node: isNodeKind ? { domain: `${name}.${TLD}`, install: kind !== 'node-basic' } : null, sites: publicSites(sites) };
  } catch (err) {
    return fail(tr('সমস্যা: ', 'Error: ') + err.message);
  } finally {
    busy = false;
  }
});

// ---------- সাইট চালু/বন্ধ ও কনফিগ ফাইল ----------
// ফাইলগুলো ওয়েব সার্ভার না চালিয়েও বানানো যায় (শুধু সার্ভারটা নামানো থাকলেই হয়)
function prepareSiteFiles(webId) {
  const svc = SERVICES[webId];
  if (!svc || !['apache', 'nginx'].includes(webId)) throw new Error(tr('অজানা সার্ভার', 'Unknown server'));
  if (!fs.existsSync(svc.exe)) throw new Error(tr(`${svc.label} এখনো নামানো হয়নি। একবার Start চাপুন, তারপর আবার চেষ্টা করুন`, `${svc.label} is not downloaded yet. Click Start once, then try again`));
  const sites = withToolSites(scanSites());
  const live = running && running.id === 'nginx' ? running.phpPorts : null;
  const webPort = running && running.id === webId ? running.webPort : getWebPort();
  const upOf = (x) => {
    const v = phpOfSite(x);
    return !live || (live[v] && live[v].length) ? phpUpstream(v) : phpUpstream(defaultPhpVersion());
  };
  writeSiteFiles(svc, webId === 'nginx' ? nginxEntries(sites, webPort, upOf) : apacheEntries(sites, webPort), sites);
  return { svc, dir: sitesEnabledDir(svc), sites };
}

ipcMain.handle('site:setEnabled', async (_event, domain, on) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  if (!withToolSites(scanSites()).some((x) => x.domain === domain && !x.system)) {
    return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  }
  busy = true;
  let resume = false;
  try {
    settings.siteDisabled = { ...(settings.siteDisabled || {}) };
    if (on) delete settings.siteDisabled[domain];
    else settings.siteDisabled[domain] = true;
    saveSettings(settings);
    if (!on && nodeRun[domain]) {
      if (nodeRun[domain].task === 'run') nodeResume.add(domain); // চলছিল, তাই চালু করলে আবার চালাব
      await stopNodeApp(domain); // বন্ধ করা Node সাইটের অ্যাপও থামানো
    }
    const sites = withToolSites(scanSites());
    const h = await syncHosts(sites);
    const live = await reloadRunning(sites);
    let message = on ? tr(`${domain} চালু করা হয়েছে`, `${domain} enabled`) : tr(`${domain} বন্ধ করা হয়েছে`, `${domain} disabled`);
    if (!live) message += tr(' (ওয়েব সার্ভার চালু করলে প্রযোজ্য হবে)', ' (applies when a web server is started)');
    if (!h.ok) message += hostsFailNote(h);
    if (on && nodeResume.delete(domain)) {
      resume = true;
      message += tr(' · অ্যাপ আবার চালু হচ্ছে...', ' · restarting its app...');
    }
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
    // busy ছাড়ার পরে চালাই (startNodeApp/ensureNodeRuntime নিজেও busy ব্যবহার করে); UI আটকে না রেখে ব্যাকগ্রাউন্ডে
    if (resume) {
      startNodeApp(domain)
        .then((r) => sendStatus(r.message))
        .catch((e) => sendStatus(tr('অ্যাপ আবার চালু ব্যর্থ: ', 'Restarting the app failed: ') + e.message));
    }
  }
});

// একটা সাইটের কনফিগ ফাইল Notepad-এ খোলা (domain = 'localhost' হলে 00-default.conf)
ipcMain.handle('site:openConf', async (_event, domain, webId) => {
  try {
    const { dir, sites } = prepareSiteFiles(webId);
    const isDef = domain === 'localhost';
    const site = sites.find((x) => x.domain === domain);
    if (!isDef && !site) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
    if (site && site.disabled) return { ok: false, message: tr('সাইটটা বন্ধ আছে, আগে চালু করুন', 'The site is disabled, enable it first') };
    const file = path.join(dir, isDef ? '00-default.conf' : `${domain}.conf`);
    if (!fs.existsSync(file)) return { ok: false, message: tr('কনফিগ ফাইল পাওয়া যায়নি', 'Config file not found') };
    const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
    child.on('error', () => shell.showItemInFolder(file));
    child.unref();
    const auto = fs.readFileSync(file, 'utf8').startsWith(AUTO_MARK);
    return {
      ok: true,
      message: auto
        ? tr(`${file} খোলা হয়েছে। এটা চালুর সময় আবার লেখা হয়; নিজের মতো রাখতে প্রথম লাইনটা (${AUTO_MARK}) মুছে সেভ করুন`, `${file} opened. It is rewritten on every start; to keep your edits delete the first line (${AUTO_MARK}) and save`)
        : tr(`${file} খোলা হয়েছে (এটা আপনার নিজের ফাইল, অ্যাপ বদলাবে না)`, `${file} opened (this is your own file, the app will not change it)`),
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

// ---------- কনফিগ ফাইল: "নিজের করে রাখুন" / "অটোতে ফিরুন" / "সব অটোতে ফিরুন" ----------
// ফাইলের প্রথম লাইন AUTO_MARK থাকলে ফাইলটা অ্যাপের (প্রতিবার আবার লেখা হয়); না থাকলে ব্যবহারকারীর নিজের (custom)
const confFileFor = (svc, domain) => path.join(sitesEnabledDir(svc), domain === 'localhost' ? '00-default.conf' : `${domain}.conf`);
const backupStamp = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14);
// নিজের ফাইল মোছার আগে কপি রাখা: <ফাইল>.bak-<সময়> (নাম .conf-এ শেষ হয় না, তাই সার্ভার এটা লোড করে না)
function backupConf(file) {
  const b = `${file}.bak-${backupStamp()}`;
  fs.copyFileSync(file, b);
  return b;
}
const readTextOrNull = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

// কোন সাইটের কনফিগ এখন ব্যবহারকারীর নিজের (marker নেই) -- Sites পেজে "নিজের" ব্যাজ দেখানোর জন্য
ipcMain.handle('sites:confState', (_event, webId) => {
  try {
    const svc = SERVICES[webId];
    if (!svc || !['apache', 'nginx'].includes(webId)) return { custom: [] };
    const custom = ['localhost', ...withToolSites(scanSites()).filter((x) => !x.disabled).map((x) => x.domain)].filter((d) => {
      const txt = readTextOrNull(confFileFor(svc, d));
      return txt !== null && !txt.startsWith(AUTO_MARK);
    });
    return { custom };
  } catch {
    return { custom: [] };
  }
});

function confTarget(webId, domain) {
  const { svc, sites } = prepareSiteFiles(webId);
  if (domain !== 'localhost') {
    const site = sites.find((x) => x.domain === domain);
    if (!site) throw new Error(tr('সাইটটা পাওয়া যায়নি', 'site not found'));
    if (site.disabled) throw new Error(tr('সাইটটা বন্ধ আছে, আগে চালু করুন', 'The site is disabled, enable it first'));
  }
  return { svc, sites, file: confFileFor(svc, domain) };
}

// "নিজের করে রাখুন": প্রথম marker লাইনটা মুছে দেওয়া, ফলে অ্যাপ আর ফাইলটা বদলায় না
ipcMain.handle('site:keepConf', async (_event, domain, webId) => {
  try {
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/.test(domain)) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
    const { file } = confTarget(webId, domain);
    const txt = readTextOrNull(file);
    if (txt === null) return { ok: false, message: tr('কনফিগ ফাইল পাওয়া যায়নি', 'Config file not found') };
    if (!txt.startsWith(AUTO_MARK)) return { ok: true, message: tr('ফাইলটা আগে থেকেই আপনার নিজের', 'This file is already yours') };
    const nl = txt.indexOf('\n');
    fs.writeFileSync(file, nl === -1 ? '' : txt.slice(nl + 1));
    return {
      ok: true,
      message: tr(
        `${domain}: কনফিগটা এখন আপনার নিজের, অ্যাপ আর বদলাবে না। অ্যাপের আপডেট (যেমন PHP ভার্সন, সেশন) এতে আর আসবে না; আবার অটো করতে "অটোতে ফিরুন" চাপুন`,
        `${domain}: the config is now yours and the app will not change it. App updates (PHP version, session...) no longer reach it; click "Reset to auto" to go back`
      ),
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

// "অটোতে ফিরুন": নিজের ফাইল হলে আগে .bak কপি রেখে ফাইলটা মুছে অ্যাপের ফাইল আবার বানানো; সার্ভার চালু থাকলে প্রযোজ্য করা
ipcMain.handle('site:resetConf', async (_event, domain, webId) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  busy = true;
  try {
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/.test(domain)) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
    const { file } = confTarget(webId, domain);
    let backup = '';
    const txt = readTextOrNull(file);
    if (txt !== null) {
      if (!txt.startsWith(AUTO_MARK)) backup = backupConf(file);
      fs.rmSync(file, { force: true });
    }
    prepareSiteFiles(webId); // অটো ফাইল আবার লেখা
    const live = running && running.id === webId ? await reloadRunning(withToolSites(scanSites())) : false;
    let message = tr(`${domain}: অটো কনফিগে ফিরেছে`, `${domain}: back to the auto config`);
    if (backup) message += tr(` (আপনার আগের ফাইলের কপি: ${backup})`, ` (copy of your previous file: ${backup})`);
    if (!live) message += tr(' (ওয়েব সার্ভার চালু করলে প্রযোজ্য হবে)', ' (applies when the web server is started)');
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// "সব অটোতে ফিরুন": অ্যাপ যে ফাইলগুলো বানায় (00-default + প্রতিটা চালু সাইট) সব নতুন করে লেখা; নিজের হলে আগে .bak কপি।
// ব্যবহারকারীর অন্য ফাইল (যেমন নিজের বানানো extra.conf) ও <domain>.d ফোল্ডার ছোঁয়া হয় না।
ipcMain.handle('sites:resetAll', async (_event, webId) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  busy = true;
  try {
    const { svc, sites } = prepareSiteFiles(webId);
    const names = ['00-default.conf', ...sites.filter((x) => !x.disabled).map((x) => `${x.domain}.conf`)];
    let nAuto = 0;
    let nOwn = 0;
    for (const n of names) {
      const full = path.join(sitesEnabledDir(svc), n);
      const txt = readTextOrNull(full);
      if (txt === null) continue;
      if (txt.startsWith(AUTO_MARK)) nAuto++;
      else {
        backupConf(full);
        nOwn++;
      }
      fs.rmSync(full, { force: true });
    }
    prepareSiteFiles(webId);
    const live = running && running.id === webId ? await reloadRunning(withToolSites(scanSites())) : false;
    let message = tr(`${nAuto + nOwn}টা কনফিগ ফাইল অটোতে ফিরেছে`, `${nAuto + nOwn} config file(s) reset to auto`);
    if (nOwn) message += tr(` (এর মধ্যে ${nOwn}টা আপনার নিজের ছিল, কপি রাখা হয়েছে: ফাইলের নামের শেষে .bak-তারিখ)`, ` (${nOwn} of them were yours; copies were kept next to them as .bak-<date>)`);
    if (!live) message += tr(' (ওয়েব সার্ভার চালু করলে প্রযোজ্য হবে)', ' (applies when the web server is started)');
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// ---------- সাইটের এক্সট্রা conf (sites-enabled\<domain>.d\*.conf) ----------
// domain 'localhost' বা একটা চালু, সিস্টেম নয় এমন সাইট হতে হবে; ফোল্ডারের পথ আমরাই বানাই (রেন্ডারার থেকে পথ নিই না)
function extrasTarget(webId, domain) {
  const { svc, sites } = prepareSiteFiles(webId);
  if (domain !== 'localhost') {
    const site = sites.find((x) => x.domain === domain);
    if (!site) throw new Error(tr('সাইটটা পাওয়া যায়নি', 'site not found'));
    if (site.system) throw new Error(tr('এই সিস্টেম সাইটে এক্সট্রা conf চলে না', 'extra conf is not available for system sites'));
    if (site.disabled) throw new Error(tr('সাইটটা বন্ধ আছে, আগে চালু করুন', 'The site is disabled, enable it first'));
  }
  const dir = extrasDir(svc, domain);
  fs.mkdirSync(dir, { recursive: true });
  return { svc, dir };
}

const openInNotepad = (file) => {
  const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
  child.on('error', () => shell.showItemInFolder(file));
  child.unref();
};

function extraTemplate(webId, domain) {
  const head = `# Extra rules for ${domain} (${webId === 'nginx' ? 'Nginx' : 'Apache'}).\n# This file is included INSIDE the site's ${webId === 'nginx' ? 'server { }' : '<VirtualHost>'} block. The app never overwrites it.\n`;
  return (
    head +
    (webId === 'nginx'
      ? '# Examples (remove the leading # to use):\n#   add_header Access-Control-Allow-Origin *;\n#   client_max_body_size 256m;\n#   location /api/ { try_files $uri /index.php?$query_string; }\n'
      : '# Examples (remove the leading # to use):\n#   Redirect 301 /old /new\n#   SetEnv MY_VAR value\n#   <Directory "...">  ...  </Directory>\n') +
    '# Save the file, then click "Refresh sites" to apply. A mistake here can stop the web server from reloading.\n'
  );
}

ipcMain.handle('site:addExtra', async (_event, domain, webId, rawName) => {
  try {
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/.test(domain)) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
    const name = String(rawName || '').trim().replace(/\.conf$/i, '');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name)) {
      return { ok: false, message: tr('সমস্যা: নামে শুধু a-z, 0-9, - _ . চলবে (যেমন cors)', 'Error: the name may only contain a-z, 0-9, - _ . (e.g. cors)') };
    }
    const { dir } = extrasTarget(webId, domain);
    const file = path.join(dir, `${name}.conf`);
    const existed = fs.existsSync(file);
    if (!existed) fs.writeFileSync(file, extraTemplate(webId, domain));
    openInNotepad(file);
    return {
      ok: true,
      message: existed
        ? tr(`${file} আগে থেকেই ছিল, খোলা হয়েছে`, `${file} already existed, opened`)
        : tr(`${file} বানানো হয়েছে। এডিট করে সেভ করুন, তারপর "সাইট রিফ্রেশ" চাপুন`, `${file} created. Edit and save it, then click "Refresh sites"`),
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

ipcMain.handle('site:openExtras', async (_event, domain, webId) => {
  try {
    if (typeof domain !== 'string' || !/^[a-z0-9.-]+$/.test(domain)) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
    const { dir } = extrasTarget(webId, domain);
    await shell.openPath(dir);
    return { ok: true, message: dir };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

ipcMain.handle('sites:openDir', async (_event, webId) => {
  try {
    const { dir } = prepareSiteFiles(webId);
    await shell.openPath(dir);
    return { ok: true, message: dir };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

// সাইটের root ফোল্ডার ফাইল এক্সপ্লোরারে খোলা (শুধু আমাদের জানা সাইটের root; ইচ্ছেমতো পাথ নেয় না)
ipcMain.handle('site:openFolder', async (_event, domain) => {
  const root = domain === 'localhost' ? WWW_DIR : (withToolSites(scanSites()).find((x) => x.domain === domain) || {}).root;
  if (!root) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  if (!fs.existsSync(root)) return { ok: false, message: tr(`সমস্যা: ফোল্ডারটা নেই: ${root}`, `Error: the folder does not exist: ${root}`) };
  const err = await shell.openPath(root);
  return err ? { ok: false, message: tr('সমস্যা: ', 'Error: ') + err } : { ok: true, message: root };
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


// সাইট ধরে PHP সীমা (max_execution_time, memory_limit, max_input_time, display_errors); ফাঁকা ঘর = ডিফল্ট
ipcMain.handle('site:setPhpIni', async (_event, domain, cfg) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const sites = withToolSites(scanSites());
  if (!sites.some((s) => s.domain === domain && !s.system && !s.node)) {
    return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  }
  const clean = {};
  for (const [k, re] of Object.entries({ ...PHP_INI_KEYS, ...PHP_USER_INI_KEYS })) {
    const raw = cfg && cfg[k] !== undefined && cfg[k] !== null ? String(cfg[k]).trim() : '';
    if (raw === '') continue;
    const v = k === 'display_errors' ? (raw.toLowerCase() === 'on' ? 'On' : raw.toLowerCase() === 'off' ? 'Off' : raw) : raw;
    if (!re.test(v)) return { ok: false, message: tr(`সমস্যা: ${k}-এর মান ঠিক নয় (${raw})`, `Error: invalid value for ${k} (${raw})`) };
    clean[k] = v;
  }
  // আপলোড/পোস্ট সাইজ জোড়ায় দিতে হয় এবং post_max_size >= upload_max_filesize হতে হবে (নইলে বড় আপলোড আটকে যায়)
  if (clean.upload_max_filesize && !clean.post_max_size) {
    return { ok: false, message: tr('সমস্যা: upload_max_filesize দিলে post_max_size-ও দিন (একই বা বড় মান)', 'Error: when you set upload_max_filesize, set post_max_size too (same or larger)') };
  }
  if (clean.upload_max_filesize && clean.post_max_size && clean.post_max_size !== '0' && (clean.upload_max_filesize === '0' || sizeBytes(clean.post_max_size) < sizeBytes(clean.upload_max_filesize))) {
    return { ok: false, message: tr('সমস্যা: post_max_size, upload_max_filesize-এর সমান বা বড় হতে হবে', 'Error: post_max_size must be the same as or larger than upload_max_filesize') };
  }
  if (Object.keys(clean).some((k) => k in PHP_USER_INI_KEYS)) {
    const site = sites.find((s) => s.domain === domain);
    const f = site && path.join(site.root, '.user.ini');
    let cur = null;
    try {
      cur = fs.readFileSync(f, 'utf8');
    } catch {}
    if (cur !== null && !cur.startsWith(USER_INI_MARK)) {
      return { ok: false, message: tr(`সমস্যা: ${f} নামে আপনার নিজের ফাইল আছে। সেটা সরান বা নিজে এডিট করুন, অ্যাপ ওটা ছোঁবে না`, `Error: you already have your own ${f}. Remove it or edit it yourself, the app will not touch it`) };
    }
  }
  busy = true;
  try {
    settings.sitePhpIni = { ...(settings.sitePhpIni || {}) };
    if (Object.keys(clean).length) settings.sitePhpIni[domain] = clean;
    else delete settings.sitePhpIni[domain];
    saveSettings(settings);
    syncUserIni(sites);
    ensureSitePrepend(path.join(ROOT_DIR, 'data', 'php-tmp').replace(/\\/g, '/')); // প্রতি রিকোয়েস্টে পড়া হয়, php-cgi রিস্টার্ট লাগে না
    const live = await reloadRunning(sites);
    const label = Object.keys(clean).length ? Object.entries(clean).map(([k, v]) => `${k}=${v}`).join(', ') : tr('ডিফল্ট', 'default');
    return {
      ok: true,
      message: live ? tr(`${domain}-এর PHP সীমা এখন: ${label}`, `${domain} PHP limits are now: ${label}`) : tr(`${domain}-এর PHP সীমা (${label}) সেভ হয়েছে। সার্ভার চালু করলে কাজ করবে`, `PHP limits (${label}) saved for ${domain}. They apply when the server starts`),
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// ---------- পাবলিক ডোমেইন (Step B1) ----------
// নামগুলো সাইটের server_name/ServerAlias-এ যোগ হয় (পোর্ট 80)। SSL/সার্টিফিকেট পরের ধাপে।
ipcMain.handle('site:setPublic', async (_event, domain, text) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const sites = withToolSites(scanSites());
  if (!sites.some((s) => s.domain === domain && !s.system)) {
    return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  }
  const names = [...new Set(String(text || '').toLowerCase().split(/[\s,;]+/).map((x) => x.trim().replace(/\.$/, '')).filter(Boolean))];
  if (names.length > 10) return { ok: false, message: tr('সমস্যা: একটা সাইটে সর্বোচ্চ ১০টা নাম', 'Error: at most 10 names per site') };
  for (const h of names) {
    if (!PUBLIC_HOST_RE.test(h) || PUBLIC_BAD_TLD.test(h)) {
      return { ok: false, message: tr(`সমস্যা: "${h}" ঠিক ডোমেইন নাম নয় (যেমন app.example.com; .test/.local চলবে না, http:// বা পোর্ট লিখবেন না)`, `Error: "${h}" is not a valid public domain name (e.g. app.example.com; .test/.local are not allowed, no http:// or port)`) };
    }
    if (sites.some((s) => s.domain === h)) return { ok: false, message: tr(`সমস্যা: "${h}" নামে এই অ্যাপে আগে থেকেই একটা সাইট আছে`, `Error: a site named "${h}" already exists in this app`) };
    const other = Object.entries(settings.sitePublic || {}).find(([d, list]) => d !== domain && Array.isArray(list) && list.includes(h));
    if (other) return { ok: false, message: tr(`সমস্যা: "${h}" আগে থেকেই ${other[0]} সাইটে দেওয়া আছে`, `Error: "${h}" is already used by ${other[0]}`) };
  }
  busy = true;
  try {
    settings.sitePublic = { ...(settings.sitePublic || {}) };
    if (names.length) settings.sitePublic[domain] = names;
    else delete settings.sitePublic[domain];
    saveSettings(settings);
    const live = await reloadRunning(sites);
    const label = names.length ? names.join(', ') : tr('কিছু নেই', 'none');
    return {
      ok: true,
      message: live ? tr(`${domain}-এর পাবলিক নাম এখন: ${label}`, `${domain} public names are now: ${label}`) : tr(`${domain}-এর পাবলিক নাম (${label}) সেভ হয়েছে। সার্ভার চালু করলে কাজ করবে`, `Public names (${label}) saved for ${domain}. They apply when the server starts`),
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// এই PC-র পাবলিক IP (দুটো সেবা, প্রথমটা না পেলে দ্বিতীয়টা)
function fetchPublicIp() {
  const get = (url) =>
    new Promise((resolve) => {
      const req = https.get(url, { timeout: 6000 }, (res) => {
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(/^\d{1,3}(\.\d{1,3}){3}$/.test(d.trim()) ? d.trim() : ''));
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(''));
    });
  return get('https://api.ipify.org').then((ip) => ip || get('https://icanhazip.com'));
}

// DNS পরীক্ষা: নামগুলো 8.8.8.8 ও 1.1.1.1 দিয়ে খুঁজে এই PC-র পাবলিক IP-র সাথে মেলানো (কিছু বদলায় না)
ipcMain.handle('site:checkPublic', async (_event, text) => {
  const hosts = [...new Set(String(text || '').toLowerCase().split(/[\s,;]+/).map((x) => x.trim().replace(/\.$/, '')).filter(Boolean))].slice(0, 10);
  if (!hosts.length) return { ok: false, message: tr('আগে নাম লিখুন', 'Enter a name first'), ip: '', hosts: [] };
  const ip = await fetchPublicIp();
  const resolvers = ['8.8.8.8', '1.1.1.1'].map((s) => {
    const r = new dns.promises.Resolver({ timeout: 4000, tries: 1 });
    r.setServers([s]);
    return r;
  });
  const out = [];
  for (const h of hosts) {
    if (!PUBLIC_HOST_RE.test(h) || PUBLIC_BAD_TLD.test(h)) {
      out.push({ host: h, status: 'invalid', ips: [] });
      continue;
    }
    const found = new Set();
    for (const r of resolvers) {
      try {
        for (const a of await r.resolve4(h)) found.add(a);
      } catch {}
    }
    const ips = [...found];
    const status = !ips.length ? 'none' : ip && ips.length === 1 && ips[0] === ip ? 'ok' : ip && ips.includes(ip) ? 'mixed' : ip ? 'wrong' : 'unknown';
    out.push({ host: h, status, ips });
  }
  return { ok: true, ip, hosts: out, message: '' };
});

// ---------- Let's Encrypt সার্টিফিকেট (Step B2) ----------
// win-acme নন-ইন্টারঅ্যাক্টিভভাবে চালানো: http-01 (filesystem), PEM ফাইল data\certs-এ। এখনো https server ব্লক বানানো হয় না (Step B3)।
async function ensureWinAcme() {
  if (fs.existsSync(winAcmeExe())) return false;
  await installInto({ label: 'win-acme', exeRel: 'wacs.exe' }, winAcmeDir(), { url: WINACME_URL });
  return true;
}

ipcMain.handle('acme:status', async (_event, domain) => {
  const names = domain ? sitePublicNames(domain) : [];
  const now = Date.now();
  return {
    installed: fs.existsSync(winAcmeExe()),
    email: String(settings.acmeEmail || ''),
    task: await acmeTaskExists(),
    certsDir: certsDir(),
    serverRunning: !!running,
    port80: getWebPort() === 80,
    webId: running ? running.id : '',
    httpsOn: !!tlsFor(names),
    fwPublic: await fwRuleExists(PUBLIC_FW_RULE),
    certs: names.map((h) => {
      const c = certFor(h);
      if (!c) return { host: h, status: 'none' };
      const days = Math.floor((c.end.getTime() - now) / 86400000);
      return { host: h, status: days < 0 ? 'expired' : days <= 14 ? 'soon' : 'ok', expires: c.end.toISOString().slice(0, 10), days, staging: c.staging };
    }),
  };
});

ipcMain.handle('acme:install', async () => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  busy = true;
  try {
    const fresh = await ensureWinAcme();
    return { ok: true, message: fresh ? tr('win-acme ইনস্টল হয়েছে', 'win-acme installed') : tr('win-acme আগেই ইনস্টল করা আছে', 'win-acme is already installed') };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

ipcMain.handle('acme:folder', () => {
  fs.mkdirSync(certsDir(), { recursive: true });
  return shell.openPath(certsDir());
});

// আমাদের ওয়েব সার্ভার challenge ফোল্ডারটা সত্যিই দিচ্ছে কিনা নিজে যাচাই (Host হেডার দিয়ে, 127.0.0.1:80-তে)
function selfCheckChallenge(host) {
  return new Promise((resolve) => {
    const dir = path.join(acmeWebroot(), '.well-known', 'acme-challenge');
    const file = path.join(dir, 's360-selfcheck');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, 'server360-ok');
    } catch (e) {
      return resolve({ ok: false, why: e.message });
    }
    const req = http.get({ host: '127.0.0.1', port: 80, path: '/.well-known/acme-challenge/s360-selfcheck', headers: { Host: host }, timeout: 6000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        fs.rmSync(file, { force: true });
        resolve(res.statusCode === 200 && d.trim() === 'server360-ok' ? { ok: true } : { ok: false, why: 'HTTP ' + res.statusCode });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => {
      fs.rmSync(file, { force: true });
      resolve({ ok: false, why: e.message });
    });
  });
}

ipcMain.handle('acme:issue', async (_event, domain, emailRaw, staging) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const sites = withToolSites(scanSites());
  if (!sites.some((s) => s.domain === domain && !s.system)) return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  const names = sitePublicNames(domain);
  if (!names.length) return { ok: false, message: tr('আগে পাবলিক ডোমেইন নাম সেভ করুন, তারপর সার্টিফিকেট নিন', 'Save a public domain name first, then get the certificate') };
  const email = String(emailRaw === undefined || emailRaw === null || emailRaw === '' ? settings.acmeEmail || '' : emailRaw).trim();
  if (!EMAIL_RE.test(email)) return { ok: false, message: tr("সমস্যা: একটা ঠিক ইমেইল দিন (Let's Encrypt জরুরি নোটিশ পাঠায়)", "Error: enter a valid email address (Let's Encrypt sends important notices there)") };
  if (!running) return { ok: false, message: tr('আগে ওয়েব সার্ভার চালু করুন (Nginx বা Apache), তারপর সার্টিফিকেট নিন', 'Start the web server (Nginx or Apache) first, then get the certificate') };
  if (getWebPort() !== 80) return { ok: false, message: tr('সার্টিফিকেটের জন্য ওয়েব সার্ভারের পোর্ট ৮০ হতে হবে (এখন ' + getWebPort() + ')', 'The web server port must be 80 for certificates (now ' + getWebPort() + ')') };
  busy = true;
  try {
    settings.acmeEmail = email;
    saveSettings(settings);
    fs.mkdirSync(certsDir(), { recursive: true });
    fs.mkdirSync(path.join(acmeWebroot(), '.well-known', 'acme-challenge'), { recursive: true });
    // কনফিগ নতুন করে লিখে নেওয়া (পুরনো সেভ করা নামে challenge পথ না থাকলে বসে যাবে)
    await reloadRunning(sites);
    sendStatus(tr('ওয়েব সার্ভারের challenge পথ পরীক্ষা হচ্ছে...', 'Checking the web server challenge path...'));
    const chk = await selfCheckChallenge(names[0]);
    if (!chk.ok) {
      return { ok: false, message: tr(`সমস্যা: ওয়েব সার্ভার /.well-known/acme-challenge/ দিচ্ছে না (${chk.why})। সাইটের কনফিগ ফাইল নিজের হাতে বদলানো (Custom) থাকলে "Reset to auto" দিন`, `Error: the web server does not serve /.well-known/acme-challenge/ (${chk.why}). If the site's config file is Custom (edited by you), use "Reset to auto"`) };
    }
    const fresh = await ensureWinAcme();
    if (fresh) sendStatus(tr('win-acme ইনস্টল হয়েছে', 'win-acme installed'));
    // সার্টিফিকেট পাওয়া/নবায়নের পর Nginx রিলোড (Apache-র SSL পরের ধাপে)। ব্যর্থ হলেও যেন নবায়ন ব্যর্থ না ধরা হয়
    const bat = path.join(certsDir(), 'reload-web.bat');
    const ng = SERVICES.nginx;
    fs.writeFileSync(bat, ['@echo off', ...(fs.existsSync(ng.exe) ? [`"${ng.exe}" -p "${fwdSlash(ng.dir)}/" -s reload >nul 2>&1`] : []), 'exit /b 0', ''].join('\r\n'));
    const args = [
      '--source', 'manual', '--host', names.join(','), '--commonname', names[0],
      '--validation', 'filesystem', '--webroot', acmeWebroot(),
      '--store', 'pemfiles', '--pemfilespath', certsDir(),
      '--installation', 'script', '--script', bat,
      '--accepttos', '--emailaddress', email, '--notaskscheduler',
      // NOT '--test': in win-acme, --test adds interactive prompts ("Try in default browser?", "Quit?") that crash without a console.
      // --baseuri alone selects Let's Encrypt staging, still fully non-interactive.
      ...(staging ? ['--baseuri', 'https://acme-staging-v02.api.letsencrypt.org/'] : []),
    ];
    sendStatus(tr(`${names.join(', ')}-এর সার্টিফিকেট নেওয়া হচ্ছে (১-২ মিনিট লাগতে পারে)...`, `Getting the certificate for ${names.join(', ')} (may take 1-2 minutes)...`));
    const run = await new Promise((resolve) => {
      const child = execFile(winAcmeExe(), args, { cwd: winAcmeDir(), timeout: 5 * 60 * 1000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, out: String(stdout || '') + String(stderr || '') }));
      try { child.stdin.end(); } catch (_) {}
    });
    const tail = run.out.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).slice(-70).join('\n').slice(-5000);
    const got = certFor(names[0]);
    const allIn = got && names.every((h) => got.names.includes(h));
    if (!run.err && allIn) {
      try { await reloadRunning(withToolSites(scanSites())); } catch {}
      return { ok: true, message: tr(`সার্টিফিকেট পাওয়া গেছে (মেয়াদ ${got.end.toISOString().slice(0, 10)} পর্যন্ত${got.staging ? ', টেস্ট/staging, ব্রাউজার বিশ্বাস করবে না' : ''})`, `Certificate issued (valid until ${got.end.toISOString().slice(0, 10)}${got.staging ? ', test/staging, browsers will not trust it' : ''})`), output: tail };
    }
    return { ok: false, message: tr('সার্টিফিকেট পাওয়া যায়নি। নিচের লগ দেখুন (DNS, রাউটার ফরওয়ার্ড ৮০ আর ফায়ারওয়াল আগে ঠিক করুন)', 'The certificate was not issued. See the log below (check DNS, the router forward for port 80 and the firewall first)'), output: tail || (run.err && run.err.message) || '' };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// নবায়ন নিজে থেকে: Windows Task Scheduler-এ রোজ win-acme --renew (UAC লাগে)। অ্যাপ বন্ধ থাকলেও চলে।
ipcMain.handle('acme:autoRenew', async () => {
  if (!fs.existsSync(winAcmeExe())) return { ok: false, message: tr('আগে win-acme ইনস্টল করুন', 'Install win-acme first') };
  const cmdFile = path.join(TOOLS_DIR, 'acme-renew-task.cmd');
  const lines = [
    '@echo off',
    'net session >nul 2>&1',
    'if errorlevel 1 ( echo Run this file as Administrator. & pause & exit /b 1 )',
    `schtasks /Create /TN "${ACME_TASK}" /TR "\\"${winAcmeExe()}\\" --renew" /SC DAILY /ST 09:00 /RU SYSTEM /RL HIGHEST /F`,
    'echo Done.',
  ];
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  fs.writeFileSync(cmdFile, lines.join('\r\n') + '\r\n');
  await new Promise((resolve) =>
    execFile('powershell.exe', ['-NoProfile', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c','"${cmdFile}"' -Verb RunAs -Wait`], { windowsHide: true, timeout: 120000 }, () => resolve())
  );
  if (await acmeTaskExists()) return { ok: true, message: tr('অটো-নবায়ন চালু হয়েছে (রোজ সকাল ৯টায়, Task Scheduler-এ)', 'Auto-renewal is on (daily at 09:00, in Task Scheduler)') };
  shell.showItemInFolder(cmdFile);
  return { ok: false, message: tr(`অটো-নবায়ন বসানো যায়নি। Explorer-এ খোলা ${path.basename(cmdFile)} ফাইলে ডান ক্লিক করে "Run as administrator" দিন`, `Could not set up auto-renewal. In the Explorer window, right-click ${path.basename(cmdFile)} and choose "Run as administrator"`) };
});

// সাইট ধরে সেশনের মেয়াদ (মিনিট; ফাঁকা/০ মানে ডিফল্ট)
ipcMain.handle('site:setSession', async (_event, domain, minutes) => {
  if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
  const sites = withToolSites(scanSites());
  if (!sites.some((s) => s.domain === domain && !s.system)) {
    return { ok: false, message: tr('সমস্যা: সাইটটা পাওয়া যায়নি', 'Error: site not found') };
  }
  const raw = String(minutes === undefined || minutes === null ? '' : minutes).trim();
  const n = raw === '' ? 0 : parseInt(raw, 10);
  if (raw !== '' && (!/^\d+$/.test(raw) || n > 525600)) {
    return { ok: false, message: tr('সমস্যা: মিনিট ১ থেকে ৫২৫৬০০-এর মধ্যে একটা সংখ্যা দিন (ফাঁকা = ডিফল্ট)', 'Error: enter minutes between 1 and 525600 (empty = default)') };
  }
  busy = true;
  try {
    settings.siteSession = { ...(settings.siteSession || {}) };
    if (n >= 1) settings.siteSession[domain] = n;
    else delete settings.siteSession[domain];
    saveSettings(settings);
    const label = n >= 1 ? tr(`${n} মিনিট`, `${n} minute(s)`) : tr('ডিফল্ট', 'default');
    let lvNote = '';
    try {
      const lv = laravelProjectOf(sites.find((x) => x.domain === domain));
      if (lv) {
        const f = path.join(lv, '.env');
        fs.writeFileSync(f, setEnvValues(fs.readFileSync(f, 'utf8'), { SESSION_LIFETIME: n >= 1 ? n : LARAVEL_DEFAULT_SESSION_MIN }));
        lvNote = tr(` (Laravel .env-এ SESSION_LIFETIME=${n >= 1 ? n : LARAVEL_DEFAULT_SESSION_MIN} বসানো হয়েছে)`, ` (Laravel .env SESSION_LIFETIME set to ${n >= 1 ? n : LARAVEL_DEFAULT_SESSION_MIN})`);
      }
    } catch {}
    const live = await reloadRunning(sites);
    return {
      ok: true,
      message: live
        ? tr(`${domain}-এর সেশন মেয়াদ এখন ${label}`, `${domain} session lifetime is now ${label}`) + lvNote
        : tr(`${domain}-এর সেশন মেয়াদ (${label}) সেভ হয়েছে। সার্ভার চালু করলে কাজ করবে`, `Session lifetime (${label}) saved for ${domain}. It will apply when the server starts`) + lvNote,
    };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  } finally {
    busy = false;
  }
});

// PHP extension তালিকা ও চালু/বন্ধ (ভার্সন ধরে)
ipcMain.handle('ext:list', (_event, version) => {
  const versions = phpVersionList().filter((v) => v.installed).map((v) => v.version);
  const ver = versions.includes(version) ? version : defaultPhpVersion();
  const l = phpExtList(ver);
  return { versions, version: ver, def: defaultPhpVersion(), items: l ? l.items : [], running: !!running };
});
ipcMain.handle('ext:set', (_event, version, name, on) => {
  name = String(name || '');
  const l = phpExtList(version);
  if (!l || !l.items.some((i) => i.name === name)) return { ok: false, message: tr('সমস্যা: extension পাওয়া যায়নি', 'Error: extension not found') };
  settings.phpExt = { ...(settings.phpExt || {}) };
  settings.phpExt[version] = { ...(settings.phpExt[version] || {}), [name]: !!on };
  saveSettings(settings);
  try {
    refreshPhpIni(l.dir);
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
  const state = on ? tr('চালু', 'enabled') : tr('বন্ধ', 'disabled');
  return {
    ok: true,
    message: running
      ? tr(`PHP ${version}-এ ${name} ${state}। কার্যকর করতে ওয়েব সার্ভার বন্ধ করে আবার চালু করুন`, `${name} ${state} for PHP ${version}. Stop and start the web server to apply`)
      : tr(`PHP ${version}-এ ${name} ${state}। সার্ভার চালু করলে কাজ করবে`, `${name} ${state} for PHP ${version}. It will apply when the server starts`),
  };
});

// ---------- ভাষা ----------
ipcMain.handle('lang:get', () => (settings.lang === 'en' ? 'en' : 'bn'));
ipcMain.handle('lang:set', (_event, lang) => {
  settings.lang = lang === 'en' ? 'en' : 'bn';
  saveSettings(settings);
  if (tray && !tray.isDestroyed()) buildTray(); // ট্রে মেনুর ভাষাও বদলাবে
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
// ডাটাবেস রিস্টার্ট: নিরাপদে বন্ধ করে আবার চালু (চলমান না থাকলে কিছু করে না)
async function restartDatabase(id) {
  const db = DATABASES[id];
  if (!db) return tr('সমস্যা: অজানা ডাটাবেস', 'Error: unknown database');
  if (!dbRun[id]) return tr(`${db.label} চলছে না`, `${db.label} is not running`);
  if (busy) return tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...');
  await stopDatabase(id);
  return startDatabase(id);
}
ipcMain.handle('db:restart', (_event, id) => restartDatabase(id));
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
  // \"Start All-এ চালু\" সুইচ দেওয়া Node অ্যাপগুলোও (ওয়েব সার্ভার ও ডাটাবেসের পরে, যাতে .test ঠিকানায় খোলে)
  try {
    for (const s of scanSites().filter((x) => x.node && !x.disabled && nodeCfg(x.domain).startall)) {
      if (nodeRun[s.domain]) continue;
      const r = await startNodeApp(s.domain);
      lines.push(r.message);
    }
  } catch (err) {
    lines.push(tr('Node অটো-চালু ব্যর্থ: ', 'Node auto-start failed: ') + err.message);
  }
  return lines.join('\n');
});

// যা যা চলছে (ওয়েব সার্ভার ও ডাটাবেস) সবগুলো রিস্টার্ট
ipcMain.handle('all:restart', async () => {
  const lines = [];
  if (running) lines.push(await restartWebServer());
  for (const id of Object.keys(DATABASES)) {
    if (dbRun[id]) lines.push(await restartDatabase(id));
  }
  return lines.length ? lines.join('\n') : tr('কিছুই চলছে না', 'Nothing is running');
});

ipcMain.handle('all:stop', async () => {
  const lines = [];
  // চলমান Node অ্যাপগুলোও বন্ধ (npm install চললে সেটা ছোঁয়া হয় না)
  for (const d of Object.keys(nodeRun)) {
    if (nodeRun[d] && nodeRun[d].task === 'run' && (await stopNodeApp(d))) lines.push(tr(`${d} বন্ধ হয়েছে`, `${d} stopped`));
  }
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
  if (kind === 'postgres' && pgPw()) {
    return tr(`Adminer ব্রাউজারে খোলা হয়েছে${warn}। Username postgres, Password-এ আপনার সেট করা পাসওয়ার্ড দিন।`, `Adminer opened in the browser${warn}. Username postgres, and enter the password you set.`);
  }
  if (kind === 'mysql' && mysqlRootPw()) {
    return tr(`Adminer ব্রাউজারে খোলা হয়েছে${warn}। Username root, Password-এ আপনার সেট করা পাসওয়ার্ড দিন।`, `Adminer opened in the browser${warn}. Username root, and enter the password you set.`);
  }
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
// Restore/Backup পেজের পথ ক্লিক করলে Explorer-এ খোলা। ফোল্ডার = খোলে; ফাইল = Explorer-এ দেখায় (চালায় না);
// পথ না থাকলে সবচেয়ে কাছের আছে-এমন উপরের ফোল্ডার (ড্রাইভের root বাদ)।
ipcMain.handle('path:open', async (_event, p) => {
  try {
    if (typeof p !== 'string' || p.length > 500 || /[\x00-\x1f<>|"*?]/.test(p)) return { ok: false };
    if (!/^[A-Za-z]:\\/.test(p) && !/^\\\\[^\\]+\\/.test(p)) return { ok: false };
    let cur = path.resolve(p);
    for (let i = 0; i < 12; i++) {
      let st = null;
      try {
        st = fs.statSync(cur);
      } catch {}
      if (st) {
        if (st.isDirectory()) {
          const err = await shell.openPath(cur);
          return { ok: !err, path: cur, message: err || '' };
        }
        shell.showItemInFolder(cur);
        return { ok: true, path: cur };
      }
      const up = path.dirname(cur);
      if (up === cur || path.parse(up).root === up) return { ok: false };
      cur = up;
    }
    return { ok: false };
  } catch (err) {
    return { ok: false, message: err.message };
  }
});

ipcMain.handle('open:url', (_event, url) => {
  if (/^http:\/\/(localhost|[a-z0-9-]+\.test)(:\d{1,5})?\/?$/.test(url)) return shell.openExternal(url);
});


// ---------- Node.js সাইট (অ্যাপ চালানো, লগ, npm install) ----------
// www-র যে সাবফোল্ডারে package.json আছে (index.php/artisan/composer.json/wp-config.php নেই) সেটা Node সাইট।
// অ্যাপ নিজের পোর্টে চলে (PORT ভেরিয়েবলে পাঠানো হয়), <নাম>.test ঠিকানা Nginx/Apache-র reverse proxy দিয়ে সেখানে যায়।
// Node অ্যাপ ওয়েব সার্ভারের সাথে নিজে থেকে চালু/বন্ধ হয় না; অ্যাপ বন্ধ করলে বা অ্যাপ কোয়িট করলে এগুলোও বন্ধ হয়।
const nodeRun = {}; // domain -> { proc, task: 'run' | 'install', port, exit: Promise<code> }
const nodeResume = new Set(); // যে সাইট বন্ধ করার সময় অ্যাপ চলছিল: আবার চালু (On) করলে অ্যাপও নিজে চালু হবে (শুধু এই রান, সেভ হয় না)
const nodeLogs = {}; // domain -> [লাইন...] (প্রসেস বন্ধ হলেও লগ থাকে, যাতে এরর পড়া যায়)
const NODE_LOG_MAX = 400;
const nodeBusyMsg = () => tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...');

function nodeLogPush(domain, text) {
  const arr = (nodeLogs[domain] = nodeLogs[domain] || []);
  const clean = String(text).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''); // রঙের escape কোড বাদ
  for (const line of clean.split(/\r?\n/)) {
    if (line.trim()) arr.push(line.slice(0, 500));
  }
  if (arr.length > NODE_LOG_MAX) arr.splice(0, arr.length - NODE_LOG_MAX);
}

// ব্যর্থতার বার্তায় লগের শেষ কয়েকটা কাজের লাইন (নিজের [শেষ...] লাইন ও Node-এর ভার্সন লাইন বাদে)
const nodeTail = (domain) =>
  (nodeLogs[domain] || [])
    .filter((l) => !l.startsWith('[') && !l.startsWith('---') && !/^Node\.js v\d/.test(l))
    .slice(-3)
    .join(' | ')
    .slice(-300);

const findNodeSite = (domain) => scanSites().find((s) => s.domain === domain && s.node) || null;

// চালানোর কমান্ড নিজে ধরা: scripts.start -> scripts.dev -> package.json "main" -> server.js/index.js/app.js/main.js
function detectNodeCmd(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const sc = pkg.scripts || {};
    if (sc.start) return 'npm start';
    if (sc.dev) return 'npm run dev';
    if (typeof pkg.main === 'string' && /^[\w./-]+$/.test(pkg.main) && fs.existsSync(path.join(dir, pkg.main))) return `node ${pkg.main}`;
  } catch {}
  for (const f of ['server.js', 'index.js', 'app.js', 'main.js']) {
    if (fs.existsSync(path.join(dir, f))) return `node ${f}`;
  }
  return '';
}
const nodeCmdOf = (site) => String(nodeCfg(site.domain).cmd || '').trim() || detectNodeCmd(site.root);

// ---- Node ভার্সন (step 2): "টুলস ও ভার্সন" পেজের Node তালিকা থেকে সাইট ধরে ভার্সন বাছা ----
// settings.nodeSites[domain].version = '22.12.0'। না থাকলে (বা তালিকা থেকে মুছে গেলে) চালু (active) ভার্সন ব্যবহার হয়।
function nodeVersionList() {
  const def = TOOL_DEFAULTS.node;
  const items = (settings.toolVersions && settings.toolVersions.node && settings.toolVersions.node.items) || {};
  return [{ version: def.version, folder: def.folder, url: def.url }, ...Object.entries(items).map(([v, it]) => ({ version: v, folder: it.folder, url: it.url || null }))].map((x) => {
    const dir = path.join(TOOLS_DIR, x.folder);
    return { version: x.version, folder: x.folder, url: x.url, dir, installed: fs.existsSync(path.join(dir, SERVICES.node.exeRel)) };
  });
}
const pinnedNodeVersion = (domain) => {
  const v = nodeCfg(domain).version;
  return v && nodeVersionList().some((x) => x.version === v) ? v : '';
};
const nodeVersionOf = (domain) => pinnedNodeVersion(domain) || activeVersion('node').version;

// অ্যাপের পরিবেশ: PORT, আর PATH-এর শুরুতে Node-এর ফোল্ডার (যাতে node, npm, npx পাওয়া যায়)
function nodeEnv(port, nodeDir) {
  const env = { ...process.env, PORT: String(port), FORCE_COLOR: '0' };
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  env[pk] = (nodeDir || path.dirname(SERVICES.node.exe)) + path.delimiter + (env[pk] || '');
  return env;
}

// নির্দিষ্ট Node ভার্সন তৈরি আছে কিনা দেখে (না থাকলে নামায়)। ফেরত দেয় { version, dir, ... }
async function ensureNodeRuntime(version) {
  const find = () => nodeVersionList().find((x) => x.version === version) || nodeVersionList().find((x) => x.version === activeVersion('node').version);
  let v = find();
  if (v.installed) return v;
  if (busy) throw new Error(nodeBusyMsg());
  busy = true;
  try {
    if (v.version === activeVersion('node').version) {
      await ensureService(SERVICES.node);
    } else {
      if (!v.url) throw new Error(tr(`Node ${v.version}-এর ফাইল নেই (লোকাল ZIP থেকে যোগ হয়েছিল)। \"টুলস ও ভার্সন\" থেকে আবার যোগ করুন`, `Node ${v.version} files are missing (it was added from a local ZIP). Add it again from \"Tools & Versions\"`));
      sendStatus(tr(`Node ${v.version} নামানো হচ্ছে...`, `Downloading Node ${v.version}...`));
      await installInto(SERVICES.node, v.dir, { url: v.url });
      sendStatus(tr(`Node ${v.version} ইনস্টল সম্পন্ন`, `Node ${v.version} installed`));
    }
  } finally {
    busy = false;
  }
  v = find();
  if (!v.installed) throw new Error(tr(`Node ${v.version} পাওয়া যায়নি`, `Node ${v.version} not found`));
  return v;
}

function spawnNodeTask(domain, site, command, task, port, nodeEntry) {
  nodeLogPush(domain, `--- ${new Date().toLocaleTimeString()} ---`);
  nodeLogPush(domain, `> ${command}${task === 'run' ? `   (PORT=${port}, Node ${nodeEntry.version})` : `   (Node ${nodeEntry.version})`}`);
  const proc = spawn(command, { cwd: site.root, env: nodeEnv(port, nodeEntry.dir), shell: true, windowsHide: true });
  trackPid(proc, 'node', 'cmd.exe');
  const run = { proc, task, port, version: nodeEntry.version };
  run.exit = new Promise((resolve) => {
    proc.once('exit', (code) => resolve(code));
    proc.once('error', (e) => {
      nodeLogPush(domain, 'error: ' + e.message);
      resolve(-1);
    });
  });
  nodeRun[domain] = run;
  proc.stdout.on('data', (d) => nodeLogPush(domain, d));
  proc.stderr.on('data', (d) => nodeLogPush(domain, d));
  run.exit.then((code) => {
    nodeLogPush(domain, tr(`[শেষ হয়েছে, কোড ${code}]`, `[exited, code ${code}]`));
    if (nodeRun[domain] === run) delete nodeRun[domain];
  });
  return run;
}

async function stopNodeApp(domain) {
  const run = nodeRun[domain];
  if (!run) return false;
  killTree(run.proc.pid);
  await Promise.race([run.exit, new Promise((r) => setTimeout(r, 4000))]);
  if (nodeRun[domain] === run) delete nodeRun[domain];
  return true;
}

// প্রক্সির কনফিগ বদলালে চলমান ওয়েব সার্ভারে লোড করা (Apache-তে ভেতরে ভেতরে রিস্টার্ট হয়)
async function reloadWebLocked() {
  if (!running || busy) return false;
  busy = true;
  try {
    return await reloadRunning(withToolSites(scanSites()));
  } catch {
    return false;
  } finally {
    busy = false;
  }
}

const nodeFail = (msg) => ({ ok: false, message: tr('সমস্যা: ', 'Error: ') + msg });

async function startNodeApp(domain) {
  const site = findNodeSite(domain);
  if (!site) return nodeFail(tr('Node সাইটটা পাওয়া যায়নি', 'Node site not found'));
  if (site.disabled) return nodeFail(tr('সাইটটা বন্ধ আছে (সাইটের টেবিলে \"চালু\" টিক দিন)', 'the site is disabled (tick \"On\" in the sites table)'));
  if (nodeRun[domain]) return { ok: false, message: tr(`${domain} আগে থেকেই ${nodeRun[domain].task === 'install' ? 'npm install চালাচ্ছে' : 'চলছে'}`, `${domain} is already ${nodeRun[domain].task === 'install' ? 'running npm install' : 'running'}`) };
  const command = nodeCmdOf(site);
  if (!command) return nodeFail(tr('চালানোর কমান্ড পাওয়া যায়নি। কমান্ড ঘরে লিখুন (যেমন node server.js)', 'no start command found. Enter one in the command field (e.g. node server.js)'));
  let nodeEntry;
  try {
    nodeEntry = await ensureNodeRuntime(nodeVersionOf(domain));
  } catch (err) {
    return nodeFail(err.message);
  }

  // পোর্ট: খালি না থাকলে (নিজের বসানো না হলে) পরের খালি নম্বর নেওয়া, আর proxy-র কনফিগ নতুন পোর্টে লোড করা
  let port = nodePortOf(domain);
  let portChanged = false;
  if (!(await isPortFree(port))) {
    if (nodeCfg(domain).manual) return nodeFail(tr(`পোর্ট ${port} অন্য কেউ ব্যবহার করছে। অন্য পোর্ট দিন বা ঘরটা ফাঁকা রাখুন (অটো)`, `port ${port} is in use. Enter another port or leave the field empty (auto)`));
    const used = new Set(Object.values(settings.nodeSites || {}).map((c) => c && c.port));
    let p = 3100;
    while (p < 4000 && (used.has(p) || !(await isPortFree(p)))) p++;
    if (p >= 4000) return nodeFail(tr('খালি পোর্ট পাওয়া যায়নি (3100-3999)', 'no free port found (3100-3999)'));
    settings.nodeSites = { ...(settings.nodeSites || {}), [domain]: { ...nodeCfg(domain), port: p } };
    saveSettings(settings);
    port = p;
    portChanged = true;
  }

  const run = spawnNodeTask(domain, site, command, 'run', port, nodeEntry);
  // ১.৫ সেকেন্ডের মধ্যে বন্ধ হয়ে গেলে ব্যর্থ
  const early = await Promise.race([run.exit, new Promise((r) => setTimeout(() => r(null), 1500))]);
  if (early !== null) {
    const tail = nodeTail(domain);
    return nodeFail(tr(`অ্যাপ চালু হয়নি (কোড ${early}). ${tail}`, `the app did not start (code ${early}). ${tail}`));
  }
  if (portChanged) await reloadWebLocked();

  // পোর্টে সাড়া না দেওয়া পর্যন্ত কিছুক্ষণ অপেক্ষা (সর্বোচ্চ ~8 সেকেন্ড)
  let listening = false;
  for (let i = 0; i < 20 && nodeRun[domain] === run; i++) {
    if (await tcpCheck(port)) {
      listening = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (listening) await trackListener(run.proc, port, 'node', 'node.exe');
  if (nodeRun[domain] !== run) {
    const tail = nodeTail(domain);
    return nodeFail(tr(`অ্যাপ চালু হয়ে বন্ধ হয়ে গেছে। ${tail}`, `the app started and then stopped. ${tail}`));
  }
  const where = running ? siteUrl(domain) : `http://localhost:${port}`;
  return {
    ok: true,
    message: listening
      ? tr(`${domain} চালু হয়েছে (পোর্ট ${port}, Node ${nodeEntry.version})। খুলুন: ${where}${running ? '' : ' (ওয়েব সার্ভার চালু করলে .test ঠিকানাতেও খুলবে)'}`, `${domain} started (port ${port}, Node ${nodeEntry.version}). Open: ${where}${running ? '' : ' (start a web server to open it on the .test address)'}`)
      : tr(`${domain}-এর কমান্ড চালু হয়েছে, কিন্তু পোর্ট ${port} এখনো সাড়া দিচ্ছে না। লগ দেখুন; অ্যাপ PORT না মানলে পোর্ট ঘরে অ্যাপের আসল পোর্ট দিন`, `${domain} command is running, but port ${port} does not answer yet. Check the log; if the app ignores PORT, enter the app's real port in the port field`),
  };
}

async function installNodeDeps(domain) {
  const site = findNodeSite(domain);
  if (!site) return nodeFail(tr('Node সাইটটা পাওয়া যায়নি', 'Node site not found'));
  if (nodeRun[domain]) return { ok: false, message: tr(`${domain} এখন চলছে, আগে বন্ধ করুন`, `${domain} is busy, stop it first`) };
  let nodeEntry;
  try {
    nodeEntry = await ensureNodeRuntime(nodeVersionOf(domain));
  } catch (err) {
    return nodeFail(err.message);
  }
  const npm = path.join(nodeEntry.dir, 'npm.cmd');
  if (!fs.existsSync(npm)) return nodeFail(tr('এই Node ZIP-এ npm.cmd নেই', 'this Node ZIP does not include npm.cmd'));
  sendStatus(tr(`${domain}: npm install চলছে (কিছুক্ষণ লাগবে)...`, `${domain}: running npm install (this takes a while)...`));
  const run = spawnNodeTask(domain, site, `\"${npm}\" install`, 'install', nodePortOf(domain), nodeEntry);
  const timer = setTimeout(() => killTree(run.proc.pid), 15 * 60 * 1000);
  const code = await run.exit;
  clearTimeout(timer);
  if (code === 0) return { ok: true, message: tr(`${domain}: npm install শেষ হয়েছে`, `${domain}: npm install finished`) };
  const tail = nodeTail(domain);
  return nodeFail(tr(`npm install ব্যর্থ (কোড ${code}). ${tail}`, `npm install failed (code ${code}). ${tail}`));
}

ipcMain.handle('node:list', () =>
  withToolSites(scanSites())
    .filter((s) => s.node)
    .map((s) => {
      const cfg = nodeCfg(s.domain);
      const run = nodeRun[s.domain];
      return {
        domain: s.domain,
        name: s.name,
        root: s.root,
        url: siteUrl(s.domain),
        enabled: !s.disabled,
        cmd: String(cfg.cmd || ''),
        cmdAuto: detectNodeCmd(s.root),
        port: nodePortOf(s.domain),
        manual: !!cfg.manual,
        state: run ? run.task : 'stopped', // 'run' | 'install' | 'stopped'
        hasModules: fs.existsSync(path.join(s.root, 'node_modules')),
        version: pinnedNodeVersion(s.domain), // '' = চালু (active) ভার্সন
        runVersion: run ? run.version : '',
        autostart: !!cfg.autostart,
        startall: !!cfg.startall,
        defVersion: activeVersion('node').version,
        versions: nodeVersionList().map((v) => ({ version: v.version, installed: v.installed })),
        webRunning: !!running,
      };
    })
);

ipcMain.handle('node:config', async (_event, domain, cfg = {}) => {
  const site = findNodeSite(domain);
  if (!site) return nodeFail(tr('Node সাইটটা পাওয়া যায়নি', 'Node site not found'));
  const prev = nodeCfg(domain);
  const cmd = (cfg.cmd === undefined ? String(prev.cmd || '') : String(cfg.cmd || '')).trim(); // পাঠানো না হলে আগেরটা থাকে
  if (cmd.length > 300 || /[\r\n\0]/.test(cmd)) return nodeFail(tr('কমান্ড এক লাইনে ও ৩০০ অক্ষরের মধ্যে হতে হবে', 'the command must be a single line of at most 300 characters'));
  const portSent = cfg.port !== undefined; // পাঠানো না হলে পোর্ট (ও manual চিহ্ন) আগের মতোই থাকে
  const portRaw = String(cfg.port ?? '').trim();
  let port = prev.port;
  let manual = portSent ? false : !!prev.manual;
  if (portSent && portRaw) {
    port = validPort(portRaw);
    if (!port) return nodeFail(tr('পোর্ট ১-৬৫৫৩৫-এর মধ্যে একটা সংখ্যা হতে হবে', 'the port must be a number between 1 and 65535'));
    const taken = port === getWebPort() || Object.keys(DATABASES).some((id) => getDbPort(id) === port) || Object.entries(settings.nodeSites || {}).some(([d, c]) => d !== domain && c && c.port === port);
    if (taken) return nodeFail(tr(`পোর্ট ${port} ওয়েব সার্ভার, ডাটাবেস বা অন্য Node সাইট নিয়ে রেখেছে`, `port ${port} is used by the web server, a database or another Node site`));
    manual = true;
  }
  const portChanged = port !== prev.port;
  // Node ভার্সন (ফাঁকা = চালু ভার্সন) ও অ্যাপ খুললে অটো-চালু: পাঠানো না হলে আগের মান থাকে
  let version = cfg.version === undefined ? prev.version || '' : String(cfg.version || '').trim();
  if (version && !nodeVersionList().some((x) => x.version === version)) return nodeFail(tr(`Node ${version} তালিকায় নেই। আগে \"টুলস ও ভার্সন\" পেজে যোগ করুন`, `Node ${version} is not in the list. Add it on the \"Tools & Versions\" page first`));
  if (version === activeVersion('node').version) version = ''; // চালু ভার্সনের সাথে এক হলে আলাদা করে বাঁধার দরকার নেই
  const autostart = cfg.autostart === undefined ? !!prev.autostart : !!cfg.autostart;
  const startall = cfg.startall === undefined ? !!prev.startall : !!cfg.startall; // Start All চাপলে চালু হবে কি না (অ্যাপ খোলার অটো-চালু থেকে আলাদা)
  settings.nodeSites = { ...(settings.nodeSites || {}), [domain]: { ...(cmd ? { cmd } : {}), ...(port ? { port } : {}), ...(manual ? { manual: true } : {}), ...(version ? { version } : {}), ...(autostart ? { autostart: true } : {}), ...(startall ? { startall: true } : {}) } };
  saveSettings(settings);
  if (portChanged) await reloadWebLocked();
  const live = !!nodeRun[domain];
  return { ok: true, message: tr(`${domain}-এর সেটিং সেভ হয়েছে${live ? ' (চলমান অ্যাপে প্রযোজ্য হতে রিস্টার্ট করুন)' : ''}`, `${domain} settings saved${live ? ' (restart the running app to apply)' : ''}`) };
});

ipcMain.handle('node:start', (_event, domain) => startNodeApp(domain));
ipcMain.handle('node:stop', async (_event, domain) => ((await stopNodeApp(domain)) ? { ok: true, message: tr(`${domain} বন্ধ হয়েছে`, `${domain} stopped`) } : { ok: false, message: tr(`${domain} চলছে না`, `${domain} is not running`) }));
ipcMain.handle('node:restart', async (_event, domain) => {
  if (nodeRun[domain] && nodeRun[domain].task === 'install') return { ok: false, message: tr('npm install চলছে, শেষ হওয়া পর্যন্ত অপেক্ষা করুন', 'npm install is running, wait for it to finish') };
  await stopNodeApp(domain);
  return startNodeApp(domain);
});
ipcMain.handle('node:install', (_event, domain) => installNodeDeps(domain));
ipcMain.handle('node:log', (_event, domain) => ({ lines: (nodeLogs[domain] || []).slice(-300), state: nodeRun[domain] ? nodeRun[domain].task : 'stopped' }));

// অ্যাপ খুললে: আগের বার ক্র্যাশ/জোর-বন্ধ হওয়ায় রয়ে যাওয়া node.exe (শুধু আমাদের tools ফোল্ডারেরগুলো) মেরে ফেলা,
// তারপর \"অ্যাপ খুললে চালু\" টিক দেওয়া Node অ্যাপগুলো একটা একটা করে চালু করা।
async function startupNodeApps() {
  try {
    await killStale('node');
    const list = scanSites().filter((s) => s.node && !s.disabled && nodeCfg(s.domain).autostart);
    for (const s of list) {
      if (nodeRun[s.domain]) continue;
      sendStatus(tr(`${s.domain} নিজে থেকে চালু হচ্ছে...`, `Auto-starting ${s.domain}...`));
      const r = await startNodeApp(s.domain);
      sendStatus(r.message);
    }
  } catch (err) {
    sendStatus(tr('Node অটো-চালু ব্যর্থ: ', 'Node auto-start failed: ') + err.message);
  }
}

// ---------- টুলস ও ভার্সন ----------
const TOOL_ORDER = ['php', 'nginx', 'apache', 'mysql', 'postgres', 'phpmyadmin', 'node'];
const TOOL_HELP = {
  php: 'https://windows.php.net/download/',
  nginx: 'https://nginx.org/en/download.html',
  apache: 'https://www.apachelounge.com/download/',
  mysql: 'https://dev.mysql.com/downloads/mysql/',
  postgres: 'https://www.enterprisedb.com/download-postgresql-binaries',
  phpmyadmin: 'https://www.phpmyadmin.net/downloads/',
  node: 'https://nodejs.org/en/download',
};
const TOOL_HINT = {
  php: ['Thread Safe নয় এমন (NTS) x64 ZIP নামান', 'Download the Non-Thread-Safe (NTS) x64 ZIP'],
  nginx: ['Windows-এর ZIP নামান', 'Download the Windows ZIP'],
  apache: ['Win64 ZIP নামান (Apache Lounge)', 'Download the Win64 ZIP (Apache Lounge)'],
  mysql: ['"ZIP Archive" (Windows x64) নামান, MSI নয়', 'Download the "ZIP Archive" (Windows x64), not the MSI'],
  postgres: ['EDB-র "Windows x86-64" binaries ZIP নামান', 'Download the EDB "Windows x86-64" binaries ZIP'],
  phpmyadmin: ['all-languages.zip নামান', 'Download all-languages.zip'],
  node: ['nodejs.org/dist থেকে node-v...-win-x64.zip নামান (Windows Binary ZIP, MSI নয়)', 'Download node-v...-win-x64.zip from nodejs.org/dist (the Windows Binary ZIP, not the MSI)'],
};
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z._-]{0,30}$/;
// কোনো টুল চলার সময় ভার্সন বদলানো যাবে না
const toolInUse = (id) => (id === 'mysql' || id === 'postgres' ? !!dbRun[id] : id === 'node' ? Object.keys(nodeRun).length > 0 : !!running);

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
  // যে Node ভার্সনে কোনো অ্যাপ এখন চলছে সেটা মোছা যাবে না (ফাইল আটকে থাকে)
  if (id === 'node' && Object.values(nodeRun).some((r) => r.version === version)) {
    return { ok: false, message: tr(`Node ${version} এখন কোনো অ্যাপ ব্যবহার করছে। আগে সেই অ্যাপ বন্ধ করুন`, `Node ${version} is in use by a running app. Stop that app first`) };
  }
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
  // যে Node সাইটগুলো এই ভার্সনে বাঁধা ছিল সেগুলো চালু (active) ভার্সনে ফিরবে
  if (id === 'node' && settings.nodeSites) {
    const moved = Object.keys(settings.nodeSites).filter((d) => settings.nodeSites[d] && settings.nodeSites[d].version === version);
    moved.forEach((d) => delete settings.nodeSites[d].version);
    if (moved.length) phpNote = tr(` (${moved.length}টা Node সাইট চালু ভার্সনে ফিরেছে)`, ` (${moved.length} Node site(s) went back to the active version)`);
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
  // ধাপ ০: ভাষা (প্রথমবার তাই দুই ভাষাতেই লেখা; সিস্টেমের ভাষা বাংলা হলে বাংলা আগে থেকে বাছা থাকে)
  const sysBn = String(app.getLocale() || '').toLowerCase().startsWith('bn');
  const lg = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'Server 360',
    message: 'ভাষা বেছে নিন / Choose your language',
    detail: 'পরে সেটিংস থেকেও বদলানো যাবে।\nYou can change it later in Settings.',
    buttons: ['বাংলা', 'English'],
    defaultId: sysBn ? 0 : 1,
    cancelId: sysBn ? 0 : 1,
  });
  settings.lang = lg.response === 1 ? 'en' : 'bn';
  saveSettings(settings);
  win.webContents.send('lang:changed', settings.lang);

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

// ---------- Backup (Session 12, step 1) ----------
// মূল কাজ backup.js-এ; এখানে শুধু ctx জোগান ও IPC। পাসওয়ার্ড settings.json-এ সাধারণ লেখায় নয়: Electron safeStorage (DPAPI) দিয়ে মোড়া।
const { safeStorage } = require('electron');
const { createBackup } = require('./backup.js');
const BACKUP_CLI = process.argv.includes('--backup'); // Task Scheduler এটা দিয়ে চালায়: কোনো উইন্ডো ছাড়া একবার backup নিয়ে বেরিয়ে যায়
// একসাথে একটাই অ্যাপ: দ্বিতীয়বার খুললে আগেরটার উইন্ডো সামনে আসে (--backup চালানো আলাদা, তাতে লক নেই)
const GOT_LOCK = BACKUP_CLI ? true : app.requestSingleInstanceLock();
if (!GOT_LOCK) app.quit();
app.on('second-instance', () => showMainWindow());
const SEVENZIP_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/7z2606-x64.exe';
const backup = createBackup({
  tr,
  settings: () => settings,
  save: saveSettings,
  rootDir: () => ROOT_DIR,
  toolsDir: () => TOOLS_DIR,
  wwwDir: () => WWW_DIR,
  certsDir: () => certsDir(),
  settingsPath: () => SETTINGS_PATH,
  mysqlDir: () => SERVICES.mysql.dir,
  pgDir: () => SERVICES.postgres.dir,
  mysqlPort: () => getDbPort('mysql'),
  pgPort: () => getDbPort('postgres'),
  mysqlEnv: () => mysqlEnv(),
  pgEnv: () => pgEnv(),
  phpVersions: () => phpVersionList().map((x) => x.version),
  nodeVersions: () => nodeVersionList().map((x) => x.version),
  secret: {
    enc: (t) => (safeStorage.isEncryptionAvailable() ? 'ss:' + safeStorage.encryptString(t).toString('base64') : 'b64:' + Buffer.from(t, 'utf8').toString('base64')),
    dec: (v) => {
      try {
        return v.startsWith('ss:') ? safeStorage.decryptString(Buffer.from(v.slice(3), 'base64')) : Buffer.from(v.slice(4), 'base64').toString('utf8');
      } catch {
        return '';
      }
    },
  },
  download,
  sevenZipUrl: SEVENZIP_URL,
  // ডাটাবেস বন্ধ থাকলে backup-এর জন্য সাময়িক চালু/বন্ধ (startDatabase নিজে ensureService, পোর্ট পরীক্ষা ইত্যাদি করে)
  startDb: async (id) => {
    const message = await startDatabase(id);
    return { ok: !!dbRun[id], message };
  },
  stopDb: async (id) => {
    await stopDatabase(id);
  },
  onProgress: (name) => win && !win.isDestroyed() && win.webContents.send('status', tr('Backup: ', 'Backup: ') + name),
});

ipcMain.handle('backup:getConfig', () => backup.getConfig());
ipcMain.handle('backup:setConfig', (_e, cfg, secrets) => {
  try {
    return { ok: true, config: backup.setConfig(cfg || {}, secrets || {}) };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});
ipcMain.handle('backup:run', async () => backup.runBackup({ source: 'manual' }));
ipcMain.handle('backup:status', () => ({ running: backup.isRunning(), last: backup.lastStatus(), log: backup.tailLog(60), sevenZip: !!backup.find7z(), backupDir: backup.dirs.baseDir() }));
ipcMain.handle('backup:ensure7z', async () => {
  try {
    const r = await backup.ensure7z();
    return r.ok ? { ok: true, message: r.fresh ? tr('7-Zip ইনস্টল হয়েছে', '7-Zip installed') : tr('7-Zip আগেই আছে', '7-Zip is already available') } : { ok: false, message: r.message };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});
ipcMain.handle('backup:chooseFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled || !r.filePaths[0] ? '' : r.filePaths[0];
});
// ফোল্ডারের সাইজ (Backup পেজে নিজের ফোল্ডার যোগ করার সময় দেখানো ও mode সাজেস্ট করতে); শুধু পড়ে, সর্বোচ্চ ৬০ সেকেন্ড
ipcMain.handle('backup:folderSize', async (_e, dir) => {
  try {
    if (typeof dir !== 'string' || !dir || !fs.statSync(dir).isDirectory()) return { ok: false };
    const r = await require('./backup').folderSize(dir, 60000);
    return { ok: true, bytes: r.bytes, files: r.files, partial: r.partial };
  } catch {
    return { ok: false };
  }
});
ipcMain.handle('backup:openLogs', () => shell.openPath(backup.dirs.logsDir()));
// Restore ধাপ ১: backup-এর তালিকা (শুধু পড়ে, কিছু বদলায় না); customDir খালি হলে চালু গন্তব্যগুলো, নইলে শুধু ওই ফোল্ডার
ipcMain.handle('restore:list', async (_e, customDir) => {
  try {
    return await backup.listBackups({ customDir: typeof customDir === 'string' ? customDir : '' });
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});

// Restore ধাপ ২: www সাইট ফেরত আনা। restore:wwwInfo শুধু পড়ে; restore:www ফাইল বসায়, তারপর সাইট স্ক্যান + hosts + ওয়েব সার্ভার reload,
// আর Node সাইটের node_modules না থাকলে npm install নিজে চালায় (বাদ-দেওয়া ফোল্ডার আবার তৈরি হয়ে সাইট চলার উপযোগী হয়)।
ipcMain.handle('restore:wwwInfo', (_e, dir) => {
  try {
    return backup.restoreWwwInfo(typeof dir === 'string' ? dir : '');
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});
// 5b: ডাটাবেস "_restored" নামে ফিরলে, কোন সাইট এখনো মূল ডাটাবেস ব্যবহার করছে (.env DB_DATABASE / wp-config.php DB_NAME) শুধু পড়ে বলে দেয়; কিছু বদলায় না।
// ফেরত দেয় true শুধু যদি প্রতিটা নতুন-নামের ডাটাবেসের জন্য নির্দিষ্ট লাইন যোগ হয় (তখন সাধারণ ⚠ লাইনটা আর লাগে না)।
const RESTORED_SITE_RE = /-restored(-\d+)?$/;
function dbHintsForRenamed(results) {
  try {
    const renamed = (results || []).filter((x) => x && x.ok && x.action === 'renamed' && x.name && x.final);
    if (!renamed.length || !fs.existsSync(WWW_DIR)) return false;
    const unq = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2');
    const used = []; // { folder, db }
    for (const e of fs.readdirSync(WWW_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dir = path.join(WWW_DIR, e.name);
      let db = '';
      let file = '';
      try {
        const envFile = path.join(dir, '.env');
        if (fs.existsSync(envFile)) {
          const m = fs.readFileSync(envFile, 'utf8').match(/^\s*DB_DATABASE\s*=\s*(.*)$/m);
          if (m) {
            db = unq(m[1]);
            file = '.env';
          }
        }
        if (!db && fs.existsSync(path.join(dir, 'wp-config.php'))) {
          const m = fs.readFileSync(path.join(dir, 'wp-config.php'), 'utf8').match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]*)['"]/);
          if (m) {
            db = m[1];
            file = 'wp-config.php';
          }
        }
      } catch (_) {}
      if (db) used.push({ folder: e.name, db, file });
    }
    let covered = 0;
    for (const x of renamed) {
      const sites = used.filter((u) => u.db === x.name).map((u) => u.folder);
      if (!sites.length) continue;
      covered++;
      // 5d: শুধু \"-restored\" সাইটের জন্য ঠিক-করার বাটন (মূল সাইট নয়: চালু সাইট ভুল করে কপির ডাটাবেসে চলে যেত)
      x.fixes = used.filter((u) => u.db === x.name && u.file && RESTORED_SITE_RE.test(u.folder)).map((u) => ({ folder: u.folder, file: u.file, from: x.name, to: x.final }));
      x.notes = (x.notes || []).concat(
        tr(
          `সাইট ${sites.join(', ')} এখনো মূল "${x.name}" ডাটাবেস ব্যবহার করছে; এই কপি ("${x.final}") কোনো সাইটে জোড়া নেই। কপি ব্যবহার করতে ওই সাইটের .env-এ DB_DATABASE=${x.final} (WordPress হলে wp-config.php-এর DB_NAME) বসান।`,
          `Site ${sites.join(', ')} still uses the original "${x.name}" database; this copy ("${x.final}") is not wired to any site. To use the copy, set DB_DATABASE=${x.final} in that site's .env (DB_NAME in wp-config.php for WordPress).`
        )
      );
    }
    return covered === renamed.length;
  } catch (_) {
    return false;
  }
}

// Restore-এর পর "-restored" কপির কনফিগ পুরোনো নামে রয়ে গেছে কিনা শুধু পড়ে বলে দেয় (কোনো ফাইল বদলায় না)।
function restoredConfigHints(origName, finalName) {
  const out = [];
  const dir = path.join(WWW_DIR, finalName);
  const slug = siteSlug(finalName);
  const unq = (v) => String(v).trim().replace(/^(['"])(.*)\1$/, '$2');
  try {
    const envFile = path.join(dir, '.env');
    if (fs.existsSync(envFile)) {
      const env = {};
      for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
        if (m && !(m[1] in env)) env[m[1]] = unq(m[2]);
      }
      if (env.DB_DATABASE && env.DB_CONNECTION !== 'sqlite') {
        out.push(
          tr(
            `${finalName}: .env-এ DB_DATABASE=${env.DB_DATABASE} আছে, মানে এই কপি আর মূল সাইট একই ডাটাবেস ব্যবহার করছে। আলাদা ডাটাবেস চাইলে ডাটাবেস restore-এ "দুটোই রাখুন" করে .env-এ নতুন নাম বসান।`,
            `${finalName}: .env has DB_DATABASE=${env.DB_DATABASE}, so this copy and the original site use the same database. For a separate one, restore the database with "keep both" and put the new name in .env.`
          )
        );
      }
      if (env.APP_URL) {
        let host = '';
        try {
          host = new URL(env.APP_URL).hostname.toLowerCase();
        } catch (_) {}
        if (host.endsWith('.test') && host !== slug + '.test') {
          out.push(
            tr(
              `${finalName}: .env-এর APP_URL=${env.APP_URL} পুরোনো নামের। এই কপির ঠিকানা http://${slug}.test, চাইলে APP_URL বদলান।`,
              `${finalName}: APP_URL=${env.APP_URL} in .env is the old name. This copy opens at http://${slug}.test; change APP_URL if you need to.`
            )
          );
        }
      }
    }
    const wp = path.join(dir, 'wp-config.php');
    if (fs.existsSync(wp)) {
      const m = fs.readFileSync(wp, 'utf8').match(/define\(\s*['"]DB_NAME['"]\s*,\s*['"]([^'"]*)['"]/);
      if (m) {
        out.push(
          tr(
            `${finalName}: wp-config.php-এ DB_NAME=${m[1]} আছে, মানে মূল সাইটের ডাটাবেসই ব্যবহার হচ্ছে। WordPress-এর সাইট URL ডাটাবেসের ভেতরে থাকে, তাই সেটাও পুরোনো ঠিকানার থাকবে।`,
            `${finalName}: wp-config.php has DB_NAME=${m[1]}, so the original site's database is used. WordPress keeps its site URL inside the database, so it still points to the old address.`
          )
        );
      }
    }
  } catch (_) {}
  return out;
}
// স্ট্যাটাস বারে শেষ লেখাটা (Restore www 99%, npm install চলছে...) বাসি থেকে যেত; কাজ শেষে একটা চূড়ান্ত বার্তা পাঠাই।
async function restoreWwwRun(opts) {
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    const o = opts && typeof opts === 'object' ? opts : {};
    const r = await backup.restoreWww({
      dir: typeof o.dir === 'string' ? o.dir : '',
      password: typeof o.password === 'string' ? o.password : '',
      picks: Array.isArray(o.picks) ? o.picks.map((p) => ({ name: String(p && p.name), mode: p && p.mode === 'overwrite' ? 'overwrite' : 'rename' })) : [],
    });
    if (!r.ok || !r.folders || !r.folders.length) return r;
    try {
      for (const x of r.results || []) {
        if (x.ok && x.action === 'renamed') {
          for (const h of restoredConfigHints(x.name, x.final)) (r.warnings = r.warnings || []).push(h);
        }
      }
    } catch (_) {}
    if (!busy) {
      busy = true;
      try {
        const sites = withToolSites(scanSites());
        const h = await syncHosts(sites);
        await reloadRunning(sites);
        if (!h.ok) r.hostsNote = hostsFailNote(h);
      } catch (err) {
        r.warnings = (r.warnings || []).concat(tr('সাইট রিফ্রেশে সমস্যা: ', 'Site refresh problem: ') + err.message);
      } finally {
        busy = false;
      }
    }
    r.npm = [];
    for (const f of r.folders) {
      try {
        const slug = f.toLowerCase().replace(/\s+/g, '-');
        const s = scanSites().find((x) => x.name === slug && x.node);
        if (s && !fs.existsSync(path.join(WWW_DIR, f, 'node_modules'))) {
          const ir = await installNodeDeps(s.domain);
          r.npm.push({ site: f, ok: !!ir.ok, message: ir.message || '' });
        }
      } catch (err) {
        r.npm.push({ site: f, ok: false, message: err.message });
      }
    }
    return r;
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
}

ipcMain.handle('restore:www', async (_e, opts) => {
  const res = await restoreWwwRun(opts);
  try {
    if (res && res.ok) {
      const n = Array.isArray(res.folders) ? res.folders.length : 0;
      sendStatus(tr(`Restore www: শেষ (${n}টা সাইট)`, `Restore www: finished (${n} site(s))`));
    } else {
      sendStatus(tr('Restore www: ব্যর্থ বা বাতিল', 'Restore www: failed or cancelled'));
    }
  } catch (_) {}
  return res;
});

// Restore ধাপ ৩: MySQL ডাটাবেস ফেরত আনা। restore:dbInfo শুধু পড়ে (MySQL চালু থাকলে নামের মিল দেখে); restore:db ডাটাবেসে লেখে।
// নাম মিললে ব্যবহারকারী প্রতিটার জন্য বাছে: নতুন নামে রাখা (<নাম>_restored) বা overwrite (আগে পুরনোটার safety dump `<ROOT>\backup\pre-restore\<stamp>`-এ)।
ipcMain.handle('restore:dbInfo', async (_e, dir) => {
  try {
    return await backup.restoreDbInfo(typeof dir === 'string' ? dir : '');
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});
ipcMain.handle('restore:db', async (_e, opts) => {
  let res;
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    const o = opts && typeof opts === 'object' ? opts : {};
    res = await backup.restoreMysql({
      dir: typeof o.dir === 'string' ? o.dir : '',
      password: typeof o.password === 'string' ? o.password : '',
      picks: Array.isArray(o.picks) ? o.picks.map((p) => ({ name: String(p && p.name), mode: p && p.mode === 'overwrite' ? 'overwrite' : 'rename' })) : [],
    });
  } catch (err) {
    res = { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
  if (res && res.ok && dbHintsForRenamed(res.results) && res.renamedGeneric) res.warnings = (res.warnings || []).filter((w) => w !== res.renamedGeneric);
  try {
    if (res && res.ok) {
      const n = Array.isArray(res.results) ? res.results.filter((x) => x.ok).length : 0;
      sendStatus(tr(`Restore MySQL: শেষ (${n}টা ডাটাবেস)`, `Restore MySQL: finished (${n} database(s))`));
    } else {
      sendStatus(tr('Restore MySQL: ব্যর্থ বা বাতিল', 'Restore MySQL: failed or cancelled'));
    }
  } catch (_) {}
  return res;
});

// Restore ধাপ ৩b: PostgreSQL ডাটাবেস ফেরত আনা। restore:pgInfo আর্কাইভ খুলে (পাসওয়ার্ড দিয়ে) ডাটাবেসের তালিকা পড়ে, কিছু বদলায় না; restore:pg ডাটাবেসে লেখে।
// নাম মিললে: নতুন নামে (<নাম>_restored) বা overwrite (আগে pg_dump safety copy `<ROOT>\\backup\\pre-restore\\<stamp>`-এ)। role ফেরত আসে না।
ipcMain.handle('restore:pgInfo', async (_e, opts) => {
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    const o = opts && typeof opts === 'object' ? opts : {};
    return await backup.restorePgInfo({ dir: typeof o.dir === 'string' ? o.dir : '', password: typeof o.password === 'string' ? o.password : '' });
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});
ipcMain.handle('restore:pg', async (_e, opts) => {
  let res;
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    const o = opts && typeof opts === 'object' ? opts : {};
    res = await backup.restorePg({
      dir: typeof o.dir === 'string' ? o.dir : '',
      password: typeof o.password === 'string' ? o.password : '',
      picks: Array.isArray(o.picks) ? o.picks.map((p) => ({ name: String(p && p.name), mode: p && p.mode === 'overwrite' ? 'overwrite' : 'rename' })) : [],
    });
  } catch (err) {
    res = { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
  if (res && res.ok && dbHintsForRenamed(res.results) && res.renamedGeneric) res.warnings = (res.warnings || []).filter((w) => w !== res.renamedGeneric);
  try {
    if (res && res.ok) {
      const n = Array.isArray(res.results) ? res.results.filter((x) => x.ok).length : 0;
      sendStatus(tr(`Restore PostgreSQL: শেষ (${n}টা ডাটাবেস)`, `Restore PostgreSQL: finished (${n} database(s))`));
    } else {
      sendStatus(tr('Restore PostgreSQL: ব্যর্থ বা বাতিল', 'Restore PostgreSQL: failed or cancelled'));
    }
  } catch (_) {}
  return res;
});

// 5d: \"-restored\" সাইটের .env DB_DATABASE / wp-config.php DB_NAME নতুন (restored) ডাটাবেসে বদলায়। শুধু ব্যবহারকারী বাটন চাপলে চলে।
// নিয়ম: সাইট ফোল্ডার www-র সরাসরি সন্তান ও নাম \"-restored\"-এ শেষ; ফাইলে এখন ঠিক `from` মান থাকতে হবে (নইলে কিছু বদলায় না);
// আগে ফাইলের কপি `<ROOT>\backup\pre-restore\<stamp>\<সাইট>\`-এ রাখা হয় (কপি না হলে ফাইল বদলায় না); শুধু ওই একটা মান বদলায়।
ipcMain.handle('restore:fixDb', (_e, o) => {
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    o = o && typeof o === 'object' ? o : {};
    const folder = String(o.folder || '');
    const file = o.file === '.env' || o.file === 'wp-config.php' ? o.file : '';
    const from = String(o.from || '');
    const to = String(o.to || '');
    const NAME_RE = /^[A-Za-z0-9_$-]{1,64}$/;
    if (!file || !NAME_RE.test(from) || !NAME_RE.test(to) || from === to) return { ok: false, message: tr('অনুরোধটা ঠিক নেই, কিছু বদলানো হয়নি।', 'Invalid request, nothing changed.') };
    if (!/^[A-Za-z0-9._ -]+$/.test(folder) || folder.startsWith('.') || !RESTORED_SITE_RE.test(folder)) return { ok: false, message: tr('শুধু \"-restored\" সাইট বদলানো যায়।', 'Only \"-restored\" sites can be changed.') };
    const dir = path.join(WWW_DIR, folder);
    if (path.dirname(dir) !== path.resolve(WWW_DIR) && path.dirname(dir) !== WWW_DIR) return { ok: false, message: tr('ফোল্ডারটা www-র ভেতরে নেই।', 'The folder is not inside www.') };
    const f = path.join(dir, file);
    if (!fs.existsSync(f)) return { ok: false, message: tr(`${folder}\\${file} পাওয়া যায়নি।`, `${folder}\\${file} was not found.`) };
    const txt = fs.readFileSync(f, 'utf8');
    let out = '';
    if (file === '.env') {
      const re = /^([ \t]*DB_DATABASE[ \t]*=[ \t]*)(.*)$/m;
      const m = txt.match(re);
      const raw = m ? m[2].trim() : '';
      const q = /^(['"])(.*)\1$/.exec(raw);
      const cur = q ? q[2] : raw;
      if (!m || cur !== from) return { ok: false, message: tr(`${folder}: .env-এ DB_DATABASE এখন "${cur || '?'}" (আশা ছিল "${from}") অথবা লাইনটা অন্য ধরনের (যেমন শেষে # মন্তব্য); কিছু বদলানো হয়নি, হাতে এডিট করুন।`, `${folder}: DB_DATABASE in .env is now "${cur || '?'}" (expected "${from}") or the line has another format (for example a trailing # comment); nothing changed, edit it by hand.`) };
      out = txt.replace(re, (_a, pre) => pre + (q ? q[1] + to + q[1] : to));
    } else {
      const re = /(define\(\s*['"]DB_NAME['"]\s*,\s*)(['"])([^'"]*)\2/;
      const m = txt.match(re);
      if (!m || m[3] !== from) return { ok: false, message: tr(`${folder}: wp-config.php-এ DB_NAME এখন "${m ? m[3] : '?'}" (আশা ছিল "${from}"); কিছু বদলানো হয়নি, হাতে এডিট করুন।`, `${folder}: DB_NAME in wp-config.php is now "${m ? m[3] : '?'}" (expected "${from}"); nothing changed, edit it by hand.`) };
      out = txt.replace(re, (_a, pre, qt) => pre + qt + to + qt);
    }
    if (out === txt) return { ok: false, message: tr('কিছু বদলায়নি।', 'Nothing changed.') };
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
    const bakDir = path.join(backup.dirs.baseDir(), 'pre-restore', stamp, folder);
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, file);
    fs.copyFileSync(f, bak);
    if (fs.readFileSync(bak, 'utf8') !== txt) return { ok: false, message: tr('ব্যাকআপ কপি মেলেনি, ফাইল বদলানো হয়নি।', 'The safety copy does not match, the file was not changed.') };
    fs.writeFileSync(f, out);
    let extra = '';
    if (file === '.env' && fs.existsSync(path.join(dir, 'bootstrap', 'cache', 'config.php'))) {
      extra = tr(' Laravel config cache চালু আছে: `php artisan config:clear` না চালালে পুরোনো মান চলতে পারে।', ' Laravel config cache is present: run `php artisan config:clear`, otherwise the old value may still be used.');
    }
    return {
      ok: true,
      backup: bak,
      message: tr(`${folder}: ${file}-এ ডাটাবেস "${from}" থেকে "${to}" করা হয়েছে। পুরোনো ফাইলের কপি: ${bak}.`, `${folder}: database in ${file} changed from "${from}" to "${to}". Safety copy of the old file: ${bak}.`) + extra,
    };
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});

// Restore ধাপ ৪a: নিজের ফোল্ডার (extra-N আর্কাইভ) ও plain copy (files\\<label>) ফেরত আনা। restore:otherInfo শুধু পড়ে; restore:other ফাইল বসায়।
// কিছু মোছে না; extra-N যায় <ROOT>\\restored\\<নাম>-<stamp>-এ; copy মূল পথে (না থাকলে) / <পথ>_restored-এ / merge।
ipcMain.handle('restore:otherInfo', (_e, dir) => {
  try {
    return backup.restoreOtherInfo(typeof dir === 'string' ? dir : '');
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});
ipcMain.handle('restore:other', async (_e, opts) => {
  let res;
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    const o = opts && typeof opts === 'object' ? opts : {};
    res = await backup.restoreOther({
      dir: typeof o.dir === 'string' ? o.dir : '',
      password: typeof o.password === 'string' ? o.password : '',
      picks: Array.isArray(o.picks)
        ? o.picks.map((p) =>
            p && p.kind === 'extra'
              ? { kind: 'extra', n: Number(p.n), mode: p.mode === 'rename' || p.mode === 'overwrite' ? p.mode : 'restored' }
              : { kind: 'copy', label: String(p && p.label), mode: p && p.mode === 'overwrite' ? 'overwrite' : 'rename' }
          )
        : [],
    });
  } catch (err) {
    res = { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
  try {
    if (res && res.ok && !busy) {
      const wr = path.resolve(WWW_DIR).toLowerCase() + path.sep;
      const inWww = (res.results || []).some((x) => x && x.ok && x.target && (path.resolve(String(x.target)).toLowerCase() + path.sep).startsWith(wr));
      if (inWww) {
        busy = true;
        try {
          const sites = withToolSites(scanSites());
          const h = await syncHosts(sites);
          await reloadRunning(sites);
          if (!h.ok) res.hostsNote = hostsFailNote(h);
        } catch (err) {
          res.warnings = (res.warnings || []).concat(tr('সাইট রিফ্রেশে সমস্যা: ', 'Site refresh problem: ') + err.message);
        } finally {
          busy = false;
        }
      }
    }
  } catch (_) {}
  try {
    if (res && res.ok) {
      const n = Array.isArray(res.results) ? res.results.filter((x) => x.ok).length : 0;
      sendStatus(tr(`Restore ফোল্ডার: শেষ (${n}টা)`, `Restore folders: finished (${n})`));
    } else {
      sendStatus(tr('Restore ফোল্ডার: ব্যর্থ বা বাতিল', 'Restore folders: failed or cancelled'));
    }
  } catch (_) {}
  return res;
});

// Restore ধাপ ৪b: settings.7z = সার্টিফিকেট + প্রতি-সাইট সেটিংস। restore:settingsInfo শুধু পড়ে; restore:settings সার্টিফিকেট কপি করে (আগের ফাইল বদলায় না)
// আর settings.json থেকে শুধু সাদা-তালিকার সাইট-সেটিংস মেশায় (পথ, পোর্ট, পাসওয়ার্ড আসে না)। তারপর সাইট স্ক্যান + hosts + চলতি ওয়েব সার্ভার reload।
ipcMain.handle('restore:settingsInfo', (_e, dir) => {
  try {
    return backup.restoreSettingsInfo(typeof dir === 'string' ? dir : '');
  } catch (err) {
    return { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
});
ipcMain.handle('restore:settings', async (_e, opts) => {
  let res;
  try {
    if (busy) return { ok: false, message: tr('একটা কাজ চলছে, একটু অপেক্ষা করুন...', 'A task is running, please wait...') };
    const o = opts && typeof opts === 'object' ? opts : {};
    res = await backup.restoreSettings({
      dir: typeof o.dir === 'string' ? o.dir : '',
      password: typeof o.password === 'string' ? o.password : '',
      certs: o.certs !== false,
      sites: o.sites !== false,
      conflict: o.conflict === 'replace' ? 'replace' : 'keep',
    });
    if (res && res.ok && (res.changed || (res.certs && res.certs.copied.length)) && !busy) {
      busy = true;
      try {
        const sites = withToolSites(scanSites());
        const h = await syncHosts(sites);
        await reloadRunning(sites);
        if (!h.ok) res.hostsNote = hostsFailNote(h);
      } catch (err) {
        res.warnings = (res.warnings || []).concat(tr('সাইট রিফ্রেশে সমস্যা: ', 'Site refresh problem: ') + err.message);
      } finally {
        busy = false;
      }
    }
  } catch (err) {
    res = { ok: false, message: tr('ত্রুটি: ', 'Error: ') + err.message };
  }
  try {
    if (res && res.ok) sendStatus(tr('Restore settings: শেষ', 'Restore settings: finished'));
    else sendStatus(tr('Restore settings: ব্যর্থ বা বাতিল', 'Restore settings: failed or cancelled'));
  } catch (_) {}
  return res;
});

// ---------- Backup: Windows Task Scheduler (অ্যাপ বন্ধ থাকলেও) ----------
// প্রতিটা সময়ের জন্য একটা task: "Server 360 - Backup HHMM", রোজ চলে, ইউজারের Windows পাসওয়ার্ড দিয়ে (লগআউট থাকলেও)।
// পাসওয়ার্ড আমরা কোথাও রাখি না, শুধু schtasks-কে একবার দিই (Windows নিজে সংরক্ষণ করে)। Task চালায় run-backup.cmd -> `electron . --backup`।
const BK_TASK_PREFIX = 'Server 360 - Backup ';
let bkTaskTimes = new Set();
const bkDefaultUser = () => (process.env.USERDOMAIN ? process.env.USERDOMAIN + '\\' : '') + (process.env.USERNAME || '');

function bkSchtasks(args) {
  return new Promise((resolve) =>
    execFile('schtasks.exe', args, { windowsHide: true, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') })
    )
  );
}
async function bkTaskList() {
  if (process.platform !== 'win32') return [];
  const r = await bkSchtasks(['/Query', '/FO', 'CSV', '/NH']);
  const list = [];
  for (const line of r.out.split(/\r?\n/)) {
    const mm = /^"\\Server 360 - Backup (\d{2})(\d{2})"/.exec(line.trim());
    if (mm) list.push(`${mm[1]}:${mm[2]}`);
  }
  return list.sort();
}
async function bkTaskRefresh() {
  const list = await bkTaskList();
  bkTaskTimes = new Set(list);
  return list;
}

ipcMain.handle('backup:taskState', async () => ({ times: await bkTaskRefresh(), user: bkDefaultUser() }));

ipcMain.handle('backup:taskInstall', async (_e, user, password) => {
  if (process.platform !== 'win32') return { ok: false, message: tr('এটা শুধু Windows-এ চলে', 'Windows only') };
  const cfg = backup.getConfig();
  if (!cfg.times.length) return { ok: false, message: tr('আগে অন্তত একটা সময় যোগ করে সেভ করুন', 'Add at least one time and save first') };
  if (!(cfg.local.enabled && cfg.local.dir) && !(cfg.share.enabled && cfg.share.unc)) return { ok: false, message: tr('আগে একটা গন্তব্য (লোকাল বা নেটওয়ার্ক শেয়ার) চালু করে সেভ করুন', 'Enable a destination (local or network share) and save first') };
  user = String(user || '').trim() || bkDefaultUser();
  password = String(password || '');
  if (!password) return { ok: false, message: tr('ইউজারের Windows পাসওয়ার্ড দিন (ফাঁকা পাসওয়ার্ডে লগআউট অবস্থায় চালানো যায় না)', 'Enter the Windows password of that user (a blank password cannot run while logged out)') };
  try {
    // ছোট runner ফাইল: পথে স্পেস থাকলেও schtasks-এর /TR ঠিক থাকে
    const cmdFile = path.join(backup.dirs.baseDir(), 'run-backup.cmd');
    fs.mkdirSync(backup.dirs.baseDir(), { recursive: true });
    const appArg = app.isPackaged ? '' : `"${app.getAppPath()}" `;
    // Task Scheduler আসল প্রোগ্রামকে কম (below-normal) priority-তে চালায়, তাই www প্যাক ধীর হয়েছিল (৫ মিনিট, হাতে ১২ সেকেন্ড); `start /normal` দিয়ে সাধারণ priority চাওয়া
    fs.writeFileSync(cmdFile, ['@echo off', `start "" /wait /normal /b "${process.execPath}" ${appArg}--backup`, 'exit /b %errorlevel%', ''].join('\r\n'));
    for (const tm of await bkTaskList()) await bkSchtasks(['/Delete', '/TN', BK_TASK_PREFIX + tm.replace(':', ''), '/F']);
    const fails = [];
    for (const tm of cfg.times) {
      const r = await bkSchtasks(['/Create', '/TN', BK_TASK_PREFIX + tm.replace(':', ''), '/TR', `"${cmdFile}"`, '/SC', 'DAILY', '/ST', tm, '/RU', user, '/RP', password, '/F']);
      if (!r.ok) fails.push(`${tm}: ${r.out.split(password).join('***').trim().slice(0, 200)}`);
    }
    const list = await bkTaskRefresh();
    if (fails.length) return { ok: false, message: tr('Task বসানো যায়নি: ', 'Could not create the task: ') + fails[0] + tr(' (ভুল ইউজার/পাসওয়ার্ড, অথবা অ্যাপ Administrator হিসেবে না চালালে এই ইউজারের জন্য অনুমতি নেই)', ' (wrong user/password, or this account may not be allowed; try running the app as Administrator)'), times: list };
    return { ok: true, message: tr(`Task Scheduler-এ বসানো হয়েছে: ${list.join(', ')} (অ্যাপ বন্ধ বা লগআউট থাকলেও চলবে)`, `Installed in Task Scheduler: ${list.join(', ')} (runs even when the app is closed or logged out)`), times: list };
  } catch (err) {
    return { ok: false, message: tr('সমস্যা: ', 'Error: ') + err.message };
  }
});

ipcMain.handle('backup:taskRemove', async () => {
  for (const tm of await bkTaskList()) await bkSchtasks(['/Delete', '/TN', BK_TASK_PREFIX + tm.replace(':', ''), '/F']);
  const list = await bkTaskRefresh();
  return list.length ? { ok: false, message: tr('কিছু task মোছা যায়নি (Administrator হিসেবে অ্যাপ চালিয়ে দেখুন)', 'Some tasks could not be removed (try running the app as Administrator)'), times: list } : { ok: true, message: tr('Task Scheduler থেকে মোছা হয়েছে', 'Removed from Task Scheduler'), times: [] };
});

// অ্যাপ খোলা থাকলে নির্ধারিত সময়ে নিজে backup (প্রতি ২০ সেকেন্ডে দেখে; একই দিনের একই সময়ে একবারই)
let bkLastFire = '';
setInterval(() => {
  try {
    if (BACKUP_CLI || !GOT_LOCK) return;
    const cfg = backup.getConfig();
    if (!cfg.appEnabled || !cfg.times.length || backup.isRunning()) return;
    const d = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()} ${hm}`;
    if (!cfg.times.includes(hm) || bkLastFire === key || bkTaskTimes.has(hm)) return; // Task Scheduler-এ বসানো সময় অ্যাপ নিজে ধরে না (দুবার backup এড়াতে)
    bkLastFire = key;
    backup.runBackup({ source: 'timer' }).then((r) => {
      if (win && !win.isDestroyed()) win.webContents.send('status', (r.ok ? '' : '⚠ ') + r.message);
    });
  } catch {}
}, 20000);

app.whenReady().then(() => {
  if (!GOT_LOCK) return;
  if (BACKUP_CLI) {
    // Task Scheduler: উইন্ডো নেই; একবার backup নিয়ে কোড দিয়ে বেরিয়ে যায় (0 = সফল)
    backup
      .runBackup({ source: 'task' })
      .then((r) => app.exit(r.ok ? 0 : 1))
      .catch(() => app.exit(2));
    return;
  }
  bkTaskRefresh().catch(() => {});
  Menu.setApplicationMenu(null);
  createWindow();
  if (keepRunningOn()) buildTray();
  applyLoginItem();
  if (!settings.wwwDir) {
    win.webContents.once('did-finish-load', () => askWwwFolderFirstRun());
  } else {
    // আগের বারের রয়ে যাওয়া node.exe সাফ করে \"অ্যাপ খুললে চালু\" Node অ্যাপগুলো চালু করা (উইন্ডো তৈরির একটু পরে)
    win.webContents.once('did-finish-load', () => setTimeout(() => startupNodeApps(), 2500));
    // সেটিং চালু থাকলে অ্যাপ খুলে ৪ সেকেন্ড পর Start All (কোন ওয়েব সার্ভার, সেটা UI-তে বেছে রাখা, তাই renderer চালায়)
    if (settings.startAllOnLaunch) {
      win.webContents.once('did-finish-load', () =>
        setTimeout(() => {
          if (win && !win.isDestroyed()) win.webContents.send('auto:startAll');
        }, 4000)
      );
    }
  }
});

app.on('before-quit', () => {
  quitting = true;
  if (running) running.procs.forEach((p) => killTree(p.pid));
  for (const r of Object.values(nodeRun)) killTree(r.proc.pid); // Node অ্যাপগুলোও বন্ধ
  // ডাটাবেসকে আগে নিয়ম মেনে বন্ধ করার চেষ্টা (ডাটা নিরাপদ রাখতে)
  for (const [id, run] of Object.entries(dbRun)) {
    const cmd = DATABASES[id].shutdownCmd(SERVICES[DATABASES[id].svcId], run.port);
    try {
      execFileSync(cmd.exe, cmd.args, { timeout: 15000, windowsHide: true, env: cmd.env || process.env });
    } catch {}
    killTree(run.proc.pid);
  }
});
