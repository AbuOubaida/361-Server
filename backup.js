'use strict';
// Server 360 - Backup backend (step 1).
// Electron-এর উপর নির্ভর করে না: main.js এখান থেকে createBackup(ctx) নিয়ে সব কিছু ctx দিয়ে জোগান দেয়।
// প্রযুক্তি: ডাটাবেস সবসময় dump (লাইভ data ফোল্ডার কপি নয়), আগে লোকাল tmp-এ প্যাক, তারপর গন্তব্যে কপি (.part ফোল্ডার -> rename),
// তাই নেটওয়ার্ক ভাঙলে আধা-ফাইল পড়ে থাকে না।
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const STAMP_RE = /^\d{8}-\d{6}$/;
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dayOf = (d = new Date()) => stampOf(d).slice(0, 8);

const SYSTEM_MYSQL_DBS = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);
const WWW_EXCLUDES = ['node_modules', '.git'];

function run(exe, args, opts = {}) {
  return new Promise((resolve) => {
    const ch = execFile(
      exe,
      args,
      {
        windowsHide: true,
        maxBuffer: 50 * 1024 * 1024,
        timeout: opts.timeout || 6 * 3600 * 1000,
        env: opts.env || process.env,
        cwd: opts.cwd,
        windowsVerbatimArguments: !!opts.verbatim,
      },
      (err, stdout, stderr) =>
        resolve({ ok: !err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
    // stdin বন্ধ: কোনো প্রোগ্রাম প্রশ্ন করে বসে থাকলে (ঝুলে যাওয়া) সেটা সাথে সাথে ব্যর্থ হবে
    if (ch.stdin) ch.stdin.end();
    if (opts.onData && ch.stdout) ch.stdout.on('data', (d) => opts.onData(String(d)));
  });
}

function createBackup(ctx) {
  const tr = ctx.tr || ((bn, en) => en);
  const win = process.platform === 'win32';

  // ---------- ফোল্ডার ----------
  const baseDir = () => path.join(ctx.rootDir(), 'backup');
  const logsDir = () => path.join(baseDir(), 'logs');
  const tmpRoot = () => path.join(baseDir(), 'tmp');
  const lockFile = () => path.join(baseDir(), 'backup.lock');
  const statusFile = () => path.join(baseDir(), 'LAST_STATUS.json');
  const sevenDir = () => path.join(ctx.toolsDir(), '7zip');

  // ---------- কনফিগ ----------
  // settings.backup = { local:{enabled,dir}, share:{enabled,unc,user,subdir}, times:['02:00'], what:{mysql,postgres,www,certs,extra:[]}, retentionDays, minFreeGb, appEnabled }
  // পাসওয়ার্ড settings.backupSecrets = { zip, share } (ctx.secret.enc দিয়ে মোড়া), কখনো UI-তে ফেরত যায় না।
  const DEFAULTS = {
    local: { enabled: false, dir: '' },
    share: { enabled: false, unc: '', user: '', subdir: '' },
    times: ['02:00'],
    what: { mysql: true, postgres: true, www: true, certs: true, extra: [] },
    retentionDays: 14,
    minFreeGb: 0,
    appEnabled: true,
  };

  function normTimes(list) {
    const out = [];
    for (const t of Array.isArray(list) ? list : []) {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
      if (!m) continue;
      const h = Number(m[1]);
      const mi = Number(m[2]);
      if (h > 23 || mi > 59) continue;
      const s = `${pad(h)}:${pad(mi)}`;
      if (!out.includes(s)) out.push(s);
    }
    return out.sort();
  }

  function getConfig() {
    const s = ctx.settings();
    const c = s.backup || {};
    const sec = s.backupSecrets || {};
    return {
      local: { ...DEFAULTS.local, ...(c.local || {}) },
      share: { ...DEFAULTS.share, ...(c.share || {}) },
      times: normTimes(c.times && c.times.length ? c.times : DEFAULTS.times),
      what: { ...DEFAULTS.what, ...(c.what || {}), extra: Array.isArray(c.what && c.what.extra) ? c.what.extra.filter((x) => x && x.path).slice(0, 20) : [] },
      retentionDays: Number.isInteger(c.retentionDays) && c.retentionDays >= 0 ? c.retentionDays : DEFAULTS.retentionDays,
      minFreeGb: Number(c.minFreeGb) >= 0 ? Number(c.minFreeGb) : 0,
      appEnabled: c.appEnabled !== false,
      hasZipPassword: !!sec.zip,
      hasSharePassword: !!sec.share,
    };
  }

  // secrets: undefined = বদলাবে না, '' = মুছবে, 'text' = নতুন
  function setConfig(cfg, secrets = {}) {
    const s = ctx.settings();
    const cur = getConfig();
    const next = {
      local: { enabled: !!(cfg.local && cfg.local.enabled), dir: String((cfg.local && cfg.local.dir) || '').trim() },
      share: {
        enabled: !!(cfg.share && cfg.share.enabled),
        unc: String((cfg.share && cfg.share.unc) || '').trim(),
        user: String((cfg.share && cfg.share.user) || '').trim(),
        subdir: String((cfg.share && cfg.share.subdir) || '').trim().replace(/^[\\/]+|[\\/]+$/g, ''),
      },
      times: normTimes(cfg.times || cur.times),
      what: {
        mysql: !!(cfg.what ? cfg.what.mysql : cur.what.mysql),
        postgres: !!(cfg.what ? cfg.what.postgres : cur.what.postgres),
        www: !!(cfg.what ? cfg.what.www : cur.what.www),
        certs: !!(cfg.what ? cfg.what.certs : cur.what.certs),
        extra: ((cfg.what && cfg.what.extra) || cur.what.extra).filter((x) => x && x.path).map((x) => ({ path: String(x.path), label: String(x.label || path.basename(String(x.path))) })).slice(0, 20),
      },
      retentionDays: Number.isInteger(cfg.retentionDays) && cfg.retentionDays >= 0 ? cfg.retentionDays : cur.retentionDays,
      minFreeGb: Number(cfg.minFreeGb) >= 0 ? Number(cfg.minFreeGb) : cur.minFreeGb,
      appEnabled: cfg.appEnabled !== false,
    };
    const sec = { ...(s.backupSecrets || {}) };
    if (secrets.zip !== undefined) {
      if (secrets.zip) sec.zip = ctx.secret.enc(String(secrets.zip));
      else delete sec.zip;
    }
    if (secrets.share !== undefined) {
      if (secrets.share) sec.share = ctx.secret.enc(String(secrets.share));
      else delete sec.share;
    }
    s.backup = next;
    s.backupSecrets = sec;
    ctx.save(s);
    return getConfig();
  }

  const zipPassword = () => {
    const v = (ctx.settings().backupSecrets || {}).zip;
    return v ? ctx.secret.dec(v) : '';
  };
  const sharePassword = () => {
    const v = (ctx.settings().backupSecrets || {}).share;
    return v ? ctx.secret.dec(v) : '';
  };

  // ---------- লগ ----------
  let logPath = '';
  function log(line) {
    const n = new Date();
    const msg = `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())} ${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}  ${line}`;
    try {
      fs.mkdirSync(logsDir(), { recursive: true });
      if (!logPath) logPath = path.join(logsDir(), `backup_${dayOf()}.log`);
      fs.appendFileSync(logPath, msg + '\n');
    } catch {}
    if (ctx.onLog) ctx.onLog(msg);
  }
  function pruneLogs() {
    try {
      const limit = Date.now() - 60 * 86400000;
      for (const f of fs.readdirSync(logsDir())) {
        if (!/^backup_\d{8}\.log$/.test(f)) continue;
        const p = path.join(logsDir(), f);
        if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { force: true });
      }
    } catch {}
  }
  function lastStatus() {
    try {
      return JSON.parse(fs.readFileSync(statusFile(), 'utf8'));
    } catch {
      return null;
    }
  }
  function tailLog(lines = 60) {
    try {
      const files = fs.readdirSync(logsDir()).filter((f) => /^backup_\d{8}\.log$/.test(f)).sort();
      if (!files.length) return '';
      const text = fs.readFileSync(path.join(logsDir(), files[files.length - 1]), 'utf8');
      return text.split(/\r?\n/).slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  // ---------- 7-Zip ----------
  function find7z() {
    const cands = [
      path.join(sevenDir(), '7z.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
    ];
    return cands.find((p) => fs.existsSync(p)) || '';
  }

  // installer .exe নামিয়ে চুপচাপ (/S) আমাদের tools\7zip-এ বসানো (admin লাগে না)। /D= শেষে থাকতে হবে, কোটেশন ছাড়া।
  async function ensure7z() {
    if (find7z()) return { ok: true, fresh: false, exe: find7z() };
    if (!ctx.sevenZipUrl) return { ok: false, message: '7-Zip URL not configured' };
    fs.mkdirSync(ctx.toolsDir(), { recursive: true });
    const setup = path.join(ctx.toolsDir(), '7z-setup.exe');
    await ctx.download(ctx.sevenZipUrl, setup, '7-Zip');
    fs.mkdirSync(sevenDir(), { recursive: true });
    const r = await run(setup, ['/S', `/D=${sevenDir()}`], { verbatim: true, timeout: 120000 });
    try {
      fs.rmSync(setup, { force: true });
    } catch {}
    const exe = find7z();
    if (!exe) return { ok: false, message: tr('7-Zip ইনস্টল হয়নি (7z.exe পাওয়া যায়নি)', '7-Zip install failed (7z.exe not found)') + (r.stderr ? ': ' + r.stderr.slice(0, 120) : '') };
    return { ok: true, fresh: true, exe };
  }

  // ---------- আর্কাইভ ----------
  // 7z -bsp1 stdout-এ শতকরা হিসাব দেয়; শেষটা স্ট্যাটাস বারে পাঠানো (প্রায় প্রতি সেকেন্ডে একবার)
  const pct = (outBase) => {
    let last = 0;
    return (chunk) => {
      const m = chunk.match(/(\d{1,3})%/g);
      if (!m || Date.now() - last < 1000) return;
      last = Date.now();
      if (ctx.onProgress) ctx.onProgress(`Pack ${path.basename(outBase)} ${m[m.length - 1]}`);
    };
  };

  // password থাকলে .7z (AES-256, ফাইলের নামও লুকানো) এবং পরীক্ষা করে নেওয়া; না থাকলে 7-Zip থাকলে .zip, নাহলে tar.exe দিয়ে .zip
  async function makeArchive(outBase, srcDir, excludes, password) {
    const parent = path.dirname(srcDir);
    const name = path.basename(srcDir);
    const sevenZ = find7z();
    if (password) {
      if (!sevenZ) return { ok: false, message: 'password set but 7-Zip is missing' };
      const out = outBase + '.7z';
      const args = ['a', '-t7z', '-mx=3', '-mhe=on', '-bsp1', '-p' + password, '-y', out, name, ...excludes.map((x) => '-xr!' + x)];
      const r = await run(sevenZ, args, { cwd: parent, onData: pct(outBase) });
      if (!r.ok || !fs.existsSync(out)) return { ok: false, message: (`7z failed (exit code ${r.code}): ` + (r.stdout + r.stderr).trim().slice(-300)) };
      const t = await run(sevenZ, ['t', '-p' + password, out], {});
      if (!t.ok) return { ok: false, message: '7z test failed: ' + (t.stdout + t.stderr).slice(-300) };
      return { ok: true, file: out };
    }
    const out = outBase + '.zip';
    if (sevenZ) {
      const r = await run(sevenZ, ['a', '-tzip', '-mx=3', '-bsp1', '-y', out, name, ...excludes.map((x) => '-xr!' + x)], { cwd: parent, onData: pct(outBase) });
      if (!r.ok || !fs.existsSync(out)) return { ok: false, message: (`7z failed (exit code ${r.code}): ` + (r.stdout + r.stderr).trim().slice(-300)) };
      return { ok: true, file: out };
    }
    const tarExe = ctx.tarExe || (win ? 'tar.exe' : 'tar');
    const r = await run(tarExe, ['-a', '-c', '-f', out, ...excludes.flatMap((x) => ['--exclude', x]), '-C', parent, name], {});
    if (!r.ok || !fs.existsSync(out)) return { ok: false, message: ('tar failed: ' + r.stderr).slice(0, 400) };
    return { ok: true, file: out };
  }

  // ---------- ডাটাবেস dump ----------
  async function dumpMysql(dir) {
    const bin = path.join(ctx.mysqlDir(), 'bin');
    const mysqlExe = path.join(bin, 'mysql.exe');
    const dumpExe = path.join(bin, 'mysqldump.exe');
    if (!fs.existsSync(mysqlExe) || !fs.existsSync(dumpExe)) return { skipped: 'MySQL not installed' };
    const common = ['--no-defaults', '-u', 'root', '-h', '127.0.0.1', '-P', String(ctx.mysqlPort())];
    const env = ctx.mysqlEnv();
    const list = await run(mysqlExe, [...common, '-N', '-B', '-e', 'SHOW DATABASES'], { env, timeout: 60000 });
    if (!list.ok) return { skipped: 'MySQL not running or login failed: ' + (list.stderr || '').trim().slice(0, 150) };
    const dbs = list.stdout.split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !SYSTEM_MYSQL_DBS.has(x.toLowerCase()));
    if (!dbs.length) return { skipped: 'no user databases' };
    const file = path.join(dir, 'mysql.sql');
    const r = await run(
      dumpExe,
      [...common, '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--default-character-set=utf8mb4', '--databases', ...dbs, '--result-file=' + file],
      { env }
    );
    if (!r.ok) return { ok: false, message: 'mysqldump failed: ' + (r.stderr || '').trim().slice(0, 300) };
    return { ok: true, dbs };
  }

  async function dumpPostgres(dir) {
    const bin = path.join(ctx.pgDir(), 'bin');
    const dumpAll = path.join(bin, 'pg_dumpall.exe');
    if (!fs.existsSync(dumpAll)) return { skipped: 'PostgreSQL not installed' };
    const file = path.join(dir, 'postgres.sql');
    const r = await run(dumpAll, ['-h', '127.0.0.1', '-p', String(ctx.pgPort()), '-U', 'postgres', '-w', '-f', file], { env: ctx.pgEnv(), timeout: 3600000 });
    if (!r.ok) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
      const m = (r.stderr || '').trim();
      if (/could not connect|connection refused|timeout expired/i.test(m)) return { skipped: 'PostgreSQL not running' };
      return { ok: false, message: 'pg_dumpall failed: ' + m.slice(0, 300) };
    }
    return { ok: true };
  }

  // ---------- গন্তব্য ----------
  function dirSize(p) {
    let total = 0;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const f = path.join(p, e.name);
      total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
    }
    return total;
  }

  function freeBytes(p) {
    try {
      const s = fs.statfsSync(p);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null; // অজানা = পরীক্ষা হবে না
    }
  }

  function destinations(cfg) {
    const list = [];
    if (cfg.local.enabled && cfg.local.dir) list.push({ kind: 'local', root: cfg.local.dir });
    if (cfg.share.enabled && cfg.share.unc) list.push({ kind: 'share', unc: cfg.share.unc.replace(/[\\/]+$/, ''), root: path.join(cfg.share.unc.replace(/[\\/]+$/, ''), cfg.share.subdir || '') });
    return list;
  }

  async function connectShare(d, cfg) {
    if (!win || !cfg.share.user) return { ok: true, connected: false };
    const r = await run('net', ['use', d.unc, sharePassword(), '/user:' + cfg.share.user, '/persistent:no'], { timeout: 60000 });
    if (!r.ok) return { ok: false, message: ('net use failed: ' + (r.stdout + r.stderr)).trim().slice(0, 250) };
    return { ok: true, connected: true };
  }

  function applyRetention(root, days) {
    if (!days) return 0;
    let removed = 0;
    const limit = Date.now() - days * 86400000;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (!e.isDirectory() || !STAMP_RE.test(e.name)) continue;
      const y = Number(e.name.slice(0, 4));
      const mo = Number(e.name.slice(4, 6)) - 1;
      const d = Number(e.name.slice(6, 8));
      if (new Date(y, mo, d).getTime() < limit) {
        fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  // ---------- মূল রান ----------
  let running = false;
  const isRunning = () => running;

  async function runBackup(opts = {}) {
    if (running) return { ok: false, busy: true, message: tr('Backup আগে থেকেই চলছে', 'A backup is already running') };
    const cfg = getConfig();
    const dests = destinations(cfg);
    if (!dests.length) return { ok: false, message: tr('কোনো গন্তব্য চালু করা নেই (Local বা Network share)', 'No destination is enabled (Local or Network share)') };

    fs.mkdirSync(baseDir(), { recursive: true });
    // লক ফাইল: ১ দিনের পুরনো হলে বাসি ধরে মুছে ফেলা
    try {
      if (fs.existsSync(lockFile()) && Date.now() - fs.statSync(lockFile()).mtimeMs > 86400000) fs.rmSync(lockFile(), { force: true });
      fs.closeSync(fs.openSync(lockFile(), 'wx'));
    } catch {
      return { ok: false, busy: true, message: tr('অন্য একটা backup চলছে (lock ফাইল আছে)', 'Another backup is running (lock file exists)') };
    }
    running = true;
    logPath = '';
    const started = new Date();
    const stamp = stampOf(started);
    const steps = [];
    const step = (name, ok, msg = '') => {
      steps.push({ name, ok, msg });
      log(`[${ok === 'skip' ? 'SKIP' : ok ? 'OK' : 'FAIL'}] ${name}${msg ? ' - ' + msg : ''}`);
      if (ctx.onProgress) ctx.onProgress(name);
    };
    const tmp = path.join(tmpRoot(), stamp);
    const connected = [];
    let failed = false;

    try {
      log(`=== Backup ${stamp} start (${opts.source || 'manual'}) ===`);
      const password = zipPassword();
      if (password) {
        const z = await ensure7z().catch((e) => ({ ok: false, message: e.message }));
        if (!z.ok) {
          step('7-Zip', false, z.message);
          throw new Error(tr('পাসওয়ার্ড দেওয়া আছে কিন্তু 7-Zip নেই; encrypted backup ছাড়া চালানো হয় না', 'A password is set but 7-Zip is missing; refusing to write an unencrypted backup'));
        }
      }
      fs.mkdirSync(tmp, { recursive: true });
      const packDir = path.join(tmp, 'out');
      fs.mkdirSync(packDir, { recursive: true });
      const manifest = { app: 'Server 360', stamp, created: started.toISOString(), encrypted: !!password, files: [], mysqlDbs: [], postgres: false, sites: [] };

      // ১) ডাটাবেস
      const dumpDir = path.join(tmp, 'db');
      fs.mkdirSync(dumpDir, { recursive: true });
      let anyDump = false;
      if (cfg.what.mysql) {
        const r = await dumpMysql(dumpDir);
        if (r.skipped) step('MySQL dump', 'skip', r.skipped);
        else if (!r.ok) { step('MySQL dump', false, r.message); failed = true; }
        else { step('MySQL dump', true, r.dbs.join(', ')); manifest.mysqlDbs = r.dbs; anyDump = true; }
      }
      if (cfg.what.postgres) {
        const r = await dumpPostgres(dumpDir);
        if (r.skipped) step('PostgreSQL dump', 'skip', r.skipped);
        else if (!r.ok) { step('PostgreSQL dump', false, r.message); failed = true; }
        else { step('PostgreSQL dump', true); manifest.postgres = true; anyDump = true; }
      }
      if (anyDump) {
        const a = await makeArchive(path.join(packDir, 'database'), dumpDir, [], password);
        if (a.ok) { step('Pack database', true, path.basename(a.file)); manifest.files.push(path.basename(a.file)); }
        else { step('Pack database', false, a.message); failed = true; }
      }

      // ২) www সাইট
      if (cfg.what.www) {
        const www = ctx.wwwDir();
        if (www && fs.existsSync(www)) {
          manifest.sites = fs.readdirSync(www, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
          const a = await makeArchive(path.join(packDir, 'www'), www, WWW_EXCLUDES, password);
          if (a.ok) { step('Pack www', true, path.basename(a.file)); manifest.files.push(path.basename(a.file)); }
          else { step('Pack www', false, a.message); failed = true; }
        } else step('Pack www', 'skip', 'www folder not found');
      }

      // ৩) সার্টিফিকেট ও সেটিংস (প্রাইভেট কী ও পাসওয়ার্ড থাকে, তাই শুধু encrypted হলে)
      if (cfg.what.certs) {
        if (!password) {
          step('Certificates + settings', 'skip', 'only backed up when a password is set (contains private keys and passwords)');
        } else {
          const sec = path.join(tmp, 'secrets');
          fs.mkdirSync(sec, { recursive: true });
          const certs = ctx.certsDir();
          if (certs && fs.existsSync(certs)) fs.cpSync(certs, path.join(sec, 'certs'), { recursive: true });
          if (fs.existsSync(ctx.settingsPath())) fs.copyFileSync(ctx.settingsPath(), path.join(sec, 'settings.json'));
          const a = await makeArchive(path.join(packDir, 'settings'), sec, [], password);
          if (a.ok) { step('Pack certificates + settings', true, path.basename(a.file)); manifest.files.push(path.basename(a.file)); }
          else { step('Pack certificates + settings', false, a.message); failed = true; }
        }
      }

      // ৪) নিজের বাড়তি ফোল্ডার
      let ex = 0;
      for (const item of cfg.what.extra) {
        ex++;
        if (!fs.existsSync(item.path)) { step('Extra: ' + item.label, 'skip', 'folder not found'); continue; }
        const a = await makeArchive(path.join(packDir, 'extra-' + ex), item.path, [], password);
        if (a.ok) { step('Pack extra: ' + item.label, true, path.basename(a.file)); manifest.files.push(path.basename(a.file)); manifest['extra' + ex] = item.label; }
        else { step('Pack extra: ' + item.label, false, a.message); failed = true; }
      }

      if (!manifest.files.length) throw new Error(tr('backup করার মতো কিছু তৈরি হয়নি', 'Nothing was produced to back up'));
      manifest.complete = !failed; // false = some step failed, this folder is a partial backup
      manifest.failedSteps = steps.filter((x) => x.ok === false).map((x) => x.name);
      fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // ৫) গন্তব্যে নেওয়া
      const need = dirSize(packDir);
      let okDest = 0;
      for (const d of dests) {
        const label = d.kind === 'local' ? 'Local' : 'Network share';
        try {
          if (d.kind === 'share') {
            const c = await connectShare(d, cfg);
            if (!c.ok) throw new Error(c.message);
            if (c.connected) connected.push(d);
          }
          fs.mkdirSync(d.root, { recursive: true });
          const free = freeBytes(d.root);
          if (free !== null && free < need + cfg.minFreeGb * 1073741824) throw new Error(`not enough free space (${Math.round(free / 1048576)} MB free, ${Math.round(need / 1048576)} MB needed)`);
          const part = path.join(d.root, stamp + '.part');
          fs.rmSync(part, { recursive: true, force: true });
          fs.mkdirSync(part, { recursive: true });
          for (const f of fs.readdirSync(packDir)) fs.copyFileSync(path.join(packDir, f), path.join(part, f));
          fs.renameSync(part, path.join(d.root, stamp));
          step('Copy to ' + label, true, d.root);
          okDest++;
          try {
            const n = applyRetention(d.root, cfg.retentionDays);
            if (n) step('Retention ' + label, true, `${n} old backup(s) removed`);
          } catch (e) {
            step('Retention ' + label, false, e.message);
          }
        } catch (e) {
          step('Copy to ' + label, false, e.message);
          failed = true;
        }
      }
      if (!okDest) throw new Error(tr('কোনো গন্তব্যে কপি হয়নি', 'Could not copy to any destination'));
    } catch (e) {
      failed = true;
      log('ERROR ' + e.message);
      steps.push({ name: 'Error', ok: false, msg: e.message });
    } finally {
      for (const d of connected) await run('net', ['use', d.unc, '/delete', '/y'], { timeout: 30000 });
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
      try {
        fs.rmSync(lockFile(), { force: true });
      } catch {}
      running = false;
    }

    const status = { ok: !failed, stamp, started: started.toISOString(), finished: new Date().toISOString(), source: opts.source || 'manual', steps };
    try {
      fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2));
    } catch {}
    log(`=== Backup ${stamp} ${failed ? 'FAILED' : 'OK'} ===`);
    if (failed && win) {
      const last = steps.filter((s) => s.ok === false).map((s) => s.name + ': ' + s.msg).join(' | ').slice(0, 800);
      run('eventcreate', ['/T', 'ERROR', '/ID', '100', '/L', 'APPLICATION', '/SO', 'Server 360 Backup', '/D', last || 'Backup failed'], { timeout: 15000 });
    }
    pruneLogs();
    return { ok: !failed, status, message: failed ? tr('Backup-এ সমস্যা হয়েছে, log দেখুন', 'Backup finished with errors, see the log') : tr('Backup সম্পূর্ণ', 'Backup completed') };
  }

  return { getConfig, setConfig, runBackup, isRunning, lastStatus, tailLog, find7z, ensure7z, dirs: { baseDir, logsDir } };
}

module.exports = { createBackup, stampOf, STAMP_RE };
