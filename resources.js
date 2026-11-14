'use strict';
// সাইট মনিটরিং (R1, ধাপ ২): প্রসেস গ্রুপ ধরে CPU ও RAM (ওয়েব সার্ভার, php-cgi, Node, MySQL, PostgreSQL)।
// PowerShell/wmic লাগে না: শুধু `tasklist /v /fo csv /nh` (Windows-এ সবসময় থাকে)।
// গ্রুপ চেনা হয় প্রসেসের .exe নামে (main.js বলে দেয় কোন গ্রুপ এখন চালু, কোন নামে)।
// সীমা: একই নামের অন্য প্রোগ্রামের প্রসেসও (যেমন অন্য জায়গার mysqld.exe) গোনা হয়, কারণ tasklist-এ parent/path নেই।
// ইতিহাস শুধু মেমরিতে (শেষ ২ ঘণ্টা); অ্যাপ বন্ধ করলে মুছে যায়।
const { execFile } = require('child_process');
const os = require('os');

const SAMPLE_MS = 30000;
const KEEP_POINTS = 240; // ৩০ সেকেন্ডে ২ ঘণ্টা
const TASKLIST_TIMEOUT = 20000;
const HIGH_FOR = 3; // পরপর ৩ নমুনা (প্রায় ১.৫ মিনিট) সীমার ওপরে থাকলে তবেই জানানো হয়
const CPU_CHOICES = [0, 50, 70, 90]; // % (০ = বন্ধ), সব কোর মিলিয়ে ১০০%
const RAM_CHOICES = [0, 512, 1024, 2048, 4096]; // MB (০ = বন্ধ), গ্রুপ প্রতি

// tasklist /v /fo csv /nh-এর এক লাইন -> { image, pid, memMB, cpuSec } (না মিললে null)
// কলাম: 1 Image, 2 PID, 3 Session Name, 4 Session#, 5 Mem Usage ("12,345 K"), 6 Status, 7 User, 8 CPU Time (h:mm:ss), 9 Window Title
function parseLine(line) {
  const f = [];
  const re = /"([^"]*)"/g;
  let m;
  while ((m = re.exec(line)) && f.length < 8) f.push(m[1]);
  if (f.length < 5) return null;
  const pid = Number(f[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const kb = Number(String(f[4]).replace(/\D/g, ''));
  let cpuSec = null;
  const c = f[7] && f[7].match(/(\d+):(\d+):(\d+)/);
  if (c) cpuSec = Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]);
  return { image: String(f[0]).toLowerCase(), pid, memMB: Number.isFinite(kb) ? kb / 1024 : 0, cpuSec };
}
function parseTasklist(out) {
  const rows = [];
  for (const line of String(out).split(/\r?\n/)) {
    const r = line.trim() ? parseLine(line) : null;
    if (r) rows.push(r);
  }
  return rows;
}

function runTasklist() {
  return new Promise((resolve) => {
    try {
      execFile('tasklist', ['/v', '/fo', 'csv', '/nh'], { windowsHide: true, timeout: TASKLIST_TIMEOUT, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
        if (err) return resolve(null);
        resolve(parseTasklist(out));
      });
    } catch {
      resolve(null);
    }
  });
}

