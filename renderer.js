const $ = (id) => document.getElementById(id);

// নিরাপত্তা-জাল: কোনো কারণে পুরো পাতা (body/html) স্ক্রল হয়ে গেলে (যেমন লুকানো ইনপুটে ফোকাস গেলে) সাইডবার/কনটেন্ট
// জানালার বাইরে চলে গিয়ে ফাঁকা দেখায়। তাই পাতার নিজের স্ক্রল সবসময় ০ তে ফিরিয়ে দিই (.content-এর নিজের স্ক্রল ঠিক থাকে)।
window.addEventListener(
  'scroll',
  () => {
    const se = document.scrollingElement;
    if (se && (se.scrollTop || se.scrollLeft)) se.scrollTo(0, 0);
  },
  true
);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

// ---------- ভাষা (i18n.js-এ LANG ও t()) ----------
let statusIsDefault = true;
function applyStatic() {
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach((n) => (n.textContent = t(n.dataset.i18n)));
  document.querySelectorAll('[data-i18n-html]').forEach((n) => (n.innerHTML = t(n.dataset.i18nHtml)));
  document.querySelectorAll('[data-i18n-ph]').forEach((n) => (n.placeholder = t(n.dataset.i18nPh)));
  $('langBtnText').textContent = t('lang.other');
  $('langSel').value = LANG;
  if (statusIsDefault) $('status').textContent = t('status.wait');
  const meta = PAGES[currentPage];
  $('pageTitle').textContent = t(meta[0]);
  $('pageSub').textContent = t(meta[1]);
}

async function setLang(lang) {
  LANG = lang === 'en' ? 'en' : 'bn';
  try {
    localStorage.setItem('lang', LANG);
  } catch {}
  await window.api.setLang(LANG); // main.js-এর বার্তাও এই ভাষায় যাবে
  applyStatic();
  // ডাইনামিক অংশ নতুন ভাষায় আবার আঁকা
  dbsEl.textContent = '';
  for (const k of Object.keys(dbUi)) delete dbUi[k];
  $('nodeList').textContent = '';
  for (const k of Object.keys(nodeUi)) delete nodeUi[k];
  await refreshAll();
  loadSites();
  if (currentPage === 'tools') loadTools();
  if (currentPage === 'backup') bkLoad();
}
$('langBtn').addEventListener('click', () => setLang(LANG === 'bn' ? 'en' : 'bn'));
$('langSel').addEventListener('change', (e) => setLang(e.target.value));

// ---------- স্ট্যাটাস বার ও লগ ----------
const logs = [];
function renderLogs() {
  const panel = $('logPanel');
  panel.textContent = '';
  for (const l of logs.slice().reverse()) {
    panel.appendChild(el('div', { className: 'l' + (l.err ? ' err' : '') }, el('time', { textContent: l.time }), l.msg));
  }
}

function setStatus(msg) {
  msg = String(msg ?? '');
  statusIsDefault = false;
  $('status').textContent = msg;
  const err = /^(সমস্যা|Error)|⚠/.test(msg);
  const bar = $('statusbar');
  bar.classList.toggle('err', err);
  bar.classList.toggle('ok', !err && /হয়েছে|সম্পন্ন|সেভ|started|stopped|saved|installed|added|removed|loaded|changed|opened|now uses|will now use/i.test(msg));
  // ডাউনলোডের শতকরা হিসাব (ঘনঘন বদলায়) লগে রাখা হয় না
  if (msg && !/\d+%$/.test(msg)) {
    logs.push({ msg, err, time: new Date().toLocaleTimeString() });
    if (logs.length > 60) logs.shift();
    if (!$('logPanel').hidden) renderLogs();
  }
}

$('logToggle').addEventListener('click', () => {
  const panel = $('logPanel');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderLogs();
});

// ---------- বাটনে কাজ চলার অবস্থা ----------
async function work(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add('working');
  try {
    return await fn();
  } catch (err) {
    setStatus(t('err') + (err && err.message ? err.message : err));
  } finally {
    btn.classList.remove('working');
    btn.disabled = false;
    refreshAll();
  }
}
// কাজ চলাকালীন বাটন আবার চালু করে না ফেলা
function setDisabled(btn, value) {
  if (!btn.classList.contains('working')) btn.disabled = value;
}

// ---------- নেভিগেশন ----------
const PAGES = {
  services: ['page.services', 'page.services.sub'],
  sites: ['page.sites', 'page.sites.sub'],
  tools: ['page.tools', 'page.tools.sub'],
  backup: ['page.backup', 'page.backup.sub'],
  settings: ['page.settings', 'page.settings.sub'],
};
let currentPage = 'services';
document.querySelectorAll('.nav').forEach((btn) =>
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    currentPage = page;
    document.querySelectorAll('.nav').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + page));
    $('pageTitle').textContent = t(PAGES[page][0]);
    $('pageSub').textContent = t(PAGES[page][1]);
    if (page === 'sites') loadSites();
    if (page === 'tools') loadTools();
    if (page === 'backup') bkLoad();
    if (page === 'settings') appBehaviorLoad();
  })
);

// ---------- ওয়েব সার্ভার ----------
const portInput = $('port');
const radios = () => [...document.querySelectorAll('input[name="server"]')];
const selectedServer = () => document.querySelector('input[name="server"]:checked').value;

function updateApacheNote() {
  $('apacheNote').hidden = selectedServer() !== 'apache';
}
radios().forEach((r) =>
  r.addEventListener('change', () => {
    localStorage.setItem('server', selectedServer());
    updateApacheNote();
    loadSites(); // "নিজের" ব্যাজ নির্বাচিত সার্ভার অনুযায়ী
  })
);
{
  const saved = localStorage.getItem('server');
  const r = radios().find((x) => x.value === saved);
  if (r) r.checked = true;
  updateApacheNote();
}

function applyWeb(w) {
  const running = !!w;
  const badge = $('webBadge');
  badge.className = 'badge' + (running ? ' on' : '');
  badge.textContent = running ? t('badge.web', w.id === 'nginx' ? 'Nginx' : 'Apache', w.port) : t('badge.stopped');
  if (running) {
    const r = radios().find((x) => x.value === w.id);
    if (r) r.checked = true;
    updateApacheNote();
  }
  radios().forEach((r) => (r.disabled = running));
  setDisabled($('start'), running);
  setDisabled($('stop'), !running);
  setDisabled($('restart'), !running);
  portInput.disabled = running;
  setDisabled($('savePort'), running);
}

$('start').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('starting'));
    setStatus(await window.api.startServer(selectedServer()));
    loadSites();
  })
);
$('restart').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('starting'));
    setStatus(await window.api.restartServer());
    loadSites();
  })
);
$('stop').addEventListener('click', (e) =>
  work(e.currentTarget, async () => setStatus(await window.api.stopServer()))
);
$('savePort').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const r = await window.api.setPort('web', portInput.value);
    portInput.value = r.port;
    setStatus(r.message);
    loadSites();
  })
);

// ---------- Start All / Stop All ----------
$('startAll').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('startingAll'));
    setStatus(await window.api.startAll(selectedServer()));
    loadSites();
  })
);
$('restartAll').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('restartingAll'));
    setStatus(await window.api.restartAll());
    loadSites();
  })
);
$('stopAll').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('stoppingAll'));
    setStatus(await window.api.stopAll());
  })
);

// ---------- ডাটাবেস কার্ড ----------
const dbUi = {};
const dbsEl = $('dbs');

