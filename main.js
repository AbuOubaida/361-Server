const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { spawn, exec, execFile, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const extract = require('extract-zip');

// ====== এখানে আপনার লিংক বসান ======
const APACHE_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/httpd-2.4.70-261106-Win64-VS18.zip';
const NGINX_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/nginx-1.30.6.zip';
// PHP zip-এর আসল নাম দিন (Release-এ আপলোড করা ফাইলের নাম)
const PHP_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/php-8.5.12-1-nts-Win32-vs17-x64.zip';

// MySQL zip-এর আসল নাম দিন (Release-এ আপলোড করা ফাইলের নাম)
const MYSQL_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/mysql-8.4.13-winx64.zip';
// PostgreSQL zip-এর আসল নাম দিন (EDB-র "binaries" zip, Release-এ আপলোড করা ফাইলের নাম)
const POSTGRES_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/postgresql-18.6-5-windows-x64-binaries.zip';

// Microsoft-এর স্থির লিংক: সর্বশেষ সাপোর্টেড VC++ Redistributable (x64)
const VCREDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';
// ====================================

// অ্যাপের নিজস্ব ডাটা ফোল্ডার: C:\Users\<name>\AppData\Roaming\my-laragon
const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
const VCREDIST_PATH = path.join(TOOLS_DIR, 'vc_redist.x64.exe');

// MySQL-এর ডাটা tools-এর বাইরে থাকে, যাতে MySQL আবার নামালেও ডাটাবেস না হারায
const MYSQL_DATA_DIR = path.join(app.getPath('userData'), 'data', 'mysql');
const PG_DATA_DIR = path.join(app.getPath('userData'), 'data', 'postgres');
const MYSQL_INI = path.join(app.getPath('userData'), 'data', 'my.ini');

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
function makeService(id, label, url, folder, exeRelPath, opts = {}) {
  const dir = path.join(TOOLS_DIR, folder);
  return {
    id,
    label,
    url,
    dir,
    exeRel: exeRelPath,
    exe: path.join(dir, exeRelPath),
    needsVC: !!opts.needsVC,
    usesPHP: !!opts.usesPHP,
    vhosts: !!opts.vhosts,
    afterExtract: opts.afterExtract || null,
    beforeStart: opts.beforeStart || null,
    args: opts.args || (() => []),
  };
}

// php.ini-তে দরকারি extension চালু করা (বারবার চালালেও একই ফল)
const PHP_EXTS = 'mbstring|openssl|curl|mysqli|pdo_mysql|pgsql|pdo_pgsql|fileinfo|gd|zip|intl';
function enableExtensions(txt) {
  txt = txt.replace(/^;\s*extension_dir\s*=\s*"ext"/m, 'extension_dir = "ext"');
  txt = txt.replace(new RegExp(`^;\\s*(extension=(${PHP_EXTS}))\\s*$`, 'gm'), '$1');
  txt = txt.replace(/^;date\.timezone =.*$/m, 'date.timezone = Asia/Dhaka');
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
function refreshPhpIni() {
  const ini = path.join(SERVICES.php.dir, 'php.ini');
  if (!fs.existsSync(ini)) return;
  const txt = fs.readFileSync(ini, 'utf8');
  const next = enableExtensions(txt);
  if (next !== txt) fs.writeFileSync(ini, next);
}

// Nginx-এর একটা server ব্লক (সাইটের জন্য)
function nginxServer(serverName, root, phpPort, isDefault, webPort) {
  const r = root.replace(/\\/g, '/');
  return [
    '  server {',
    `    listen ${webPort}${isDefault ? ' default_server' : ''};`,
    `    server_name ${serverName};`,
    `    root "${r}";`,
    '    index index.php index.html;',
    isDefault
      ? '    location / { try_files $uri $uri/ =404; }'
      : '    location / { try_files $uri $uri/ /index.php?$query_string; }',
    '    location ~ \\.php$ {',
    `      fastcgi_pass 127.0.0.1:${phpPort};`,
    '      fastcgi_index index.php;',
    '      fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;',
    '      include fastcgi_params;',
    '      fastcgi_read_timeout 300;',
    '    }',
    '  }',
  ].join('\n');
}

// Nginx-এর কনফিগ প্রতিবার চালুর সময় (ও সাইট রিফ্রেশে) লেখা হয়
function writeNginxConf(svc, phpPort, sites = [], webPort = 80) {
  const parts = [
    'worker_processes 1;',
    'events { worker_connections 1024; }',
    'http {',
    '  include mime.types;',
    '  default_type application/octet-stream;',
    '  sendfile on;',
    '  client_max_body_size 128m;',
    '  server_names_hash_bucket_size 64;',
    nginxServer('localhost', WWW_DIR, phpPort, true, webPort),
    ...sites.map((s) => nginxServer(s.domain, s.root, phpPort, false, webPort)),
    '}',
    '',
  ];
  fs.writeFileSync(path.join(svc.dir, 'conf', 'nginx.conf'), parts.join('\n'));
}

const SERVICES = {
  php: makeService('php', 'PHP', PHP_URL, 'php', 'php-cgi.exe', {
    needsVC: true,
    afterExtract: setupPhpIni,
  }),
  mysql: makeService('mysql', 'MySQL', MYSQL_URL, 'mysql', path.join('bin', 'mysqld.exe'), {
    needsVC: true,
  }),
  postgres: makeService('postgres', 'PostgreSQL', POSTGRES_URL, 'pgsql', path.join('bin', 'postgres.exe'), {
    needsVC: true,
  }),
  apache: makeService('apache', 'Apache', APACHE_URL, 'Apache24', path.join('bin', 'httpd.exe'), {
    needsVC: true,
    afterExtract: (dir) => {
      const confPath = path.join(dir, 'conf', 'httpd.conf');
      let conf = fs.readFileSync(confPath, 'utf8');
      const root = dir.replace(/\\/g, '/');
      conf = conf.replace(/Define SRVROOT ".*"/, `Define SRVROOT "${root}"`);
      fs.writeFileSync(confPath, conf);
    },
    // পোর্ট বদলানো: Listen ও ServerName লাইন ঠিক করা
    beforeStart: (svc, phpPort, sites, webPort) => {
      const confPath = path.join(svc.dir, 'conf', 'httpd.conf');
      let conf = fs.readFileSync(confPath, 'utf8');
      conf = conf.replace(/^Listen\s+\S+/m, `Listen ${webPort}`);
      conf = conf.replace(/^#?ServerName\s.*$/m, `ServerName localhost:${webPort}`);
      fs.writeFileSync(confPath, conf);
    },
  }),
  nginx: makeService('nginx', 'Nginx', NGINX_URL, 'nginx', 'nginx.exe', {
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

  sendStatus('hosts ফাইল আপডেটের জন্য Administrator অনুমতি লাগবে (Yes চাপুন)...');
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
    width: 500,
    height: 900,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
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
function download(url, dest, label = 'ডাউনলোড হচ্ছে') {
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
          return reject(new Error('ডাউনলোড ব্যর্থ, কোড: ' + res.statusCode));
        }

        const file = fs.createWriteStream(dest);
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let done = 0;

        res.on('data', (chunk) => {
          done += chunk.length;
          if (total) sendStatus(`${label}... ${Math.round((done / total) * 100)}%`);
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
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
      else reject(new Error('VC++ ইনস্টল ব্যর্থ, কোড: ' + code));
    });
  });
}

async function ensureVCRedist() {
  if (await isVCInstalled()) return;

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  sendStatus('Visual C++ পাওয়া যায়নি, ডাউনলোড হচ্ছে...');
  await download(VCREDIST_URL, VCREDIST_PATH, 'Visual C++ ডাউনলোড হচ্ছে');

  sendStatus('Visual C++ ইনস্টল হচ্ছে (Yes চাপুন)...');
  await runInstaller(VCREDIST_PATH, ['/install', '/quiet', '/norestart']);
  fs.unlinkSync(VCREDIST_PATH);
}

// ---------- সার্ভিস ইনস্টল ----------
function findTopDir(parent) {
  const entry = fs.readdirSync(parent, { withFileTypes: true }).find((e) => e.isDirectory());
  if (!entry) throw new Error('zip-এর ভেতরে কোনো ফোল্ডার পাওয়া যায়নি');
  return path.join(parent, entry.name);
}

async function ensureService(svc) {
  if (fs.existsSync(svc.exe)) return;

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const zipPath = path.join(TOOLS_DIR, svc.id + '.zip');
  const tmpDir = path.join(TOOLS_DIR, '_tmp_' + svc.id);

  sendStatus(`${svc.label} পাওয়া যায়নি, ডাউনলোড শুরু হচ্ছে...`);
  await download(svc.url, zipPath, `${svc.label} ডাউনলোড হচ্ছে`);

  sendStatus('ফাইল খোলা হচ্ছে (বড় ফাইলে কিছুক্ষণ লাগে)...');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await extract(zipPath, { dir: tmpDir });

  // exe সরাসরি উপরে থাকলে (যেমন PHP) ওটাই আসল ফোল্ডার,
  // নাহলে ভেতরের প্রথম ফোল্ডারটা (যেমন nginx-1.30.6, Apache24)
  const source = fs.existsSync(path.join(tmpDir, svc.exeRel)) ? tmpDir : findTopDir(tmpDir);
  fs.rmSync(svc.dir, { recursive: true, force: true });
  fs.renameSync(source, svc.dir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlinkSync(zipPath);

  if (svc.afterExtract) svc.afterExtract(svc.dir);
  sendStatus(`${svc.label} ইনস্টল সম্পন্ন`);
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
    proc.once('exit', (code) => resolve({ proc, failed: `বন্ধ হয়ে গেছে (কোড ${code})`, output }));
    setTimeout(() => resolve({ proc, failed: null, output }), 1500);
  });
}

// ---------- ডাটাবেস (MySQL, PostgreSQL...) ----------
// নতুন ডাটাবেস (MariaDB, MongoDB...) যোগ করতে নিচের DATABASES-এ একটা এন্ট্রি বাড়ালেই হবে।

// MySQL-এর my.ini: ডাটা ফোল্ডার tools-এর বাইরে, যাতে নতুন করে নামালেও ডাটা না হারায়
function writeMysqlIni(svc, port) {
  fs.mkdirSync(path.dirname(MYSQL_INI), { recursive: true });
  const f = (p) => p.replace(/\\/g, '/');
  const ini = [
    '[mysqld]',
    `basedir=${f(svc.dir)}`,
    `datadir=${f(MYSQL_DATA_DIR)}`,
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
  fs.writeFileSync(MYSQL_INI, ini);
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
    dataDir: MYSQL_DATA_DIR,
    info: 'হোস্ট: 127.0.0.1 · ইউজার: root · পাসওয়ার্ড: ফাঁকা',
    prepare: (svc, port) => writeMysqlIni(svc, port),
    isInitialized: () => fs.existsSync(path.join(MYSQL_DATA_DIR, 'mysql')),
    // root-এর পাসওয়ার্ড ফাঁকা (Laragon-এর মতো)
    init: (svc) => runTool(svc.exe, [`--defaults-file=${MYSQL_INI}`, '--initialize-insecure', '--console'], svc.dir),
    spawnArgs: () => [`--defaults-file=${MYSQL_INI}`, '--console'],
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
    dataDir: PG_DATA_DIR,
    info: 'হোস্ট: 127.0.0.1 · ইউজার: postgres · পাসওয়ার্ড: ফাঁকা',
    prepare: () => fs.mkdirSync(path.dirname(PG_DATA_DIR), { recursive: true }),
    isInitialized: () => fs.existsSync(path.join(PG_DATA_DIR, 'PG_VERSION')),
    // শুধু নিজের কম্পিউটার থেকে ঢোকা যায় (trust), পাসওয়ার্ড লাগে না
    init: (svc) =>
      runTool(
        path.join(svc.dir, 'bin', 'initdb.exe'),
        ['-D', PG_DATA_DIR, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C'],
        svc.dir
      ),
    spawnArgs: (svc, port) => ['-D', PG_DATA_DIR, '-p', String(port), '-c', 'listen_addresses=127.0.0.1'],
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
      args: ['stop', '-D', PG_DATA_DIR, '-m', 'fast', '-w', '-t', '20'],
    }),
  },
};

// চালু থাকা ডাটাবেস: { mysql: { proc, port }, ... }
const dbRun = {};

// প্রসেসের পোর্ট সাড়া দেওয়া পর্যন্ত অপেক্ষা (প্রসেস বন্ধ হয়ে গেলে ব্যর্থ)
async function waitDbReady(db, svc, port, proc, timeoutMs = 90000) {
  let exited = null;
  proc.once('exit', (code) => (exited = code === null ? 'অজানা' : code));
  proc.once('error', (e) => (exited = e.message));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (exited !== null) return { ok: false, reason: `বন্ধ হয়ে গেছে (কোড ${exited})` };
    if (await db.check(svc, port)) return { ok: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: false, reason: 'সময় শেষ হয়ে গেছে' };
}

async function startDatabase(id) {
  const db = DATABASES[id];
  if (!db) return 'সমস্যা: অজানা ডাটাবেস';
  const svc = SERVICES[db.svcId];
  if (busy) return 'একটা কাজ চলছে, একটু অপেক্ষা করুন...';
  if (dbRun[id]) return `${db.label} আগে থেকেই চলছে`;

  busy = true;
  try {
    await ensureVCRedist();
    await ensureService(svc);
    await killStale(db.stale);

    const port = getDbPort(id);
    if (!(await isPortFree(port))) {
      return `সমস্যা: ${db.label}-এর পোর্ট ${port} অন্য কেউ ব্যবহার করছে (আসল ${db.label} বা Laragon হতে পারে)। ওই ডাটাবেসের পোর্ট ঘরে অন্য সংখ্যা দিন।`;
    }

    db.prepare(svc, port);
    if (!db.isInitialized()) {
      sendStatus(`${db.label} ডাটাবেস প্রথমবার তৈরি হচ্ছে (১-২ মিনিট লাগতে পারে)...`);
      try {
        await db.init(svc, port);
      } catch (err) {
        fs.rmSync(db.dataDir, { recursive: true, force: true }); // আধা-তৈরি ডাটা মুছে যাতে আবার চেষ্টা করা যায়
        throw new Error(`${db.label} সেটআপ ব্যর্থ: ${err.message}`);
      }
    }

    sendStatus(`${db.label} চালু হচ্ছে...`);
    const proc = spawn(svc.exe, db.spawnArgs(svc, port), { cwd: svc.dir, windowsHide: true });
    let out = '';
    const collect = (d) => (out = (out + d).slice(-2000));
    proc.stdout.on('data', collect);
    proc.stderr.on('data', collect);

    const r = await waitDbReady(db, svc, port, proc);
    if (!r.ok) {
      killTree(proc.pid);
      return `সমস্যা: ${db.label} চালু হয়নি, ${r.reason}. ${out.trim().slice(-300)}`;
    }

    dbRun[id] = { proc, port };
    proc.on('exit', () => {
      if (dbRun[id] && dbRun[id].proc === proc) delete dbRun[id];
    });
    return `${db.label} চালু হয়েছে (পোর্ট ${port})। ${db.info}`;
  } catch (err) {
    return 'সমস্যা: ' + err.message;
  } finally {
    busy = false;
  }
}

async function stopDatabase(id) {
  const db = DATABASES[id];
  const run = dbRun[id];
  if (!db || !run) return `${db ? db.label : 'ডাটাবেস'} চলছে না`;
  const svc = SERVICES[db.svcId];
  sendStatus(`${db.label} নিরাপদে বন্ধ হচ্ছে...`);

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
  return `${db.label} বন্ধ হয়েছে`;
}

// ---------- IPC ----------
async function startWebServer(id) {
  const svc = SERVICES[id];
  if (!svc || !['apache', 'nginx'].includes(id)) return 'সমস্যা: অজানা সার্ভার';
  if (busy) return 'একটা কাজ চলছে, একটু অপেক্ষা করুন...';
  if (running) {
    return running.id === id
      ? `${svc.label} আগে থেকেই চলছে`
      : `আগে ${SERVICES[running.id].label} বন্ধ করুন (দুটো একসাথে পোর্ট ৮০ নিতে পারে না)`;
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
      return `সমস্যা: পোর্ট ${webPort} অন্য কেউ ব্যবহার করছে (IIS, Skype বা আসল Laragon হতে পারে)। নিচের "পোর্ট" ঘরে অন্য সংখ্যা দিন, যেমন 8080।`;
    }
    const phpPort = svc.usesPHP ? await getFreePort() : 0;
    let sites = [];
    let hostsNote = '';
    if (svc.vhosts) {
      sites = scanSites();
      const h = await syncHosts(sites);
      if (!h.ok) hostsNote = ' ⚠ hosts ফাইল আপডেট হয়নি (Administrator অনুমতি দিন), তাই শুধু localhost কাজ করবে।';
    }
    if (svc.beforeStart) svc.beforeStart(svc, phpPort, sites, webPort);

    // Nginx-এর জন্য আগে php-cgi চালু করা
    if (svc.usesPHP) {
      const php = SERVICES.php;
      const r = await spawnChecked(php.exe, ['-b', `127.0.0.1:${phpPort}`], {
        cwd: php.dir,
        env: { ...process.env, PHP_FCGI_MAX_REQUESTS: '0', PHPRC: php.dir },
      });
      if (r.failed) {
        return `সমস্যা: PHP চালু হয়নি, ${r.failed}. ${r.output.trim().slice(0, 200)}`;
      }
      procs.push(r.proc);
    }

    const r = await spawnChecked(svc.exe, svc.args(svc.dir), { cwd: svc.dir });
    if (r.failed) {
      abort();
      const logPath = path.join(svc.dir, 'logs', 'error.log');
      return `সমস্যা: ${svc.label} চালু হয়নি, ${r.failed}. ${r.output.trim().slice(0, 200)} লগ: ${logPath}`;
    }
    procs.push(r.proc);

    running = { id, procs, phpPort, webPort };
    r.proc.on('exit', () => {
      if (running && running.procs.includes(r.proc)) {
        abort();
        running = null;
      }
    });
    return `${svc.label} চালু হয়েছে${svc.usesPHP ? ' (PHP সহ)' : ''}${svc.vhosts ? `, ${sites.length}টা সাইট` : ''}। খুলুন: ${siteUrl('localhost')}${hostsNote}`;
  } catch (err) {
    abort();
    return 'সমস্যা: ' + err.message;
  } finally {
    busy = false;
  }
}

