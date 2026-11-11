'use strict';
// Server 360 - Backup backend (step 1).
// Electron-এর উপর নির্ভর করে না: main.js এখান থেকে createBackup(ctx) নিয়ে সব কিছু ctx দিয়ে জোগান দেয়।
// প্রযুক্তি: ডাটাবেস সবসময় dump (লাইভ data ফোল্ডার কপি নয়), আগে লোকাল tmp-এ প্যাক, তারপর গন্তব্যে কপি (.part ফোল্ডার -> rename),
// তাই নেটওয়ার্ক ভাঙলে আধা-ফাইল পড়ে থাকে না।
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const net = require('net');

const STAMP_RE = /^\d{8}-\d{6}$/;
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dayOf = (d = new Date()) => stampOf(d).slice(0, 8);

const SYSTEM_MYSQL_DBS = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);
// www আর্কাইভে বাদ: নির্ভরতা/বিল্ড-ক্যাশ যা আবার তৈরি করা যায় (npm install, build) এবং Laravel লগ/ক্যাশ/সেশন/কম্পাইল-করা view।
// vendor ইচ্ছে করে বাদ দেওয়া হয়নি (composer অফলাইনে না-ও চলতে পারে)। path-সহ প্যাটার্ন (storage\\logs) 7-Zip-এর -xr! দিয়ে মেলে।
const WWW_EXCLUDES = ['node_modules', '.git', '.next', 'storage\\logs', 'storage\\framework\\cache', 'storage\\framework\\sessions', 'storage\\framework\\views'];