function buildDb(db) {
  const badge = el('span', { className: 'badge', textContent: t('badge.stopped') });
  const subEl = el('div', { className: 'card-sub', textContent: t('db.sub', db.version) });
  const portIn = el('input', { type: 'number', min: 1, max: 65535, value: db.port });
  const saveBtn = el('button', { className: 'btn sm', textContent: t('save') });
  const startBtn = el('button', { className: 'btn sm primary', textContent: '▶ Start' });
  const restartBtn = el('button', { className: 'btn sm', textContent: '↻ Restart' });
  const stopBtn = el('button', { className: 'btn sm danger', textContent: '■ Stop' });
  const auto = el('input', { type: 'checkbox', checked: db.auto });
  const adminerBtn = el('button', { className: 'btn sm', textContent: t('db.adminer') });
  const pmaBtn = db.id === 'mysql' ? el('button', { className: 'btn sm', textContent: t('db.pma') }) : null;

  saveBtn.addEventListener('click', () =>
    work(saveBtn, async () => {
      const r = await window.api.setPort(db.id, portIn.value);
      portIn.value = r.port;
      setStatus(r.message);
    })
  );
  startBtn.addEventListener('click', () =>
    work(startBtn, async () => {
      setStatus(t('db.starting', db.label));
      setStatus(await window.api.startDb(db.id));
    })
  );
  restartBtn.addEventListener('click', () =>
    work(restartBtn, async () => {
      setStatus(t('db.starting', db.label));
      setStatus(await window.api.restartDb(db.id));
    })
  );
  stopBtn.addEventListener('click', () => work(stopBtn, async () => setStatus(await window.api.stopDb(db.id))));
  auto.addEventListener('change', () => window.api.setDbAuto(db.id, auto.checked));
  adminerBtn.addEventListener('click', () => work(adminerBtn, async () => setStatus(await window.api.openAdminer(db.id))));
  if (pmaBtn) pmaBtn.addEventListener('click', () => work(pmaBtn, async () => setStatus(await window.api.openPma())));

  const infoEl = el('div', { className: 'info', textContent: db.info });
  const card = el(
    'div',
    { className: 'card' },
    el(
      'div',
      { className: 'card-head' },
      el('div', { className: 'card-icon', textContent: db.id === 'mysql' ? 'SQL' : 'PG' }),
      el('div', {}, el('div', { className: 'card-title', textContent: db.label }), subEl),
      badge
    ),
    el(
      'div',
      { className: 'row first' },
      el('div', { className: 'field' }, el('label', { textContent: t('port') }), portIn, saveBtn),
      el('label', { className: 'switch' }, auto, el('i'), t('db.auto')),
      el('span', { className: 'spacer' }),
      startBtn,
      restartBtn,
      stopBtn
    ),
    el('div', { className: 'row' }, el('span', { className: 'badge tool', textContent: t('db.view') }), adminerBtn, ...(pmaBtn ? [pmaBtn] : [])),
    infoEl
  );
  dbsEl.appendChild(card);
  dbUi[db.id] = { sub: subEl, badge, portIn, saveBtn, startBtn, restartBtn, stopBtn, auto, infoEl };
}

function updateDb(db) {
  const ui = dbUi[db.id];
  ui.sub.textContent = t('db.sub', db.version);
  ui.infoEl.textContent = db.info;
  ui.badge.className = 'badge' + (db.running ? ' on' : '');
  ui.badge.textContent = db.running ? t('badge.db', db.port) : t('badge.stopped');
  setDisabled(ui.startBtn, db.running);
  setDisabled(ui.stopBtn, !db.running);
  setDisabled(ui.restartBtn, !db.running);
  ui.portIn.disabled = db.running;
  setDisabled(ui.saveBtn, db.running);
  if (document.activeElement !== ui.portIn) ui.portIn.value = db.port;
}

async function loadDbs() {
  const dbs = await window.api.listDbs();
  for (const db of dbs) {
    if (!dbUi[db.id]) buildDb(db);
    updateDb(db);
  }
}

// ---------- সাইট ----------
function phpCell(s, php) {
  if (s.node) return el('td', { className: 'php-text', textContent: 'Node.js' });
  if (s.system) return el('td', { className: 'php-text', textContent: '—' });
  if (s.name === 'localhost') return el('td', { className: 'php-text', textContent: t('php.defaultText', php.def) });
  const sel = el('select', {});
  sel.appendChild(el('option', { value: '', textContent: t('php.default', php.def) }));
  for (const v of php.versions) sel.appendChild(el('option', { value: v, textContent: 'PHP ' + v }));
  sel.value = s.phpPinned || '';
  sel.addEventListener('change', () =>
    work(sel, async () => {
      const r = await window.api.setSitePhp(s.domain, sel.value);
      setStatus(r.message);
      await loadSites();
    })
  );
  return el('td', {}, sel);
}

function sessionCell(s) {
  if (s.system || s.node || s.name === 'localhost') return el('td', { className: 'php-text', textContent: '—' });
  const inp = el('input', { type: 'number', min: 1, max: 525600, placeholder: t('sites.sessionPh') });
  inp.style.width = '90px';
  if (s.sessionMin) inp.value = s.sessionMin;
  inp.addEventListener('change', () =>
    work(inp, async () => {
      const r = await window.api.setSiteSession(s.domain, inp.value);
      setStatus(r.message);
      await loadSites();
    })
  );
  return el('td', {}, inp);
}

