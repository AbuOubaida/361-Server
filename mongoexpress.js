'use strict';
// R2 ধাপ ২: MongoDB দেখার টুল = Mongo Express (browser-এ)। অ্যাপের নিজের Node দিয়ে `npm install mongo-express` করে চালায়।
// ইনস্টল: <tools>\mongo-express\node_modules (একবারই, নেট লাগে)। চালু: শুধু 127.0.0.1-এ, একটা খালি পোর্টে, লগইন ছাড়া।
// "Open" চাপলে চালু হয় (না থাকলে আগে ইনস্টল), MongoDB বন্ধ হলে বা অ্যাপ বন্ধ হলে থামে।
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');

const VERSION = '1.0.2';
const INSTALL_TIMEOUT = 15 * 60 * 1000;
const START_TIMEOUT = 60 * 1000;

const tcpUp = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => {
      s.destroy();
      resolve(false);
    });
  });

// deps: { ipcMain, dir() -> ইনস্টল ফোল্ডার, runtime() -> Promise<{ dir }> (Node-এর ফোল্ডার, না থাকলে নামায়),
//         mongoPort(), mongoRunning(), tr(bn,en), status(msg), freePort() -> Promise<number>,
//         openUrl(url) -> Promise, kill(pid), track(proc), cleanStale() -> Promise }
function init(deps) {
  let run = null; // { proc, port }
  let working = false;
  const nodeExe = (rt) => path.join(rt.dir, process.platform === 'win32' ? 'node.exe' : 'node');
  const appJs = () => path.join(deps.dir(), 'node_modules', 'mongo-express', 'app.js');
  const installed = () => fs.existsSync(appJs());
  const envFor = (rt, extra) => {
    const env = { ...process.env, FORCE_COLOR: '0', ...extra };
    const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
    env[pk] = rt.dir + path.delimiter + (env[pk] || '');
    return env;
  };
  const tail = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(-300);

  // ফেরত: { ok, err }
  function install(rt) {
    return new Promise((resolve) => {
      const dir = deps.dir();
      try {
        fs.mkdirSync(dir, { recursive: true });
        const pj = path.join(dir, 'package.json');
        if (!fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ name: 'mongo-express-host', version: '1.0.0', private: true }, null, 2));
      } catch (e) {
        return resolve({ ok: false, err: e.message });
      }
      const cli = path.join(rt.dir, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (!fs.existsSync(cli)) return resolve({ ok: false, err: deps.tr('এই Node ZIP-এ npm পাওয়া যায়নি', 'this Node ZIP does not include npm') });
      let out = '';
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve(v);
        }
      };
      let proc;
      try {
        proc = spawn(nodeExe(rt), [cli, 'install', `mongo-express@${VERSION}`, '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, windowsHide: true, env: envFor(rt, {}) });
      } catch (e) {
        return resolve({ ok: false, err: e.message });
      }
      const timer = setTimeout(() => {
        deps.kill(proc.pid);
        finish({ ok: false, err: deps.tr('npm install সময়মতো শেষ হয়নি', 'npm install did not finish in time') });
      }, INSTALL_TIMEOUT);
      const collect = (d) => (out = (out + d).slice(-4000));
      proc.stdout.on('data', collect);
      proc.stderr.on('data', collect);
      proc.once('error', (e) => finish({ ok: false, err: e.message }));
      proc.once('exit', (code) => finish(code === 0 && installed() ? { ok: true } : { ok: false, err: `npm (${code}) ${tail(out)}` }));
    });
  }

  async function open() {
    if (!deps.mongoRunning()) return deps.tr('আগে MongoDB চালু করুন (Start চাপুন), তারপর আবার খুলুন।', 'Start MongoDB first (press Start), then open it again.');
    if (run) {
      await deps.openUrl(`http://127.0.0.1:${run.port}/`);
      return deps.tr(`Mongo Express ব্রাউজারে খোলা হয়েছে (পোর্ট ${run.port})।`, `Mongo Express opened in the browser (port ${run.port}).`);
    }
    if (working) return deps.tr('Mongo Express-এর কাজ চলছে, একটু অপেক্ষা করুন...', 'Mongo Express is busy, please wait...');
    working = true;
    try {
      let rt;
      try {
        rt = await deps.runtime();
      } catch (e) {
        return deps.tr('সমস্যা: ', 'Error: ') + e.message;
      }
      if (!installed()) {
        deps.status(deps.tr('Mongo Express ইনস্টল হচ্ছে (npm install, ১-২ মিনিট লাগতে পারে, নেট লাগবে)...', 'Installing Mongo Express (npm install, may take 1-2 minutes, needs internet)...'));
        const r = await install(rt);
        if (!r.ok) return deps.tr('সমস্যা: Mongo Express ইনস্টল হয়নি, ', 'Error: Mongo Express install failed, ') + r.err;
      }
      try {
        await deps.cleanStale(); // আগের বার অ্যাপ হঠাৎ বন্ধ হলে লুকিয়ে থাকা প্রসেস
      } catch {}
      const port = await deps.freePort();
      deps.status(deps.tr('Mongo Express চালু হচ্ছে...', 'Starting Mongo Express...'));
      const env = envFor(rt, {
        PORT: String(port),
        VCAP_APP_HOST: '127.0.0.1', // শুধু এই পিসি
        ME_CONFIG_MONGODB_URL: `mongodb://127.0.0.1:${deps.mongoPort()}`,
        ME_CONFIG_MONGODB_ENABLE_ADMIN: 'true', // সব ডাটাবেস দেখতে
        ME_CONFIG_BASICAUTH: 'false',
        ME_CONFIG_BASICAUTH_ENABLED: 'false',
        ME_CONFIG_SITE_SSL_ENABLED: 'false',
        ME_CONFIG_SITE_COOKIESECRET: crypto.randomBytes(16).toString('hex'),
        ME_CONFIG_SITE_SESSIONSECRET: crypto.randomBytes(16).toString('hex'),
      });
      let proc;
      try {
        proc = spawn(nodeExe(rt), [appJs()], { cwd: deps.dir(), windowsHide: true, env });
      } catch (e) {
        return deps.tr('সমস্যা: ', 'Error: ') + e.message;
      }
      try {
        deps.track(proc);
      } catch {}
      let out = '';
      let exited = null;
      const collect = (d) => (out = (out + d).slice(-3000));
      proc.stdout.on('data', collect);
      proc.stderr.on('data', collect);
      proc.once('error', (e) => (exited = e.message));
      proc.once('exit', (code) => {
        exited = `exit ${code}`;
        if (run && run.proc === proc) run = null;
      });
      const t0 = Date.now();
      let up = false;
      while (Date.now() - t0 < START_TIMEOUT && exited === null) {
        if (await tcpUp(port)) {
          up = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!up) {
        deps.kill(proc.pid);
        return deps.tr('সমস্যা: Mongo Express চালু হয়নি, ', 'Error: Mongo Express did not start, ') + (exited || 'timed out') + ' ' + tail(out);
      }
      run = { proc, port };
      await deps.openUrl(`http://127.0.0.1:${port}/`);
      return deps.tr(`Mongo Express চালু হয়েছে (পোর্ট ${port}) আর ব্রাউজারে খোলা হয়েছে। MongoDB বন্ধ করলে এটাও বন্ধ হবে।`, `Mongo Express started (port ${port}) and opened in the browser. It stops when MongoDB stops.`);
    } finally {
      working = false;
    }
  }

  function stop() {
    if (!run) return false;
    const r = run;
    run = null;
    try {
      deps.kill(r.proc.pid);
    } catch {}
    return true;
  }

  deps.ipcMain.handle('mexpress:open', () => open());
  return { open, stop, running: () => !!run, installed };
}

module.exports = { init, VERSION };
