'use strict';
// Server 360 - Backup backend (step 1).
// Electron-এর উপর নির্ভর করে না: main.js এখান থেকে createBackup(ctx) নিয়ে সব কিছু ctx দিয়ে জোগান দেয়।
// প্রযুক্তি: ডাটাবেস সবসময় dump (লাইভ data ফোল্ডার কপি নয়), আগে লোকাল tmp-এ প্যাক, তারপর গন্তব্যে কপি (.part ফোল্ডার -> rename),
// তাই নেটওয়ার্ক ভাঙলে আধা-ফাইল পড়ে থাকে না।
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
const net = require('net');

const STAMP_RE = /^\d{8}-\d{6}$/;
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (d = new Date()) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const dayOf = (d = new Date()) => stampOf(d).slice(0, 8);

const SYSTEM_MYSQL_DBS = new Set(['information_schema', 'performance_schema', 'sys', 'mysql']);
// www আর্কাইভে বাদ: নির্ভরতা/বিল্ড-ক্যাশ যা আবার তৈরি করা যায় (npm install, build) এবং Laravel লগ/ক্যাশ/সেশন/কম্পাইল-করা view।
// vendor ইচ্ছে করে বাদ দেওয়া হয়নি (composer অফলাইনে না-ও চলতে পারে)। path-সহ প্যাটার্নে শুরুতে *\\ লাগে (Windows-এ টেস্টে প্রমাণিত 2026-11-12: -xr!*\\storage\\logs মেলে, -xr!storage\\logs মেলে না)।
const WWW_EXCLUDES = ['node_modules', '.git', '.next', '*\\storage\\logs', '*\\storage\\framework\\cache', '*\\storage\\framework\\sessions', '*\\storage\\framework\\views'];

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

// ফোল্ডারের মোট সাইজ মাপা (UI-তে দেখানো ও mode সাজেস্ট করার জন্য, শুধু পড়ে, কিছু বদলায় না)। symlink/junction এড়ানো (robocopy /XJ-এর মতো)।
// timeoutMs পার হলে থেমে partial:true দেয় (বিশাল ফোল্ডারে UI আটকে না থাকার জন্য)।
async function folderSize(dir, timeoutMs = 60000) {
  const fsp = fs.promises;
  const deadline = Date.now() + timeoutMs;
  const res = { bytes: 0, files: 0, partial: false, errors: 0 };
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > deadline) {
      res.partial = true;
      break;
    }
    const cur = stack.pop();
    let ents;
    try {
      ents = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      res.errors++;
      continue;
    }
    const files = [];
    for (const e of ents) {
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(path.join(cur, e.name));
      else if (e.isFile()) files.push(path.join(cur, e.name));
    }
    for (let i = 0; i < files.length; i += 64) {
      await Promise.all(
        files.slice(i, i + 64).map((f) =>
          fsp.lstat(f).then(
            (st) => {
              res.bytes += st.size;
              res.files++;
            },
            () => {
              res.errors++;
            }
          )
        )
      );
    }
  }
  return res;
}

// নেটওয়ার্ক শেয়ারে (SMB) নতুন লেখা ফাইল অ্যান্টিভাইরাস/ইনডেক্সার কিছুক্ষণ খোলা ধরে রাখলে ফোল্ডার rename EPERM/EBUSY/EACCES দেয়; তাই কয়েকবার অপেক্ষা করে আবার চেষ্টা
async function renameDirRetry(from, to, tries = 6, delayMs = 5000) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      fs.renameSync(from, to);
      return { ok: true, attempts: i };
    } catch (e) {
      last = e;
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      if (i < tries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return { ok: false, attempts: tries, error: last };
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

// ফাইলটা stdin-এ দিয়ে প্রোগ্রাম চালানো (mysql < file.sql); stdout/stderr শেষের দিকটুকু রাখে
function runWithFile(exe, args, file, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    let ch;
    try {
      ch = spawn(exe, args, { windowsHide: true, env: opts.env || process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: e.message });
    }
    const timer = setTimeout(() => {
      try {
        ch.kill();
      } catch {}
      fin({ ok: false, code: -1, stdout: out, stderr: err + '\n(timeout)' });
    }, opts.timeout || 6 * 3600 * 1000);
    ch.stdout.on('data', (d) => (out = (out + d).slice(-4000)));
    ch.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    ch.on('error', (e) => fin({ ok: false, code: -1, stdout: out, stderr: err + e.message }));
    ch.on('close', (code) => fin({ ok: code === 0, code: code == null ? -1 : code, stdout: out, stderr: err }));
    const rs = fs.createReadStream(file);
    rs.on('error', (e) => {
      try {
        ch.kill();
      } catch {}
      fin({ ok: false, code: -1, stdout: out, stderr: err + e.message });
    });
    ch.stdin.on('error', () => {}); // mysql আগে বেরিয়ে গেলে EPIPE উপেক্ষা
    rs.pipe(ch.stdin);
  });
}