// সাইট ধরে PHP সীমা: বাটন চাপলে ছোট ডায়ালগ (max_execution_time, memory_limit, max_input_time, display_errors)
function limitsCell(s) {
  if (s.system || s.node || s.name === 'localhost') return el('td', { className: 'php-text', textContent: '—' });
  const cur = s.phpIni || {};
  const n = Object.keys(cur).length;
  const btn = el('button', { className: 'btn sm', textContent: n ? t('limits.btnCustom') + ' (' + n + ')' : t('limits.btnDefault'), title: Object.entries(cur).map(([k, v]) => k + '=' + v).join('\n') });
  btn.addEventListener('click', () => {
    const dlg = el('dialog', { style: 'padding:18px; max-width:460px; border:1px solid rgba(128,128,128,.4); border-radius:10px;' });
    const fields = [
      ['max_execution_time', 'limits.maxExec', '600'],
      ['memory_limit', 'limits.memory', '512M'],
      ['max_input_time', 'limits.maxInput', '120'],
      ['display_errors', 'limits.display', 'Off'],
      ['upload_max_filesize', 'limits.upload', '512M'],
      ['post_max_size', 'limits.post', '512M'],
      ['max_input_vars', 'limits.vars', '5000'],
    ];
    const inputs = {};
    dlg.appendChild(el('b', { textContent: t('limits.title') + s.domain }));
    dlg.appendChild(el('div', { className: 'hint', textContent: t('limits.hint') }));
    for (const [k, label, ph] of fields) {
      inputs[k] = el('input', { type: 'text', placeholder: ph, value: cur[k] || '' });
      inputs[k].style.width = '100%';
      dlg.appendChild(el('div', { style: 'margin:10px 0;' }, el('label', { style: 'display:block; font-weight:600; margin-bottom:3px;', textContent: label.startsWith('limits.') ? t(label) : label }), inputs[k]));
    }
    const save = el('button', { className: 'btn sm primary', textContent: t('limits.save') });
    const cancel = el('button', { className: 'btn sm', textContent: t('limits.cancel') });
    cancel.addEventListener('click', () => dlg.close());
    save.addEventListener('click', () =>
      work(save, async () => {
        const cfg = {};
        for (const [k] of fields) cfg[k] = inputs[k].value.trim();
        const r = await window.api.setSitePhpIni(s.domain, cfg);
        setStatus(r.message);
        if (r.ok) {
          dlg.close();
          await loadSites();
        }
      })
    );
    dlg.appendChild(el('div', { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:12px;' }, cancel, save));
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  });
  return el('td', {}, btn);
}

function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  } catch {}
  const ta = el('textarea', { value: text });
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

// পাবলিক ডোমেইন (Step B1 + B2): বাটন -> ডায়ালগ (নাম লেখা, DNS পরীক্ষা, সেভ, সার্টিফিকেট)
function publicBtn(s) {
  const names = s.publicNames || [];
  const btn = el('button', { className: 'btn sm', textContent: names.length ? t('pub.btnN', names.length) : t('pub.btn'), title: names.join('\n') });
  btn.addEventListener('click', () => {
    const dlg = el('dialog', { style: 'padding:18px; max-width:520px; border:1px solid rgba(128,128,128,.4); border-radius:10px;' });
    const ta = el('textarea', { rows: 3, placeholder: 'app.example.com', value: names.join('\n') });
    ta.style.width = '100%';
    const res = el('div', { className: 'hint', style: 'margin-top:8px; word-break:break-all;' });
    dlg.appendChild(el('b', { textContent: t('pub.title') + s.domain }));
    dlg.appendChild(el('div', { className: 'hint', textContent: t('pub.hint') }));
    dlg.appendChild(el('div', { style: 'margin:10px 0;' }, el('label', { style: 'display:block; font-weight:600; margin-bottom:3px;', textContent: t('pub.label') }), ta, res));
    const check = el('button', { className: 'btn sm', textContent: t('pub.check') });
    const save = el('button', { className: 'btn sm primary', textContent: t('pub.save') });
    const cancel = el('button', { className: 'btn sm', textContent: t('pub.cancel') });
    cancel.addEventListener('click', () => dlg.close());
    check.addEventListener('click', () =>
      work(check, async () => {
        res.textContent = t('pub.checking');
        const r = await window.api.checkSitePublic(ta.value);
        res.textContent = '';
        if (!r.ok) {
          res.textContent = r.message;
          return;
        }
        res.appendChild(el('div', { textContent: r.ip ? t('pub.myip', r.ip) : t('pub.noip') }));
        for (const h of r.hosts) {
          const ips = h.ips.join(', ');
          const line = el('div', { textContent: t('pub.' + h.status, h.host, ips) });
          line.style.color = h.status === 'ok' ? '#2e9d4f' : '#d1493f';
          res.appendChild(line);
        }
      })
    );
    save.addEventListener('click', () =>
      work(save, async () => {
        const r = await window.api.setSitePublic(s.domain, ta.value);
        setStatus(r.message);
        if (r.ok) {
          dlg.close();
          await loadSites();
        } else {
          res.textContent = r.message;
          res.style.color = '#d1493f';
        }
      })
    );
    dlg.appendChild(el('div', { style: 'display:flex; gap:8px; justify-content:flex-end; margin-top:12px;' }, check, cancel, save));

    // ---- সার্টিফিকেট অংশ (Step B2) ----
    const certLines = el('div', { style: 'margin:6px 0; font-size:13px; word-break:break-all;' });
    const certNote = el('div', { className: 'hint', style: 'color:#d1493f;' });
    const certLog = el('pre', { style: 'display:none; max-height:260px; overflow:auto; font-size:11px; white-space:pre-wrap; word-break:break-all; background:rgba(128,128,128,.12); padding:6px; border-radius:6px; margin:6px 0 0;' });
    const email = el('input', { type: 'text', placeholder: 'you@example.com' });
    email.style.width = '100%';
    const stg = el('input', { type: 'checkbox' });
    const get = el('button', { className: 'btn sm accent', textContent: t('cert.get') });
    const fwLine = el('div', { style: 'font-size:13px; margin:6px 0 2px;' });
    const fwBtn = el('button', { className: 'btn sm primary', textContent: t('cert.fwBtn'), style: 'display:none;' });
    fwBtn.addEventListener('click', () =>
      work(fwBtn, async () => {
        const r = await window.api.allowPublicFirewall();
        setStatus(r.message);
        await refreshCert();
      })
    );
    const refreshCert = async () => {
      let st;
      try {
        st = await window.api.acmeStatus(s.domain);
      } catch {
        return;
      }
      if (!email.value) email.value = st.email || '';
      certLines.textContent = '';
      if (!names.length) certLines.appendChild(el('div', { textContent: t('cert.noNames') }));
      for (const c of st.certs) {
        const line = el('div', { textContent: t('cert.' + c.status, c.host, c.expires, c.days) + (c.staging ? t('cert.staging') : '') });
        line.style.color = c.status === 'ok' ? '#2e9d4f' : c.status === 'none' ? '' : '#d1493f';
        certLines.appendChild(line);
      }
      fwLine.textContent = st.fwPublic ? t('cert.fwOk') : t('cert.fwNo');
      fwLine.style.color = st.fwPublic ? '#2e9d4f' : '#d1493f';
      fwBtn.style.display = st.fwPublic ? 'none' : '';
      const notes = [];
      if (st.httpsOn) {
        const h = el('div', { textContent: st.webId === 'apache' ? t('cert.httpsApache') : t('cert.httpsOn') });
        h.style.color = st.webId === 'apache' ? '#d1493f' : '#2e9d4f';
        certLines.appendChild(h);
      }
      if (!st.installed) notes.push(t('cert.notinst'));
      if (!st.serverRunning) notes.push(t('cert.srvStopped'));
      else if (!st.port80) notes.push(t('cert.port'));
      certNote.textContent = notes.join(' ');
    };
    get.addEventListener('click', () =>
      work(get, async () => {
        const typed = ta.value.toLowerCase().split(/[\s,;]+/).filter(Boolean).sort().join(' ');
        if (typed !== [...names].sort().join(' ')) {
          certNote.textContent = t('cert.unsaved');
          return;
        }
        certLog.style.display = 'none';
        const r = await window.api.acmeIssue(s.domain, email.value.trim(), stg.checked);
        setStatus(r.message);
        certNote.textContent = r.ok ? '' : r.message;
        if (r.output) {
          certLog.textContent = r.output;
          certLog.style.display = 'block';
        }
        await refreshCert();
      })
    );
    dlg.appendChild(
      el(
        'div',
        { style: 'margin-top:14px; padding-top:10px; border-top:1px solid rgba(128,128,128,.3);' },
        el('b', { textContent: t('cert.title') }),
        el('div', { className: 'hint', textContent: t('cert.hint') }),
        certLines,
        el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' }, fwLine, fwBtn),
        el('label', { style: 'display:block; font-weight:600; margin:8px 0 3px;', textContent: t('cert.email') }),
        email,
        el('label', { style: 'display:flex; gap:6px; align-items:center; margin:8px 0; font-size:13px;' }, stg, el('span', { textContent: t('cert.test') })),
        el('div', { style: 'display:flex; justify-content:flex-end;' }, get),
        certNote,
        certLog
      )
    );
    refreshCert();
    dlg.addEventListener('close', () => dlg.remove());
    document.body.appendChild(dlg);
    dlg.showModal();
  });
  return btn;
}

// Tools পেজের win-acme কার্ড (Step B2): ইনস্টল অবস্থা, সার্টিফিকেট ফোল্ডার, অটো-নবায়ন
async function loadAcme() {
  const box = $('acmeBox');
  if (!box) return;
  let st;
  try {
    st = await window.api.acmeStatus();
  } catch {
    return;
  }
  box.textContent = '';
  const install = el('button', { className: 'btn sm accent', textContent: t('acme.install') });
  install.addEventListener('click', () =>
    work(install, async () => {
      const r = await window.api.acmeInstall();
      setStatus(r.message);
      await loadAcme();
    })
  );
  const folder = el('button', { className: 'btn sm', textContent: t('acme.folder') });
  folder.addEventListener('click', () => window.api.acmeFolder());
  const renew = el('button', { className: 'btn sm', textContent: t('acme.taskSet') });
  renew.addEventListener('click', () =>
    work(renew, async () => {
      const r = await window.api.acmeAutoRenew();
      setStatus(r.message);
      await loadAcme();
    })
  );
  box.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px;' }, el('b', { textContent: st.installed ? t('acme.installed') : t('acme.missing') }), el('span', { style: 'flex:1' }), ...(st.installed ? [] : [install]), folder));
  box.appendChild(el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px;' }, el('span', { textContent: st.task ? t('acme.taskOn') : t('acme.taskOff') }), el('span', { style: 'flex:1' }), ...(st.installed && !st.task ? [renew] : [])));
}

// LAN-এ শেয়ার: সুইচ + পোর্ট; চালু থাকলে http://<IP>:<পোর্ট> ও Copy
function netCell(s, net) {
  if (s.system || s.name === 'localhost' || !s.enabled) return el('td', { className: 'php-text', textContent: '—' });
  const cb = el('input', { type: 'checkbox', checked: !!s.share.on });
  const port = el('input', { type: 'number', min: 1024, max: 65535, placeholder: t('share.auto') });
  port.style.width = '78px';
  if (s.share.port) port.value = s.share.port;
  const save = () =>
    work(cb, async () => {
      const r = await window.api.setSiteShare(s.domain, cb.checked, port.value);
      setStatus(r.message);
      await loadSites();
    });
  cb.addEventListener('change', save);
  port.addEventListener('change', save);
  const kids = [el('label', { className: 'switch', title: t('share.tip') }, cb, el('i')), ' ', port];
  if (s.share.on && s.share.port) {
    const ip = net.ips[0];
    if (ip) {
      const url = `http://${ip}:${s.share.port}`;
      const btn = el('button', { className: 'btn sm', textContent: t('share.copy') });
      btn.addEventListener('click', async () => {
        await copyText(url);
        setStatus(t('share.copied', url));
      });
      kids.push(el('div', { className: 'hint', style: 'margin-top:4px; word-break:break-all;' }, url, ' ', btn));
    } else {
      kids.push(el('div', { className: 'hint', textContent: t('share.noip') }));
    }
  }
  kids.push(el('div', { style: 'margin-top:6px;' }, publicBtn(s)));
  return el('td', {}, ...kids);
}

function renderShareBar(net) {
  const bar = $('shareBar');
  bar.textContent = '';
  const ipText = net.ips.length ? net.ips.join(', ') : t('share.noip');
  const row = el('div', { className: 'row first' }, el('b', { textContent: t('share.title') }), el('span', { className: 'hint', textContent: ' ' + t('share.ip') + ': ' + ipText }));
  if (net.fw.known) {
    row.appendChild(el('span', { className: 'badge ' + (net.fw.ok ? 'ok' : ''), textContent: net.fw.ok ? t('share.fw.ok') : t('share.fw.no') }));
    if (!net.fw.ok) {
      const b = el('button', { className: 'btn sm primary', textContent: t('share.fw.btn') });
      b.addEventListener('click', () =>
        work(b, async () => {
          const r = await window.api.allowFirewall();
          setStatus(r.message);
          await loadSites();
        })
      );
      row.appendChild(b);
    }
  }
  bar.appendChild(row);
  bar.appendChild(el('div', { className: 'hint', textContent: t('share.hint') }));
}

function folderCell(s) {
  const a = el('a', { className: 'link', textContent: s.root, title: t('sites.openFolder') });
  a.addEventListener('click', async () => {
    const r = await window.api.openSiteFolder(s.domain);
    if (!r.ok) setStatus(r.message);
  });
  return el('td', { className: 'path' }, a);
}

function enabledCell(s) {
  if (s.system || s.name === 'localhost') return el('td', { className: 'php-text', textContent: '—' });
  const cb = el('input', { type: 'checkbox', checked: !!s.enabled });
  cb.addEventListener('change', () =>
    work(cb, async () => {
      const r = await window.api.setSiteEnabled(s.domain, cb.checked);
      setStatus(r.message);
      await loadSites();
    })
  );
  return el('td', {}, cb);
}

// নাম জিজ্ঞেস করার ছোট পপআপ (Electron-এ prompt() নেই); বাতিল করলে null
function askName(title, hint, placeholder) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'text', maxLength: 40, placeholder });
    const ok = el('button', { className: 'btn sm primary', textContent: t('dlg.ok') });
    const cancel = el('button', { className: 'btn sm', textContent: t('dlg.cancel') });
    const box = el('div', { className: 'modal-box' }, el('div', { className: 'modal-title', textContent: title }), el('div', { className: 'hint', textContent: hint }), input, el('div', { className: 'row' }, ok, cancel));
    const back = el('div', { className: 'modal-back' }, box);
    const close = (v) => {
      back.remove();
      resolve(v);
    };
    ok.addEventListener('click', () => close(input.value.trim()));
    cancel.addEventListener('click', () => close(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim());
      if (e.key === 'Escape') close(null);
    });
    back.addEventListener('mousedown', (e) => {
      if (e.target === back) close(null);
    });
    document.body.appendChild(back);
    input.focus();
  });
}

