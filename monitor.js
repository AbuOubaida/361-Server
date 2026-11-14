'use strict';
// সাইট মনিটরিং (R1, ধাপ ১): প্রতি কয়েক সেকেন্ড পর পর সাইট ও বাইরের URL-এ HTTP অনুরোধ পাঠিয়ে
// চালু/বন্ধ, HTTP কোড ও সাড়া দেওয়ার সময় (ms) জমা রাখে। main.js থেকে init(deps) দিয়ে চালু হয়।
// এই ধাপে CPU/RAM, হিট/ব্যান্ডউইথ, ই-মেইল নেই (ধাপ ২, ৩, ৪)।
//
// সাইট পরীক্ষা: ওয়েব সার্ভারের পোর্টে 127.0.0.1-এ যায়, Host হেডারে সাইটের ডোমেইন দেয়
// (hosts ফাইল/DNS লাগে না)। অনুরোধে User-Agent "Server360-Monitor" থাকে, যাতে ধাপ ৩-এ access log থেকে এগুলো বাদ দেওয়া যায়।
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const INTERVALS = [30, 60, 300]; // সেকেন্ড
const KEEP_DAYS = [1, 7, 30];
const MAX_URLS = 20;
const MAX_SAMPLES = 50000; // প্রতি লক্ষ্যে সর্বোচ্চ (৩০ সেকেন্ড + ৩০ দিন দিলে পুরনোগুলো আগে বাদ পড়ে)
const MAX_EVENTS = 60;
const SITE_TIMEOUT = 5000;
const URL_TIMEOUT = 8000;
const POOL = 4; // একসাথে সর্বোচ্চ ৪টা অনুরোধ
const FAILS_TO_ALERT = 2; // পরপর ২ বার ব্যর্থ হলে তবেই "বন্ধ" জানানো হয়
const SAVE_EVERY_MS = 5 * 60 * 1000;
const UA = 'Server360-Monitor';

// ব্যর্থতার কোড -> পড়ার মতো লেখা [বাংলা, English] (UI-র i18n কী 'mon.err.<কোড>' এর সাথে মেলানো রাখতে হবে)
const ERR_TEXT = {
  timeout: ['সময় শেষ', 'timeout'],
  ETIMEDOUT: ['সময় শেষ', 'timeout'],
  ECONNREFUSED: ['সংযোগ প্রত্যাখ্যাত', 'connection refused'],
  ECONNRESET: ['সংযোগ ছিঁড়ে গেছে', 'connection reset'],
  ENOTFOUND: ['ঠিকানা পাওয়া যায়নি', 'address not found'],
  EAI_AGAIN: ['ঠিকানা খোঁজা যায়নি (DNS)', 'DNS lookup failed'],
  EHOSTUNREACH: ['হোস্টে পৌঁছানো যায়নি', 'host unreachable'],
  ENETUNREACH: ['নেটওয়ার্কে পৌঁছানো যায়নি', 'network unreachable'],
  CERT_HAS_EXPIRED: ['সার্টিফিকেটের মেয়াদ শেষ', 'certificate expired'],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['সার্টিফিকেট যাচাই হয়নি', 'certificate not trusted'],
  DEPTH_ZERO_SELF_SIGNED_CERT: ['সার্টিফিকেট নিজে-সই করা', 'self-signed certificate'],
  SELF_SIGNED_CERT_IN_CHAIN: ['সার্টিফিকেট নিজে-সই করা', 'self-signed certificate'],
  ERR_TLS_CERT_ALTNAME_INVALID: ['সার্টিফিকেট অন্য নামের', 'certificate name mismatch'],
};