ipcMain.handle('service:start', (_event, id) => startWebServer(id));
function stopWebServer() {
  if (!running) return 'কোনো ওয়েব সার্ভার চলছে না';
  const { id, procs } = running;
  running = null;
  procs.forEach((p) => killTree(p.pid));
  return `${SERVICES[id].label} বন্ধ হয়েছে`;
}

ipcMain.handle('service:stop', () => stopWebServer());

// ---------- সাইট ----------
const siteUrl = (domain) => `http://${domain}${getWebPort() === 80 ? '' : ':' + getWebPort()}`;
const publicSites = (sites) => [
  { name: 'localhost', domain: 'localhost', root: WWW_DIR, url: siteUrl('localhost') },
  ...sites.map(({ name, domain, root }) => ({ name, domain, root, url: siteUrl(domain) })),
];

ipcMain.handle('sites:list', () => publicSites(scanSites()));

ipcMain.handle('sites:refresh', async () => {
  if (busy) return { sites: publicSites(scanSites()), message: 'একটা কাজ চলছে, একটু অপেক্ষা করুন...' };
  busy = true;
  try {
    const sites = scanSites();
    const h = await syncHosts(sites);
    let message;
    const svc = running && SERVICES[running.id];
    if (svc && svc.vhosts) {
      svc.beforeStart(svc, running.phpPort, sites, running.webPort);
      await new Promise((resolve) =>
        execFile(svc.exe, [...svc.args(svc.dir), '-s', 'reload'], { cwd: svc.dir }, () => resolve())
      );
      message = `${sites.length}টা সাইট লোড হয়েছে`;
    } else {
      message = `${sites.length}টা সাইট পাওয়া গেছে (Nginx চালু করলে কাজ করবে)`;
    }
    if (!h.ok) message += ' ⚠ hosts আপডেট হয়নি (Administrator অনুমতি দিন)';
    return { sites: publicSites(sites), message };
  } catch (err) {
    return { sites: [], message: 'সমস্যা: ' + err.message };
  } finally {
    busy = false;
  }
});