function confCell(s, custom) {
  const b = el('button', { className: 'btn sm', textContent: t('sites.conf'), disabled: !s.enabled });
  b.addEventListener('click', () =>
    work(b, async () => {
      const r = await window.api.openSiteConf(s.domain, selectedServer());
      setStatus(r.message);
    })
  );
  // এক্সট্রা conf: sites-enabled\<domain>.d\*.conf (সিস্টেম সাইট ও বন্ধ সাইটে নয়)
  const noExtra = !s.enabled || s.system;
  const add = el('button', { className: 'btn sm', textContent: t('sites.addExtra'), title: t('sites.addExtra.tip'), disabled: noExtra });
  add.addEventListener('click', () =>
    work(add, async () => {
      const name = await askName(t('dlg.extra.title', s.domain), t('dlg.extra.hint'), t('dlg.extra.ph'));
      if (!name) return;
      const r = await window.api.addSiteExtra(s.domain, selectedServer(), name);
      setStatus(r.message);
    })
  );
  const dir = el('button', { className: 'btn sm', textContent: '📁', title: t('sites.openExtras.tip'), disabled: noExtra });
  dir.addEventListener('click', () =>
    work(dir, async () => {
      const r = await window.api.openSiteExtras(s.domain, selectedServer());
      if (!r.ok) setStatus(r.message);
    })
  );
  // নিজের করে রাখা (marker নেই) হলে "নিজের" ব্যাজ + "অটোতে ফিরুন"; নইলে "নিজের করে রাখুন"
  const own = custom.has(s.domain);
  const keepBtn = el('button', {
    className: 'btn sm',
    textContent: own ? t('sites.reset') : t('sites.keep'),
    title: own ? t('sites.reset.tip') : t('sites.keep.tip'),
    disabled: !s.enabled,
  });
  keepBtn.addEventListener('click', () =>
    work(keepBtn, async () => {
      if (own && !confirm(t('sites.reset.confirm', s.domain))) return;
      const r = own ? await window.api.resetSiteConf(s.domain, selectedServer()) : await window.api.keepSiteConf(s.domain, selectedServer());
      setStatus(r.message);
      await loadSites();
    })
  );
  const badge = own ? el('span', { className: 'badge custom', textContent: t('sites.custom'), title: t('sites.custom.tip') }) : null;
  return el('td', { className: 'conf-cell' }, b, ' ', add, ' ', dir, ' ', keepBtn, ...(badge ? [' ', badge] : []));
}

async function renderSites(sites, php) {
  let custom = new Set();
  try {
    custom = new Set((await window.api.confState(selectedServer())).custom);
  } catch {}
  let net = { ips: [], fw: { known: false, ok: false } };
  try {
    net = await window.api.netInfo();
  } catch {}
  renderShareBar(net);
  const body = $('sitesBody');
  body.textContent = '';
  $('siteCount').textContent = sites.filter((s) => !s.system).length;
  for (const s of sites) {
    const a = el('a', { className: 'link', textContent: s.url });
    a.addEventListener('click', () => window.api.openUrl(s.url));
    const row = el(
      'tr',
      {},
      enabledCell(s),
      el('td', {}, a, ...(s.system ? [' ', el('span', { className: 'badge tool', textContent: t('sites.tool') })] : []), ...(s.node ? [' ', el('span', { className: 'badge tool', textContent: t('sites.node') })] : [])),
      folderCell(s),
      phpCell(s, php),
      sessionCell(s),
      limitsCell(s),
      netCell(s, net),
      confCell(s, custom)
    );
    if (!s.enabled) row.style.opacity = '0.55';
    body.appendChild(row);
  }
  if (sites.filter((s) => !s.system).length <= 1) {
    body.appendChild(el('tr', {}, el('td', { className: 'empty', colSpan: 8, textContent: t('sites.empty') })));
  }
}
async function loadSites() {
  const [sites, php] = await Promise.all([window.api.listSites(), window.api.listPhp()]);
  renderSites(sites, php);
  loadNodeSites();
}

// ---------- Node.js অ্যাপ ----------
// প্রতিটা Node সাইটের জন্য একটা ব্লক: কমান্ড, পোর্ট, চালু/বন্ধ/রিস্টার্ট, npm install, লগ।
// ব্লকগুলো একবার বানানো হয়, পরে শুধু অবস্থা বদলায় (যাতে টাইপ করা লেখা মুছে না যায়)।
const nodeUi = {};
let nodeLogTimer = null;

function nodeStateText(state) {
  return state === 'run' ? t('node.state.run') : state === 'install' ? t('node.state.install') : t('node.state.stopped');
}

