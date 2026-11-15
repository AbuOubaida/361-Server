'use strict';
// সাইট মনিটরিং (R1, ধাপ ৪): ইমেইল সতর্কবার্তা। কোনো নতুন package নয়: Node-এর net/tls দিয়ে নিজের ছোট SMTP ক্লায়েন্ট।
// সমর্থন: সরাসরি TLS (সাধারণত পোর্ট ৪৬৫), STARTTLS (সাধারণত ৫৮৭), বা এনক্রিপশন ছাড়া (শুধু localhost/পরীক্ষার জন্য);
// লগইন AUTH PLAIN বা AUTH LOGIN। পাসওয়ার্ড এনক্রিপশন ছাড়া চ্যানেলে (localhost বাদে) কখনো পাঠানো হয় না।
// সতর্কবার্তা (monitor.js / resources.js-এর যে লেখা বেলুনে যায়) জমিয়ে একটা মেইলে যায় (~২০ সেকেন্ড অপেক্ষা), ঘণ্টায় সর্বোচ্চ ৬টা মেইল।
// সেটিং settings.monitor.mail-এ; পাসওয়ার্ড deps.enc দিয়ে মোড়া (Electron safeStorage), কখনো UI-তে ফেরত যায় না।
const net = require('net');
const tls = require('tls');
const os = require('os');

const TIMEOUT_MS = 20000;
const DELAY_MS = 20000; // প্রথম সতর্কবার্তার পর এতক্ষণ জমিয়ে তারপর পাঠানো
const RETRY_MS = 5 * 60 * 1000;
const MAX_PER_HOUR = 6;
const MAX_LINES = 50;
const MAX_ATTEMPTS = 3;
const SECURE = ['starttls', 'ssl', 'none'];

const clean = (s, n) => String(s == null ? '' : s).replace(/[\r\n\0]+/g, ' ').trim().slice(0, n);
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ADDR = /^[^\s<>@"',;]+@[^\s<>@"',;]+\.[^\s<>@"',;]+$|^[^\s<>@"',;]+@localhost$/i;

function addrOf(s) {
  s = clean(s, 320);
  const m = s.match(/<([^<>\s]+)>/);
  const a = m ? m[1] : s;
  return ADDR.test(a) ? a : null;
}
function addrList(s) {
  const out = [];
  for (const part of String(s || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const a = addrOf(part);
    if (!a) return null; // একটাও খারাপ হলে পুরোটা বাতিল
    if (!out.includes(a)) out.push(a);
  }
  return out.length && out.length <= 10 ? out : null;
}
function encWord(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + b64(s) + '?=';
}
function heloName() {
  const h = String(os.hostname() || '').replace(/[^A-Za-z0-9.-]/g, '');
  return h || 'localhost';
}

// সার্ভারের উত্তর পড়ার ছোট পাঠক: এক উত্তর = { code, lines[] } (মাল্টিলাইন "250-..." শেষ "250 ...")
function makeReader(sock) {
  let buf = '';
  let cur = [];
  const queue = [];
  let waiter = null;
  let dead = null;
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      const m = line.match(/^(\d{3})([ -])(.*)$/);
      if (!m) continue;
      cur.push(m[3]);
      if (m[2] === ' ') {
        queue.push({ code: Number(m[1]), lines: cur });
        cur = [];
      }
    }
    flush();
  };
  const fail = (e) => {
    if (!dead) dead = e;
    flush();
  };
  const onEnd = () => fail(new Error('connection closed by the server'));
  function flush() {
    if (!waiter) return;
    if (queue.length) {
      const w = waiter;
      waiter = null;
      w.resolve(queue.shift());
    } else if (dead) {
      const w = waiter;
      waiter = null;
      w.reject(dead);
    }
  }
  sock.on('data', onData);
  sock.on('error', fail);
  sock.on('close', onEnd);
  sock.on('end', onEnd);
  return {
    next() {
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        flush();
      });
    },
    detach() {
      sock.off('data', onData);
      sock.off('error', fail);
      sock.off('close', onEnd);
      sock.off('end', onEnd);
    },
  };
}

function connect(opt) {
  return new Promise((resolve, reject) => {
    let done = false;
    const ok = (s) => {
      if (!done) {
        done = true;
        resolve(s);
      }
    };
    const bad = (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    };
    let s;
    try {
      if (opt.secure === 'ssl') {
        s = tls.connect({ host: opt.host, port: opt.port, servername: net.isIP(opt.host) ? undefined : opt.host, rejectUnauthorized: !opt.insecureTls });
        s.once('secureConnect', () => ok(s));
      } else {
        s = net.connect({ host: opt.host, port: opt.port });
        s.once('connect', () => ok(s));
      }
    } catch (e) {
      return bad(e);
    }
    s.once('error', bad);
    s.setTimeout(TIMEOUT_MS, () => {
      s.destroy();
      bad(new Error('connection timed out'));
    });
  });
}