// ---------- পোর্ট ----------
ipcMain.handle('port:get', () => getWebPort());

// kind = 'web' অথবা ডাটাবেসের id (mysql, postgres...)
ipcMain.handle('port:set', (_event, kind, value) => {
  const db = DATABASES[kind];
  const label = db ? db.label : 'ওয়েব';
  const current = db ? getDbPort(kind) : getWebPort();
  if (db ? dbRun[kind] : running) {
    return { ok: false, port: current, message: 'আগে সার্ভার বন্ধ করুন, তারপর পোর্ট বদলান' };
  }
  const p = validPort(value);
  if (!p) {
    return { ok: false, port: current, message: 'পোর্ট ১ থেকে ৬৫৫৩৫-র মধ্যে একটা সংখ্যা হতে হবে' };
  }
  const others = [kind === 'web' ? null : getWebPort(), ...Object.keys(DATABASES).filter((k) => k !== kind).map(getDbPort)];
  if (others.includes(p)) {
    return { ok: false, port: current, message: `পোর্ট ${p} আরেকটা সার্ভিসে দেওয়া আছে, অন্য সংখ্যা দিন` };
  }
  settings[db ? db.portKey : 'webPort'] = p;
  saveSettings(settings);
  return { ok: true, port: p, message: `${label} পোর্ট ${p} সেভ হয়েছে।` };
});