function buildNodeApp(n) {
  const name = el('b', { textContent: n.domain });
  const badge = el('span', { className: 'badge' });
  const openLink = el('a', { className: 'link' });
  const cmdIn = el('input', { type: 'text', maxLength: 300 });
  const portIn = el('input', { type: 'number', min: 1, max: 65535 });
  const verSel = el('select', { title: t('node.version.tip') });
  const autoChk = el('input', { type: 'checkbox' });
  const autoLbl = el('label', { className: 'switch', title: t('node.auto.tip') }, autoChk, el('i'), t('node.auto'));
  const allChk = el('input', { type: 'checkbox' });
  const allLbl = el('label', { className: 'switch', title: t('node.all.tip') }, allChk, el('i'), t('node.all'));
  const saveBtn = el('button', { className: 'btn sm', textContent: t('node.save') });
  const startBtn = el('button', { className: 'btn sm primary', textContent: t('node.start') });
  const stopBtn = el('button', { className: 'btn sm danger', textContent: t('node.stop') });
  const restartBtn = el('button', { className: 'btn sm', textContent: t('node.restart') });
  const installBtn = el('button', { className: 'btn sm accent', textContent: t('node.install'), title: t('node.install.tip') });
  const logBtn = el('button', { className: 'btn sm', textContent: t('node.log') });
  const logBox = el('pre', { className: 'node-log', hidden: true });
  const folder = el('div', { className: 'hint', style: 'margin-top:6px' });
  const domain = n.domain;
  const done = async (r) => {
    if (r && r.message) setStatus(r.message);
    cmdIn.dataset.dirty = '';
    portIn.dataset.dirty = '';
    await loadNodeSites();
    if (!logBox.hidden) pollLog(domain);
  };

  openLink.addEventListener('click', () => {
    const u = nodeUi[domain] && nodeUi[domain].data;
    if (u) window.api.openUrl(u.webRunning ? u.url : `http://localhost:${u.port}`);
  });
  const cfgNow = () => ({ cmd: cmdIn.value, port: portIn.value, version: verSel.value, autostart: autoChk.checked, startall: allChk.checked });
  saveBtn.addEventListener('click', () => work(saveBtn, async () => done(await window.api.configNode(domain, cfgNow()))));
  // ভার্সন বা অটো-চালু বদলালেই সেভ (এগুলোর জন্য আলাদা বাটন লাগে না)
  const quickSave = (ctl) => () =>
    work(ctl, async () => {
      const r = await window.api.configNode(domain, { version: verSel.value, autostart: autoChk.checked, startall: allChk.checked });
      verSel.dataset.dirty = '';
      setStatus(r.message);
      await loadNodeSites();
    });
  verSel.addEventListener('change', quickSave(verSel));
  autoChk.addEventListener('change', quickSave(autoChk));
  allChk.addEventListener('change', quickSave(allChk));
  startBtn.addEventListener('click', () =>
    work(startBtn, async () => {
      setStatus(t('node.starting', domain));
      const c = await window.api.configNode(domain, cfgNow()); // ঘরের বর্তমান মান আগে সেভ
      if (!c.ok) return setStatus(c.message);
      logBox.hidden = false;
      startLogTimer();
      await done(await window.api.startNode(domain));
    })
  );
  stopBtn.addEventListener('click', () => work(stopBtn, async () => done(await window.api.stopNode(domain))));
  restartBtn.addEventListener('click', () => work(restartBtn, async () => done(await window.api.restartNode(domain))));
  installBtn.addEventListener('click', () =>
    work(installBtn, async () => {
      logBox.hidden = false;
      startLogTimer();
      await done(await window.api.installNode(domain));
    })
  );
  logBtn.addEventListener('click', () => {
    logBox.hidden = !logBox.hidden;
    if (!logBox.hidden) {
      pollLog(domain);
      startLogTimer();
    }
  });

  const box = el(
    'div',
    { className: 'node-app' },
    el('div', { className: 'row first' }, name, badge, el('span', { className: 'spacer' }), openLink),
    folder,
    el('div', { className: 'row' }, cmdIn, portIn, saveBtn),
    el('div', { className: 'row' }, el('span', { className: 'hint', textContent: t('node.version') }), verSel, el('span', { className: 'spacer' }), autoLbl, allLbl),
    el('div', { className: 'row' }, startBtn, stopBtn, restartBtn, installBtn, el('span', { className: 'spacer' }), logBtn),
    logBox
  );
  nodeUi[domain] = { box, badge, openLink, cmdIn, portIn, verSel, autoChk, allChk, startBtn, stopBtn, restartBtn, installBtn, saveBtn, logBox, folder, data: n };
  return box;
}

function updateNodeApp(n) {
  const u = nodeUi[n.domain];
  u.data = n;
  u.badge.textContent = nodeStateText(n.state);
  u.badge.classList.toggle('on', n.state === 'run');
  u.openLink.textContent = n.webRunning ? n.url : `http://localhost:${n.port}`;
  u.folder.textContent = n.root + (n.hasModules ? '' : t('node.noModules'));
  u.cmdIn.placeholder = t('node.cmdPh', n.cmdAuto || '—');
  u.portIn.placeholder = t('node.portPh');
  // ঘরে ফোকাস থাকলে বা লেখা বদলানো থাকলে ওভাররাইট করি না
  if (document.activeElement !== u.cmdIn && u.cmdIn.dataset.dirty !== '1') u.cmdIn.value = n.cmd;
  if (document.activeElement !== u.portIn && u.portIn.dataset.dirty !== '1') u.portIn.value = n.manual ? n.port : '';
  // Node ভার্সন তালিকা: প্রথমে চালু ভার্সন (ডিফল্ট), তারপর যোগ করা বাকিগুলো
  if (!u.verSel.classList.contains('working') && document.activeElement !== u.verSel) {
    u.verSel.textContent = '';
    u.verSel.appendChild(el('option', { value: '', textContent: t('node.version.def', n.defVersion) }));
    for (const v of n.versions) {
      if (v.version === n.defVersion) continue;
      u.verSel.appendChild(el('option', { value: v.version, textContent: 'Node ' + v.version + (v.installed ? '' : t('node.version.missing')) }));
    }
    u.verSel.value = n.version || '';
  }
  u.verSel.disabled = n.state !== 'stopped'; // চলার সময় ভার্সন বদলানো যাবে না (আগে বন্ধ করুন)
  if (document.activeElement !== u.autoChk) u.autoChk.checked = n.autostart;
  if (document.activeElement !== u.allChk) u.allChk.checked = n.startall;
  if (n.state === 'run' && n.runVersion) u.badge.textContent += ' · Node ' + n.runVersion;
  const idle = n.state === 'stopped' && n.enabled;
  if (!u.startBtn.classList.contains('working')) u.startBtn.disabled = !idle;
  if (!u.stopBtn.classList.contains('working')) u.stopBtn.disabled = n.state !== 'run';
  if (!u.restartBtn.classList.contains('working')) u.restartBtn.disabled = n.state !== 'run';
  if (!u.installBtn.classList.contains('working')) u.installBtn.disabled = !idle;
  u.box.style.opacity = n.enabled ? '' : '0.55';
}

async function pollLog(domain) {
  const u = nodeUi[domain];
  if (!u || u.logBox.hidden) return;
  const r = await window.api.nodeLog(domain);
  const atBottom = u.logBox.scrollTop + u.logBox.clientHeight >= u.logBox.scrollHeight - 30;
  u.logBox.textContent = r.lines.length ? r.lines.join('\n') : t('node.noLog');
  if (atBottom) u.logBox.scrollTop = u.logBox.scrollHeight;
}
function startLogTimer() {
  if (nodeLogTimer) return;
  nodeLogTimer = setInterval(async () => {
    const open = Object.keys(nodeUi).filter((d) => nodeUi[d] && !nodeUi[d].logBox.hidden);
    if (!open.length || currentPage !== 'sites') {
      clearInterval(nodeLogTimer);
      nodeLogTimer = null;
      return;
    }
    for (const d of open) await pollLog(d);
  }, 1500);
}

async function loadNodeSites() {
  let list = [];
  try {
    list = await window.api.listNodeSites();
  } catch {}
  $('nodeCard').hidden = list.length === 0;
  const holder = $('nodeList');
  for (const d of Object.keys(nodeUi)) {
    if (!list.some((n) => n.domain === d)) {
      nodeUi[d].box.remove();
      delete nodeUi[d];
    }
  }
  for (const n of list) {
    if (!nodeUi[n.domain]) {
      const box = buildNodeApp(n);
      nodeUi[n.domain].cmdIn.addEventListener('input', () => (nodeUi[n.domain].cmdIn.dataset.dirty = '1'));
      nodeUi[n.domain].portIn.addEventListener('input', () => (nodeUi[n.domain].portIn.dataset.dirty = '1'));
      holder.appendChild(box);
    }
    updateNodeApp(n);
  }
}
$('refreshSites').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('sites.searching'));
    const r = await window.api.refreshSites();
    renderSites(r.sites, await window.api.listPhp());
    setStatus(r.message);
  })
);

// ---------- নতুন সাইট (খালি / WordPress) ----------
function createSite(kind) {
  return (e) =>
    work(e.currentTarget, async () => {
      const name = $('newSiteName').value;
      setStatus(t('starting'));
      const r = await window.api.createSite(kind, name);
      setStatus(r.message);
      if (r.ok) {
        $('newSiteName').value = '';
        renderSites(r.sites, await window.api.listPhp());
        if (r.url) window.api.openUrl(r.url);
      }
    });
}
// Node.js স্টার্টার টেমপ্লেট (basic / express / vite / next)। npm লাগে এমনগুলোর জন্য তৈরির পরে নিজে থেকে npm install চালায়।
$('newNode').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const name = $('newSiteName').value;
    setStatus(t('starting'));
    const r = await window.api.createSite($('newNodeKind').value, name);
    setStatus(r.message);
    if (!r.ok) return;
    $('newSiteName').value = '';
    renderSites(r.sites, await window.api.listPhp());
    if (r.node && r.node.install) {
      await loadNodeSites();
      const u = nodeUi[r.node.domain];
      if (u) {
        u.logBox.hidden = false;
        startLogTimer();
        setStatus(t('node.creating', r.node.domain));
        const ir = await window.api.installNode(r.node.domain);
        setStatus(ir.ok ? ir.message + t('node.thenStart') : ir.message);
        await loadNodeSites();
        pollLog(r.node.domain);
      }
    }
  })
);
$('newBlank').addEventListener('click', createSite('blank'));
$('newWp').addEventListener('click', createSite('wordpress'));
$('newLaravel').addEventListener('click', createSite('laravel'));

