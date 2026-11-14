'use strict';
// সাইট মনিটরিং (R1, ধাপ ৩b): প্রতিটা সাইটের access log (logs\sites\<domain>.access.log) থেকে হিট, পাঠানো bytes, 4xx/5xx ও গড় সাড়ার সময়।
// লগের লাইন (main.js-এর NG_LOG_FORMAT / AP_LOG_FORMAT):
//   Nginx : epoch.ms|status|bytes|সেকেন্ড|method|path|UA            (৭ ঘর, UA-তে | থাকতে পারে, তাই UA সবশেষে)
//   Apache: epoch|status|bytes|মাইক্রোসেকেন্ড|GET /path HTTP/1.1|UA  (৬ ঘর; ধাপ ৩a-র প্রথম সংস্করণের পুরনো লাইনে Nginx-এর মতো ৭ ঘর)
// মনিটরের নিজের পরীক্ষা (UA = Server360-Monitor) গোনা হয় না। ? এর পরের অংশ কখনো পড়া/রাখা হয় না (আমরা path-ই রাখি না)।
// প্রতিটা লগের কত byte পর্যন্ত পড়া হয়েছে তা traffic.json-এ থাকে; অ্যাপ বন্ধ থাকলেও লগের নিজের সময় ধরে পরে গোনা হয়।
// ধাপ ৩c: দিন ধরে Top URL (শুধু পথ, ? ছাড়া, সর্বোচ্চ ২০০ অক্ষর; সাইট প্রতি দিনে সর্বোচ্চ ১০০টা পথ রাখা হয়, ছাপিয়ে গেলে সেরা ৫০টা রেখে বাকি বাদ) এবং isRead/forget (main.js ২০ MB-র বেশি log সরানোর আগে জানতে চায় পুরোটা পড়া হয়েছে কিনা)।
// জমা: মিনিট-বাকেট শেষ ২৪ ঘণ্টা, ঘণ্টা-বাকেট keepDays (monitor.keepDays) দিন। বাকেট = [হিট, bytes, 4xx, 5xx, সাড়ার-সময়ের-যোগফল ms]।
const fs = require('fs');

const ROUND_MS = 10000;
const CATCHUP_MS = 800; // এখনো না-পড়া অংশ থাকলে তাড়াতাড়ি আবার
const CHUNK = 2 * 1024 * 1024; // এক ফাইল থেকে এক রাউন্ডে সর্বোচ্চ ২ MB
const SAVE_MS = 60000;
const MIN_BUCKETS_H = 24; // মিনিট-বাকেট কত ঘণ্টা
const DAY = 86400;
const PATH_MAX = 200;
const DAY_PATHS = 100; // এর বেশি হলে সেরা ৫০টা রেখে বাকি ফেলা হয়
const DAY_KEEP = 50;
const dayKey = (tsSec) => {
  const d = new Date(tsSec * 1000);
  return String(d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate());
};

// এক লাইন -> { ts(সেকেন্ড), status, bytes, ms, mon, path } অথবা null (পড়া যায়নি); path = ? ও # ছাড়া, '/' দিয়ে শুরু, নইলে ''
function parseLine(kind, line) {
  if (!line) return null;
  const f = line.split('|');
  if (f.length < 6) return null;
  const ts = Number(f[0]);
  const status = Number(f[1]);
  if (!Number.isFinite(ts) || ts < 1e9 || ts > 4e9) return null;
  if (!Number.isInteger(status) || status < 100 || status > 599) return null;
  let bytes = Number(f[2]);
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0;
  let tm = Number(f[3]);
  if (!Number.isFinite(tm) || tm < 0) tm = 0;
  const ms = kind === 'apache' ? tm / 1000 : tm * 1000;
  let ua;
  let target;
  if (String(f[4]).includes(' ')) {
    ua = f.slice(5).join('|'); // Apache: "GET /x HTTP/1.1" এক ঘরে
    target = String(f[4]).split(' ')[1] || '';
  } else if (f.length >= 7) {
    ua = f.slice(6).join('|');
    target = String(f[5]);
  } else return null; // "-" (খারাপ অনুরোধ) ইত্যাদি
  let path = target.split('?')[0].split('#')[0];
  if (!path.startsWith('/')) path = '';
  if (path.length > PATH_MAX) path = path.slice(0, PATH_MAX);
  return { ts, status, bytes, ms, mon: ua.startsWith('Server360-Monitor'), path };
}