// opt: { host, port, secure, user, pass, insecureTls }  mail: { from, to[], subject, text }
async function smtpSend(opt, mail) {
  const host = clean(opt.host, 255);
  const port = Number(opt.port);
  if (!host) throw new Error('SMTP server is empty');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SMTP port is not valid');
  const secure = SECURE.includes(opt.secure) ? opt.secure : 'starttls';
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(host);
  if (opt.user && secure === 'none' && !local) throw new Error('refusing to send the password without encryption (choose SSL/TLS or STARTTLS)');
  const from = addrOf(mail.from);
  if (!from) throw new Error('"From" address is not valid');
  const to = Array.isArray(mail.to) ? mail.to : addrList(mail.to);
  if (!to || !to.length) throw new Error('"To" address is not valid');

  let sock = await connect({ host, port, secure, insecureTls: !!opt.insecureTls });
  let rd = makeReader(sock);
  const close = () => {
    try {
      rd.detach();
    } catch {}
    try {
      sock.destroy();
    } catch {}
  };
  const expect = (r, codes, what) => {
    if (!codes.includes(r.code)) throw new Error(`SMTP ${r.code} (${what}): ${clean(r.lines.join(' '), 200)}`);
    return r;
  };
  const cmd = async (line, codes, what) => {
    sock.write(line + '\r\n');
    return expect(await rd.next(), codes, what);
  };
  try {
    expect(await rd.next(), [220], 'greeting');
    let ehlo = await cmd('EHLO ' + heloName(), [250], 'EHLO');
    if (secure === 'starttls') {
      if (!ehlo.lines.some((l) => /^STARTTLS\b/i.test(l))) throw new Error('the server does not offer STARTTLS (try SSL/TLS on port 465)');
      await cmd('STARTTLS', [220], 'STARTTLS');
      rd.detach();
      sock.setTimeout(0);
      const raw = sock;
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: raw, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: !opt.insecureTls });
        t.once('secureConnect', () => resolve(t));
        t.once('error', reject);
      });
      sock.setTimeout(TIMEOUT_MS, () => sock.destroy(new Error('connection timed out')));
      rd = makeReader(sock);
      ehlo = await cmd('EHLO ' + heloName(), [250], 'EHLO');
    }
    if (opt.user) {
      const caps = ehlo.lines.join(' ').toUpperCase();
      const user = String(opt.user);
      const pass = String(opt.pass || '');
      if (/\bAUTH\b[^ ]*.*\bPLAIN\b/.test(caps) || !/\bLOGIN\b/.test(caps)) {
        await cmd('AUTH PLAIN ' + b64('\0' + user + '\0' + pass), [235], 'login');
      } else {
        await cmd('AUTH LOGIN', [334], 'login');
        await cmd(b64(user), [334], 'login');
        await cmd(b64(pass), [235], 'login');
      }
    }
    await cmd(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
    for (const a of to) await cmd(`RCPT TO:<${a}>`, [250, 251], 'RCPT TO');
    await cmd('DATA', [354], 'DATA');
    const body = (b64(String(mail.text || '')).match(/.{1,76}/g) || []).join('\r\n');
    const msg = [
      `From: "Server 360" <${from}>`,
      `To: ${to.map((a) => `<${a}>`).join(', ')}`,
      `Subject: ${encWord(clean(mail.subject, 200))}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${heloName()}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body,
    ].join('\r\n');
    await cmd(msg + '\r\n.', [250], 'message');
    try {
      sock.write('QUIT\r\n');
    } catch {}
  } finally {
    close();
  }
  return true;
}

// deps: { ipcMain, getSettings(), saveSettings(), tr(bn,en), enc(text), dec(value), status(msg) }
function init(deps) {
  let timer = null;
  let stopped = false;
  let pending = []; // [{ ts, msg }]
  let attempts = 0;
  const sentAt = []; // শেষ ঘণ্টার পাঠানোর সময়
  let last = null; // { ts, ok, err }

  function cfg() {
    const s = deps.getSettings();
    const m = (s.monitor = s.monitor && typeof s.monitor === 'object' ? s.monitor : {});
    const c = (m.mail = m.mail && typeof m.mail === 'object' ? m.mail : {});
    if (typeof c.enabled !== 'boolean') c.enabled = false;
    c.host = clean(c.host, 255);
    const p = Number(c.port);
    c.port = Number.isInteger(p) && p >= 1 && p <= 65535 ? p : 587;
    if (!SECURE.includes(c.secure)) c.secure = 'starttls';
    c.user = clean(c.user, 255);
    c.from = clean(c.from, 320);
    c.to = clean(c.to, 600);
    if (typeof c.insecureTls !== 'boolean') c.insecureTls = false;
    if (typeof c.pass !== 'string') c.pass = '';
    return c;
  }
  function view() {
    const c = cfg();
    return { cfg: { enabled: c.enabled, host: c.host, port: c.port, secure: c.secure, user: c.user, from: c.from, to: c.to, insecureTls: c.insecureTls, hasPass: !!c.pass }, last };
  }
  const options = (c) => ({ host: c.host, port: c.port, secure: c.secure, user: c.user, pass: c.pass ? deps.dec(c.pass) : '', insecureTls: c.insecureTls });
  const nice = (e) => clean(e && e.message ? e.message : e, 300);

  function slotFree(now) {
    while (sentAt.length && now - sentAt[0] > 3600000) sentAt.shift();
    return sentAt.length < MAX_PER_HOUR;
  }
  function arm(ms) {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = null;
      flush().catch(() => {});
    }, ms);
  }
  async function flush() {
    const c = cfg();
    if (stopped || !pending.length) return;
    if (!c.enabled || !c.host) {
      pending = [];
      return;
    }
    const now = Date.now();
    if (!slotFree(now)) {
      arm(RETRY_MS); // ঘণ্টার সীমা: স্লট খালি হলে আবার
      return;
    }
    const lines = pending.slice();
    pending = [];
    const hhmm = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const text =
      lines.map((x) => `${hhmm(x.ts)}  ${x.msg}`).join('\n') +
      '\n\n' +
      deps.tr(`পিসি: ${os.hostname()}\nএই মেইল Server 360 স্বয়ংক্রিয়ভাবে পাঠিয়েছে। বন্ধ করতে Monitoring পেজে "ইমেইল সতর্কবার্তা" বন্ধ করুন।`, `PC: ${os.hostname()}\nSent automatically by Server 360. To stop, switch off "E-mail alerts" on the Monitoring page.`);
    const subject = deps.tr(`[Server 360] ${lines.length}টি সতর্কবার্তা`, `[Server 360] ${lines.length} alert(s)`);
    try {
      await smtpSend(options(c), { from: c.from, to: c.to, subject, text });
      sentAt.push(Date.now());
      attempts = 0;
      last = { ts: Date.now(), ok: true, err: '' };
    } catch (e) {
      last = { ts: Date.now(), ok: false, err: nice(e) };
      attempts++;
      if (attempts < MAX_ATTEMPTS) {
        pending = lines.concat(pending).slice(-MAX_LINES);
        arm(RETRY_MS);
      } else {
        attempts = 0; // ৩ বার ব্যর্থ: এই সতর্কবার্তাগুলো বাদ, নতুনগুলো আবার চেষ্টা পাবে
        try {
          deps.status(deps.tr('ইমেইল পাঠানো যাচ্ছে না: ' + nice(e), 'Cannot send e-mail: ' + nice(e)));
        } catch {}
      }
    }
    try {
      deps.send('monitor:mail', null);
    } catch {}
    if (pending.length) arm(DELAY_MS);
  }

  // monitor.js / resources.js-এর বেলুনের একই লেখা এখানেও আসে
  function alert(msg) {
    const c = cfg();
    if (stopped || !c.enabled || !c.host || !c.to) return;
    pending.push({ ts: Date.now(), msg: clean(msg, 300) });
    if (pending.length > MAX_LINES) pending = pending.slice(-MAX_LINES);
    arm(DELAY_MS);
  }

  const { ipcMain } = deps;
  ipcMain.handle('mail:get', () => view());
  // c: { enabled, host, port, secure, user, from, to, insecureTls }; pass: নতুন পাসওয়ার্ড (ফাঁকা/অনুপস্থিত = আগেরটাই থাকে), c.clearPass === true = মুছে ফেলা
  ipcMain.handle('mail:setConfig', (_e, c, pass) => {
    c = c || {};
    const m = cfg();
    if (typeof c.enabled === 'boolean') m.enabled = c.enabled;
    if (typeof c.host === 'string') m.host = clean(c.host, 255);
    if (c.port !== undefined) {
      const p = Number(c.port);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) m.port = p;
    }
    if (SECURE.includes(c.secure)) m.secure = c.secure;
    if (typeof c.user === 'string') m.user = clean(c.user, 255);
    if (typeof c.from === 'string') m.from = clean(c.from, 320);
    if (typeof c.to === 'string') m.to = clean(c.to, 600);
    if (typeof c.insecureTls === 'boolean') m.insecureTls = c.insecureTls;
    if (c.clearPass === true) m.pass = '';
    if (typeof pass === 'string' && pass !== '') m.pass = deps.enc(pass.slice(0, 200));
    if (!m.enabled) pending = [];
    deps.saveSettings();
    return view();
  });
  ipcMain.handle('mail:test', async () => {
    const c = cfg();
    try {
      await smtpSend(options(c), {
        from: c.from,
        to: c.to,
        subject: deps.tr('[Server 360] টেস্ট মেইল', '[Server 360] Test mail'),
        text: deps.tr(`এটা Server 360-এর টেস্ট মেইল। এটা পেলে SMTP সেটিং ঠিক আছে।\nপিসি: ${os.hostname()}`, `This is a test mail from Server 360. If you received it, the SMTP settings work.\nPC: ${os.hostname()}`),
      });
      last = { ts: Date.now(), ok: true, err: '' };
      return { ok: true, err: '' };
    } catch (e) {
      last = { ts: Date.now(), ok: false, err: nice(e) };
      return { ok: false, err: nice(e) };
    }
  });

  return {
    alert,
    flush,
    view,
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
    },
  };
}

module.exports = { init, smtpSend, addrList, addrOf };