// ---------- সেটিংস: ফোল্ডার ----------
$('changeWww').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const r = await window.api.chooseWww();
    $('wwwPath').textContent = r.path;
    if (r.message) setStatus(r.message);
    else if (r.ok) setStatus(t('folder.changed'));
    loadSites();
  })
);
$('openWww').addEventListener('click', () => window.api.openWww());
$('openWww2').addEventListener('click', () => window.api.openWww());
$('openSitesDir').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const r = await window.api.openSitesDir(selectedServer());
    if (!r.ok) setStatus(r.message);
  })
);

$('resetAllConf').addEventListener('click', (e) => {
  if (!confirm(t('sites.resetAll.confirm'))) return;
  work(e.currentTarget, async () => {
    const r = await window.api.resetAllConf(selectedServer());
    setStatus(r.message);
    await loadSites();
  });
});

$('changeRoot').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const r = await window.api.chooseRoot();
    $('rootPath').textContent = r.path;
    if (r.message) setStatus(r.message);
  })
);
$('openRoot').addEventListener('click', () => window.api.openRoot());

// ---------- টুলস ও ভার্সন ----------
let extVer = '';
async function loadExt() {
  const r = await window.api.listExt(extVer);
  extVer = r.version;
  const sel = $('extVer');
  sel.textContent = '';
  for (const v of r.versions) sel.appendChild(el('option', { value: v, textContent: 'PHP ' + v + (v === r.def ? ' (default)' : '') }));
  sel.value = r.version;
  const grid = $('extGrid');
  grid.textContent = '';
  if (!r.items.length) grid.appendChild(el('div', { className: 'hint', textContent: t('ext.empty') }));
  for (const it of r.items) {
    const cb = el('input', { type: 'checkbox', checked: it.enabled });
    cb.addEventListener('change', () =>
      work(cb, async () => {
        const res = await window.api.setExt(extVer, it.name, cb.checked);
        setStatus(res.message);
        if (!res.ok) await loadExt();
      })
    );
    grid.appendChild(el('label', { style: 'display:flex;align-items:center;gap:6px;font-size:13px;' }, cb, el('span', { textContent: it.name })));
  }
}
$('extVer').addEventListener('change', () => {
  extVer = $('extVer').value;
  loadExt();
});

// ---------- কনফিগ ফাইল কার্ড ----------
async function loadCfg() {
  const box = $('cfgList');
  if (!box) return;
  let list = [];
  try {
    list = await window.api.cfgList();
  } catch {
    return;
  }
  box.textContent = '';
  for (const c of list) {
    const open = el('button', { className: 'btn sm accent', textContent: t('cfg.open') });
    open.disabled = !c.canOpen;
    open.addEventListener('click', () =>
      work(open, async () => {
        const r = await window.api.cfgOpen(c.id);
        setStatus(r.message);
      })
    );
    const folder = el('button', { className: 'btn sm', textContent: '📁', title: t('cfg.folder') });
    folder.addEventListener('click', () => window.api.cfgFolder(c.id));
    const badgeCls = c.kind === 'yours' ? ' on' : c.kind === 'auto' ? ' custom' : ' tool';
    box.appendChild(
      el(
        'div',
        { style: 'padding:10px 0; border-top:1px solid rgba(128,128,128,.25);' },
        el('div', { style: 'display:flex; gap:8px; align-items:center; flex-wrap:wrap;' }, el('b', { textContent: c.label }), el('span', { className: 'badge' + badgeCls, textContent: t('cfg.kind.' + c.kind) }), el('span', { style: 'flex:1' }), open, folder),
        el('div', { style: 'word-break:break-all; font-size:12px; margin-top:4px; opacity:.8;', textContent: c.file + (c.exists ? '' : ' ' + t('cfg.notYet')) }),
        el('div', { className: 'hint', textContent: c.note })
      )
    );
  }
}

function renderTools(tools) {
  loadExt();
  loadCfg();
  loadAcme();
  const box = $('toolsList');
  box.textContent = '';
  for (const tl of tools) {
    const verIn = el('input', { type: 'text', placeholder: t('tools.verPh') });
    const urlIn = el('input', { type: 'text', placeholder: t('tools.urlPh') });
    const addUrl = el('button', { className: 'btn sm accent', textContent: t('tools.addUrl') });
    const addLocal = el('button', { className: 'btn sm', textContent: t('tools.addLocal') });
    const helpBtn = el('button', { className: 'btn sm', textContent: t('tools.help') });

    const afterAdd = async (r) => {
      if (r.message) setStatus(r.message);
      if (r.ok) await loadTools();
    };
    addUrl.addEventListener('click', () =>
      work(addUrl, async () => {
        setStatus(t('tools.adding', tl.label));
        await afterAdd(await window.api.addTool({ id: tl.id, version: verIn.value, url: urlIn.value }));
      })
    );
    addLocal.addEventListener('click', () =>
      work(addLocal, async () => afterAdd(await window.api.addTool({ id: tl.id, version: verIn.value, local: true })))
    );
    helpBtn.addEventListener('click', () => window.api.toolHelp(tl.id));

    const rows = tl.versions.map((v) => {
      const useBtn = el('button', { className: 'btn sm accent', textContent: t('tools.use') });
      const delBtn = el('button', { className: 'btn sm', textContent: t('tools.remove') });
      useBtn.disabled = tl.inUse;
      useBtn.addEventListener('click', () =>
        work(useBtn, async () => {
          const r = await window.api.useTool(tl.id, v.version);
          setStatus(r.message);
          await loadTools();
        })
      );
      delBtn.addEventListener('click', () =>
        work(delBtn, async () => {
          if (!confirm(t('tools.confirmRemove', tl.label, v.version))) return;
          const r = await window.api.removeTool(tl.id, v.version);
          setStatus(r.message);
          await loadTools();
        })
      );
      return el(
        'div',
        { className: 'ver-row' + (v.active ? ' active' : '') },
        el('b', { textContent: 'v' + v.version }),
        el('span', { className: 'badge tool', textContent: t('tools.src.' + v.source) }),
        el('span', { className: 'ver-state', textContent: v.installed ? t('tools.installed') : t('tools.notInstalled') }),
        el('span', { className: 'spacer' }),
        v.active ? el('span', { className: 'badge on', textContent: t('tools.active') }) : useBtn,
        ...(!v.isDefault && !v.active ? [delBtn] : [])
      );
    });

    box.appendChild(
      el(
        'div',
        { className: 'card' },
        el(
          'div',
          { className: 'card-head' },
          el('div', { className: 'card-icon', textContent: tl.label.slice(0, 3).toUpperCase() }),
          el('div', {}, el('div', { className: 'card-title', textContent: tl.label }), el('div', { className: 'card-sub', textContent: t('tools.current', tl.active) })),
          tl.inUse ? el('span', { className: 'badge on', textContent: t('tools.running') }) : null
        ),
        ...rows,
        el(
          'div',
          { className: 'add-box' },
          el('div', { className: 'row first' }, verIn, urlIn),
          el('div', { className: 'row' }, addUrl, addLocal, el('span', { className: 'spacer' }), helpBtn),
          el('div', { className: 'hint', textContent: tl.hint + (LANG === 'en' ? '.' : '।') + (tl.isDb ? t('tools.dbNote') : '') })
        )
      )
    );
  }
}
async function loadTools() {
  renderTools(await window.api.listTools());
}

// ---------- শুরুতে ----------
window.api.onStatus(setStatus);
window.api.onWwwChanged((p) => {
  $('wwwPath').textContent = p;
  loadSites();
});
window.api.onRootChanged((p) => ($('rootPath').textContent = p));
// প্রথমবারের ভাষা-ডায়ালগে বাছা ভাষা (main.js পাঠায়)
window.api.onLangChanged((l) => {
  if (l !== LANG) setLang(l);
});

async function refreshAll() {
  try {
    applyWeb(await window.api.webStatus());
    await loadDbs();
    if (currentPage === 'settings') {
      await loadMysqlPw();
      await loadPgPw();
    }
    if (currentPage === 'sites') await loadNodeSites(); // Node অ্যাপ চলছে/বন্ধ অবস্থা হালনাগাদ
  } catch {}
}