// deps: { ipcMain, getSettings(), saveSettings(), dataFile(), getLogFiles() -> [{domain, kind:'nginx'|'apache', file, own}], send(ch, p) }
function init(deps) {
  let st = { v: 1, files: {}, minutes: {}, hours: {}, top: {} };
  let timer = null;
  let busy = false;
  let stopped = false;
  let dirty = false;
  let lastSave = 0;
  let latest = { ok: true, ts: 0, own: [] };

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(deps.dataFile(), 'utf8'));
      if (j && typeof j === 'object') {
        st = { v: 1, files: j.files || {}, minutes: j.minutes || {}, hours: j.hours || {}, top: j.top || {} };
      }
    } catch {}
  }
  function save(sync) {
    try {
      const f = deps.dataFile();
      const tmp = f + '.tmp';
      fs.mkdirSync(require('path').dirname(f), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(st));
      fs.renameSync(tmp, f);
      dirty = false;
      lastSave = Date.now();
    } catch {
      if (sync) dirty = false;
    }
  }

  function cfg() {
    const s = deps.getSettings();
    const m = (s.monitor = s.monitor && typeof s.monitor === 'object' ? s.monitor : {});
    const t = (m.traffic = m.traffic && typeof m.traffic === 'object' ? m.traffic : {});
    if (typeof t.enabled !== 'boolean') t.enabled = true;
    const kd = Number(m.keepDays);
    t.keepDays = Number.isInteger(kd) && kd >= 1 && kd <= 365 ? kd : 7;
    return t;
  }

  function add(domain, p, nowSec, keepDays) {
    const row = (p.status >= 500 ? [1, p.bytes, 0, 1, p.ms] : p.status >= 400 ? [1, p.bytes, 1, 0, p.ms] : [1, p.bytes, 0, 0, p.ms]);
    const put = (grp, key) => {
      const d = (st[grp][domain] = st[grp][domain] || {});
      const b = d[key];
      if (b) for (let i = 0; i < 5; i++) b[i] += row[i];
      else d[key] = row.slice();
    };
    if (p.ts >= nowSec - MIN_BUCKETS_H * 3600) put('minutes', String(Math.floor(p.ts / 60)));
    if (p.ts >= nowSec - keepDays * DAY) {
      put('hours', String(Math.floor(p.ts / 3600)));
      if (p.path) {
        const td = (st.top[domain] = st.top[domain] || {});
        const day = (td[dayKey(p.ts)] = td[dayKey(p.ts)] || {});
        const e = day[p.path];
        if (e) {
          e[0] += 1;
          e[1] += p.bytes;
        } else {
          day[p.path] = [1, p.bytes];
          const keys = Object.keys(day);
          if (keys.length > DAY_PATHS) {
            keys.sort((a, b) => day[b][0] - day[a][0]);
            for (const k of keys.slice(DAY_KEEP)) delete day[k];
          }
        }
      }
    }
    dirty = true;
  }

  function trim(nowSec, keepDays) {
    const dayCut = Number(dayKey(nowSec - keepDays * DAY));
    for (const dom of Object.keys(st.top)) {
      const d = st.top[dom];
      for (const k of Object.keys(d)) if (Number(k) < dayCut) delete d[k];
      if (!Object.keys(d).length) delete st.top[dom];
    }
    const minCut = Math.floor(nowSec / 60) - MIN_BUCKETS_H * 60;
    const hourCut = Math.floor(nowSec / 3600) - keepDays * 24;
    for (const [grp, cut] of [['minutes', minCut], ['hours', hourCut]]) {
      for (const dom of Object.keys(st[grp])) {
        const d = st[grp][dom];
        for (const k of Object.keys(d)) if (Number(k) < cut) delete d[k];
        if (!Object.keys(d).length) delete st[grp][dom];
      }
    }
  }

  // এক ফাইলের নতুন অংশ পড়ে বাকেটে যোগ। ফেরত: এখনো পড়ার মতো অংশ বাকি আছে কিনা
  async function readOne(f, nowSec, keepDays) {
    let fh;
    try {
      fh = await fs.promises.open(f.file, 'r');
    } catch {
      return false; // ফাইল এখনো নেই (সাইটে এখনো হিট আসেনি)
    }
    try {
      const stt = await fh.stat();
      const bt = Math.round(stt.birthtimeMs || 0);
      let rec = st.files[f.file];
      if (!rec) rec = st.files[f.file] = { off: 0, bt };
      if (rec.bt !== bt || stt.size < rec.off) {
        rec.off = 0; // নতুন ফাইল বা ছোট হয়ে গেছে (রোটেট/মোছা)
        rec.bt = bt;
        dirty = true;
      }
      if (stt.size <= rec.off) return false;
      const n = Math.min(CHUNK, stt.size - rec.off);
      const buf = Buffer.alloc(n);
      const { bytesRead } = await fh.read(buf, 0, n, rec.off);
      if (!bytesRead) return false;
      const nl = buf.lastIndexOf(10, bytesRead - 1);
      let used;
      if (nl >= 0 && nl < bytesRead) used = nl + 1;
      else used = bytesRead >= CHUNK ? bytesRead : 0; // একটাও পূর্ণ লাইন নেই: অর্ধেক লাইন হলে অপেক্ষা, ২ MB-র দানব লাইন হলে বাদ
      if (!used) return false;
      const text = buf.toString('utf8', 0, used);
      for (const line of text.split('\n')) {
        const l = line.endsWith('\r') ? line.slice(0, -1) : line;
        const p = parseLine(f.kind, l);
        if (p && !p.mon) add(f.domain, p, nowSec, keepDays);
      }
      rec.off += used;
      dirty = true;
      return rec.off < stt.size;
    } catch {
      return false;
    } finally {
      try {
        await fh.close();
      } catch {}
    }
  }

  async function round() {
    if (busy || stopped) return false;
    busy = true;
    let more = false;
    try {
      const c = cfg();
      if (!c.enabled) return false;
      const list = deps.getLogFiles() || [];
      const nowSec = Math.floor(Date.now() / 1000);
      const own = new Set();
      for (const f of list) {
        if (f.own) {
          own.add(f.domain);
          continue;
        }
        if (await readOne(f, nowSec, c.keepDays)) more = true;
      }
      trim(nowSec, c.keepDays);
      latest = { ok: true, ts: Date.now(), own: [...own], seen: [...new Set(list.filter((f) => !f.own).map((f) => f.domain))] };
      if (dirty && Date.now() - lastSave >= SAVE_MS) save();
    } catch {
      latest = { ok: false, ts: Date.now(), own: [], seen: [] };
    } finally {
      busy = false;
    }
    if (!stopped) {
      try {
        deps.send('monitor:traffic', null);
      } catch {}
    }
    return more;
  }

  function schedule(ms) {
    clearTimeout(timer);
    timer = null;
    if (stopped || !cfg().enabled) return;
    timer = setTimeout(async () => {
      timer = null;
      let more = false;
      try {
        more = await round();
      } catch {}
      schedule(more ? CATCHUP_MS : ROUND_MS);
    }, ms);
  }

  const sum = (acc, b) => {
    for (let i = 0; i < 5; i++) acc[i] += b[i];
  };

  // hours <= 24: মিনিট-বাকেট, নইলে ঘণ্টা-বাকেট
  function source(hours) {
    return hours <= 24 ? { grp: 'minutes', unit: 60 } : { grp: 'hours', unit: 3600 };
  }

  function get(hours) {
    hours = Number(hours) > 0 ? Math.min(Number(hours), 24 * 365) : 24;
    const c = cfg();
    const { grp, unit } = source(hours);
    const from = Math.floor(Date.now() / 1000 / unit) - Math.ceil((hours * 3600) / unit);
    const rows = [];
    const doms = new Set([...Object.keys(st[grp]), ...(latest.seen || []), ...(latest.own || [])]);
    for (const dom of doms) {
      const isOwn = (latest.own || []).includes(dom);
      const acc = [0, 0, 0, 0, 0];
      const d = st[grp][dom] || {};
      for (const k of Object.keys(d)) if (Number(k) >= from) sum(acc, d[k]);
      rows.push({
        domain: dom,
        own: isOwn,
        hits: acc[0],
        bytes: acc[1],
        e4: acc[2],
        e5: acc[3],
        avgMs: acc[0] ? Math.round(acc[4] / acc[0] * 10) / 10 : null,
      });
    }
    rows.sort((a, b) => b.hits - a.hits || a.domain.localeCompare(b.domain));
    return { cfg: { enabled: c.enabled, keepDays: c.keepDays }, ok: latest.ok, ts: latest.ts, hours, sites: rows };
  }

  // domain = সাইটের নাম, অথবা '*' = সব সাইট; ফেরত বিন্দুগুলোর t মিলিসেকেন্ডে, ফাঁকা বাকেট 0
  function history(domain, hours) {
    hours = [1, 24, 168].includes(Number(hours)) ? Number(hours) : 24;
    const size = hours === 1 ? 60 : hours === 24 ? 900 : 7200; // বাকেটের মাপ (সেকেন্ড)
    const { grp, unit } = source(hours);
    const nowSec = Math.floor(Date.now() / 1000);
    const end = Math.floor(nowSec / size) * size;
    const count = Math.round((hours * 3600) / size);
    const first = end - (count - 1) * size;
    const out = new Map();
    for (let i = 0; i < count; i++) out.set(first + i * size, [0, 0, 0, 0, 0]);
    const doms = domain === '*' ? Object.keys(st[grp]) : [String(domain)];
    for (const dom of doms) {
      const d = st[grp][dom];
      if (!d) continue;
      for (const k of Object.keys(d)) {
        const ts = Number(k) * unit;
        const b = Math.floor(ts / size) * size;
        const slot = out.get(b);
        if (slot) sum(slot, d[k]);
      }
    }
    return { size, points: [...out].map(([t, a]) => ({ t: t * 1000, hits: a[0], bytes: a[1], e4: a[2], e5: a[3] })) };
  }

  // hours <= 24: আজ, নইলে শেষ ৭ দিন। domain '*' = সব সাইট মিলিয়ে। ফেরত: সেরা ২০ পথ
  function top(domain, hours) {
    const days = Number(hours) > 24 ? 7 : 1;
    const nowSec = Math.floor(Date.now() / 1000);
    const keys = new Set();
    for (let i = 0; i < days; i++) keys.add(dayKey(nowSec - i * DAY));
    const doms = domain === '*' ? Object.keys(st.top) : [String(domain)];
    const acc = new Map();
    for (const dom of doms) {
      const d = st.top[dom];
      if (!d) continue;
      for (const k of keys) {
        const day = d[k];
        if (!day) continue;
        for (const [p, v] of Object.entries(day)) {
          const a = acc.get(p) || [0, 0];
          a[0] += v[0];
          a[1] += v[1];
          acc.set(p, a);
        }
      }
    }
    const items = [...acc].map(([path, a]) => ({ path, hits: a[0], bytes: a[1] }));
    items.sort((a, b) => b.hits - a.hits || a.path.localeCompare(b.path));
    return { days, items: items.slice(0, 20) };
  }
  // সংখ্যা মুছে ফেলা; কোন log কতদূর পড়া হয়েছে (offset) থাকে, তাই পুরনো লাইন আবার গোনা হয় না
  function reset() {
    st.minutes = {};
    st.hours = {};
    st.top = {};
    dirty = true;
    save();
  }
  // ২০ MB-র বেশি log সরানোর আগে main.js জিজ্ঞেস করে: পুরোটা পড়া হয়েছে? (গোনা বন্ধ থাকলে কেউ পড়ছে না, তাই true)
  function isRead(file) {
    if (!cfg().enabled) return true;
    try {
      const stt = fs.statSync(file);
      const rec = st.files[file];
      if (!rec) return stt.size === 0;
      return rec.bt === Math.round(stt.birthtimeMs || 0) && rec.off >= stt.size;
    } catch {
      return false;
    }
  }
  function forget(file) {
    delete st.files[file];
    dirty = true;
  }

  load();
  const { ipcMain } = deps;
  ipcMain.handle('traffic:get', (_e, hours) => get(hours));
  ipcMain.handle('traffic:history', (_e, domain, hours) => history(String(domain || '*'), hours));
  ipcMain.handle('traffic:top', (_e, domain, hours) => top(String(domain || '*'), hours));
  ipcMain.handle('traffic:reset', (_e, hours) => {
    reset();
    return get(hours);
  });
  ipcMain.handle('traffic:setConfig', (_e, c) => {
    c = c || {};
    const m = cfg();
    if (typeof c.enabled === 'boolean') m.enabled = c.enabled;
    deps.saveSettings();
    schedule(m.enabled ? 300 : 0);
    return get(c.hours);
  });

  schedule(6000);
  return {
    round,
    get,
    history,
    top,
    reset,
    isRead,
    forget,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      if (dirty) save(true);
    },
  };
}

module.exports = { init, parseLine };
