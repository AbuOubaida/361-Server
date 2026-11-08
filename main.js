const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const extract = require('extract-zip');

// ====== এখানে আপনার লিংক বসান ======
const APACHE_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/httpd-2.4.70-261106-Win64-VS18.zip';
// Nginx zip আপলোড করার পর তার আসল নাম বসান (nginx.org থেকে নামানো Windows zip)
const NGINX_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/nginx-1.30.6.zip';

// Microsoft-এর স্থির লিংক: সর্বশেষ সাপোর্টেড VC++ Redistributable (x64)
const VCREDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';
// ====================================

// অ্যাপের নিজস্ব ডাটা ফোল্ডার: C:\Users\<name>\AppData\Roaming\my-laragon
const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
const VCREDIST_PATH = path.join(TOOLS_DIR, 'vc_redist.x64.exe');

// ---------- সার্ভিসের তালিকা ----------
// নতুন সার্ভিস (PHP, MySQL...) যোগ করতে এখানে একটা এন্ট্রি বাড়ালেই হবে
function makeService(id, label, url, folder, exeRelPath, opts = {}) {
  const dir = path.join(TOOLS_DIR, folder);
  return {
    id,
    label,
    url,
    dir,
    exe: path.join(dir, exeRelPath),
    needsVC: !!opts.needsVC,
    afterExtract: opts.afterExtract || null,
    args: opts.args || (() => []),
  };
}

const SERVICES = {
  apache: makeService('apache', 'Apache', APACHE_URL, 'Apache24', path.join('bin', 'httpd.exe'), {
    needsVC: true,
    afterExtract: (dir) => {
      // httpd.conf-এ SRVROOT ঠিক করা
      const confPath = path.join(dir, 'conf', 'httpd.conf');
      let conf = fs.readFileSync(confPath, 'utf8');
      const root = dir.replace(/\\/g, '/');
      conf = conf.replace(/Define SRVROOT ".*"/, `Define SRVROOT "${root}"`);
      fs.writeFileSync(confPath, conf);
    },
  }),
  nginx: makeService('nginx', 'Nginx', NGINX_URL, 'nginx', 'nginx.exe', {
    afterExtract: (dir) => {
      // Nginx-এর logs ও temp ফোল্ডার থাকতে হয়
      fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'temp'), { recursive: true });
    },
    // -p দিয়ে Nginx-কে তার নিজের ফোল্ডার চিনিয়ে দেওয়া
    args: (dir) => ['-p', dir.replace(/\\/g, '/') + '/'],
  }),
};

let win = null;
let running = null; // { id, proc } — একসময়ে একটাই সার্ভার চলবে (পোর্ট ৮০)
let busy = false;

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 420,
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
      // 0 = সফল, 3010 = সফল কিন্তু রিস্টার্ট দরকার
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

// ---------- সার্ভিস ইনস্টল (সব সার্ভিসের জন্য একই কোড) ----------
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

  sendStatus('ফাইল খোলা হচ্ছে...');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  await extract(zipPath, { dir: tmpDir });

  // zip-এর ভেতরের প্রথম ফোল্ডারটা (যেমন nginx-1.xx.x) আমাদের নির্দিষ্ট নামে সরানো
  const top = findTopDir(tmpDir);
  fs.rmSync(svc.dir, { recursive: true, force: true });
  fs.renameSync(top, svc.dir);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.unlinkSync(zipPath);

  if (svc.afterExtract) svc.afterExtract(svc.dir);
  sendStatus(`${svc.label} ইনস্টল সম্পন্ন`);
}

// ---------- IPC ----------
ipcMain.handle('service:start', async (_event, id) => {
  const svc = SERVICES[id];
  if (!svc) return 'সমস্যা: অজানা সার্ভার';
  if (busy) return 'একটা কাজ চলছে, একটু অপেক্ষা করুন...';
  if (running) {
    return running.id === id
      ? `${svc.label} আগে থেকেই চলছে`
      : `আগে ${SERVICES[running.id].label} বন্ধ করুন (দুটো একসাথে পোর্ট ৮০ নিতে পারে না)`;
  }

  busy = true;
  try {
    if (svc.needsVC) await ensureVCRedist();
    await ensureService(svc);

    const proc = spawn(svc.exe, svc.args(svc.dir), { cwd: svc.dir, windowsHide: true });
    let output = '';
    proc.stdout.on('data', (d) => (output += d));
    proc.stderr.on('data', (d) => (output += d));

    // ১.৫ সেকেন্ডের মধ্যে বন্ধ হয়ে গেলে বুঝব চালু হয়নি
    const failed = await new Promise((resolve) => {
      proc.once('error', (e) => resolve(e.message));
      proc.once('exit', (code) => resolve(`বন্ধ হয়ে গেছে (কোড ${code})`));
      setTimeout(() => resolve(null), 1500);
    });

    if (failed) {
      const logPath = path.join(svc.dir, 'logs', 'error.log');
      return `সমস্যা: ${svc.label} চালু হয়নি, ${failed}. ${output.trim().slice(0, 200)} লগ: ${logPath}`;
    }

    running = { id, proc };
    proc.on('exit', () => {
      if (running && running.proc === proc) running = null;
    });
    return `${svc.label} চালু হয়েছে`;
  } catch (err) {
    return 'সমস্যা: ' + err.message;
  } finally {
    busy = false;
  }
});

ipcMain.handle('service:stop', () => {
  if (!running) return 'কোনো সার্ভার চলছে না';
  const { id, proc } = running;
  killTree(proc.pid);
  running = null;
  return `${SERVICES[id].label} বন্ধ হয়েছে`;
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  if (running) killTree(running.proc.pid);
});