// latin1 (বাইট-নিরাপদ) স্ট্রিম লেখা; বাফার ভরলে অপেক্ষা
function writeLatin1(stream, str) {
  return stream.write(str, 'latin1') ? Promise.resolve() : new Promise((r) => stream.once('drain', r));
}
function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject);
    stream.end(resolve);
  });
}
const toL1 = (s) => Buffer.from(String(s), 'utf8').toString('latin1'); // UTF-8 নামকে ফাইলের (latin1 পড়া) বাইটের রূপে

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
  async function connectShare(d, cfg, tries = 3) {
    if (!win || !cfg.share.user) return { ok: true, connected: false };
    const m = /^\\\\([^\\/]+)/.exec(d.unc);
    const host = m ? m[1] : '';
    let last = '';
    for (let attempt = 1; attempt <= tries; attempt++) {
      if (host && !(await probeSmb(host))) {
        last = `cannot reach ${host} on port 445 (PC off/asleep, network down, or firewall)`;
      } else {
        const r = await run('net', ['use', d.unc, sharePassword(), '/user:' + cfg.share.user, '/persistent:no'], { timeout: 25000 });
        if (r.ok) return { ok: true, connected: true };
        last = ('net use failed: ' + ((r.stdout + r.stderr).trim() || 'no answer within 25 s')).slice(0, 250);
      }
      log(`    share attempt ${attempt}/${tries} failed: ${last}`);
      if (attempt < tries) await sleep(10000);
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


  // ---------- Restore, step 1: list backups (READ ONLY, nothing is changed) ----------
  // One entry per backup folder (<root>\<YYYYMMDD-HHMMSS>\ with manifest.json). A folder without a readable manifest.json is still listed (manifest:false).
  function readBackupDir(dir, source) {
    const item = { dir, stamp: path.basename(dir), source, manifest: true, complete: false, encrypted: false, created: '', files: [], missing: [], mysqlDbs: [], postgres: false, sites: [], extras: [], copyFolders: [], failedSteps: [], note: '' };
    let m = null;
    try {
      m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch (e) {
      item.manifest = false;
      item.note = e.code === 'ENOENT' ? 'no manifest.json' : 'manifest.json unreadable: ' + e.message;
    }
    let names = [];
    if (m && typeof m === 'object') {
      item.complete = m.complete !== false;
      item.encrypted = !!m.encrypted;
      item.created = typeof m.created === 'string' ? m.created : '';
      item.mysqlDbs = Array.isArray(m.mysqlDbs) ? m.mysqlDbs.map(String) : [];
      item.postgres = !!m.postgres;
      item.sites = Array.isArray(m.sites) ? m.sites.map(String) : [];
      item.failedSteps = Array.isArray(m.failedSteps) ? m.failedSteps.map(String) : [];
      item.copyFolders = Array.isArray(m.copyFolders) ? m.copyFolders.filter((c) => c && typeof c.label === 'string').map((c) => String(c.label)) : [];
      for (const k of Object.keys(m)) {
        const x = /^extra(\d+)$/.exec(k);
        if (x) item.extras.push({ n: Number(x[1]), label: String(m[k]) });
      }
      item.extras.sort((a, b) => a.n - b.n);
      names = Array.isArray(m.files) ? m.files.map(String) : [];
    } else {
      try {
        names = fs.readdirSync(dir).filter((n) => /\.(7z|zip|sql)$/i.test(n));
      } catch {}
    }
    item.files = names.map((name) => {
      let size = -1;
      try {
        size = fs.statSync(path.join(dir, name)).size;
      } catch {}
      return { name, size, exists: size >= 0 };
    });
    item.missing = item.files.filter((f) => !f.exists).map((f) => f.name);
    return item;
  }

  function scanRoot(root, source) {
    const items = [];
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && STAMP_RE.test(e.name)) items.push(readBackupDir(path.join(root, e.name), source));
    }
    return items;
  }

  // plain copies: <root>\files\<label> (+ how many old-version folders are under .versions)
  function scanCopies(root, source) {
    const out = [];
    const fd = path.join(root, 'files');
    let list;
    try {
      list = fs.readdirSync(fd, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      let versions = 0;
      try {
        versions = fs.readdirSync(path.join(fd, e.name, '.versions'), { withFileTypes: true }).filter((v) => v.isDirectory() && STAMP_RE.test(v.name)).length;
      } catch {}
      out.push({ label: e.name, dir: path.join(fd, e.name), versions, source, root });
    }
    return out;
  }

  // opts.customDir: scan that folder only (a backup folder itself, or a folder that holds backup folders); otherwise the enabled destinations (Local / Network share)
  async function listBackups(opts = {}) {
    const out = { ok: true, items: [], copies: [], errors: [], noDest: false };
    const connected = [];
    try {
      if (opts.customDir) {
        const dir = String(opts.customDir);
        let st;
        try {
          st = fs.statSync(dir);
        } catch (e) {
          return { ok: false, message: tr('ফোল্ডার পড়া যায়নি: ', 'Cannot read the folder: ') + e.message };
        }
        if (!st.isDirectory()) return { ok: false, message: tr('এটা ফোল্ডার নয়: ', 'Not a folder: ') + dir };
        if (fs.existsSync(path.join(dir, 'manifest.json'))) {
          out.items.push(readBackupDir(dir, 'custom'));
        } else {
          out.items.push(...scanRoot(dir, 'custom'));
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            // renamed backup folders (not a stamp name) that still have a manifest.json
            if (e.isDirectory() && !STAMP_RE.test(e.name) && fs.existsSync(path.join(dir, e.name, 'manifest.json'))) out.items.push(readBackupDir(path.join(dir, e.name), 'custom'));
          }
          out.copies.push(...scanCopies(dir, 'custom'));
        }
      } else {
        const cfg = getConfig();
        const dests = destinations(cfg);
        if (!dests.length) return { ...out, noDest: true };
        for (const d of dests) {
          const label = d.kind === 'local' ? 'Local' : 'Network share';
          try {
            if (d.kind === 'share') {
              const c = await connectShare(d, cfg, 1);
              if (!c.ok) throw new Error(c.message);
              // do not drop a connection that a running backup is using
              if (c.connected && !running) connected.push(d);
            }
            out.items.push(...scanRoot(d.root, d.kind));
            out.copies.push(...scanCopies(d.root, d.kind));
          } catch (e) {
            out.errors.push({ label, message: e.message });
          }
        }
      }
      out.items.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));
      return out;
    } finally {
      for (const d of connected) await run('net', ['use', d.unc, '/delete', '/y'], { timeout: 30000 });
    }
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
          const finalDir = path.join(d.root, stamp);
          const rr = await renameDirRetry(part, finalDir);
          if (!rr.ok) {
            // rename বারবার ব্যর্থ: সরাসরি চূড়ান্ত ফোল্ডারে আবার কপি (manifest.json সবার শেষে, যাতে অসম্পূর্ণ কপি সম্পূর্ণ দেখায় না), তারপর .part মোছার চেষ্টা
            log(`  rename of the .part folder failed ${rr.attempts} times (${rr.error.code}), copying straight into ${finalDir} instead ...`);
            fs.mkdirSync(finalDir, { recursive: true });
            const names = fs.readdirSync(packDir).sort((a, b) => (a === 'manifest.json') - (b === 'manifest.json'));
            for (const f of names) fs.copyFileSync(path.join(packDir, f), path.join(finalDir, f));
            try {
              fs.rmSync(part, { recursive: true, force: true });
            } catch (e) {
              log(`  could not remove the leftover ${part}: ${e.message} (delete it by hand)`);
            }
          } else if (rr.attempts > 1) {
            log(`  rename of the .part folder worked on attempt ${rr.attempts}`);
          }
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
    return { ok: !failed, status, message: failed ? tr('Backup-এ সমস্যা হয়েছে, log দেখুন', 'Backup finished with errors, see the log') : warnings ? tr('Backup হয়েছে, কিন্তু সতর্কতা আছে (যেমন কোনো ডাটাবেস dump হয়নি, বা কোনো গন্তব্যে কপি হয়নি, বা কোনো ফোল্ডার পাওয়া যায়নি), log দেখুন', 'Backup done, but with warnings (for example a database was not dumped, a destination copy failed, or a folder was not found), see the log') : tr('Backup সম্পূর্ণ', 'Backup completed') };
  }

  // ---------- Restore, step 2: www সাইট ফেরত আনা ----------
  // নিরাপত্তা: আগে লোকাল tmp-এ extract, তারপর সাইট ধরে জায়গায় বসানো (আংশিক ব্যর্থ হলে পুরনো সাইট অক্ষত থাকে)।
  // নাম মিললে: 'rename' (ডিফল্ট, <নাম>-restored) বা 'overwrite' (পুরনো ফোল্ডারের উপরে merge; archive-এ যা নেই, যেমন node_modules/.git, থেকে যায়)।
  // বাদ-যাওয়া ফোল্ডার (node_modules, Laravel storage ইত্যাদি) এখানে বানানো হয় না, শুধু Laravel-এর ফাঁকা ফোল্ডার ও wwwExclude-এর ফাঁকা path আবার বানাই;
  // npm install ইত্যাদি main.js করে (restore:www)।
  let restoring = false;
  const SAFE_SITE = (n) => typeof n === 'string' && !!n && n !== '.' && n !== '..' && !/[\\/:*?"<>|]/.test(n);
  const LARAVEL_DIRS = ['storage/logs', 'storage/framework/cache/data', 'storage/framework/sessions', 'storage/framework/views', 'storage/app/public', 'bootstrap/cache'];

  function wwwArchiveOf(item) {
    const f = item.files.find((x) => x.exists && /^www\.(7z|zip)$/i.test(x.name));
    return f ? path.join(item.dir, f.name) : '';
  }
  function restoreWwwInfo(dir) {
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tr('ফোল্ডার দেওয়া হয়নি', 'No folder given') };
    const item = readBackupDir(dir, 'custom');
    if (!item.manifest) return { ok: false, message: tr('manifest.json নেই বা পড়া যায় না, তাই www restore করা যাবে না', 'manifest.json is missing or unreadable, so www cannot be restored') };
    const archive = wwwArchiveOf(item);
    if (!archive) return { ok: false, message: tr('এই backup-এ www আর্কাইভ নেই', 'This backup has no www archive') };
    let m = {};
    try {
      m = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) || {};
    } catch {}
    const www = ctx.wwwDir();
    const sites = item.sites.filter(SAFE_SITE).map((name) => ({ name, exists: !!www && fs.existsSync(path.join(www, name)) }));
    return {
      ok: true,
      archive,
      encrypted: item.encrypted,
      complete: item.complete,
      failedSteps: item.failedSteps,
      sites,
      excluded: Array.isArray(m.wwwExcluded) ? m.wwwExcluded.map(String) : [],
      copyFolders: Array.isArray(m.copyFolders) ? m.copyFolders.map((c) => String(c && c.label)) : [],
      wwwDir: www || '',
      sevenZip: !!find7z(),
    };
  }

  async function moveDir(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch {
      await fs.promises.cp(from, to, { recursive: true, force: true });
      await fs.promises.rm(from, { recursive: true, force: true });
    }
  }
  // সাইট চলার উপযোগী করা: Laravel-এর ফাঁকা ফোল্ডার, আর wwwExclude-এ থাকা (এই সাইটের ভেতরের) ফাঁকা path
  function makeRunnable(www, origName, finalName, excluded) {
    const notes = [];
    const dir = path.join(www, finalName);
    if (fs.existsSync(path.join(dir, 'artisan'))) {
      const made = LARAVEL_DIRS.filter((rel) => {
        const p = path.join(dir, ...rel.split('/'));
        if (fs.existsSync(p)) return false;
        try {
          fs.mkdirSync(p, { recursive: true });
          return true;
        } catch {
          return false;
        }
      });
      if (made.length) notes.push(tr('Laravel-এর ' + made.length + 'টা ফাঁকা ফোল্ডার আবার বানানো হয়েছে (storage, cache)', made.length + ' empty Laravel folder(s) recreated (storage, cache)'));
    }
    let madeEx = 0;
    for (const rel of excluded) {
      const seg = String(rel).split(/[\\/]+/).filter(Boolean);
      if (seg.length < 2 || seg.includes('..') || seg[0].toLowerCase() !== origName.toLowerCase()) continue;
      const p = path.join(www, finalName, ...seg.slice(1));
      if (!fs.existsSync(p)) {
        try {
          fs.mkdirSync(p, { recursive: true });
          madeEx++;
        } catch {}
      }
    }
    if (madeEx) notes.push(tr(madeEx + 'টা বাদ-দেওয়া ফোল্ডার ফাঁকা অবস্থায় বানানো হয়েছে (ভেতরের ফাইল আলাদা copy থেকে আসে, ধাপ ৪)', madeEx + ' left-out folder(s) created empty (their files come from the plain copy, step 4)'));
    return notes;
  }

  async function restoreWww(opts) {
    if (restoring) return { ok: false, message: tr('আরেকটা restore চলছে', 'Another restore is running') };
    if (running) return { ok: false, message: tr('একটা backup চলছে, শেষ হলে চেষ্টা করুন', 'A backup is running, try again when it has finished') };
    const info = restoreWwwInfo(opts && opts.dir);
    if (!info.ok) return info;
    const www = ctx.wwwDir();
    if (!www) return { ok: false, message: tr('www ফোল্ডার ঠিক করা নেই', 'The www folder is not set') };
    const valid = new Set(info.sites.map((s) => s.name));
    const picks = (Array.isArray(opts.picks) ? opts.picks : []).filter((p) => p && valid.has(p.name));
    if (!picks.length) return { ok: false, message: tr('কোনো সাইট বাছা হয়নি', 'No site selected') };
    const password = typeof opts.password === 'string' ? opts.password : '';
    if (info.encrypted && !password) return { ok: false, needPassword: true, message: tr('এই backup পাসওয়ার্ড দিয়ে encrypted, পাসওয়ার্ড দিন', 'This backup is encrypted, enter the password') };
    const sevenZ = find7z();
    const is7z = /\.7z$/i.test(info.archive);
    if (is7z && !sevenZ) return { ok: false, message: tr('7-Zip নেই; Backup পেজ থেকে ইনস্টল করুন', '7-Zip is missing; install it from the Backup page') };
    const wrongPw = (s) => /wrong password|cannot open encrypted archive|can not open encrypted archive|data error in encrypted/i.test(s);
    const pwArgs = password ? ['-p' + password] : [];
    const tmp = path.join(tmpRoot(), 'restore-' + stampOf());
    const results = [];
    const warnings = [];
    restoring = true;
    try {
      fs.mkdirSync(www, { recursive: true });
      fs.mkdirSync(tmp, { recursive: true });
      log(`Restore www: ${info.archive} -> ${picks.length} site(s): ${picks.map((p) => p.name + '(' + (p.mode || 'rename') + ')').join(', ')}`);
      let top = '';
      if (sevenZ) {
        if (ctx.onProgress) ctx.onProgress('Restore: reading archive');
        const lr = await run(sevenZ, ['l', '-slt', ...pwArgs, info.archive], { timeout: 30 * 60000 });
        const lout = lr.stdout + lr.stderr;
        if (!lr.ok) {
          if (wrongPw(lout)) return { ok: false, wrongPassword: true, message: tr('পাসওয়ার্ড ভুল', 'Wrong password') };
          return { ok: false, message: '7z list failed: ' + lout.trim().slice(-300) };
        }
        const idx = lout.indexOf('----------');
        const counts = {};
        const re = /^Path = (.*)$/gm;
        let mm;
        const body = idx >= 0 ? lout.slice(idx) : lout;
        while ((mm = re.exec(body))) {
          const first = mm[1].trim().split(/[\\/]/)[0];
          if (first) counts[first] = (counts[first] || 0) + 1;
        }
        top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || '';
        if (!top) return { ok: false, message: tr('আর্কাইভের ভেতরে কিছু পাওয়া যায়নি', 'The archive is empty') };
        let lastP = -20;
        const xr = await run(sevenZ, ['x', info.archive, '-o' + tmp, '-y', '-bsp1', ...pwArgs, ...picks.map((p) => top + '\\' + p.name)], {
          timeout: 6 * 3600 * 1000,
          onData: (chunk) => {
            const m = chunk.match(/(\d{1,3})%/g);
            if (!m) return;
            const p = parseInt(m[m.length - 1], 10);
            if (ctx.onProgress) ctx.onProgress(`Restore www ${p}%`);
            if (p >= lastP + 20) {
              lastP = p;
              log(`  restore extract: ${p}%`);
            }
          },
        });
        const xout = xr.stdout + xr.stderr;
        if (!xr.ok && xr.code !== 1) {
          if (wrongPw(xout)) return { ok: false, wrongPassword: true, message: tr('পাসওয়ার্ড ভুল', 'Wrong password') };
          return { ok: false, message: `7z extract failed (exit code ${xr.code}): ` + xout.trim().slice(-300) };
        }
        if (xr.code === 1) warnings.push(tr('7-Zip সতর্কতা দিয়েছে (কিছু ফাইল এড়ানো হতে পারে), বিস্তারিত log-এ', '7-Zip reported warnings (some files may have been skipped), see the log'));
      } else {
        const tarExe = ctx.tarExe || (win ? 'tar.exe' : 'tar');
        const r = await run(tarExe, ['-xf', info.archive, '-C', tmp], {});
        if (!r.ok) return { ok: false, message: ('tar failed: ' + r.stderr).slice(0, 400) };
        const dirs = fs.readdirSync(tmp, { withFileTypes: true }).filter((e) => e.isDirectory());
        top = dirs.length ? dirs[0].name : '';
        if (!top) return { ok: false, message: tr('আর্কাইভের ভেতরে কিছু পাওয়া যায়নি', 'The archive is empty') };
      }
      const wwwRoot = path.join(tmp, top);
      const taken = (n) => fs.existsSync(path.join(www, n));
      for (const p of picks) {
        const src = path.join(wwwRoot, p.name);
        if (!fs.existsSync(src)) {
          results.push({ name: p.name, ok: false, message: tr('আর্কাইভে পাওয়া যায়নি', 'not found in the archive') });
          continue;
        }
        let finalName = p.name;
        let action = 'new';
        if (taken(p.name)) {
          if (p.mode === 'overwrite') action = 'merged';
          else {
            finalName = p.name + '-restored';
            for (let i = 2; taken(finalName); i++) finalName = `${p.name}-restored-${i}`;
            action = 'renamed';
          }
        }
        try {
          if (action === 'merged') await fs.promises.cp(src, path.join(www, finalName), { recursive: true, force: true });
          else await moveDir(src, path.join(www, finalName));
          const notes = makeRunnable(www, p.name, finalName, info.excluded);
          results.push({ name: p.name, final: finalName, action, ok: true, notes });
          log(`  restored ${p.name} -> ${finalName} (${action})`);
        } catch (e) {
          results.push({ name: p.name, ok: false, message: e.message });
          log(`  [FAIL] restore ${p.name}: ${e.message}`);
        }
      }
      if (!info.complete) warnings.push(tr('এই backup আংশিক (complete নয়): ' + (info.failedSteps.join(', ') || '?'), 'This backup is partial (not complete): ' + (info.failedSteps.join(', ') || '?')));
      if (info.copyFolders.length) warnings.push(tr('আলাদা copy হিসেবে রাখা ফোল্ডার (' + info.copyFolders.join(', ') + ') এখানে ফেরত আসে না, ধাপ ৪-এ আসবে', 'Folders kept as plain copies (' + info.copyFolders.join(', ') + ') are not restored here, step 4 will do that'));
      return { ok: results.some((r) => r.ok), results, warnings, folders: results.filter((r) => r.ok).map((r) => r.final) };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      restoring = false;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  // ---------- Restore, step 3: MySQL ডাটাবেস ফেরত আনা ----------
  // backup-এ database.7z-এর ভেতরে db\mysql.sql (mysqldump --databases, সব ইউজার-ডাটাবেস একটা ফাইলে)।
  // আমরা ফাইলটাকে ডাটাবেস ধরে ভাগ করি (header + প্রতিটা "-- Current Database:" অংশ + footer), তারপর বাছা প্রতিটার জন্য আলাদা mysql চালাই,
  // তাই একটা ব্যর্থ হলে অন্যগুলো আটকায় না। নাম মিললে: rename (<নাম>_restored, পুরনো অক্ষত) বা overwrite (আগে পুরনোটার safety dump, তারপর DROP + import)।
  // PostgreSQL এখানে নেই (postgres.sql আলাদা ধাপে)।
  const SAFE_DB = (n) => typeof n === 'string' && n.length > 0 && n.length <= 64 && !/[`\\/\r\n\0]/.test(n) && !SYSTEM_MYSQL_DBS.has(n.toLowerCase());
  const DB_MARK = /^-- Current Database: `(.*)`\s*$/;
  const DB_FOOT = /^\/\*!40103 SET TIME_ZONE=@OLD_TIME_ZONE \*\/;/;

  function dbArchiveOf(item) {
    const f = item.files.find((x) => x.exists && /^database\.(7z|zip)$/i.test(x.name));
    return f ? path.join(item.dir, f.name) : '';
  }
  function mysqlTools() {
    const bin = path.join(ctx.mysqlDir(), 'bin');
    return { mysqlExe: path.join(bin, 'mysql.exe'), dumpExe: path.join(bin, 'mysqldump.exe'), common: ['--no-defaults', '-u', 'root', '-h', '127.0.0.1', '-P', String(ctx.mysqlPort())] };
  }
  async function listMysqlDbs() {
    const { mysqlExe, common } = mysqlTools();
    if (!fs.existsSync(mysqlExe)) return { ok: false, installed: false, message: 'MySQL not installed' };
    const r = await run(mysqlExe, [...common, '-N', '-B', '-e', 'SHOW DATABASES'], { env: ctx.mysqlEnv(), timeout: 60000 });
    if (!r.ok) return { ok: false, installed: true, notRunning: /2003|10061|Can't connect/i.test(r.stderr || ''), message: (r.stderr || '').trim().slice(0, 200) };
    return { ok: true, installed: true, dbs: r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) };
  }

  async function restoreDbInfo(dir) {
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tr('ফোল্ডার দেওয়া হয়নি', 'No folder given') };
    const item = readBackupDir(dir, 'custom');
    if (!item.manifest) return { ok: false, message: tr('manifest.json নেই বা পড়া যায় না, তাই ডাটাবেস restore করা যাবে না', 'manifest.json is missing or unreadable, so databases cannot be restored') };
    const archive = dbArchiveOf(item);
    if (!archive) return { ok: false, message: tr('এই backup-এ ডাটাবেস আর্কাইভ নেই', 'This backup has no database archive') };
    if (!item.mysqlDbs.length) return { ok: false, message: tr('এই backup-এ কোনো MySQL ডাটাবেস নেই', 'This backup has no MySQL databases') };
    const cur = await listMysqlDbs();
    const have = cur.ok ? new Set(cur.dbs.map((x) => x.toLowerCase())) : null;
    const dbs = item.mysqlDbs.filter(SAFE_DB).map((name) => ({ name, exists: have ? have.has(name.toLowerCase()) : null }));
    return {
      ok: true,
      archive,
      encrypted: item.encrypted,
      complete: item.complete,
      failedSteps: item.failedSteps,
      dbs,
      skippedNames: item.mysqlDbs.filter((n) => !SAFE_DB(n)),
      postgres: item.postgres,
      mysqlInstalled: cur.installed !== false,
      mysqlRunning: !!cur.ok,
      sevenZip: !!find7z(),
    };
  }

  // mysql.sql-কে ভাগ করা: { header[], footer[], sections:[{name, file}] }; ফাইল latin1 পড়া/লেখা (বাইনারি কলামের বাইট অক্ষত থাকে)
  async function splitMysqlDump(file, outDir) {
    const header = [];
    const footer = [];
    const sections = [];
    let cur = null;
    let mode = 'header';
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const mk = DB_MARK.exec(line);
        if (mk && mode !== 'footer') {
          if (cur) await closeStream(cur.stream);
          const name = Buffer.from(mk[1], 'latin1').toString('utf8');
          const f = path.join(outDir, 'sec-' + sections.length + '.sql');
          cur = { name, file: f, stream: fs.createWriteStream(f, { encoding: 'latin1' }) };
          sections.push({ name, file: f });
          mode = 'section';
        } else if (mode === 'section' && DB_FOOT.test(line)) {
          mode = 'footer';
          footer.push(line);
          continue;
        }
        if (mode === 'header') header.push(line);
        else if (mode === 'footer') footer.push(line);
        else await writeLatin1(cur.stream, line + '\n');
      }
    } finally {
      rl.close();
      if (cur) await closeStream(cur.stream).catch(() => {});
    }
    return { header, footer, sections };
  }

  // বাছা ডাটাবেসের জন্য চালানোর SQL ফাইল: header + [DROP] + অংশ (নাম বদলালে CREATE/USE লাইন বদলে) + footer
  async function buildRunFile(runFile, parts, sec, oldName, newName, drop) {
    const out = fs.createWriteStream(runFile, { encoding: 'latin1' });
    const oldL = '`' + toL1(oldName) + '`';
    const newL = '`' + toL1(newName) + '`';
    const rename = newName !== oldName;
    let qualified = 0;
    let seenCreate = false;
    let seenUse = false;
    try {
      for (const l of parts.header) await writeLatin1(out, l + '\n');
      if (drop) await writeLatin1(out, 'DROP DATABASE IF EXISTS ' + oldL + ';\n');
      const rl = readline.createInterface({ input: fs.createReadStream(sec.file, { encoding: 'latin1' }), crlfDelay: Infinity });
      for await (let line of rl) {
        if (rename) {
          if (!seenCreate && /^CREATE DATABASE\b/.test(line)) {
            line = line.replace(oldL, newL);
            seenCreate = true;
          } else if (!seenUse && line.startsWith('USE ' + oldL)) {
            line = line.replace(oldL, newL);
            seenUse = true;
          } else if (line.includes(oldL + '.')) qualified++;
        }
        await writeLatin1(out, line + '\n');
      }
      for (const l of parts.footer) await writeLatin1(out, l + '\n');
    } finally {
      await closeStream(out).catch(() => {});
    }
    return { qualified, renamedOk: !rename || (seenCreate && seenUse) };
  }

  function freeDbName(base, taken) {
    const lower = new Set([...taken].map((x) => x.toLowerCase()));
    for (let i = 1; i < 1000; i++) {
      const suf = i === 1 ? '_restored' : '_restored' + i;
      const nm = base.slice(0, 64 - suf.length) + suf;
      if (!lower.has(nm.toLowerCase())) return nm;
    }
    return '';
  }

  async function restoreMysql(opts) {
    if (restoring) return { ok: false, message: tr('আরেকটা restore চলছে', 'Another restore is running') };
    if (running) return { ok: false, message: tr('একটা backup চলছে, শেষ হলে চেষ্টা করুন', 'A backup is running, try again when it has finished') };
    const info = await restoreDbInfo(opts && opts.dir);
    if (!info.ok) return info;
    if (!info.mysqlInstalled) return { ok: false, message: tr('MySQL ইনস্টল করা নেই; আগে Services পেজ থেকে MySQL চালু করুন', 'MySQL is not installed; start MySQL once from the Services page first') };
    const valid = new Set(info.dbs.map((d) => d.name));
    const picks = (Array.isArray(opts.picks) ? opts.picks : []).filter((p) => p && valid.has(p.name));
    if (!picks.length) return { ok: false, message: tr('কোনো ডাটাবেস বাছা হয়নি', 'No database selected') };
    const password = typeof opts.password === 'string' ? opts.password : '';
    if (info.encrypted && !password) return { ok: false, needPassword: true, message: tr('এই backup পাসওয়ার্ড দিয়ে encrypted, পাসওয়ার্ড দিন', 'This backup is encrypted, enter the password') };
    const sevenZ = find7z();
    const is7z = /\.7z$/i.test(info.archive);
    if (is7z && !sevenZ) return { ok: false, message: tr('7-Zip নেই; Backup পেজ থেকে ইনস্টল করুন', '7-Zip is missing; install it from the Backup page') };
    const wrongPw = (x) => /wrong password|cannot open encrypted archive|can not open encrypted archive|data error in encrypted/i.test(x);
    const stamp = stampOf();
    const tmp = path.join(tmpRoot(), 'restore-db-' + stamp);
    const results = [];
    const warnings = [];
    let startedHere = false;
    restoring = true;
    try {
      fs.mkdirSync(tmp, { recursive: true });
      log(`Restore MySQL: ${info.archive} -> ${picks.length} database(s): ${picks.map((p) => p.name + '(' + (p.mode || 'rename') + ')').join(', ')}`);
      // ১) আর্কাইভ খোলা (শুধু dump ফাইল, ছোট)
      if (ctx.onProgress) ctx.onProgress('Restore: reading database archive');
      const exDir = path.join(tmp, 'x');
      fs.mkdirSync(exDir, { recursive: true });
      if (sevenZ) {
        const xr = await run(sevenZ, ['x', info.archive, '-o' + exDir, '-y', ...(password ? ['-p' + password] : [])], { timeout: 6 * 3600 * 1000 });
        const xout = xr.stdout + xr.stderr;
        if (!xr.ok && xr.code !== 1) {
          if (wrongPw(xout)) return { ok: false, wrongPassword: true, message: tr('পাসওয়ার্ড ভুল', 'Wrong password') };
          return { ok: false, message: `7z extract failed (exit code ${xr.code}): ` + xout.trim().slice(-300) };
        }
        if (xr.code === 1) warnings.push(tr('7-Zip সতর্কতা দিয়েছে, বিস্তারিত log-এ', '7-Zip reported warnings, see the log'));
      } else {
        const tarExe = ctx.tarExe || (win ? 'tar.exe' : 'tar');
        const r = await run(tarExe, ['-xf', info.archive, '-C', exDir], {});
        if (!r.ok) return { ok: false, message: ('tar failed: ' + r.stderr).slice(0, 400) };
      }
      const findSql = (d, depth) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isFile() && e.name.toLowerCase() === 'mysql.sql') return path.join(d, e.name);
        }
        if (depth > 0) {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (e.isDirectory()) {
              const r = findSql(path.join(d, e.name), depth - 1);
              if (r) return r;
            }
          }
        }
        return '';
      };
      const sqlFile = findSql(exDir, 2);
      if (!sqlFile) return { ok: false, message: tr('আর্কাইভে mysql.sql পাওয়া যায়নি', 'mysql.sql was not found in the archive') };

      // ২) MySQL চালু আছে কি; না থাকলে চালু করা (বন্ধ করি না: সাইটগুলো এখন এটা চাইবে)
      let cur = await listMysqlDbs();
      if (!cur.ok && cur.notRunning && ctx.startDb) {
        log('  MySQL is not running, starting it for the restore ...');
        if (ctx.onProgress) ctx.onProgress('Restore: starting MySQL');
        const sr = await ctx.startDb('mysql').catch((e) => ({ ok: false, message: e.message }));
        if (!sr || !sr.ok) return { ok: false, message: tr('MySQL চালু করা যায়নি: ', 'Could not start MySQL: ') + String((sr && sr.message) || '').slice(0, 200) };
        startedHere = true;
        cur = await listMysqlDbs();
      }
      if (!cur.ok) return { ok: false, message: tr('MySQL-এ ঢোকা যায়নি: ', 'Cannot connect to MySQL: ') + (cur.message || '') };
      const taken = new Set(cur.dbs);

      // ৩) dump ভাগ করা
      if (ctx.onProgress) ctx.onProgress('Restore: splitting the dump');
      const secDir = path.join(tmp, 'sec');
      fs.mkdirSync(secDir, { recursive: true });
      const parts = await splitMysqlDump(sqlFile, secDir);
      log(`  dump has ${parts.sections.length} database section(s): ${parts.sections.map((x) => x.name).join(', ')}`);
      const { mysqlExe, dumpExe, common } = mysqlTools();
      const env = ctx.mysqlEnv();
      const preDir = path.join(baseDir(), 'pre-restore', stamp);

      // ৪) প্রতিটা বাছা ডাটাবেস
      for (const p of picks) {
        const sec = parts.sections.find((x) => x.name === p.name);
        if (!sec) {
          results.push({ name: p.name, ok: false, message: tr('dump-এ পাওয়া যায়নি', 'not found in the dump') });
          continue;
        }
        const clash = [...taken].some((x) => x.toLowerCase() === p.name.toLowerCase());
        let finalName = p.name;
        let action = 'new';
        let drop = false;
        if (clash) {
          if (p.mode === 'overwrite') {
            action = 'overwritten';
            drop = true;
          } else {
            finalName = freeDbName(p.name, taken);
            action = 'renamed';
            if (!finalName) {
              results.push({ name: p.name, ok: false, message: tr('নতুন নাম পাওয়া গেল না', 'no free name found') });
              continue;
            }
          }
        }
        const res = { name: p.name, final: finalName, action, ok: false, notes: [] };
        try {
          if (ctx.onProgress) ctx.onProgress(`Restore: ${p.name}`);
          // overwrite: আগে পুরনোটার safety dump; না হলে কিছুই মোছা হয় না
          if (drop) {
            fs.mkdirSync(preDir, { recursive: true });
            const pre = path.join(preDir, p.name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.sql');
            const dr = await run(dumpExe, [...common, '--single-transaction', '--quick', '--routines', '--triggers', '--events', '--default-character-set=utf8mb4', '--databases', p.name, '--result-file=' + pre], { env, timeout: 3600000 });
            if (!dr.ok) {
              res.message = tr('পুরনো ডাটাবেসের safety dump হয়নি, তাই কিছু মোছা হয়নি: ', 'Safety dump of the old database failed, so nothing was dropped: ') + (dr.stderr || '').trim().slice(0, 200);
              results.push(res);
              log(`  [FAIL] ${p.name}: ${res.message}`);
              continue;
            }
            res.preDump = pre;
            res.notes.push(tr('পুরনো ডাটাবেসের কপি রাখা আছে: ' + pre, 'A copy of the old database was saved: ' + pre));
          }
          const runFile = path.join(tmp, 'run-' + results.length + '.sql');
          const br = await buildRunFile(runFile, parts, sec, p.name, finalName, drop);
          if (!br.renamedOk) {
            res.message = tr('dump-এর CREATE/USE লাইন চেনা গেল না, নাম বদলানো যায়নি', 'Could not find the CREATE/USE lines in the dump, cannot rename');
            results.push(res);
            continue;
          }
          if (br.qualified) res.notes.push(tr(`${br.qualified}টা লাইনে (view/trigger) পুরনো ডাটাবেসের নাম লেখা আছে, নতুন নামে সেগুলো পুরনোটার দিকেই দেখাতে পারে`, `${br.qualified} line(s) (views/triggers) mention the old database name and may still point to the old one`));
          const ir = await runWithFile(mysqlExe, [...common, '--default-character-set=utf8mb4'], runFile, { env });
          try {
            fs.rmSync(runFile, { force: true });
          } catch {}
          if (!ir.ok) {
            res.message = `mysql import failed (exit code ${ir.code}): ` + (ir.stderr || ir.stdout).trim().slice(-300);
            if (drop) res.notes.push(tr('ডাটাবেস আংশিক থাকতে পারে; উপরের safety dump থেকে ফেরত নেওয়া যাবে', 'The database may be partial; the safety dump above can bring it back'));
            results.push(res);
            log(`  [FAIL] ${p.name}: ${res.message}`);
            continue;
          }
          const cnt = await run(mysqlExe, [...common, '-N', '-B', '-e', `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${finalName.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`], { env, timeout: 60000 });
          res.tables = cnt.ok ? parseInt(cnt.stdout.trim(), 10) : null;
          res.ok = true;
          taken.add(finalName);
          results.push(res);
          log(`  restored ${p.name} -> ${finalName} (${action}${res.tables != null ? ', ' + res.tables + ' tables' : ''})`);
        } catch (e) {
          res.message = e.message;
          results.push(res);
          log(`  [FAIL] ${p.name}: ${e.message}`);
        }
      }
      if (!info.complete) warnings.push(tr('এই backup আংশিক (complete নয়): ' + (info.failedSteps.join(', ') || '?'), 'This backup is partial (not complete): ' + (info.failedSteps.join(', ') || '?')));
      if (results.some((r) => r.ok && r.action === 'renamed')) warnings.push(tr('নতুন নামে রাখা ডাটাবেস সাইটের .env / wp-config.php-তে নিজে থেকে বসে না; সাইট ওই নামে চালাতে চাইলে ফাইলে নামটা বদলান', 'A database restored under a new name is not wired into any site (.env / wp-config.php); edit the file if a site should use it'));
      if (info.postgres) warnings.push(tr('PostgreSQL ডাম্প (postgres.sql) আলাদা বোতামে ফেরত আনা হয়: "PostgreSQL ডাটাবেস ফেরত আনুন"', 'The PostgreSQL dump (postgres.sql) is restored with its own button: "Restore PostgreSQL databases"'));
      if (startedHere) warnings.push(tr('MySQL এই restore-এর জন্য চালু করা হয়েছিল, চালু অবস্থায় রাখা আছে', 'MySQL was started for this restore and is left running'));
      return { ok: results.some((r) => r.ok), results, warnings };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      restoring = false;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  // ---------- Restore, step 3b: PostgreSQL ডাটাবেস ফেরত আনা ----------
  // backup-এ database.7z-এর ভেতরে db\postgres.sql (pg_dumpall)। প্রতিটা ইউজার-ডাটাবেসের অংশ এরকম (PostgreSQL 18.6-এ আসল ফাইলে দেখা):
  //   \restrict <key> ... CREATE DATABASE <নাম> WITH ...; ... \unrestrict <key>   (তৈরির ব্লক)
  //   \connect <নাম>
  //   \restrict <key> ... ডেটা ... \unrestrict <key>
  // postgres / template1 অংশে CREATE DATABASE থাকে না (ফেরত আনা হয় না); role-গুলো (CREATE ROLE) ফেরত আনা হয় না।
  // ফাইলটা latin1 লাইনে পড়ি (বাইট ঠিক থাকে), CREATE DATABASE-ওয়ালা ব্লক থেকে অংশ শুরু, একই নামের \connect-এর পরের ব্লক সেই অংশে যায়।
  // নাম মিললে: rename (<নাম>_restored, পুরনো অক্ষত) বা overwrite (আগে পুরনোটার pg_dump safety copy, তারপর DROP + import)।
  const SAFE_PGDB = (n) => typeof n === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_$-]{0,62}$/.test(n) && !['postgres', 'template0', 'template1'].includes(n);
  const pgIdent = (n) => '"' + String(n).replace(/"/g, '""') + '"';
  const parsePgIdent = (s) => {
    const m = /^\s*("(?:[^"]|"")*"|[^\s;"]+)/.exec(s || '');
    if (!m) return '';
    const v = m[1];
    return v[0] === '"' ? v.slice(1, -1).replace(/""/g, '"') : v;
  };
  const PG_BLOCK_MAX = 3000; // CREATE DATABASE-ওয়ালা ব্লক ছোট; এর চেয়ে বড় ব্লক (বড় ডেটা) ইউজার-ডাটাবেসের তৈরির ব্লক নয়

  function pgTools() {
    const bin = path.join(ctx.pgDir(), 'bin');
    return {
      psql: path.join(bin, 'psql.exe'),
      dump: path.join(bin, 'pg_dump.exe'),
      common: ['-X', '-q', '-w', '-h', '127.0.0.1', '-p', String(ctx.pgPort()), '-U', 'postgres'],
    };
  }
  async function listPgDbs() {
    const { psql, common } = pgTools();
    if (!fs.existsSync(psql)) return { ok: false, installed: false, message: 'PostgreSQL not installed' };
    const r = await run(psql, [...common, '-d', 'postgres', '-A', '-t', '-c', 'SELECT datname FROM pg_database ORDER BY 1'], { env: ctx.pgEnv(), timeout: 60000 });
    if (!r.ok) return { ok: false, installed: true, notRunning: /could not connect|connection refused|timeout expired|10061/i.test(r.stderr || ''), message: (r.stderr || '').trim().slice(0, 200) };
    return { ok: true, installed: true, dbs: r.stdout.split(/\r?\n/).map((x) => x.trim()).filter(Boolean) };
  }

  // postgres.sql ভাগ করা। outDir দিলে প্রতি ইউজার-ডাটাবেসের জন্য সেকশন ফাইল লেখে; না দিলে শুধু নামগুলো (restorePgInfo)।
  async function splitPgDump(file, outDir) {
    const sections = [];
    let cur = null; // { name, file, stream, connected }
    let inBlock = false;
    let direct = false; // ব্লকটা সরাসরি cur-এ লিখছি (ডেটা ব্লক)
    let buf = [];
    let overflow = false;
    let createName = '';
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'latin1' }), crlfDelay: Infinity });
    const put = async (c, line) => {
      if (c && c.stream) await writeLatin1(c.stream, line + '\n');
    };
    const closeCur = async () => {
      if (cur && cur.stream) await closeStream(cur.stream).catch(() => {});
      cur = null;
    };
    try {
      for await (const line of rl) {
        if (!inBlock) {
          if (line.charCodeAt(0) === 92 /* \ */) {
            if (line.startsWith('\\restrict ')) {
              inBlock = true;
              if (cur && cur.connected) {
                direct = true;
                await put(cur, line);
              } else {
                direct = false;
                buf = [line];
                overflow = false;
                createName = '';
              }
              continue;
            }
            const mc = /^\\connect\s+(.*)$/.exec(line);
            if (mc) {
              const nm = parsePgIdent(mc[1]);
              if (cur && cur.name === nm) {
                cur.connected = true;
                await put(cur, line);
              } else {
                await closeCur();
              }
              continue;
            }
          }
          if (cur) await put(cur, line); // ব্লকের বাইরের বাকি লাইন (ফাঁকা/মন্তব্য)
          continue;
        }
        // ব্লকের ভেতরে
        if (direct) {
          await put(cur, line);
          if (line.startsWith('\\unrestrict ')) {
            inBlock = false;
            direct = false;
            await closeCur(); // ডেটা ব্লক শেষ = এই ডাটাবেসের অংশ শেষ; পরের \restrict নতুন ডাটাবেসের হতে পারে
          }
          continue;
        }
        if (!overflow) {
          buf.push(line);
          if (!createName && line.startsWith('CREATE DATABASE ')) createName = parsePgIdent(line.slice(16));
          if (buf.length > PG_BLOCK_MAX) {
            overflow = true;
            buf = [];
          }
        }
        if (line.startsWith('\\unrestrict ')) {
          inBlock = false;
          if (!overflow && createName) {
            await closeCur();
            if (outDir) {
              const f = path.join(outDir, 'pg-' + sections.length + '.sql');
              cur = { name: createName, file: f, stream: fs.createWriteStream(f, { encoding: 'latin1' }), connected: false };
              for (const l of buf) await put(cur, l);
            } else {
              cur = { name: createName, file: '', stream: null, connected: false };
            }
            sections.push({ name: createName, file: cur.file });
          }
          buf = [];
        }
      }
    } finally {
      rl.close();
      await closeCur();
    }
    return { sections };
  }

  // বাছা অংশের চালানোর ফাইল: নাম বদলালে তৈরির ব্লকের CREATE/ALTER/COMMENT DATABASE আর \connect লাইনে নতুন নাম
  async function buildPgRunFile(runFile, secFile, oldName, newName, rename) {
    const out = fs.createWriteStream(runFile, { encoding: 'latin1' });
    let seenCreate = false;
    let seenConnect = false;
    let phase = 0; // 0 = \connect-এর আগে (তৈরির ব্লক)
    const nid = pgIdent(newName);
    const rl = readline.createInterface({ input: fs.createReadStream(secFile, { encoding: 'latin1' }), crlfDelay: Infinity });
    try {
      for await (let line of rl) {
        if (rename && phase === 0) {
          let m;
          if (line.startsWith('CREATE DATABASE ') && (m = /^CREATE DATABASE\s+("(?:[^"]|"")*"|\S+)(.*)$/.exec(line)) && parsePgIdent(m[1]) === oldName) {
            line = 'CREATE DATABASE ' + nid + m[2];
            seenCreate = true;
          } else if (line.startsWith('ALTER DATABASE ') && (m = /^ALTER DATABASE\s+("(?:[^"]|"")*"|\S+)(.*)$/.exec(line)) && parsePgIdent(m[1]) === oldName) {
            line = 'ALTER DATABASE ' + nid + m[2];
          } else if (line.startsWith('COMMENT ON DATABASE ') && (m = /^COMMENT ON DATABASE\s+("(?:[^"]|"")*"|\S+)(.*)$/.exec(line)) && parsePgIdent(m[1]) === oldName) {
            line = 'COMMENT ON DATABASE ' + nid + m[2];
          } else if (line.startsWith('\\connect ') && parsePgIdent(line.slice(9)) === oldName) {
            line = '\\connect ' + nid;
            seenConnect = true;
          }
        }
        if (phase === 0 && line.startsWith('\\connect ')) phase = 1;
        await writeLatin1(out, line + '\n');
      }
    } finally {
      rl.close();
      await closeStream(out).catch(() => {});
    }
    return { renamedOk: !rename || (seenCreate && seenConnect) };
  }

  function freePgName(base, taken) {
    const have = new Set([...taken]);
    for (let i = 1; i < 1000; i++) {
      const suf = i === 1 ? '_restored' : '_restored' + i;
      const nm = base.slice(0, 63 - suf.length) + suf;
      if (!have.has(nm)) return nm;
    }
    return '';
  }

  // database.7z/zip থেকে db\postgres.sql বের করা; ফেরত { ok, file } বা { ok:false, ... }
  async function extractPgSql(archive, password, exDir, warnings) {
    const sevenZ = find7z();
    const is7z = /\.7z$/i.test(archive);
    if (is7z && !sevenZ) return { ok: false, message: tr('7-Zip নেই; Backup পেজ থেকে ইনস্টল করুন', '7-Zip is missing; install it from the Backup page') };
    const wrongPw = (x) => /wrong password|cannot open encrypted archive|can not open encrypted archive|data error in encrypted/i.test(x);
    fs.mkdirSync(exDir, { recursive: true });
    if (sevenZ) {
      const xr = await run(sevenZ, ['x', archive, '-o' + exDir, '-y', ...(password ? ['-p' + password] : [])], { timeout: 6 * 3600 * 1000 });
      const xout = xr.stdout + xr.stderr;
      if (!xr.ok && xr.code !== 1) {
        if (wrongPw(xout)) return { ok: false, wrongPassword: true, message: tr('পাসওয়ার্ড ভুল', 'Wrong password') };
        return { ok: false, message: `7z extract failed (exit code ${xr.code}): ` + xout.trim().slice(-300) };
      }
      if (xr.code === 1 && warnings) warnings.push(tr('7-Zip সতর্কতা দিয়েছে, বিস্তারিত log-এ', '7-Zip reported warnings, see the log'));
    } else {
      const tarExe = ctx.tarExe || (win ? 'tar.exe' : 'tar');
      const r = await run(tarExe, ['-xf', archive, '-C', exDir], {});
      if (!r.ok) return { ok: false, message: ('tar failed: ' + r.stderr).slice(0, 400) };
    }
    const find = (d, depth) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isFile() && e.name.toLowerCase() === 'postgres.sql') return path.join(d, e.name);
      if (depth > 0) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) {
            const r = find(path.join(d, e.name), depth - 1);
            if (r) return r;
          }
        }
      }
      return '';
    };
    const file = find(exDir, 2);
    if (!file) return { ok: false, message: tr('আর্কাইভে postgres.sql পাওয়া যায়নি', 'postgres.sql was not found in the archive') };
    return { ok: true, file };
  }

  // শুধু পড়ে: dump-এ কোন কোন ডাটাবেস আছে (পাসওয়ার্ড লাগে, কারণ নামগুলো মূল ফাইলের ভেতরে) আর PostgreSQL-এ এখন কোনটা আছে
  async function restorePgInfo(opts) {
    if (restoring) return { ok: false, message: tr('আরেকটা restore চলছে', 'Another restore is running') };
    const dir = opts && opts.dir;
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tr('ফোল্ডার দেওয়া হয়নি', 'No folder given') };
    const item = readBackupDir(dir, 'custom');
    if (!item.manifest) return { ok: false, message: tr('manifest.json নেই বা পড়া যায় না, তাই ডাটাবেস restore করা যাবে না', 'manifest.json is missing or unreadable, so databases cannot be restored') };
    const archive = dbArchiveOf(item);
    if (!archive) return { ok: false, message: tr('এই backup-এ ডাটাবেস আর্কাইভ নেই', 'This backup has no database archive') };
    if (!item.postgres) return { ok: false, message: tr('এই backup-এ PostgreSQL ডাম্প নেই', 'This backup has no PostgreSQL dump') };
    const password = typeof (opts && opts.password) === 'string' ? opts.password : '';
    if (item.encrypted && !password) return { ok: false, needPassword: true, message: tr('এই backup পাসওয়ার্ড দিয়ে encrypted, পাসওয়ার্ড দিন', 'This backup is encrypted, enter the password') };
    const tmp = path.join(tmpRoot(), 'restore-pginfo-' + stampOf());
    restoring = true;
    try {
      const ex = await extractPgSql(archive, password, path.join(tmp, 'x'), null);
      if (!ex.ok) return ex;
      const parts = await splitPgDump(ex.file, null);
      const cur = await listPgDbs();
      const have = cur.ok ? new Set(cur.dbs) : null;
      const names = [...new Set(parts.sections.map((s) => s.name))];
      return {
        ok: true,
        encrypted: item.encrypted,
        complete: item.complete,
        failedSteps: item.failedSteps,
        dbs: names.filter(SAFE_PGDB).map((name) => ({ name, exists: have ? have.has(name) : null })),
        skippedNames: names.filter((n) => !SAFE_PGDB(n)),
        pgInstalled: cur.installed !== false,
        pgRunning: !!cur.ok,
        sevenZip: !!find7z(),
      };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      restoring = false;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  async function restorePg(opts) {
    if (restoring) return { ok: false, message: tr('আরেকটা restore চলছে', 'Another restore is running') };
    if (running) return { ok: false, message: tr('একটা backup চলছে, শেষ হলে চেষ্টা করুন', 'A backup is running, try again when it has finished') };
    const dir = opts && opts.dir;
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tr('ফোল্ডার দেওয়া হয়নি', 'No folder given') };
    const item = readBackupDir(dir, 'custom');
    if (!item.manifest) return { ok: false, message: tr('manifest.json নেই বা পড়া যায় না, তাই ডাটাবেস restore করা যাবে না', 'manifest.json is missing or unreadable, so databases cannot be restored') };
    const archive = dbArchiveOf(item);
    if (!archive) return { ok: false, message: tr('এই backup-এ ডাটাবেস আর্কাইভ নেই', 'This backup has no database archive') };
    if (!item.postgres) return { ok: false, message: tr('এই backup-এ PostgreSQL ডাম্প নেই', 'This backup has no PostgreSQL dump') };
    const password = typeof opts.password === 'string' ? opts.password : '';
    if (item.encrypted && !password) return { ok: false, needPassword: true, message: tr('এই backup পাসওয়ার্ড দিয়ে encrypted, পাসওয়ার্ড দিন', 'This backup is encrypted, enter the password') };
    const { psql, dump, common } = pgTools();
    if (!fs.existsSync(psql)) return { ok: false, message: tr('PostgreSQL ইনস্টল করা নেই; আগে Services পেজ থেকে PostgreSQL চালু করুন', 'PostgreSQL is not installed; start PostgreSQL once from the Services page first') };
    const picks = (Array.isArray(opts.picks) ? opts.picks : []).filter((p) => p && SAFE_PGDB(p.name));
    if (!picks.length) return { ok: false, message: tr('কোনো ডাটাবেস বাছা হয়নি', 'No database selected') };
    const stamp = stampOf();
    const tmp = path.join(tmpRoot(), 'restore-pg-' + stamp);
    const results = [];
    const warnings = [];
    let startedHere = false;
    restoring = true;
    try {
      fs.mkdirSync(tmp, { recursive: true });
      log(`Restore PostgreSQL: ${archive} -> ${picks.length} database(s): ${picks.map((p) => p.name + '(' + (p.mode || 'rename') + ')').join(', ')}`);
      if (ctx.onProgress) ctx.onProgress('Restore: reading database archive');
      const ex = await extractPgSql(archive, password, path.join(tmp, 'x'), warnings);
      if (!ex.ok) return ex;

      let cur = await listPgDbs();
      if (!cur.ok && cur.notRunning && ctx.startDb) {
        log('  PostgreSQL is not running, starting it for the restore ...');
        if (ctx.onProgress) ctx.onProgress('Restore: starting PostgreSQL');
        const sr = await ctx.startDb('postgres').catch((e) => ({ ok: false, message: e.message }));
        if (!sr || !sr.ok) return { ok: false, message: tr('PostgreSQL চালু করা যায়নি: ', 'Could not start PostgreSQL: ') + String((sr && sr.message) || '').slice(0, 200) };
        startedHere = true;
        cur = await listPgDbs();
      }
      if (!cur.ok) return { ok: false, message: tr('PostgreSQL-এ ঢোকা যায়নি: ', 'Cannot connect to PostgreSQL: ') + (cur.message || '') };
      const taken = new Set(cur.dbs);

      if (ctx.onProgress) ctx.onProgress('Restore: splitting the dump');
      const secDir = path.join(tmp, 'sec');
      fs.mkdirSync(secDir, { recursive: true });
      const parts = await splitPgDump(ex.file, secDir);
      log(`  dump has ${parts.sections.length} database section(s): ${parts.sections.map((x) => x.name).join(', ')}`);
      const env = ctx.pgEnv();
      const preDir = path.join(baseDir(), 'pre-restore', stamp);

      for (const p of picks) {
        const sec = parts.sections.find((x) => x.name === p.name);
        if (!sec) {
          results.push({ name: p.name, ok: false, message: tr('dump-এ পাওয়া যায়নি', 'not found in the dump') });
          continue;
        }
        const clash = taken.has(p.name);
        let finalName = p.name;
        let action = 'new';
        let drop = false;
        if (clash) {
          if (p.mode === 'overwrite') {
            action = 'overwritten';
            drop = true;
          } else {
            finalName = freePgName(p.name, taken);
            action = 'renamed';
            if (!finalName) {
              results.push({ name: p.name, ok: false, message: tr('নতুন নাম পাওয়া গেল না', 'no free name found') });
              continue;
            }
          }
        }
        const res = { name: p.name, final: finalName, action, ok: false, notes: [] };
        try {
          if (ctx.onProgress) ctx.onProgress(`Restore: ${p.name}`);
          if (drop) {
            // পুরনোটার safety copy আগে; না হলে কিছুই মোছা হয় না
            fs.mkdirSync(preDir, { recursive: true });
            const pre = path.join(preDir, 'pg_' + p.name.replace(/[^A-Za-z0-9_.-]/g, '_') + '.sql');
            const dr = await run(dump, ['-w', '-h', '127.0.0.1', '-p', String(ctx.pgPort()), '-U', 'postgres', '-d', p.name, '-f', pre], { env, timeout: 3600000 });
            if (!dr.ok) {
              try {
                fs.rmSync(pre, { force: true });
              } catch {}
              res.message = tr('পুরনো ডাটাবেসের safety dump হয়নি, তাই কিছু মোছা হয়নি: ', 'Safety dump of the old database failed, so nothing was dropped: ') + (dr.stderr || '').trim().slice(0, 200);
              results.push(res);
              log(`  [FAIL] ${p.name}: ${res.message}`);
              continue;
            }
            res.preDump = pre;
            res.notes.push(tr('পুরনো ডাটাবেসের কপি রাখা আছে: ' + pre, 'A copy of the old database was saved: ' + pre));
            const dd = await run(psql, [...common, '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${pgIdent(p.name)} WITH (FORCE)`], { env, timeout: 120000 });
            if (!dd.ok) {
              res.message = tr('পুরনো ডাটাবেস মোছা যায়নি (এখনো কেউ ব্যবহার করছে?): ', 'Could not drop the old database (is something still using it?): ') + (dd.stderr || '').trim().slice(0, 200);
              results.push(res);
              log(`  [FAIL] ${p.name}: ${res.message}`);
              continue;
            }
          }
          const rename = finalName !== p.name;
          let runFile = sec.file;
          if (rename) {
            runFile = path.join(tmp, 'run-' + results.length + '.sql');
            const br = await buildPgRunFile(runFile, sec.file, p.name, finalName, true);
            if (!br.renamedOk) {
              res.message = tr('dump-এর CREATE DATABASE / \\connect লাইন চেনা গেল না, নাম বদলানো যায়নি', 'Could not find the CREATE DATABASE / \\connect lines in the dump, cannot rename');
              results.push(res);
              continue;
            }
          }
          const ir = await runWithFile(psql, [...common, '-d', 'postgres'], runFile, { env });
          if (rename) {
            try {
              fs.rmSync(runFile, { force: true });
            } catch {}
          }
          const errLines = (ir.stderr || '').split(/\r?\n/).filter((l) => /\bERROR:|\bFATAL:/.test(l));
          const after = await listPgDbs();
          if (!after.ok || !after.dbs.includes(finalName)) {
            res.message = `psql import failed (exit code ${ir.code}): ` + (errLines.join(' | ') || (ir.stderr || ir.stdout || '').trim()).slice(-300);
            if (drop) res.notes.push(tr('ডাটাবেস নেই বা আংশিক; উপরের safety copy থেকে ফেরত নেওয়া যাবে', 'The database is missing or partial; the safety copy above can bring it back'));
            results.push(res);
            log(`  [FAIL] ${p.name}: ${res.message}`);
            continue;
          }
          const cnt = await run(psql, [...common, '-d', finalName, '-A', '-t', '-c', "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')"], { env, timeout: 60000 });
          res.tables = cnt.ok ? parseInt(cnt.stdout.trim(), 10) : null;
          if (errLines.length) res.notes.push(tr(`import-এ ${errLines.length}টা ত্রুটির লাইন ছিল (যেমন অনুপস্থিত role): ` + errLines.slice(0, 3).join(' | ').slice(0, 300), `The import printed ${errLines.length} error line(s) (for example a missing role): ` + errLines.slice(0, 3).join(' | ').slice(0, 300)));
          res.ok = true;
          taken.add(finalName);
          results.push(res);
          log(`  restored ${p.name} -> ${finalName} (${action}${res.tables != null ? ', ' + res.tables + ' tables' : ''}${errLines.length ? ', ' + errLines.length + ' error line(s)' : ''})`);
        } catch (e) {
          res.message = e.message;
          results.push(res);
          log(`  [FAIL] ${p.name}: ${e.message}`);
        }
      }
      if (!item.complete) warnings.push(tr('এই backup আংশিক (complete নয়): ' + (item.failedSteps.join(', ') || '?'), 'This backup is partial (not complete): ' + (item.failedSteps.join(', ') || '?')));
      warnings.push(tr('role/ইউজার (এবং postgres, template1) ফেরত আনা হয় না; মালিক role এই PostgreSQL-এ না থাকলে ownership-এর ত্রুটি আসতে পারে', 'Roles/users (and the postgres and template1 databases) are not restored; a missing owner role can print ownership errors'));
      if (results.some((r) => r.ok && r.action === 'renamed')) warnings.push(tr('নতুন নামে রাখা ডাটাবেস সাইটের কনফিগে নিজে থেকে বসে না; সাইট ওই নামে চালাতে চাইলে নামটা বদলান', 'A database restored under a new name is not wired into any site; change the name in the site config if a site should use it'));
      if (startedHere) warnings.push(tr('PostgreSQL এই restore-এর জন্য চালু করা হয়েছিল, চালু অবস্থায় রাখা আছে', 'PostgreSQL was started for this restore and is left running'));
      return { ok: results.some((r) => r.ok), results, warnings };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      restoring = false;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  // ---------- Restore, step 4a: নিজের ফোল্ডার (extra-N আর্কাইভ) আর plain copy (files\<label>) ----------
  // কখনো কিছু নিজে থেকে মুছি না, আর settings.json / সার্টিফিকেটে হাত দিই না (সেটা আলাদা ধাপ)।
  // extra-N: backup-এ মূল পথ রাখা নেই (শুধু নাম), তাই সবসময় নতুন ফোল্ডারে: <ROOT>\restored\<নাম>-<stamp>।
  // files\<label>: manifest-এ মূল পথ (source) আছে। মূল পথ না থাকলে সেখানেই বসে; থাকলে ব্যবহারকারী বাছে:
  //   rename (<পথ>_restored, পুরনো অক্ষত, ডিফল্ট) বা overwrite (merge: একই নামের ফাইল বদলায়, backup-এ নেই এমন ফাইল থেকে যায়)।
  // .versions আর .s360-state.json ফেরত আনা হয় না।
  const safeName = (s) => String(s).replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').trim().replace(/^\.+$/, '_') || 'folder';
  // www-এর সরাসরি সাবফোল্ডার হলে নতুন নাম '-restored' (হাইফেন): সাইট-স্ক্যান শুধু [a-z0-9-] নাম নেয়, '_' থাকলে সাইট হয় না। বাইরে '_restored'।
  function freeDirName(base) {
    if (!fs.existsSync(base)) return base;
    let direct = false;
    try {
      const www = ctx.wwwDir && ctx.wwwDir();
      direct = !!www && path.resolve(path.dirname(base)).toLowerCase() === path.resolve(www).toLowerCase();
    } catch {}
    for (let i = 1; i < 1000; i++) {
      const cand = direct ? base + (i === 1 ? '-restored' : '-restored-' + i) : base + (i === 1 ? '_restored' : '_restored' + i);
      if (!fs.existsSync(cand)) return cand;
    }
    return '';
  }
  function readManifestRaw(dir) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
  }
  function restoreOtherInfo(dir) {
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tr('ফোল্ডার দেওয়া হয়নি', 'No folder given') };
    const item = readBackupDir(dir, 'custom');
    const m = item.manifest ? readManifestRaw(dir) : null;
    if (!m) return { ok: false, message: tr('manifest.json নেই বা পড়া যায় না, তাই restore করা যাবে না', 'manifest.json is missing or unreadable, so nothing can be restored') };
    const extras = [];
    for (const x of item.extras) {
      const f = item.files.find((y) => y.exists && new RegExp('^extra-' + x.n + '\\.(7z|zip)$', 'i').test(y.name));
      extras.push({ n: x.n, label: x.label, archive: f ? path.join(dir, f.name) : '', target: path.join(ctx.rootDir(), 'restored', safeName(x.label) + '-' + item.stamp) });
    }
    const copies = [];
    const list = Array.isArray(m.copyFolders) ? m.copyFolders : [];
    for (const c of list) {
      if (!c || typeof c.label !== 'string') continue;
      const mm = /^files[\\/]([^\\/]+)$/.exec(String(c.folder || ''));
      if (!mm || mm[1] === '.' || mm[1] === '..') continue;
      const srcDir = path.join(path.dirname(dir), 'files', mm[1]);
      let exists = false;
      try {
        exists = fs.statSync(srcDir).isDirectory();
      } catch {}
      const source = typeof c.source === 'string' ? c.source : '';
      copies.push({ label: c.label, srcDir, exists, source, sourceExists: !!source && fs.existsSync(source) });
    }
    if (!extras.length && !copies.length) return { ok: false, message: tr('এই backup-এ নিজের ফোল্ডার বা আলাদা copy নেই', 'This backup has no own folders or plain copies') };
    return { ok: true, encrypted: item.encrypted, complete: item.complete, failedSteps: item.failedSteps, extras, copies, sevenZip: !!find7z(), restoredRoot: path.join(ctx.rootDir(), 'restored') };
  }

  async function restoreOther(opts) {
    if (restoring) return { ok: false, message: tr('আরেকটা restore চলছে', 'Another restore is running') };
    if (running) return { ok: false, message: tr('একটা backup চলছে, শেষ হলে চেষ্টা করুন', 'A backup is running, try again when it has finished') };
    const info = restoreOtherInfo(opts && opts.dir);
    if (!info.ok) return info;
    const picks = Array.isArray(opts.picks) ? opts.picks : [];
    const todo = [];
    for (const p of picks) {
      if (!p) continue;
      if (p.kind === 'extra') {
        const e = info.extras.find((x) => x.n === p.n);
        if (e) todo.push({ kind: 'extra', e });
      } else if (p.kind === 'copy') {
        const c = info.copies.find((x) => x.label === p.label);
        if (c) todo.push({ kind: 'copy', c, mode: p.mode === 'overwrite' ? 'overwrite' : 'rename' });
      }
    }
    if (!todo.length) return { ok: false, message: tr('কিছু বাছা হয়নি', 'Nothing selected') };
    const password = typeof opts.password === 'string' ? opts.password : '';
    if (info.encrypted && !password && todo.some((x) => x.kind === 'extra')) return { ok: false, needPassword: true, message: tr('এই backup পাসওয়ার্ড দিয়ে encrypted, পাসওয়ার্ড দিন', 'This backup is encrypted, enter the password') };
    const sevenZ = find7z();
    const wrongPw = (x) => /wrong password|cannot open encrypted archive|can not open encrypted archive|data error in encrypted/i.test(x);
    const results = [];
    const warnings = [];
    restoring = true;
    try {
      log(`Restore own folders: ${todo.map((x) => (x.kind === 'extra' ? 'extra-' + x.e.n : 'copy ' + x.c.label + '(' + x.mode + ')')).join(', ')}`);
      for (const x of todo) {
        if (x.kind === 'extra') {
          const e = x.e;
          const res = { kind: 'extra', name: e.label, ok: false, notes: [] };
          results.push(res);
          if (!e.archive) {
            res.message = tr('আর্কাইভ ফাইল নেই', 'archive file is missing');
            continue;
          }
          const is7z = /\.7z$/i.test(e.archive);
          if (is7z && !sevenZ) {
            res.message = tr('7-Zip নেই; Backup পেজ থেকে ইনস্টল করুন', '7-Zip is missing; install it from the Backup page');
            continue;
          }
          const target = freeDirName(e.target);
          if (!target) {
            res.message = tr('নতুন ফোল্ডারের নাম পাওয়া গেল না', 'no free folder name found');
            continue;
          }
          try {
            if (ctx.onProgress) ctx.onProgress(`Restore: ${e.label}`);
            fs.mkdirSync(target, { recursive: true });
            let r;
            if (sevenZ) {
              r = await run(sevenZ, ['x', e.archive, '-o' + target, '-y', ...(password ? ['-p' + password] : [])], { timeout: 6 * 3600 * 1000 });
            } else {
              r = await run(ctx.tarExe || (win ? 'tar.exe' : 'tar'), ['-xf', e.archive, '-C', target], {});
            }
            const out = r.stdout + r.stderr;
            if (!r.ok && r.code !== 1) {
              try {
                fs.rmSync(target, { recursive: true, force: true });
              } catch {}
              if (wrongPw(out)) {
                res.wrongPassword = true;
                res.message = tr('পাসওয়ার্ড ভুল', 'Wrong password');
              } else res.message = `extract failed (exit code ${r.code}): ` + out.trim().slice(-300);
              log(`  [FAIL] ${e.label}: ${res.message}`);
              continue;
            }
            if (r.code === 1) res.notes.push(tr('7-Zip সতর্কতা দিয়েছে, বিস্তারিত log-এ', '7-Zip reported warnings, see the log'));
            res.ok = true;
            res.target = target;
            log(`  restored extra-${e.n} (${e.label}) -> ${target}`);
          } catch (err) {
            res.message = err.message;
            log(`  [FAIL] ${e.label}: ${err.message}`);
          }
        } else {
          const c = x.c;
          const res = { kind: 'copy', name: c.label, ok: false, notes: [] };
          results.push(res);
          if (!c.exists) {
            res.message = tr('backup-এর files ফোল্ডারে এই copy পাওয়া যায়নি: ', 'This copy was not found in the backup files folder: ') + c.srcDir;
            continue;
          }
          if (!c.source) {
            res.message = tr('মূল পথ manifest-এ নেই', 'the original path is not in manifest.json');
            continue;
          }
          let dst = c.source;
          let action = 'new';
          if (c.sourceExists) {
            if (x.mode === 'overwrite') action = 'merged';
            else {
              dst = freeDirName(c.source);
              action = 'renamed';
            }
          }
          if (!dst) {
            res.message = tr('নতুন ফোল্ডারের নাম পাওয়া গেল না', 'no free folder name found');
            continue;
          }
          const rs = path.resolve(c.srcDir).toLowerCase();
          const rd = path.resolve(dst).toLowerCase();
          if (rd === path.parse(rd).root || rd === rs || rd.startsWith(rs + path.sep) || rs.startsWith(rd + path.sep)) {
            res.message = tr('গন্তব্য ও backup-এর copy একটা আরেকটার ভেতরে বা একই জায়গায়, তাই থামানো হয়েছে: ', 'The target and the backup copy overlap, stopped: ') + dst;
            continue;
          }
          try {
            if (ctx.onProgress) ctx.onProgress(`Restore: ${c.label}`);
            let n = 0;
            await fs.promises.cp(c.srcDir, dst, {
              recursive: true,
              force: true,
              filter: (sp) => {
                const rel = path.relative(c.srcDir, sp);
                const first = rel.split(path.sep)[0];
                if (first === '.versions' || (rel === '.s360-state.json')) return false;
                n++;
                return true;
              },
            });
            res.ok = true;
            res.action = action;
            res.target = dst;
            res.items = n;
            if (action === 'merged') res.notes.push(tr('মূল ফোল্ডারে একই নামের ফাইল backup-এরটা দিয়ে বদলেছে; backup-এ নেই এমন ফাইল থেকে গেছে', 'Files with the same name in the original folder were replaced; files that are not in the backup were kept'));
            log(`  restored copy ${c.label} -> ${dst} (${action}, ${n} entries)`);
          } catch (err) {
            res.message = err.message;
            log(`  [FAIL] ${c.label}: ${err.message}`);
          }
        }
      }
      if (!info.complete) warnings.push(tr('এই backup আংশিক (complete নয়): ' + (info.failedSteps.join(', ') || '?'), 'This backup is partial (not complete): ' + (info.failedSteps.join(', ') || '?')));
      if (results.some((r) => r.kind === 'copy' && r.ok && r.action === 'renamed')) warnings.push(tr('নতুন নামে রাখা ফোল্ডার কোনো সাইট বা প্রোগ্রামের সাথে জোড়া নেই; দরকার হলে নিজে ঠিক করুন', 'A folder restored under a new name is not linked to any site or program; fix that yourself if needed'));
      return { ok: results.some((r) => r.ok), results, warnings };
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      restoring = false;
    }
  }

  // ---------- Restore, step 4b: settings.7z = সার্টিফিকেট + প্রতি-সাইট সেটিংস ----------
  // settings.7z-এর ভেতরে secrets\certs\* আর secrets\settings.json (শুধু পাসওয়ার্ড দিয়ে backup নিলে থাকে)।
  // settings.json পুরো বসানো হয় না: তাতে পুরনো PC-র পথ (rootDir/wwwDir), পোর্ট আর plain-text DB পাসওয়ার্ড আছে।
  // শুধু সাইট ধরে সেটিংস আমদানি হয় (সাদা তালিকা + যাচাই); বর্তমান সেটিংসের একটা কপি আগে রাখা হয়।
  // সার্টিফিকেট: বর্তমান ফাইল কখনো বদলায় না (একই নামে অন্য ফাইল থাকলে সেটা থেকে যায়, বলা হয়)।
  const SITE_KEYS = ['sitePhp', 'siteSession', 'sitePhpIni', 'sitePublic', 'siteDisabled', 'nodeSites', 'phpExt'];
  const BAD_KEY = (k) => typeof k !== 'string' || !k || k.length > 100 || ['__proto__', 'constructor', 'prototype'].includes(k) || /[\x00-\x1f\\/]/.test(k);
  const DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
  const VERSION_RE = /^[0-9A-Za-z._-]{1,40}$/;
  const INI_KEYS = ['max_execution_time', 'max_input_time', 'memory_limit', 'display_errors', 'upload_max_filesize', 'post_max_size', 'max_input_vars'];
  const HOST_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/i;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function settingsArchiveOf(item) {
    const f = item.files.find((x) => x.exists && /^settings\.(7z|zip)$/i.test(x.name));
    return f ? path.join(item.dir, f.name) : '';
  }
  function restoreSettingsInfo(dir) {
    if (typeof dir !== 'string' || !dir) return { ok: false, message: tr('ফোল্ডার দেওয়া হয়নি', 'No folder given') };
    const item = readBackupDir(dir, 'custom');
    if (!item.manifest) return { ok: false, message: tr('manifest.json নেই বা পড়া যায় না, তাই restore করা যাবে না', 'manifest.json is missing or unreadable, so nothing can be restored') };
    const archive = settingsArchiveOf(item);
    if (!archive) return { ok: false, message: tr('এই backup-এ settings আর্কাইভ নেই (পাসওয়ার্ড ছাড়া backup-এ সেটা রাখা হয় না)', 'This backup has no settings archive (it is only made when a password is set)') };
    return { ok: true, archive, encrypted: item.encrypted, complete: item.complete, failedSteps: item.failedSteps, sevenZip: !!find7z(), certsDir: ctx.certsDir() };
  }

  function findSecretsRoot(d, depth) {
    if (fs.existsSync(path.join(d, 'settings.json')) || fs.existsSync(path.join(d, 'certs'))) return d;
    if (depth > 0) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          const r = findSecretsRoot(path.join(d, e.name), depth - 1);
          if (r) return r;
        }
      }
    }
    return '';
  }

  // বর্তমান সার্টিফিকেট ফোল্ডারে বসানো: আগের কোনো ফাইল বদলায় না
  function copyCerts(srcDir, dstDir) {
    const out = { copied: [], same: [], kept: [] };
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(srcDir, rel), { withFileTypes: true })) {
        const r = path.join(rel, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          walk(r);
          continue;
        }
        if (!e.isFile()) continue;
        const from = path.join(srcDir, r);
        const to = path.join(dstDir, r);
        if (fs.existsSync(to)) {
          let same = false;
          try {
            same = fs.statSync(to).size === fs.statSync(from).size && fs.readFileSync(to).equals(fs.readFileSync(from));
          } catch {}
          (same ? out.same : out.kept).push(r);
          continue;
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        out.copied.push(r);
      }
    };
    walk('');
    return out;
  }

  // একটা সাইট-সেটিং মান যাচাই; ঠিক থাকলে {v} (পরিষ্কার করা মান), না হলে {skip: কারণ}
  function cleanSiteValue(key, domain, v, cur) {
    if (key === 'sitePhp') {
      if (typeof v !== 'string' || !VERSION_RE.test(v)) return { skip: 'bad value' };
      if (ctx.phpVersions && !ctx.phpVersions().includes(v)) return { skip: 'PHP ' + v + ' is not registered on this PC' };
      return { v };
    }
    if (key === 'siteSession') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0 || n > 1000000) return { skip: 'bad value' };
      return { v: n };
    }
    if (key === 'sitePhpIni') {
      if (!isObj(v)) return { skip: 'bad value' };
      const o = {};
      const SIZE_RE = /^(0|\d{1,6}[KMGkmg]?)$/;
      for (const [k, x] of Object.entries(v)) {
        if (!INI_KEYS.includes(k)) continue;
        const sv = String(x);
        // ini_set-এর চার মান prepend স্ক্রিপ্টের নিয়মে ([A-Za-z0-9-]+); বাকি তিনটা .user.ini-র জন্য আকার/সংখ্যা
        const ok = k === 'upload_max_filesize' || k === 'post_max_size' ? SIZE_RE.test(sv) : k === 'max_input_vars' ? /^\d{1,6}$/.test(sv) : /^[A-Za-z0-9-]{1,20}$/.test(sv);
        if (ok) o[k] = sv;
      }
      // site:setPhpIni-র নিয়ম: upload-এর সাথে post_max_size লাগে, আর post >= upload
      const bytes = (x) => {
        const m = /^(\d+)([KMGkmg]?)$/.exec(String(x));
        return m ? Number(m[1]) * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 }[m[2].toLowerCase()]) : 0;
      };
      if (o.upload_max_filesize) {
        const bad = !o.post_max_size || (bytes(o.post_max_size) !== 0 && bytes(o.post_max_size) < bytes(o.upload_max_filesize));
        if (bad) delete o.upload_max_filesize;
      }
      return Object.keys(o).length ? { v: o } : { skip: 'empty' };
    }
    if (key === 'sitePublic') {
      if (!Array.isArray(v) || !v.length) return { skip: 'bad value' };
      const used = new Set();
      for (const [d, arr] of Object.entries(cur.sitePublic || {})) if (d !== domain && Array.isArray(arr)) arr.forEach((n) => used.add(String(n).toLowerCase()));
      const names = [];
      for (const n of v.slice(0, 10)) {
        const nm = String(n).toLowerCase();
        if (HOST_RE.test(nm) && !used.has(nm) && !names.includes(nm)) names.push(nm);
      }
      return names.length ? { v: names } : { skip: 'names invalid or used by another site' };
    }
    if (key === 'siteDisabled') return v === true ? { v: true } : { skip: 'bad value' };
    if (key === 'nodeSites') {
      if (!isObj(v)) return { skip: 'bad value' };
      const o = {};
      if (typeof v.cmd === 'string' && v.cmd.length <= 300 && !/[\r\n]/.test(v.cmd)) o.cmd = v.cmd;
      if (typeof v.version === 'string' && VERSION_RE.test(v.version) && (!ctx.nodeVersions || ctx.nodeVersions().includes(v.version))) o.version = v.version;
      if (v.autostart === true) o.autostart = true;
      if (v.startall === true) o.startall = true;
      // পোর্ট: শুধু হাতে দেওয়া (manual) আর এই PC-তে অন্য সাইট ব্যবহার না করলে; নইলে নিজে নতুন পোর্ট নেবে
      const port = Number(v.port);
      if (v.manual === true && Number.isInteger(port) && port >= 1 && port <= 65535) {
        const taken = Object.entries(cur.nodeSites || {}).some(([d, c]) => d !== domain && c && Number(c.port) === port);
        if (!taken) {
          o.port = port;
          o.manual = true;
        }
      }
      return Object.keys(o).length ? { v: o } : { skip: 'empty' };
    }
    return { skip: 'unknown key' };
  }

  // ব্যবহারকারীর বর্তমান সেটিংসে মেশানো (কপি বানিয়ে); conflict: 'keep' (ডিফল্ট) | 'replace'
  function mergeSiteSettings(backupSettings, cur, conflict) {
    const next = {};
    const stats = { added: 0, replaced: 0, kept: 0, same: 0, skipped: 0, byKey: {}, skippedList: [] };
    const bump = (key, what) => {
      stats[what]++;
      const b = (stats.byKey[key] = stats.byKey[key] || { added: 0, replaced: 0, kept: 0, same: 0, skipped: 0 });
      b[what]++;
    };
    for (const key of SITE_KEYS) {
      const src = backupSettings[key];
      if (!isObj(src)) continue;
      const base = isObj(cur[key]) ? cur[key] : {};
      const merged = { ...base };
      let touched = false;
      if (key === 'phpExt') {
        for (const [ver, exts] of Object.entries(src)) {
          if (BAD_KEY(ver) || !VERSION_RE.test(ver) || !isObj(exts)) {
            bump(key, 'skipped');
            continue;
          }
          const m = { ...(isObj(merged[ver]) ? merged[ver] : {}) };
          for (const [ext, on] of Object.entries(exts)) {
            if (!/^[A-Za-z0-9_]{1,40}$/.test(ext) || typeof on !== 'boolean') {
              bump(key, 'skipped');
              continue;
            }
            if (!(ext in m)) {
              m[ext] = on;
              bump(key, 'added');
              touched = true;
            } else if (m[ext] === on) bump(key, 'same');
            else if (conflict === 'replace') {
              m[ext] = on;
              bump(key, 'replaced');
              touched = true;
            } else bump(key, 'kept');
          }
          merged[ver] = m;
        }
      } else {
        for (const [domain, val] of Object.entries(src)) {
          if (BAD_KEY(domain) || !DOMAIN_RE.test(domain)) {
            bump(key, 'skipped');
            continue;
          }
          const c = cleanSiteValue(key, domain, val, { ...cur, ...next });
          if (c.skip) {
            bump(key, 'skipped');
            stats.skippedList.push(`${key}: ${domain} (${c.skip})`);
            continue;
          }
          if (!(domain in merged)) {
            merged[domain] = c.v;
            bump(key, 'added');
            touched = true;
          } else if (JSON.stringify(merged[domain]) === JSON.stringify(c.v)) bump(key, 'same');
          else if (conflict === 'replace') {
            merged[domain] = c.v;
            bump(key, 'replaced');
            touched = true;
          } else bump(key, 'kept');
        }
      }
      if (touched) next[key] = merged;
    }
    return { next, stats };
  }

  async function restoreSettings(opts) {
    if (restoring) return { ok: false, message: tr('আরেকটা restore চলছে', 'Another restore is running') };
    if (running) return { ok: false, message: tr('একটা backup চলছে, শেষ হলে চেষ্টা করুন', 'A backup is running, try again when it has finished') };
    const info = restoreSettingsInfo(opts && opts.dir);
    if (!info.ok) return info;
    const wantCerts = opts.certs !== false;
    const wantSites = opts.sites !== false;
    if (!wantCerts && !wantSites) return { ok: false, message: tr('কিছু বাছা হয়নি', 'Nothing selected') };
    const conflict = opts.conflict === 'replace' ? 'replace' : 'keep';
    const password = typeof opts.password === 'string' ? opts.password : '';
    if (info.encrypted && !password) return { ok: false, needPassword: true, message: tr('এই backup পাসওয়ার্ড দিয়ে encrypted, পাসওয়ার্ড দিন', 'This backup is encrypted, enter the password') };
    const sevenZ = find7z();
    const is7z = /\.7z$/i.test(info.archive);
    if (is7z && !sevenZ) return { ok: false, message: tr('7-Zip নেই; Backup পেজ থেকে ইনস্টল করুন', '7-Zip is missing; install it from the Backup page') };
    const wrongPw = (x) => /wrong password|cannot open encrypted archive|can not open encrypted archive|data error in encrypted/i.test(x);
    const stamp = stampOf();
    const tmp = path.join(tmpRoot(), 'restore-settings-' + stamp);
    const warnings = [];
    const res = { ok: false, certs: null, sites: null, warnings };
    restoring = true;
    try {
      fs.mkdirSync(tmp, { recursive: true });
      log(`Restore settings: ${info.archive} (certs=${wantCerts}, sites=${wantSites}, conflict=${conflict})`);
      if (ctx.onProgress) ctx.onProgress('Restore: reading settings archive');
      const exDir = path.join(tmp, 'x');
      fs.mkdirSync(exDir, { recursive: true });
      if (sevenZ) {
        const xr = await run(sevenZ, ['x', info.archive, '-o' + exDir, '-y', ...(password ? ['-p' + password] : [])], { timeout: 3600 * 1000 });
        const xout = xr.stdout + xr.stderr;
        if (!xr.ok && xr.code !== 1) {
          if (wrongPw(xout)) return { ok: false, wrongPassword: true, message: tr('পাসওয়ার্ড ভুল', 'Wrong password') };
          return { ok: false, message: `7z extract failed (exit code ${xr.code}): ` + xout.trim().slice(-300) };
        }
        if (xr.code === 1) warnings.push(tr('7-Zip সতর্কতা দিয়েছে, বিস্তারিত log-এ', '7-Zip reported warnings, see the log'));
      } else {
        const r = await run(ctx.tarExe || (win ? 'tar.exe' : 'tar'), ['-xf', info.archive, '-C', exDir], {});
        if (!r.ok) return { ok: false, message: ('tar failed: ' + r.stderr).slice(0, 400) };
      }
      const root = findSecretsRoot(exDir, 2);
      if (!root) return { ok: false, message: tr('আর্কাইভে certs বা settings.json পাওয়া যায়নি', 'Neither certs nor settings.json was found in the archive') };

      // ১) সার্টিফিকেট
      if (wantCerts) {
        const cs = path.join(root, 'certs');
        if (!fs.existsSync(cs)) warnings.push(tr('এই backup-এ certs ফোল্ডার নেই', 'This backup has no certs folder'));
        else {
          const dst = ctx.certsDir();
          fs.mkdirSync(dst, { recursive: true });
          res.certs = { ...copyCerts(cs, dst), dir: dst };
          log(`  certificates: ${res.certs.copied.length} copied, ${res.certs.same.length} already there, ${res.certs.kept.length} kept (different file with the same name)`);
          if (res.certs.kept.length) warnings.push(tr('একই নামে আলাদা সার্টিফিকেট ফাইল আগে থেকে ছিল, সেগুলো বদলানো হয়নি: ' + res.certs.kept.join(', '), 'Certificate files with the same name but different content already existed and were not replaced: ' + res.certs.kept.join(', ')));
        }
      }

      // ২) প্রতি-সাইট সেটিংস
      if (wantSites) {
        const sf = path.join(root, 'settings.json');
        let bs = null;
        try {
          bs = JSON.parse(fs.readFileSync(sf, 'utf8'));
        } catch (e) {
          warnings.push(tr('settings.json পড়া গেল না: ', 'Could not read settings.json: ') + e.message);
        }
        if (isObj(bs)) {
          const cur = ctx.settings();
          const { next, stats } = mergeSiteSettings(bs, cur, conflict);
          res.sites = stats;
          if (Object.keys(next).length) {
            const sp = ctx.settingsPath();
            try {
              if (fs.existsSync(sp)) {
                const bak = path.join(path.dirname(sp), 'settings.before-restore-' + stamp + '.json');
                fs.copyFileSync(sp, bak);
                res.settingsBackup = bak;
              }
            } catch (e) {
              return { ok: false, message: tr('বর্তমান settings-এর কপি রাখা গেল না, তাই কিছু বদলানো হয়নি: ', 'Could not save a copy of the current settings, nothing was changed: ') + e.message };
            }
            Object.assign(cur, next);
            ctx.save(cur);
            res.changed = true;
          }
          log(`  site settings: ${stats.added} added, ${stats.replaced} replaced, ${stats.kept} kept (differ), ${stats.same} same, ${stats.skipped} skipped`);
          for (const x of stats.skippedList.slice(0, 20)) log('    skipped ' + x);
          warnings.push(tr('settings.json-এর install/www ফোল্ডার, পোর্ট, ডাটাবেস পাসওয়ার্ড আর LAN share আমদানি করা হয়নি (এই PC-র নিজের মান থাকে)', 'The install/www folders, ports, database passwords and LAN sharing from settings.json were NOT imported (this PC keeps its own values)'));
        }
      }
      if (!info.complete) warnings.push(tr('এই backup আংশিক (complete নয়): ' + (info.failedSteps.join(', ') || '?'), 'This backup is partial (not complete): ' + (info.failedSteps.join(', ') || '?')));
      res.ok = !!(res.certs || res.sites);
      if (!res.ok && !res.message) res.message = tr('কিছুই আমদানি হয়নি', 'Nothing was imported');
      return res;
    } catch (e) {
      return { ok: false, message: e.message };
    } finally {
      restoring = false;
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {}
    }
  }

  return { getConfig, setConfig, runBackup, isRunning, lastStatus, tailLog, find7z, ensure7z, listBackups, restoreWwwInfo, restoreWww, restoreDbInfo, restoreMysql, restorePgInfo, restorePg, restoreOtherInfo, restoreOther, restoreSettingsInfo, restoreSettings, dirs: { baseDir, logsDir } };
}

module.exports = { createBackup, stampOf, STAMP_RE, snapshotChanged, pruneVersions, moveToVersions, folderSize, renameDirRetry, runWithFile };