// ---------- ডাটাবেস চালু/বন্ধ ----------
const autoStartOf = (id) => (settings.autoStart && id in settings.autoStart ? !!settings.autoStart[id] : DATABASES[id].autoDefault);

ipcMain.handle('db:list', () =>
  Object.values(DATABASES).map((db) => ({
    id: db.id,
    label: db.label,
    port: getDbPort(db.id),
    running: !!dbRun[db.id],
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
  return lines.length ? lines.join('\n') : 'কিছুই চলছে না';
});

// শুধু localhost ও *.test লিংক খোলা যাবে
ipcMain.handle('open:url', (_event, url) => {
  if (/^http:\/\/(localhost|[a-z0-9-]+\.test)(:\d{1,5})?\/?$/.test(url)) return shell.openExternal(url);
});

// ---------- www ফোল্ডার ----------
ipcMain.handle('www:get', () => WWW_DIR);

ipcMain.handle('www:choose', async () => {
  if (running) {
    return { ok: false, path: WWW_DIR, message: 'আগে সার্ভার বন্ধ করুন, তারপর ফোল্ডার বদলান' };
  }
  const r = await dialog.showOpenDialog(win, {
    title: 'ওয়েবসাইটের ফোল্ডার বেছে নিন',
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
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    title: 'ওয়েবসাইটের ফোল্ডার',
    message: 'আপনার ওয়েবসাইটের ফাইল কোন ফোল্ডারে রাখবেন?',
    detail: `ডিফল্ট: ${DEFAULT_WWW}\n\nপরে যেকোনো সময় বদলানো যাবে।`,
    buttons: ['ডিফল্ট রাখুন', 'অন্য ফোল্ডার বেছে নিন'],
    defaultId: 0,
    cancelId: 0,
  });
  if (response === 1) {
    const r = await dialog.showOpenDialog(win, {
      title: 'ওয়েবসাইটের ফোল্ডার বেছে নিন',
      defaultPath: DEFAULT_WWW,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) WWW_DIR = r.filePaths[0];
  }
  settings.wwwDir = WWW_DIR;
  saveSettings(settings);
  win.webContents.send('www:changed', WWW_DIR);
}

app.whenReady().then(() => {
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