// ঠিক URL হলে স্বাভাবিক রূপ (href) দেয়, নইলে null। শুধু http/https, ইউজার/পাসওয়ার্ড ছাড়া।
function normUrl(s) {
  try {
    const u = new URL(String(s).trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password || !u.hostname) return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}
const urlName = (href) => {
  const u = new URL(href);
  return u.host + (u.pathname !== '/' ? u.pathname : '') + u.search;
};

// একটা GET অনুরোধ: হেডার আসামাত্র শেষ (বডি নামায় না)। কখনো throw/reject করে না।
function probe(opts, useHttps, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const t0 = Date.now();
    const fin = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      try {
        if (req) req.destroy();
      } catch {}
      fin({ code: 0, ms: Date.now() - t0, err: 'timeout' });
    }, timeoutMs);
    try {
      req = (useHttps ? https : http).request(
        { ...opts, method: 'GET', agent: false, headers: { ...(opts.headers || {}), 'User-Agent': UA, Connection: 'close', Accept: '*/*' } },
        (res) => {
          const ms = Date.now() - t0;
          const code = res.statusCode || 0;
          res.on('error', () => {});
          res.destroy();
          fin({ code, ms, err: '' });
        }
      );
      req.on('error', (e) => fin({ code: 0, ms: Date.now() - t0, err: (e && e.code) || 'error' }));
      req.end();
    } catch {
      fin({ code: 0, ms: 0, err: 'error' });
    }
  });
}