// ---- পুরনো version রাখা (copy ফোল্ডার, ঐচ্ছিক) ----
// robocopy বদলানো ফাইল ওভাররাইট করে, তাই কপির আগে Node-এ তুলনা করে (size বা mtime আলাদা, 2 সেকেন্ড সহনশীলতা - robocopy-র মতোই)
// যে ফাইলগুলো ওভাররাইট হবে তাদের পুরনোটা <dst>\.versions\<stamp>\<relative path>-এ সরিয়ে রাখি (একই ড্রাইভে rename, সস্তা)।
const VERSIONS_DIR = '.versions';
function moveToVersions(dst, rel, vdir) {
  const from = path.join(dst, rel);
  const to = path.join(vdir, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
    fs.rmSync(from, { force: true });
  }
}
async function snapshotChanged(src, dst, vdir) {
  const fsp = fs.promises;
  const res = { kept: 0, checked: 0, errors: 0, sample: [] };
  const walk = async (rel) => {
    let ents;
    try {
      ents = await fsp.readdir(path.join(src, rel), { withFileTypes: true });
    } catch {
      res.errors++;
      return;
    }
    const jobs = [];
    for (const e of ents) {
      const r = rel ? rel + path.sep + e.name : e.name;
      if (e.isSymbolicLink()) continue; // robocopy /XJ-এর মতো junction/symlink এড়াই
      if (e.isDirectory()) {
        await walk(r);
      } else if (e.isFile()) {
        jobs.push(r);
      }
    }
    for (let i = 0; i < jobs.length; i += 64) {
      await Promise.all(
        jobs.slice(i, i + 64).map(async (r) => {
          res.checked++;
          try {
            const [a, b] = await Promise.all([fsp.lstat(path.join(src, r)), fsp.lstat(path.join(dst, r)).catch((e) => (e.code === 'ENOENT' || e.code === 'ENOTDIR' ? null : Promise.reject(e)))]);
            if (!b || !b.isFile()) return; // নতুন ফাইল: রাখার মতো পুরনো কিছু নেই
            if (a.size !== b.size || Math.abs(a.mtimeMs - b.mtimeMs) > 2000) {
              moveToVersions(dst, r, vdir);
              res.kept++;
              if (res.sample.length < 3) res.sample.push(r);
            }
          } catch {
            res.errors++;
          }
        })
      );
    }
  };
  await walk('');
  return res;
}
// .versions\<stamp> ফোল্ডার N দিনের পুরনো হলে মোছা (দিন ধরে, applyRetention-এর মতো)
function pruneVersions(dst, days) {
  const root = path.join(dst, VERSIONS_DIR);
  let removed = 0;
  if (!(days > 0) || !fs.existsSync(root)) return removed;
  const limit = Date.now() - days * 86400000;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !STAMP_RE.test(e.name)) continue;
    const d = new Date(Number(e.name.slice(0, 4)), Number(e.name.slice(4, 6)) - 1, Number(e.name.slice(6, 8))).getTime();
    if (d < limit) {
      fs.rmSync(path.join(root, e.name), { recursive: true, force: true });
      removed++;
    }
  }
  if (!fs.readdirSync(root).length) fs.rmdirSync(root);
  return removed;
}

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
    what: { mysql: true, postgres: true, www: true, certs: true, extra: [], wwwExclude: [] },
    retentionDays: 14,
    minFreeGb: 0,
    appEnabled: true,
    autoStartDb: true,
  };

  // www-র ভেতরের বাদ দেওয়ার পথ: সবসময় www-এর সাপেক্ষে, ব্যাকস্ল্যাশে, ".." বা বাইরের পথ বাদ।
  // (সম্পূর্ণ পথ www-এর ভেতরের হলে সেটাকে ছোট করে নেওয়া হয়)
  function normRel(p) {
    let v = String(p || '').trim().replace(/\//g, '\\');
    const www = (ctx.wwwDir && ctx.wwwDir()) || '';
    if (www) {
      const w = String(www).replace(/\//g, '\\').replace(/\\+$/, '');
      if (v.toLowerCase() === w.toLowerCase()) return '';
      if (v.toLowerCase().startsWith(w.toLowerCase() + '\\')) v = v.slice(w.length + 1);
    }
    if (/^[a-zA-Z]:/.test(v) || v.startsWith('\\\\')) return ''; // www-র বাইরের পূর্ণ পথ
    v = v.replace(/^\\+|\\+$/g, '');
    if (!v || v.split('\\').some((x) => x === '..' || x === '.' || x === '')) return '';
    if (/[*?"<>|]/.test(v)) return '';
    return v;
  }
  function normWwwExclude(list) {
    const out = [];
    for (const x of Array.isArray(list) ? list : []) {
      const r = normRel(x);
      if (r && !out.some((y) => y.toLowerCase() === r.toLowerCase())) out.push(r);
    }
    return out.slice(0, 50);
  }
  // নিজের ফোল্ডার: mode 'archive' (7z, এনক্রিপ্ট হতে পারে) বা 'copy' (robocopy-র মতো incremental, প্লেইন ফাইল)
  const normExtra = (list) =>
    (Array.isArray(list) ? list : [])
      .filter((x) => x && x.path)
      .map((x) => {
        const mode = x.mode === 'copy' ? 'copy' : 'archive';
        const cd = parseInt(x.cleanDays, 10);
        const kd = parseInt(x.keepDays, 10);
        return { path: String(x.path), label: String(x.label || path.basename(String(x.path))), mode, cleanDays: mode === 'copy' && cd > 0 ? Math.min(cd, 3650) : 0, keepDays: mode === 'copy' && kd > 0 ? Math.min(kd, 3650) : 0 };
      })
      .slice(0, 20);

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
      what: { ...DEFAULTS.what, ...(c.what || {}), extra: normExtra(c.what && c.what.extra), wwwExclude: normWwwExclude(c.what && c.what.wwwExclude) },
      retentionDays: Number.isInteger(c.retentionDays) && c.retentionDays >= 0 ? c.retentionDays : DEFAULTS.retentionDays,
      minFreeGb: Number(c.minFreeGb) >= 0 ? Number(c.minFreeGb) : 0,
      appEnabled: c.appEnabled !== false,
      autoStartDb: c.autoStartDb !== false,
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
        extra: normExtra((cfg.what && cfg.what.extra) || cur.what.extra),
        wwwExclude: normWwwExclude(cfg.what && cfg.what.wwwExclude !== undefined ? cfg.what.wwwExclude : cur.what.wwwExclude),
      },
      retentionDays: Number.isInteger(cfg.retentionDays) && cfg.retentionDays >= 0 ? cfg.retentionDays : cur.retentionDays,
      minFreeGb: Number(cfg.minFreeGb) >= 0 ? Number(cfg.minFreeGb) : cur.minFreeGb,
      appEnabled: cfg.appEnabled !== false,
      autoStartDb: cfg.autoStartDb !== false,
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
    let logged = -20;
    return (chunk) => {
      const m = chunk.match(/(\d{1,3})%/g);
      if (!m) return;
      const p = parseInt(m[m.length - 1], 10);
      if (p >= logged + 20) {
        logged = p;
        log(`  ${path.basename(outBase)}: ${p}%`);
      }
      if (Date.now() - last < 1000) return;
      last = Date.now();
      if (ctx.onProgress) ctx.onProgress(`Pack ${path.basename(outBase)} ${m[m.length - 1]}`);
    };
  };

  async function makeArchive(outBase, srcDir, excludes, password) {
    log(`  packing ${path.basename(outBase)} from ${srcDir} ...` + (excludes.length ? ` (excluding: ${excludes.map((x) => (typeof x === 'string' ? x : x.rel)).join(', ')})` : ''));
    const t0 = Date.now();
    const res = await makeArchiveInner(outBase, srcDir, excludes, password);
    log(`  ${path.basename(outBase)} ${res.ok ? 'done' : 'FAILED'} in ${Math.round((Date.now() - t0) / 1000)} s`);
    return res;
  }
  async function makeArchiveInner(outBase, srcDir, excludes, password) {
    const parent = path.dirname(srcDir);
    const name = path.basename(srcDir);
    const sevenZ = find7z();
    // বাদ-তালিকা: স্ট্রিং = যেকোনো গভীরতায় নামে মেলে (-xr!), {rel} = আর্কাইভের মূল থেকে নির্দিষ্ট পথ (-x!www\\পথ\\*, আপনার .bat-এর CODE_SKIP-এর মতো)
    const exArgs = excludes.map((x) => (typeof x === 'string' ? '-xr!' + x : `-x!${name}\\${x.rel}\\*`));
    if (password) {
      if (!sevenZ) return { ok: false, message: 'password set but 7-Zip is missing' };
      const out = outBase + '.7z';
      const args = ['a', '-t7z', '-mx=3', '-mhe=on', '-bsp1', '-p' + password, '-y', out, name, ...exArgs];
      const r = await run(sevenZ, args, { cwd: parent, onData: pct(outBase) });
      if (!r.ok || !fs.existsSync(out)) return { ok: false, message: (`7z failed (exit code ${r.code}): ` + (r.stdout + r.stderr).trim().slice(-300)) };
      const t = await run(sevenZ, ['t', '-p' + password, out], {});
      if (!t.ok) return { ok: false, message: '7z test failed: ' + (t.stdout + t.stderr).slice(-300) };
      return { ok: true, file: out };
    }
    const out = outBase + '.zip';
    if (sevenZ) {
      const r = await run(sevenZ, ['a', '-tzip', '-mx=3', '-bsp1', '-y', out, name, ...exArgs], { cwd: parent, onData: pct(outBase) });
      if (!r.ok || !fs.existsSync(out)) return { ok: false, message: (`7z failed (exit code ${r.code}): ` + (r.stdout + r.stderr).trim().slice(-300)) };
      return { ok: true, file: out };
    }
    const tarExe = ctx.tarExe || (win ? 'tar.exe' : 'tar');
    const r = await run(tarExe, ['-a', '-c', '-f', out, ...excludes.flatMap((x) => ['--exclude', typeof x === 'string' ? x : `${name}/${x.rel.replace(/\\/g, '/')}`]), '-C', parent, name], {});
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
    if (!list.ok) return { skipped: 'MySQL not running or login failed: ' + (list.stderr || '').trim().slice(0, 150), notRunning: /2003|10061|Can't connect/i.test(list.stderr || '') };
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
      if (/could not connect|connection refused|timeout expired/i.test(m)) return { skipped: 'PostgreSQL not running', notRunning: true };
      return { ok: false, message: 'pg_dumpall failed: ' + m.slice(0, 300) };
    }
    return { ok: true };
  }

  // ডাটাবেস বন্ধ থাকলে (যেমন অ্যাপ বন্ধ করে Task Scheduler চালালে) নিজে চালু করে dump, তারপর নিজে বন্ধ (শুধু আমরা চালু করলে)
  async function dumpWithAutoStart(id, label, dumpFn, dumpDir, cfg) {
    let r = await dumpFn(dumpDir);
    let started = false;
    if (r.notRunning && cfg.autoStartDb && ctx.startDb) {
      log(`  ${label} is not running, starting it just for the backup ...`);
      const sr = await ctx.startDb(id).catch((e) => ({ ok: false, message: e.message }));
      if (sr && sr.ok) {
        started = true;
        r = await dumpFn(dumpDir);
      } else {
        r = { skipped: `${label} not running and could not be started: ${String((sr && sr.message) || '').slice(0, 200)}` };
      }
    }
    if (started && ctx.stopDb) {
      await ctx.stopDb(id).catch(() => {});
      log(`  ${label} stopped again`);
    }
    return r;
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

  // অন্য PC-র SMB পোর্ট (445) পৌঁছানো যায় কি না, ৫ সেকেন্ডে দেখে (net use ৬০ সেকেন্ড ঝুলে থাকলে কারণ বোঝা যায় না)
  function probeSmb(host) {
    return new Promise((resolve) => {
      const sock = net.connect({ host, port: 445 });
      const done = (ok) => {
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(5000, () => done(false));
      sock.once('connect', () => done(true));
      sock.once('error', () => done(false));
    });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // শেয়ারে যুক্ত হওয়া: প্রথমে 445 পোর্ট দেখা, তারপর net use (২৫ সেকেন্ড করে, সর্বোচ্চ ৩ বার, মাঝে ১০ সেকেন্ড বিরতি)
  async function connectShare(d, cfg) {
    if (!win || !cfg.share.user) return { ok: true, connected: false };
    const m = /^\\\\([^\\/]+)/.exec(d.unc);
    const host = m ? m[1] : '';
    let last = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (host && !(await probeSmb(host))) {
        last = `cannot reach ${host} on port 445 (PC off/asleep, network down, or firewall)`;
      } else {
        const r = await run('net', ['use', d.unc, sharePassword(), '/user:' + cfg.share.user, '/persistent:no'], { timeout: 25000 });
        if (r.ok) return { ok: true, connected: true };
        last = ('net use failed: ' + ((r.stdout + r.stderr).trim() || 'no answer within 25 s')).slice(0, 250);
      }
      log(`    share attempt ${attempt}/3 failed: ${last}`);
      if (attempt < 3) await sleep(10000);
    }
    return { ok: false, message: last };
  }

  // incremental কপি, মুছে ফেলা ফাইল গন্তব্যে থেকে যায় (/MIR নয়, /E)। Windows: robocopy (০-৭ = সফল, ৮+ = ব্যর্থ)
  async function copyFolderIncremental(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    if (win) {
      const r = await run('robocopy', [src, dst, '/E', '/COPY:DAT', '/DCOPY:DAT', '/XJ', '/R:3', '/W:10', '/MT:8', '/NP', '/NFL', '/NDL'], {});
      if (r.code >= 8 || r.code < 0) return { ok: false, message: `robocopy failed (exit code ${r.code}): ` + (r.stdout + r.stderr).trim().slice(-300) };
      return { ok: true };
    }
    // Windows ছাড়া (শুধু পরীক্ষা): পুরো কপি, গন্তব্যের বাড়তি ফাইল মোছে না
    fs.cpSync(src, dst, { recursive: true, force: true });
    return { ok: true };
  }

  // ---- কপি ফোল্ডারের পরিষ্কার: মূল ফোল্ডার থেকে হারানো ফাইল N দিন পর backup থেকেও মোছা ----
  // robocopy /COPY:DAT মূল ফাইলের তারিখই রাখে, তাই "হারানোর দিন" আলাদা state ফাইলে (.s360-state.json) লিখে রাখি।
  // নিরাপত্তা: মূল ফোল্ডার না পড়া গেলে/খালি হলে, বা কপির অর্ধেকের বেশি ফাইল "হারানো" দেখালে (ড্রাইভ খুলে যাওয়ার লক্ষণ) কিছুই মোছা হয় না।
  const STATE_NAME = '.s360-state.json';
  async function cleanGone(src, dst, days, vdir) {
    const fsp = fs.promises;
    let srcEntries;
    try {
      srcEntries = await fsp.readdir(src);
    } catch (e) {
      return { warn: true, message: 'source folder not readable, nothing removed: ' + e.message };
    }
    if (!srcEntries.length) return { warn: true, message: 'source folder is empty, nothing removed' };
    const statePath = path.join(dst, STATE_NAME);
    let state = { missing: {} };
    try {
      const j = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      if (j && j.missing && typeof j.missing === 'object') state = j;
    } catch {}
    const files = [];
    const walk = async (dir, rel) => {
      for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
        if (!rel && (e.name === STATE_NAME || e.name === '.versions')) continue;
        const r = rel ? rel + path.sep + e.name : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    };
    await walk(dst, '');
    const gone = [];
    for (const r of files) {
      try {
        await fsp.lstat(path.join(src, r));
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') gone.push(r);
        else return { warn: true, message: `cannot check the source (${e.code}), nothing removed` };
      }
    }
    if (files.length >= 100 && gone.length > files.length / 2) {
      return { warn: true, message: `${gone.length} of ${files.length} files are missing from the source (more than half): the source looks unavailable, nothing removed` };
    }
    const now = Date.now();
    const next = {};
    let removed = 0;
    let marked = 0;
    const sample = [];
    for (const r of gone) {
      const firstIso = state.missing[r];
      const first = firstIso ? Date.parse(firstIso) : now;
      if (!firstIso) marked++;
      if (now - first >= days * 86400000) {
        try {
          if (vdir) moveToVersions(dst, r, vdir); // পুরনো version রাখা চালু থাকলে মোছার বদলে .versions-এ সরানো
          else await fsp.rm(path.join(dst, r), { force: true });
          removed++;
          if (sample.length < 5) sample.push(r);
          continue;
        } catch {}
      }
      next[r] = new Date(first).toISOString();
    }
    await fsp.writeFile(statePath, JSON.stringify({ missing: next }, null, 1));
    if (removed) {
      const prune = async (dir, top) => {
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          if (!e.isDirectory() || (top && e.name === '.versions')) continue;
          const sub = path.join(dir, e.name);
          await prune(sub, false);
          if (!(await fsp.readdir(sub)).length) await fsp.rmdir(sub).catch(() => {});
        }
      };
      await prune(dst, true).catch(() => {});
    }
    return { ok: true, removed, marked, pending: Object.keys(next).length, total: files.length, sample };
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
      log(`[${ok === 'skip' ? 'SKIP' : ok === 'warn' ? 'WARN' : ok ? 'OK' : 'FAIL'}] ${name}${msg ? ' - ' + msg : ''}`);
      if (ctx.onProgress) ctx.onProgress(name);
    };
    const tmp = path.join(tmpRoot(), stamp);
    // ডাটাবেস ইনস্টল আছে ও চালু করা হয়েছে, কিন্তু dump হয়নি (চলছে না/চালু করা যায়নি/লগইন ব্যর্থ) = WARN, নিঃশব্দ SKIP নয়; ইনস্টলই নেই = SKIP
    const warnOf = (m) => (/not running|login failed|could not be started/i.test(m) ? 'warn' : 'skip');
    const connected = [];
    let failed = false;

    try {
      log(`=== Backup ${stamp} start (${opts.source || 'manual'}) ===`);
      // কোন গন্তব্যে কপি হবে লগে লিখে রাখা, আর Network share চালু কিন্তু UNC ফাঁকা থাকলে জানানো (আগে নিঃশব্দে বাদ পড়ত)
      log('  Destinations: ' + dests.map((d) => (d.kind === 'local' ? 'Local ' : 'Network share ') + d.root).join(' | '));
      if (cfg.share.enabled && !cfg.share.unc) log('  [WARN] Network share is switched on but the share path is empty, it is skipped');
      if (!cfg.share.enabled) log('  Network share is OFF in the saved settings');
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
        const r = await dumpWithAutoStart('mysql', 'MySQL', dumpMysql, dumpDir, cfg);
        if (r.skipped) step('MySQL dump', warnOf(r.skipped), r.skipped);
        else if (!r.ok) { step('MySQL dump', false, r.message); failed = true; }
        else { step('MySQL dump', true, r.dbs.join(', ')); manifest.mysqlDbs = r.dbs; anyDump = true; }
      }
      if (cfg.what.postgres) {
        const r = await dumpWithAutoStart('postgres', 'PostgreSQL', dumpPostgres, dumpDir, cfg);
        if (r.skipped) step('PostgreSQL dump', warnOf(r.skipped), r.skipped);
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
          manifest.wwwExcluded = cfg.what.wwwExclude;
          const a = await makeArchive(path.join(packDir, 'www'), www, [...WWW_EXCLUDES, ...cfg.what.wwwExclude.map((rel) => ({ rel }))], password);
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
      for (const item of cfg.what.extra.filter((x) => x.mode !== 'copy')) {
        ex++;
        if (!fs.existsSync(item.path)) { step('Extra: ' + item.label, 'skip', 'folder not found'); continue; }
        const a = await makeArchive(path.join(packDir, 'extra-' + ex), item.path, [], password);
        if (a.ok) { step('Pack extra: ' + item.label, true, path.basename(a.file)); manifest.files.push(path.basename(a.file)); manifest['extra' + ex] = item.label; }
        else { step('Pack extra: ' + item.label, false, a.message); failed = true; }
      }

      // বড় ফোল্ডার (যেমন user-upload): আর্কাইভ নয়, গন্তব্যের <root>\\files\\<নাম>-এ incremental কপি (মূল থেকে মুছলেও এখানে থেকে যায়)
      const usedNames = new Set();
      const copyItems = cfg.what.extra
        .filter((x) => x.mode === 'copy')
        .map((x) => {
          const base = String(x.label || path.basename(x.path)).replace(/[\\/:*?"<>|]+/g, '_').trim() || 'folder';
          let nm = base;
          let i = 2;
          while (usedNames.has(nm.toLowerCase())) nm = `${base}_${i++}`;
          usedNames.add(nm.toLowerCase());
          return { ...x, safe: nm };
        });
      if (copyItems.length) manifest.copyFolders = copyItems.map((x) => ({ label: x.label, folder: 'files/' + x.safe, source: x.path }));
      if (!manifest.files.length && !copyItems.length) throw new Error(tr('backup করার মতো কিছু তৈরি হয়নি', 'Nothing was produced to back up'));
      manifest.complete = !failed; // false = some step failed, this folder is a partial backup
      manifest.failedSteps = steps.filter((x) => x.ok === false).map((x) => x.name);
      fs.writeFileSync(path.join(packDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // ৫) গন্তব্যে নেওয়া
      const need = dirSize(packDir);
      let okDest = 0;
      const copyFails = [];
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
          for (const it of copyItems) {
            const to = path.join(d.root, 'files', it.safe);
            const nm = `Copy files ${it.label} to ${label}`;
            try {
              if (!fs.existsSync(it.path)) {
                step(nm, 'warn', 'source folder not found: ' + it.path);
                continue;
              }
              // ফাঁকা জায়গার সীমা (ন্যূনতম ফাঁকা জায়গা): গন্তব্যে এর কম থাকলে কপি শুরুই হয় না (ডিস্ক ভরে যাওয়া ঠেকাতে)
              const freeNow = freeBytes(d.root);
              if (cfg.minFreeGb > 0 && freeNow !== null && freeNow < cfg.minFreeGb * 1073741824) {
                step(nm, false, `not enough free space (${(freeNow / 1073741824).toFixed(1)} GB free, minimum ${cfg.minFreeGb} GB)`);
                failed = true;
                continue;
              }
              const vdir = it.keepDays > 0 ? path.join(to, VERSIONS_DIR, stamp) : null;
              // পুরনো version রাখা: robocopy ওভাররাইট করার আগে বদলানো ফাইলের পুরনোটা সরিয়ে রাখি (ব্যর্থ হলে WARN, কপি তবু চলে)
              if (vdir && fs.existsSync(to)) {
                const sn = await snapshotChanged(it.path, to, vdir).catch((e) => ({ error: e.message }));
                const vn = `Versions ${it.label} on ${label}`;
                if (sn.error) step(vn, 'warn', 'could not keep old versions: ' + sn.error);
                else step(vn, sn.errors ? 'warn' : true, `${sn.kept} changed file(s) kept as old version, ${sn.checked} checked` + (sn.errors ? `, ${sn.errors} could not be checked` : '') + (sn.sample.length ? `; e.g. ${sn.sample.join(', ')}` : ''));
              }
              const t1 = Date.now();
              log(`  copying ${it.path} -> ${to} (incremental, plain files) ...`);
              const cr = await copyFolderIncremental(it.path, to);
              if (cr.ok) {
                step(nm, true, `${to} (${Math.round((Date.now() - t1) / 1000)} s, plain files, NOT encrypted)`);
                // ফোল্ডারের জন্য "N দিন পর মোছা" চালু থাকলে (শুধু কপি সফল হলে)
                if (it.cleanDays > 0) {
                  const cl = await cleanGone(it.path, to, it.cleanDays, vdir).catch((e) => ({ warn: true, message: 'cleanup error: ' + e.message }));
                  const cn = `Clean ${it.label} on ${label}`;
                  if (cl.warn) step(cn, 'warn', cl.message);
                  else step(cn, true, `${cl.removed} file(s) removed, ${cl.pending} missing from the source and waiting (limit ${it.cleanDays} days), ${cl.marked} newly noticed, ${cl.total} checked` + (cl.sample.length ? `; removed e.g. ${cl.sample.join(', ')}` : ''));
                }
                if (it.keepDays > 0) {
                  try {
                    const pv = pruneVersions(to, it.keepDays);
                    if (pv) step(`Versions ${it.label} on ${label}`, true, `${pv} old version folder(s) removed (older than ${it.keepDays} days)`);
                  } catch (e) {
                    step(`Versions ${it.label} on ${label}`, 'warn', 'cleanup error: ' + e.message);
                  }
                }
              } else {
                step(nm, false, cr.message);
                failed = true;
              }
            } catch (e) {
              step(nm, false, e.message);
              failed = true;
            }
          }
        } catch (e) {
          copyFails.push({ label, msg: e.message });
        }
      }
      // একটা গন্তব্যে কপি হলে অন্যটার ব্যর্থতা WARN (তথ্য নিরাপদ আছে); কোনোটাতেই না হলে FAIL
      for (const f of copyFails) {
        if (okDest) step('Copy to ' + f.label, 'warn', f.msg);
        else {
          step('Copy to ' + f.label, false, f.msg);
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

    const warnings = steps.filter((x) => x.ok === 'warn').length;
    const status = { ok: !failed, warnings, stamp, started: started.toISOString(), finished: new Date().toISOString(), source: opts.source || 'manual', steps };
    try {
      fs.writeFileSync(statusFile(), JSON.stringify(status, null, 2));
    } catch {}
    log(`=== Backup ${stamp} ${failed ? 'FAILED' : warnings ? 'OK with ' + warnings + ' warning(s)' : 'OK'} ===`);
    if (failed && win) {
      const last = steps.filter((s) => s.ok === false).map((s) => s.name + ': ' + s.msg).join(' | ').slice(0, 800);
      run('eventcreate', ['/T', 'ERROR', '/ID', '100', '/L', 'APPLICATION', '/SO', 'Server 360 Backup', '/D', last || 'Backup failed'], { timeout: 15000 });
    }
    pruneLogs();
    return { ok: !failed, status, message: failed ? tr('Backup-এ সমস্যা হয়েছে, log দেখুন', 'Backup finished with errors, see the log') : warnings ? tr('Backup হয়েছে, কিন্তু সতর্কতা আছে (যেমন কোনো ডাটাবেস dump হয়নি), log দেখুন', 'Backup done, but with warnings (for example a database was not dumped), see the log') : tr('Backup সম্পূর্ণ', 'Backup completed') };
  }

  return { getConfig, setConfig, runBackup, isRunning, lastStatus, tailLog, find7z, ensure7z, dirs: { baseDir, logsDir } };
}

module.exports = { createBackup, stampOf, STAMP_RE, snapshotChanged, pruneVersions, moveToVersions };
