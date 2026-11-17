'use strict';
// Auto-update (session 37): GitHub Releases + electron-updater। শুধু ইনস্টল করা অ্যাপে (app.isPackaged) কাজ করে।
// নিয়ম: নিজে নিজে কিছু নামে না, ইনস্টলও হয় না, রিস্টার্টও হয় না। প্রতিটা ধাপ ব্যবহারকারীর বোতামে:
//   Check -> (নতুন ভার্সন থাকলে) Download -> Restart and install।
// electron-updater এখানে দেরিতে (init-এর ভেতরে) লোড হয়, তাই `npm install` করার আগেও অ্যাপ চালু হয়; না থাকলে শুধু এই কার্ড বার্তা দেখায়।
// সেটিং settings.updates.autoCheck (ডিফল্ট true): অ্যাপ খোলার ~১০ সেকেন্ড পর একবার চেক।

const CHECK_DELAY_MS = 10000;

const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n\0]+/g, ' ').trim().slice(0, n);

// deps: { ipcMain, getSettings(), saveSettings(), tr(bn,en), version, isPackaged, send(ch,p), status(msg),
//         prepareQuit() (main.js-এ quitting = true), loadUpdater() -> autoUpdater (পরীক্ষার জন্য বদলানো যায়), delayMs? }
function init(deps) {
  let up = null; // electron-updater-এর autoUpdater
  let loadErr = '';
  let timer = null;
  let stopped = false;
  const st = { status: 'idle', version: '', percent: 0, err: '', checkedAt: 0 };
  // status: idle | checking | none | available | downloading | downloaded | error

  function cfg() {
    const s = deps.getSettings();
    const u = (s.updates = s.updates && typeof s.updates === 'object' ? s.updates : {});
    if (typeof u.autoCheck !== 'boolean') u.autoCheck = true;
    return u;
  }
  const supported = () => !!deps.isPackaged && !!up;

  function view() {
    return {
      current: String(deps.version || ''),
      packaged: !!deps.isPackaged,
      supported: supported(),
      loadErr: deps.isPackaged ? loadErr : '',
      autoCheck: cfg().autoCheck,
      status: st.status,
      version: st.version,
      percent: Math.round(st.percent || 0),
      err: st.err,
      checkedAt: st.checkedAt,
    };
  }
  function push() {
    if (stopped) return;
    try {
      deps.send('app:update', null);
    } catch {}
  }
  function setState(patch) {
    Object.assign(st, patch);
    push();
  }

  // ভুলের বার্তা: সবচেয়ে সাধারণ কারণগুলো সহজ ভাষায়, বাকিটা আসল লেখা (ছোট করে)
  function nice(e) {
    const raw = clean(e && e.message ? e.message : e, 400);
    if (/\b404\b|\b406\b|latest\.yml|Unable to find latest version|ensure a production release/i.test(raw)) {
      return deps.tr(
        'GitHub-এ latest.yml পাওয়া যায়নি: এখনো কোনো release নেই, release "Latest" করা হয়নি (draft/pre-release), বা repo private। (' + raw.slice(0, 120) + ')',
        'latest.yml was not found on GitHub: no release yet, the release is not marked "Latest" (draft/pre-release), or the repository is private. (' + raw.slice(0, 120) + ')'
      );
    }
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ERR_INTERNET|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|net::/i.test(raw)) {
      return deps.tr('ইন্টারনেট সংযোগ পাওয়া যায়নি, পরে আবার চেষ্টা করুন। (' + raw.slice(0, 120) + ')', 'No internet connection, try again later. (' + raw.slice(0, 120) + ')');
    }
    return raw.slice(0, 300);
  }

  function attach() {
    try {
      up = deps.loadUpdater();
    } catch (e) {
      up = null;
      loadErr = clean(e && e.message ? e.message : e, 200);
      return;
    }
    if (!up) return;
    // কিছুই নিজে নামবে/বসবে না
    up.autoDownload = false;
    up.autoInstallOnAppQuit = false;
    up.allowPrerelease = false;
    up.allowDowngrade = false;
    up.on('checking-for-update', () => setState({ status: 'checking', err: '' }));
    up.on('update-available', (info) => setState({ status: 'available', version: clean(info && info.version, 40), err: '', checkedAt: Date.now() }));
    up.on('update-not-available', () => setState({ status: 'none', version: '', err: '', checkedAt: Date.now() }));
    up.on('download-progress', (p) => setState({ status: 'downloading', percent: Math.max(0, Math.min(100, Number(p && p.percent) || 0)) }));
    up.on('update-downloaded', (info) => {
      setState({ status: 'downloaded', percent: 100, version: clean((info && info.version) || st.version, 40), err: '' });
      try {
        deps.status(deps.tr(`নতুন ভার্সন ${st.version} নামানো হয়েছে। Settings > Updates থেকে "রিস্টার্ট ও ইনস্টল" চাপুন।`, `Version ${st.version} is downloaded. Press "Restart and install" in Settings > Updates.`));
      } catch {}
    });
    up.on('error', (e) => setState({ status: 'error', err: nice(e), checkedAt: Date.now() }));
  }

  // fromAuto = true: অ্যাপ খোলার স্বয়ংক্রিয় চেক; ব্যর্থ হলে স্ট্যাটাস বারে কিছু বলে না, শুধু কার্ডে থাকে
  async function check(fromAuto) {
    if (!supported()) return view();
    if (['checking', 'downloading', 'downloaded'].includes(st.status)) return view();
    setState({ status: 'checking', err: '' });
    try {
      await up.checkForUpdates();
    } catch (e) {
      setState({ status: 'error', err: nice(e), checkedAt: Date.now() });
    }
    if (st.status === 'available' && fromAuto) {
      try {
        deps.status(deps.tr(`নতুন ভার্সন ${st.version} পাওয়া গেছে। Settings > Updates থেকে নামান।`, `Version ${st.version} is available. Download it in Settings > Updates.`));
      } catch {}
    }
    return view();
  }

  async function download() {
    if (!supported() || st.status !== 'available') return view();
    setState({ status: 'downloading', percent: 0, err: '' });
    try {
      await up.downloadUpdate();
    } catch (e) {
      setState({ status: 'error', err: nice(e), checkedAt: Date.now() });
    }
    return view();
  }

  // ফেরত: { ok, message? }। ইনস্টলার চালু হয়ে অ্যাপ বন্ধ হবে; সার্ভারগুলো before-quit-এ বন্ধ হয়।
  function install() {
    if (!supported() || st.status !== 'downloaded') return { ok: false, message: deps.tr('আগে নতুন ভার্সন নামান', 'Download the update first') };
    try {
      deps.prepareQuit(); // উইন্ডো বন্ধ মানে ট্রেতে লুকানো নয়, সত্যিকারের বের হওয়া
      up.quitAndInstall(false, true); // চুপচাপ নয় (wizard দেখায়), শেষে অ্যাপ আবার চালু
      return { ok: true };
    } catch (e) {
      setState({ status: 'error', err: nice(e) });
      return { ok: false, message: nice(e) };
    }
  }

  attach();
  const { ipcMain } = deps;
  ipcMain.handle('update:get', () => view());
  ipcMain.handle('update:check', () => check(false));
  ipcMain.handle('update:download', () => download());
  ipcMain.handle('update:install', () => install());
  ipcMain.handle('update:setAuto', (_e, on) => {
    cfg().autoCheck = !!on;
    deps.saveSettings();
    return view();
  });

  if (supported() && cfg().autoCheck) {
    timer = setTimeout(() => {
      timer = null;
      if (!stopped && cfg().autoCheck) check(true).catch(() => {});
    }, deps.delayMs === undefined ? CHECK_DELAY_MS : deps.delayMs);
  }

  return {
    view,
    check,
    download,
    install,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { init };