// ---------- MySQL root পাসওয়ার্ড ----------
async function loadMysqlPw() {
  try {
    const r = await window.api.mysqlPwState();
    $('mysqlPwState').textContent = (r.hasPw ? t('settings.pw.isSet') : t('settings.pw.isEmpty')) + ' · ' + (r.running ? t('settings.pw.running') : t('settings.pw.stopped'));
  } catch {}
}
async function loadPgPw() {
  try {
    const r = await window.api.pgPwState();
    $('pgPwState').textContent = (r.hasPw ? t('settings.pw.isSet') : t('settings.pw.isEmpty')) + ' · ' + (r.running ? t('settings.pg.running') : t('settings.pg.stopped'));
  } catch {}
}
$('pgPwSet').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const pw = $('pgPw').value;
    if (!pw) return setStatus(t('settings.pw.enter'));
    const r = await window.api.pgSetPassword(pw);
    setStatus(r.message);
    if (r.ok) $('pgPw').value = '';
    await loadPgPw();
    loadDbs();
  })
);
$('pgPwClear').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (!confirm(t('settings.pg.confirmClear'))) return;
    const r = await window.api.pgSetPassword('');
    setStatus(r.message);
    await loadPgPw();
    loadDbs();
  })
);
$('mysqlPwSet').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const pw = $('mysqlPw').value;
    if (!pw) return setStatus(t('settings.pw.enter'));
    const r = await window.api.mysqlSetPassword(pw);
    setStatus(r.message);
    if (r.ok) $('mysqlPw').value = '';
    await loadMysqlPw();
    loadDbs();
  })
);
$('mysqlPwClear').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (!confirm(t('settings.pw.confirmClear'))) return;
    const r = await window.api.mysqlSetPassword('');
    setStatus(r.message);
    await loadMysqlPw();
    loadDbs();
  })
);

// ---------- পাসওয়ার্ড দেখান / কপি / ভুলে গেলে রিসেট (MySQL ও PostgreSQL) ----------
for (const c of [
  { p: 'mysql', kind: 'mysql', reset: (pw) => window.api.mysqlResetPassword(pw), confirmKey: 'settings.pw.resetConfirmMy', reload: () => loadMysqlPw() },
  { p: 'pg', kind: 'postgres', reset: (pw) => window.api.pgSetPassword(pw, true), confirmKey: 'settings.pw.resetConfirmPg', reload: () => loadPgPw() },
]) {
  const val = $(c.p + 'PwVal');
  const showBtn = $(c.p + 'PwShow');
  let hideTimer;
  const hide = () => {
    clearTimeout(hideTimer);
    val.style.display = 'none';
    val.textContent = '';
    showBtn.textContent = t('settings.pw.show');
  };
  showBtn.addEventListener('click', () =>
    work(showBtn, async () => {
      if (val.style.display !== 'none') return hide();
      const pw = await window.api.getDbPw(c.kind);
      if (!pw) return setStatus(t('settings.pw.none'));
      val.textContent = pw;
      val.style.display = '';
      showBtn.textContent = t('settings.pw.hide');
      hideTimer = setTimeout(hide, 15000); // ১৫ সেকেন্ড পরে নিজে লুকিয়ে যায়
    })
  );
  $(c.p + 'PwCopy').addEventListener('click', (e) =>
    work(e.currentTarget, async () => {
      const pw = await window.api.getDbPw(c.kind);
      if (!pw) return setStatus(t('settings.pw.none'));
      await copyText(pw);
      setStatus(t('settings.pw.copied'));
    })
  );
  $(c.p + 'PwReset').addEventListener('click', (e) =>
    work(e.currentTarget, async () => {
      const pw = $(c.p + 'Pw').value;
      if (!confirm(t(c.confirmKey) + (pw ? '' : '\n\n' + t('settings.pw.resetEmpty')))) return;
      const r = await c.reset(pw);
      setStatus(r.message);
      if (r.ok) $(c.p + 'Pw').value = '';
      await c.reload();
      loadDbs();
    })
  );
}

// ---------- ব্যাকআপ ----------
let bk = null; // বর্তমান কনফিগ (সেভ না করা বদলসহ)
const bkBase = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || String(p);

async function bkLoad() {
  bk = await window.api.backupGetConfig();
  bkFill();
  bkStatus();
}

function bkFill() {
  $('bkLocalOn').checked = bk.local.enabled;
  $('bkLocalDir').textContent = bk.local.dir || '—';
  $('bkShareOn').checked = bk.share.enabled;
  $('bkShareUnc').value = bk.share.unc;
  $('bkShareUser').value = bk.share.user;
  $('bkShareSub').value = bk.share.subdir;
  $('bkSharePw').value = '';
  $('bkSharePw').placeholder = bk.hasSharePassword ? t('bk.pwSaved') : t('bk.share.pw');
  $('bkAppTimer').checked = bk.appEnabled;
  $('bkMysql').checked = bk.what.mysql;
  $('bkPg').checked = bk.what.postgres;
  $('bkWww').checked = bk.what.www;
  $('bkCerts').checked = bk.what.certs;
  $('bkAutoDb').checked = bk.autoStartDb;
  $('bkZipPw').value = '';
  $('bkZipPw').placeholder = bk.hasZipPassword ? t('bk.pwSaved') : t('bk.zipPw');
  $('bkZipState').textContent = bk.hasZipPassword ? t('bk.zipPwSet') : t('bk.zipPwNone');
  $('bkZipClear').hidden = !bk.hasZipPassword;
  $('bkRetention').value = bk.retentionDays;
  $('bkMinFree').value = bk.minFreeGb;
  bkRenderTimes();
  bkRenderExtra();
  bkRenderWwwEx();
  bkTaskRefresh();
}

function bkRenderTimes() {
  const box = $('bkTimes');
  box.textContent = '';
  if (!bk.times.length) return box.appendChild(el('span', { className: 'hint', textContent: t('bk.time.none') }));
  for (const tm of bk.times) {
    box.appendChild(
      el('button', {
        className: 'btn sm',
        textContent: tm + '  ✕',
        title: t('bk.remove'),
        onclick: () => {
          bk.times = bk.times.filter((x) => x !== tm);
          bkRenderTimes();
        },
      })
    );
  }
}

function bkRenderExtra() {
  const box = $('bkExtra');
  box.textContent = '';
  for (const it of bk.what.extra) {
    box.appendChild(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'pathbox', textContent: it.path, style: 'flex:1; margin:0' }),
        bkModeSelect(it),
        ...(it.mode === 'copy' ? [bkCleanInput(it), bkKeepInput(it)] : []),
        el('button', {
          className: 'btn sm',
          textContent: '✕',
          title: t('bk.remove'),
          onclick: () => {
            bk.what.extra = bk.what.extra.filter((x) => x !== it);
            bkRenderExtra();
          },
        })
      )
    );
  }
}

// প্রতিটা নিজের ফোল্ডারের মোড: আর্কাইভ (.7z) বা Incremental কপি (robocopy-র মতো)
function bkModeSelect(it) {
  const sel = el('select', {}, el('option', { value: 'archive', textContent: t('bk.extra.mode.archive') }), el('option', { value: 'copy', textContent: t('bk.extra.mode.copy') }));
  sel.value = it.mode === 'copy' ? 'copy' : 'archive';
  sel.addEventListener('change', () => {
    it.mode = sel.value;
    if (it.mode !== 'copy') { it.cleanDays = 0; it.keepDays = 0; }
    bkRenderExtra(); // Incremental কপি হলে "N দিন পর মোছা" ঘরটা দেখানো/লুকানো
  });
  return sel;
}

// Incremental কপির জন্য: মূল ফোল্ডার থেকে হারানো ফাইল N দিন পর backup থেকে মোছা (০ = কখনো না)
function bkCleanInput(it) {
  const inp = el('input', { type: 'number', min: '0', max: '3650', value: String(it.cleanDays || 0), title: t('bk.extra.cleanTip'), style: 'width:80px' });
  inp.addEventListener('change', () => {
    const v = parseInt(inp.value, 10);
    it.cleanDays = v > 0 ? Math.min(v, 3650) : 0;
    inp.value = String(it.cleanDays);
  });
  return el('label', { className: 'hint', style: 'margin:0; display:flex; align-items:center; gap:6px; white-space:nowrap' }, t('bk.extra.clean'), inp);
}