// deps: { ipcMain, getSettings(), saveSettings(), dataFile(), tr(bn,en), getSites(), getWeb(), nodeUp(domain), notify(title, body), send(channel, payload), status(msg) }
function init(deps) {
  let data = { samples: {}, events: [] }; // samples[key] = [[সেকেন্ড-টাইমস্ট্যাম্প, HTTP কোড (০ = সাড়া নেই), ms], ...]
  let dirty = false;
  const last = {}; // key -> { state: 'up'|'down'|'off', code, ms, ts, err }
  const alerts = {}; // key -> { fails, alerted, firstFail }
  let timer = null;
  let saveTimer = null;
  let probing = false;
  let stopped = false;

  // ---- সেটিং (settings.json-এর monitor অংশ) ----
  function cfg() {
    const s = deps.getSettings();
    const m = (s.monitor = s.monitor && typeof s.monitor === 'object' ? s.monitor : {});
    if (typeof m.enabled !== 'boolean') m.enabled = true;
    if (!INTERVALS.includes(m.intervalSec)) m.intervalSec = 60;
    if (!KEEP_DAYS.includes(m.keepDays)) m.keepDays = 7;
    if (typeof m.alerts !== 'boolean') m.alerts = true;
    const urls = [];
    for (const u of Array.isArray(m.urls) ? m.urls : []) {
      const n = normUrl(u);
      if (n && !urls.includes(n)) urls.push(n);
    }
    m.urls = urls.slice(0, MAX_URLS);
    return m;
  }

  // ---- ইতিহাস ফাইল ----
  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(deps.dataFile(), 'utf8'));
      if (j && typeof j.samples === 'object' && j.samples) {
        data = { samples: {}, events: Array.isArray(j.events) ? j.events : [] };
        for (const [k, v] of Object.entries(j.samples)) if (Array.isArray(v)) data.samples[k] = v.filter((x) => Array.isArray(x) && x.length === 3);
      }
    } catch {}
  }
  function prune() {
    const cutoffSec = Math.floor((Date.now() - cfg().keepDays * 86400000) / 1000);
    for (const k of Object.keys(data.samples)) {
      let a = data.samples[k].filter((x) => x[0] >= cutoffSec);
      if (a.length > MAX_SAMPLES) a = a.slice(-MAX_SAMPLES);
      if (a.length) data.samples[k] = a;
      else delete data.samples[k];
    }
    data.events = data.events.filter((e) => e && e.ts >= cutoffSec * 1000).slice(-MAX_EVENTS);
  }
  function save() {
    if (!dirty) return;
    try {
      const f = deps.dataFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      prune();
      const tmp = f + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, f);
      dirty = false;
    } catch {}
  }

  // ---- লক্ষ্যের তালিকা ----
  function targets() {
    const list = [];
    for (const s of deps.getSites()) list.push({ key: 'site:' + s.domain, kind: 'site', name: s.domain, domain: s.domain, node: !!s.node });
    for (const u of cfg().urls) list.push({ key: 'url:' + u, kind: 'url', name: urlName(u), url: u });
    return list;
  }

  // ---- একটা ফলাফল জমা + সতর্কবার্তা ----
  const whyText = (code, err) => {
    if (code >= 500) return 'HTTP ' + code;
    if (err && ERR_TEXT[err]) return deps.tr(ERR_TEXT[err][0], ERR_TEXT[err][1]);
    return err || 'error';
  };

  function record(tg, r) {
    const ok = r.code > 0 && r.code < 500;
    const ts = Date.now();
    last[tg.key] = { state: ok ? 'up' : 'down', code: r.code, ms: r.ms, ts, err: r.err || '' };
    (data.samples[tg.key] = data.samples[tg.key] || []).push([Math.round(ts / 1000), r.code, r.ms]);
    if (data.samples[tg.key].length > MAX_SAMPLES) data.samples[tg.key].splice(0, data.samples[tg.key].length - MAX_SAMPLES);
    dirty = true;

    const a = (alerts[tg.key] = alerts[tg.key] || { fails: 0, alerted: false, firstFail: 0 });
    if (ok) {
      if (a.alerted) {
        const mins = Math.max(1, Math.round((ts - a.firstFail) / 60000));
        data.events.push({ ts, key: tg.key, name: tg.name, type: 'up', mins });
        say(deps.tr(`✓ ${tg.name} আবার চালু (${mins} মিনিট বন্ধ ছিল)`, `✓ ${tg.name} is back up (was down for ${mins} min)`));
      }
      a.fails = 0;
      a.alerted = false;
      return;
    }
    if (a.fails === 0) a.firstFail = ts;
    a.fails++;
    if (a.fails >= FAILS_TO_ALERT && !a.alerted) {
      a.alerted = true;
      const why = whyText(r.code, r.err);
      data.events.push({ ts, key: tg.key, name: tg.name, type: 'down', why });
      say(deps.tr(`⚠ ${tg.name} সাড়া দিচ্ছে না (${why})`, `⚠ ${tg.name} is not responding (${why})`));
    }
  }
  // সতর্কবার্তা: "সতর্কবার্তা" সেটিং চালু থাকলে ট্রে/নোটিফিকেশন + স্ট্যাটাস লাইনে
  function say(msg) {
    if (!cfg().alerts) return;
    try {
      deps.notify('Server 360', msg);
    } catch {}
    try {
      deps.status(msg);
    } catch {}
  }
  // সার্ভার/অ্যাপ বন্ধ থাকা = ব্যর্থতা নয়: কোনো নমুনা জমা হয় না, সতর্কতাও না
  function markOff(tg) {
    last[tg.key] = { state: 'off', code: 0, ms: 0, ts: Date.now(), err: '' };
    alerts[tg.key] = { fails: 0, alerted: false, firstFail: 0 };
  }

  // ---- এক রাউন্ড পরীক্ষা (একসাথে ওভারল্যাপ করে না) ----
  async function round() {
    if (probing) return;
    probing = true;
    try {
      const web = deps.getWeb();
      const list = targets();
      const keys = new Set(list.map((t) => t.key));
      for (const k of Object.keys(last)) if (!keys.has(k)) delete last[k];
      for (const k of Object.keys(alerts)) if (!keys.has(k)) delete alerts[k];

      const jobs = [];
      for (const tg of list) {
        if (tg.kind === 'url') {
          const u = new URL(tg.url);
          jobs.push({ tg, run: () => probe({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search }, u.protocol === 'https:', URL_TIMEOUT) });
        } else if (!web || (tg.node && !deps.nodeUp(tg.domain))) {
          markOff(tg);
        } else {
          jobs.push({ tg, run: () => probe({ host: '127.0.0.1', port: web.port, path: '/', headers: { Host: tg.domain } }, false, SITE_TIMEOUT) });
        }
      }
      let i = 0;
      await Promise.all(
        Array.from({ length: Math.min(POOL, jobs.length) }, async () => {
          while (i < jobs.length) {
            const j = jobs[i++];
            record(j.tg, await j.run());
          }
        })
      );
    } finally {
      probing = false;
    }
    if (!stopped) {
      try {
        deps.send('monitor:update', null);
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
        await round();
      } catch {}
      schedule(cfg().intervalSec * 1000);
    }, ms);
  }

  // ---- UI-র জন্য তথ্য ----
  function get() {
    const m = cfg();
    const sinceSec = Math.floor((Date.now() - 86400000) / 1000);
    const out = targets().map((tg) => {
      const l = last[tg.key] || { state: 'wait', code: 0, ms: 0, ts: 0, err: '' };
      const arr = (data.samples[tg.key] || []).filter((x) => x[0] >= sinceSec);
      const oks = arr.filter((x) => x[1] > 0 && x[1] < 500);
      return {
        key: tg.key,
        kind: tg.kind,
        name: tg.name,
        url: tg.url || '',
        node: !!tg.node,
        state: l.state,
        code: l.code,
        ms: l.ms,
        ts: l.ts,
        err: l.err,
        n24: arr.length,
        up24: arr.length ? Math.round((oks.length / arr.length) * 1000) / 10 : null,
        avg24: oks.length ? Math.round(oks.reduce((s, x) => s + x[2], 0) / oks.length) : null,
      };
    });
    return {
      cfg: { enabled: m.enabled, intervalSec: m.intervalSec, keepDays: m.keepDays, alerts: m.alerts },
      web: !!deps.getWeb(),
      targets: out,
      events: data.events.slice(-10).reverse(),
    };
  }

  // গ্রাফের জন্য: সর্বোচ্চ ~১২০টা ঝুড়িতে ভাগ করা (প্রতি ঝুড়িতে গড় ms ও ব্যর্থতার সংখ্যা)
  function history(key, hours) {
    const h = Math.min(Math.max(Number(hours) || 1, 1), 720);
    const to = Date.now();
    const from = to - h * 3600000;
    const bucketMs = Math.max(30000, Math.ceil((h * 3600000) / 120));
    const map = new Map();
    for (const [tsSec, code, ms] of data.samples[String(key)] || []) {
      const t = tsSec * 1000;
      if (t < from) continue;
      const b = Math.floor((t - from) / bucketMs);
      const e = map.get(b) || { t: from + b * bucketMs, sum: 0, okN: 0, fail: 0, n: 0 };
      e.n++;
      if (code > 0 && code < 500) {
        e.sum += ms;
        e.okN++;
      } else e.fail++;
      map.set(b, e);
    }
    const buckets = [...map.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([, e]) => ({ t: e.t, ms: e.okN ? Math.round(e.sum / e.okN) : null, fail: e.fail, n: e.n }));
    return { from, to, bucketMs, buckets };
  }

  // ---- IPC ----
  const { ipcMain } = deps;
  ipcMain.handle('monitor:get', () => get());
  ipcMain.handle('monitor:history', (_e, key, hours) => history(key, hours));
  ipcMain.handle('monitor:probeNow', async () => {
    await round();
    return get();
  });
  ipcMain.handle('monitor:setConfig', (_e, c) => {
    c = c || {};
    const m = cfg();
    if (typeof c.enabled === 'boolean') m.enabled = c.enabled;
    if (INTERVALS.includes(Number(c.intervalSec))) m.intervalSec = Number(c.intervalSec);
    if (KEEP_DAYS.includes(Number(c.keepDays))) m.keepDays = Number(c.keepDays);
    if (typeof c.alerts === 'boolean') m.alerts = c.alerts;
    deps.saveSettings();
    prune();
    dirty = true;
    schedule(m.enabled ? 1000 : 0);
    return get();
  });
  ipcMain.handle('monitor:addUrl', (_e, raw) => {
    const n = normUrl(raw);
    if (!n) return { ok: false, reason: 'bad' };
    const m = cfg();
    if (m.urls.includes(n)) return { ok: false, reason: 'dup' };
    if (m.urls.length >= MAX_URLS) return { ok: false, reason: 'max' };
    m.urls.push(n);
    deps.saveSettings();
    schedule(500);
    return { ok: true, data: get() };
  });
  ipcMain.handle('monitor:removeUrl', (_e, raw) => {
    const m = cfg();
    const n = normUrl(raw);
    m.urls = m.urls.filter((u) => u !== n);
    deps.saveSettings();
    delete data.samples['url:' + n];
    delete last['url:' + n];
    delete alerts['url:' + n];
    dirty = true;
    return get();
  });

  load();
  saveTimer = setInterval(save, SAVE_EVERY_MS);
  if (saveTimer.unref) saveTimer.unref();
  schedule(5000); // অ্যাপ খোলার ৫ সেকেন্ড পর প্রথম পরীক্ষা

  return {
    round,
    get,
    history,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      clearInterval(saveTimer);
      save();
    },
  };
}

module.exports = { init, normUrl, ERR_TEXT };