// deps: { ipcMain, getSettings(), saveSettings(), tr(bn,en), getGroups() -> [{id, images:[...]}], notify(title, body), status(msg), send(ch, p), list? (পরীক্ষার জন্য: tasklist-এর বদলে) }
function init(deps) {
  const cores = Math.max(1, os.cpus().length);
  let timer = null;
  let sampling = false;
  let stopped = false;
  let prev = null; // { t, cpu: Map(pid -> sec) }
  let latest = { ok: true, ts: 0, groups: [] };
  const hist = {}; // id -> [[tsSec, cpu|null, ramMB], ...]
  const hi = {}; // id -> { cpu: n, ram: n, cpuAlerted, ramAlerted }

  function cfg() {
    const s = deps.getSettings();
    const m = (s.monitor = s.monitor && typeof s.monitor === 'object' ? s.monitor : {});
    const r = (m.res = m.res && typeof m.res === 'object' ? m.res : {});
    if (typeof r.enabled !== 'boolean') r.enabled = true;
    if (!CPU_CHOICES.includes(r.cpuMax)) r.cpuMax = 0;
    if (!RAM_CHOICES.includes(r.ramMaxMB)) r.ramMaxMB = 0;
    return r;
  }
  const round1 = (x) => Math.round(x * 10) / 10;

  function say(msg) {
    // সতর্কবার্তা সেটিং (monitor.alerts) বন্ধ থাকলে কিছু বলে না
    const s = deps.getSettings();
    if (s.monitor && s.monitor.alerts === false) return;
    try {
      deps.notify('Server 360', msg);
    } catch {}
    try {
      deps.status(msg);
    } catch {}
  }

  function checkLimits(g, name) {
    const c = cfg();
    const h = (hi[g.id] = hi[g.id] || { cpu: 0, ram: 0, cpuAlerted: false, ramAlerted: false });
    if (c.cpuMax && g.cpu !== null) {
      if (g.cpu >= c.cpuMax) {
        h.cpu++;
        if (h.cpu >= HIGH_FOR && !h.cpuAlerted) {
          h.cpuAlerted = true;
          say(deps.tr(`⚠ ${name}-এর CPU ${g.cpu}% (সীমা ${c.cpuMax}%)`, `⚠ ${name} CPU is ${g.cpu}% (limit ${c.cpuMax}%)`));
        }
      } else {
        h.cpu = 0;
        h.cpuAlerted = false;
      }
    }
    if (c.ramMaxMB) {
      if (g.ramMB >= c.ramMaxMB) {
        h.ram++;
        if (h.ram >= HIGH_FOR && !h.ramAlerted) {
          h.ramAlerted = true;
          say(deps.tr(`⚠ ${name}-এর RAM ${Math.round(g.ramMB)} MB (সীমা ${c.ramMaxMB} MB)`, `⚠ ${name} RAM is ${Math.round(g.ramMB)} MB (limit ${c.ramMaxMB} MB)`));
        }
      } else {
        h.ram = 0;
        h.ramAlerted = false;
      }
    }
  }

  async function sample() {
    if (sampling) return;
    sampling = true;
    try {
      const defs = deps.getGroups() || [];
      if (!defs.length) {
        latest = { ok: true, ts: Date.now(), groups: [] };
        prev = null;
        return;
      }
      const rows = deps.list ? await deps.list() : await runTasklist();
      const now = Date.now();
      if (!rows) {
        latest = { ok: false, ts: now, groups: [] }; // tasklist চলেনি
        return;
      }
      const wall = prev ? (now - prev.t) / 1000 : 0;
      const nextCpu = new Map();
      const out = [];
      for (const d of defs) {
        const want = new Set((d.images || []).map((x) => String(x).toLowerCase()));
        let n = 0;
        let ram = 0;
        let delta = 0;
        let known = false;
        for (const r of rows) {
          if (!want.has(r.image)) continue;
          n++;
          ram += r.memMB;
          if (r.cpuSec !== null) {
            nextCpu.set(r.pid, r.cpuSec);
            const p = prev && prev.cpu.get(r.pid);
            if (p !== undefined && r.cpuSec >= p) {
              delta += r.cpuSec - p;
              known = true;
            }
          }
        }
        // পুরনো PID-র নমুনা না থাকলে (প্রথমবার) CPU জানা নেই। একটা প্রসেস নতুন হলে সেটা বাদ, বাকিদের হিসাব ধরা হয়
        const cpu = known && wall > 0 ? Math.min(100, round1((delta / wall / cores) * 100)) : n === 0 ? 0 : null;
        const g = { id: d.id, name: d.name || d.id, n, cpu, ramMB: Math.round(ram) };
        out.push(g);
        const a = (hist[d.id] = hist[d.id] || []);
        a.push([Math.round(now / 1000), cpu, g.ramMB]);
        if (a.length > KEEP_POINTS) a.splice(0, a.length - KEEP_POINTS);
        if (n > 0) checkLimits(g, d.name || d.id);
        else delete hi[d.id];
      }
      for (const k of Object.keys(hist)) if (!defs.some((d) => d.id === k)) delete hist[k];
      prev = { t: now, cpu: nextCpu };
      latest = { ok: true, ts: now, groups: out };
    } catch {
      latest = { ok: false, ts: Date.now(), groups: [] };
    } finally {
      sampling = false;
    }
    if (!stopped) {
      try {
        deps.send('monitor:res', null);
      } catch {}
    }
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = null;
    if (stopped || !cfg().enabled) return;
    timer = setTimeout(async () => {
      timer = null;
      try {
        await sample();
      } catch {}
      schedule(SAMPLE_MS);
    }, ms);
  }

  function get() {
    const c = cfg();
    return { cfg: { enabled: c.enabled, cpuMax: c.cpuMax, ramMaxMB: c.ramMaxMB, cores }, ok: latest.ok, ts: latest.ts, groups: latest.groups };
  }
  function history(id) {
    return { points: (hist[String(id)] || []).map((x) => ({ t: x[0] * 1000, cpu: x[1], ram: x[2] })) };
  }

  const { ipcMain } = deps;
  ipcMain.handle('res:get', () => get());
  ipcMain.handle('res:history', (_e, id) => history(id));
  ipcMain.handle('res:now', async () => {
    await sample();
    return get();
  });
  ipcMain.handle('res:setConfig', (_e, c) => {
    c = c || {};
    const m = cfg();
    if (typeof c.enabled === 'boolean') m.enabled = c.enabled;
    if (CPU_CHOICES.includes(Number(c.cpuMax))) m.cpuMax = Number(c.cpuMax);
    if (RAM_CHOICES.includes(Number(c.ramMaxMB))) m.ramMaxMB = Number(c.ramMaxMB);
    deps.saveSettings();
    for (const k of Object.keys(hi)) delete hi[k]; // সীমা বদলালে গোনা আবার শুরু
    schedule(m.enabled ? 500 : 0);
    return get();
  });

  schedule(8000);
  return {
    sample,
    get,
    history,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { init, parseLine, parseTasklist, CPU_CHOICES, RAM_CHOICES };
