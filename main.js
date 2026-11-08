const { app, BrowserWindow, ipcMain } = require('electron');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');
const extract = require('extract-zip');

// ====== এখানে আপনার লিংক বসান ======
// GitHub Release-এ আপলোড করা Apache zip-এর সরাসরি লিংক
const DOWNLOAD_URL = 'https://github.com/AbuOubaida/361-Server/releases/download/v1/httpd-2.4.70-261106-Win64-VS18.zip';

// Microsoft-এর স্থির লিংক: সবসময় সর্বশেষ সাপোর্টেড VC++ Redistributable (x64) দেয়
const VCREDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';
// ====================================

// অ্যাপের নিজস্ব ডাটা ফোল্ডার: C:\Users\<name>\AppData\Roaming\my-laragon
const TOOLS_DIR = path.join(app.getPath('userData'), 'tools');
const APACHE_DIR = path.join(TOOLS_DIR, 'Apache24');
const APACHE_EXE = path.join(APACHE_DIR, 'bin', 'httpd.exe');
const ZIP_PATH = path.join(TOOLS_DIR, 'apache.zip');
const VCREDIST_PATH = path.join(TOOLS_DIR, 'vc_redist.x64.exe');

let win = null;
let apacheProcess = null;

function createWindow() {
  win = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
}

function sendStatus(msg) {
  if (win) win.webContents.send('status', msg);
}

// ফাইল ডাউনলোড (রিডাইরেক্ট সহ)
function download(url, dest, label = 'ডাউনলোড হচ্ছে') {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        // রিডাইরেক্ট হলে নতুন লিংকে যাও (relative লিংকও সামলায়)
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

// ---------- Apache ----------
async function ensureApache() {
  if (fs.existsSync(APACHE_EXE)) return;

  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  sendStatus('Apache পাওয়া যায়নি, ডাউনলোড শুরু হচ্ছে...');
  await download(DOWNLOAD_URL, ZIP_PATH, 'Apache ডাউনলোড হচ্ছে');

  sendStatus('ফাইল খোলা হচ্ছে...');
  await extract(ZIP_PATH, { dir: TOOLS_DIR });
  fs.unlinkSync(ZIP_PATH);

  // httpd.conf-এ SRVROOT ঠিক করা
  const confPath = path.join(APACHE_DIR, 'conf', 'httpd.conf');
  let conf = fs.readFileSync(confPath, 'utf8');
  const root = APACHE_DIR.replace(/\\/g, '/');
  conf = conf.replace(/Define SRVROOT ".*"/, `Define SRVROOT "${root}"`);
  fs.writeFileSync(confPath, conf);

  sendStatus('Apache ইনস্টল সম্পন্ন');
}

// ---------- IPC ----------
ipcMain.handle('apache:start', async () => {
  if (apacheProcess) return 'Apache আগে থেকেই চলছে';
  try {
    await ensureVCRedist();
    await ensureApache();
  } catch (err) {
    return 'সমস্যা: ' + err.message;
  }
  apacheProcess = spawn(APACHE_EXE, [], { windowsHide: true });
  apacheProcess.on('exit', () => { apacheProcess = null; });
  return 'Apache চালু হয়েছে';
});

ipcMain.handle('apache:stop', () => {
  if (!apacheProcess) return 'Apache চলছে না';
  exec(`taskkill /pid ${apacheProcess.pid} /t /f`);
  apacheProcess = null;
  return 'Apache বন্ধ হয়েছে';
});

app.whenReady().then(createWindow);

app.on('before-quit', () => {
  if (apacheProcess) exec(`taskkill /pid ${apacheProcess.pid} /t /f`);
});