// Incremental কপির জন্য: বদলানো/মোছা ফাইলের পুরনো version N দিন রাখা (০ = রাখবে না, ডিস্কে বেশি জায়গা লাগে)
function bkKeepInput(it) {
  const inp = el('input', { type: 'number', min: '0', max: '3650', value: String(it.keepDays || 0), title: t('bk.extra.keepTip'), style: 'width:80px' });
  inp.addEventListener('change', () => {
    const v = parseInt(inp.value, 10);
    it.keepDays = v > 0 ? Math.min(v, 3650) : 0;
    inp.value = String(it.keepDays);
  });
  return el('label', { className: 'hint', style: 'margin:0; display:flex; align-items:center; gap:6px; white-space:nowrap' }, t('bk.extra.keep'), inp);
}

// www থেকে বাদ দেওয়া ফোল্ডারের তালিকা (www-র সাপেক্ষে পথ)
function bkRenderWwwEx() {
  const box = $('bkWwwEx');
  box.textContent = '';
  for (const rel of bk.what.wwwExclude || []) {
    box.appendChild(
      el(
        'div',
        { className: 'row' },
        el('span', { className: 'pathbox', textContent: 'www\\' + rel, style: 'flex:1; margin:0' }),
        el('button', {
          className: 'btn sm',
          textContent: '✕',
          title: t('bk.remove'),
          onclick: () => {
            bk.what.wwwExclude = bk.what.wwwExclude.filter((x) => x !== rel);
            bkRenderWwwEx();
          },
        })
      )
    );
  }
}

// ফর্মের মান bk-তে তুলে নেওয়া
function bkCollect() {
  bk.local.enabled = $('bkLocalOn').checked;
  bk.share = { enabled: $('bkShareOn').checked, unc: $('bkShareUnc').value.trim(), user: $('bkShareUser').value.trim(), subdir: $('bkShareSub').value.trim() };
  bk.appEnabled = $('bkAppTimer').checked;
  bk.what.mysql = $('bkMysql').checked;
  bk.what.postgres = $('bkPg').checked;
  bk.what.www = $('bkWww').checked;
  bk.what.certs = $('bkCerts').checked;
  bk.autoStartDb = $('bkAutoDb').checked;
  const days = parseInt($('bkRetention').value, 10);
  bk.retentionDays = Number.isInteger(days) && days >= 0 ? days : 14;
  const gb = Number($('bkMinFree').value);
  bk.minFreeGb = gb >= 0 ? gb : 0;
}

async function bkSave() {
  bkCollect();
  const secrets = {};
  if ($('bkZipPw').value) secrets.zip = $('bkZipPw').value;
  if ($('bkSharePw').value) secrets.share = $('bkSharePw').value;
  const r = await window.api.backupSetConfig(bk, secrets);
  if (!r.ok) {
    setStatus(r.message);
    return false;
  }
  bk = r.config;
  bkFill();
  return true;
}

async function bkStatus() {
  if (!bk) return;
  const s = await window.api.backupStatus();
  $('bkSevenState').textContent = s.sevenZip ? t('bk.sevenOk') : t('bk.sevenNo');
  $('bkSevenInstall').hidden = s.sevenZip;
  const last = s.last;
  if (s.running) $('bkLast').textContent = t('bk.running');
  else if (!last) $('bkLast').textContent = t('bk.noLast');
  else $('bkLast').textContent = (last.ok ? (last.warnings ? '⚠ ' : '✔ ') : '✖ ') + t('bk.last', last.stamp, last.source);
  const pre = $('bkLog');
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = s.log || '';
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

async function bkTaskRefresh() {
  const s = await window.api.backupTaskState();
  if (!$('bkTaskUser').value) $('bkTaskUser').value = s.user;
  let txt = t('bk.task.none');
  if (s.times.length) {
    txt = t('bk.task.on', s.times.join(', '));
    if (bk && s.times.join() !== bk.times.join()) txt += ' · ' + t('bk.task.diff');
  }
  $('bkTaskState').textContent = txt;
  $('bkTaskRemove').hidden = !s.times.length;
}
$('bkTaskInstall').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (!(await bkSave())) return;
    setStatus(t('bk.task.working'));
    const r = await window.api.backupTaskInstall($('bkTaskUser').value, $('bkTaskPw').value);
    $('bkTaskPw').value = '';
    setStatus((r.ok ? '' : '⚠ ') + r.message);
    bkTaskRefresh();
  })
);
$('bkTaskRemove').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (!confirm(t('bk.task.removeConfirm'))) return;
    const r = await window.api.backupTaskRemove();
    setStatus((r.ok ? '' : '⚠ ') + r.message);
    bkTaskRefresh();
  })
);

$('bkLocalPick').addEventListener('click', async () => {
  const p = await window.api.backupChooseFolder();
  if (p) {
    bk.local.dir = p;
    $('bkLocalDir').textContent = p;
    $('bkLocalOn').checked = true;
  }
});
$('bkExtraAdd').addEventListener('click', async () => {
  const p = await window.api.backupChooseFolder();
  if (p && !bk.what.extra.some((x) => x.path === p)) {
    bk.what.extra.push({ path: p, label: bkBase(p) });
    bkRenderExtra();
  }
});
$('bkWwwExAdd').addEventListener('click', async () => {
  const p = await window.api.backupChooseFolder();
  if (!p) return;
  const www = String(await window.api.getWww()).replace(/\//g, '\\').replace(/\\+$/, '');
  const v = p.replace(/\//g, '\\').replace(/\\+$/, '');
  if (!v.toLowerCase().startsWith(www.toLowerCase() + '\\')) return setStatus(t('bk.wwwEx.outside'));
  const rel = v.slice(www.length + 1);
  bk.what.wwwExclude = bk.what.wwwExclude || [];
  if (!bk.what.wwwExclude.some((x) => x.toLowerCase() === rel.toLowerCase())) {
    bk.what.wwwExclude.push(rel);
    bkRenderWwwEx();
  }
});
$('bkTimeAdd').addEventListener('click', () => {
  const v = $('bkTimeInput').value;
  if (v && !bk.times.includes(v)) {
    bk.times = [...bk.times, v].sort();
    bkRenderTimes();
  }
});
$('bkSave').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (await bkSave()) setStatus(t('bk.saved'));
  })
);
$('bkZipClear').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (!confirm(t('bk.zipPwClearConfirm'))) return;
    bkCollect();
    const r = await window.api.backupSetConfig(bk, { zip: '' });
    if (r.ok) {
      bk = r.config;
      bkFill();
      setStatus(t('bk.saved'));
    } else setStatus(r.message);
  })
);
$('bkSevenInstall').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    setStatus(t('bk.sevenInstalling'));
    const r = await window.api.backupEnsure7z();
    setStatus(r.message);
    bkStatus();
  })
);
$('bkRun').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    if (!(await bkSave())) return;
    setStatus(t('bk.starting'));
    const timer = setInterval(bkStatus, 1500);
    try {
      const r = await window.api.backupRun();
      setStatus((r.ok && !(r.status && r.status.warnings) ? '' : '⚠ ') + r.message);
    } finally {
      clearInterval(timer);
      bkStatus();
    }
  })
);
$('bkOpenLogs').addEventListener('click', () => window.api.backupOpenLogs());
setInterval(() => {
  if (currentPage === 'backup') bkStatus();
}, 4000);

// ---------- অ্যাপ চালু থাকা / অটো-স্টার্ট ----------
async function appBehaviorLoad() {
  const b = await window.api.appGetBehavior();
  $('appKeep').checked = b.keepRunning;
  $('appLogin').checked = b.openAtLogin;
  $('appAuto').checked = b.startAllOnLaunch;
}
['appKeep', 'appLogin', 'appAuto'].forEach((id) =>
  $(id).addEventListener('change', async () => {
    await window.api.appSetBehavior({ keepRunning: $('appKeep').checked, openAtLogin: $('appLogin').checked, startAllOnLaunch: $('appAuto').checked });
    setStatus(t('settings.app.saved'));
  })
);
// অ্যাপ খুললে (সেটিং চালু থাকলে) main থেকে ডাক আসে: নিজের বেছে নেওয়া ওয়েব সার্ভার দিয়ে Start All
window.api.onAutoStartAll(async () => {
  try {
    setStatus(await window.api.startAll(selectedServer()));
  } catch (err) {
    setStatus(String(err && err.message ? err.message : err));
  }
});
appBehaviorLoad();

applyStatic();
window.api.setLang(LANG); // মনে রাখা ভাষা main.js-কেও জানানো (বার্তা ও ডায়ালগের জন্য)
window.api.getWww().then((p) => ($('wwwPath').textContent = p));
window.api.getRoot().then((p) => ($('rootPath').textContent = p));
window.api.getPort().then((p) => (portInput.value = p));
loadSites();
loadMysqlPw();
loadPgPw();
refreshAll();
setInterval(refreshAll, 4000); // চলা/বন্ধ অবস্থা নিজে থেকে হালনাগাদ
