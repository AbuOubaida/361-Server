const $ = (id) => document.getElementById(id);

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
  await refreshAll();
  loadSites();
  if (currentPage === 'tools') loadTools();
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
      stopBtn
    ),
    el('div', { className: 'row' }, el('span', { className: 'badge tool', textContent: t('db.view') }), adminerBtn, ...(pmaBtn ? [pmaBtn] : [])),
    infoEl
  );
  dbsEl.appendChild(card);
  dbUi[db.id] = { sub: subEl, badge, portIn, saveBtn, startBtn, stopBtn, auto, infoEl };
}

function updateDb(db) {
  const ui = dbUi[db.id];
  ui.sub.textContent = t('db.sub', db.version);
  ui.infoEl.textContent = db.info;
  ui.badge.className = 'badge' + (db.running ? ' on' : '');
  ui.badge.textContent = db.running ? t('badge.db', db.port) : t('badge.stopped');
  setDisabled(ui.startBtn, db.running);
  setDisabled(ui.stopBtn, !db.running);
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

async function renderSites(sites, php) {
  const body = $('sitesBody');
  body.textContent = '';
  $('siteCount').textContent = sites.filter((s) => !s.system).length;
  for (const s of sites) {
    const a = el('a', { className: 'link', textContent: s.url });
    a.addEventListener('click', () => window.api.openUrl(s.url));
    body.appendChild(
      el(
        'tr',
        {},
        el('td', {}, a, ...(s.system ? [' ', el('span', { className: 'badge tool', textContent: t('sites.tool') })] : [])),
        el('td', { className: 'path', textContent: s.root }),
        phpCell(s, php)
      )
    );
  }
  if (sites.filter((s) => !s.system).length <= 1) {
    body.appendChild(el('tr', {}, el('td', { className: 'empty', colSpan: 3, textContent: t('sites.empty') })));
  }
}
async function loadSites() {
  const [sites, php] = await Promise.all([window.api.listSites(), window.api.listPhp()]);
  renderSites(sites, php);
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
$('newBlank').addEventListener('click', createSite('blank'));
$('newWp').addEventListener('click', createSite('wordpress'));

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

$('changeRoot').addEventListener('click', (e) =>
  work(e.currentTarget, async () => {
    const r = await window.api.chooseRoot();
    $('rootPath').textContent = r.path;
    if (r.message) setStatus(r.message);
  })
);
$('openRoot').addEventListener('click', () => window.api.openRoot());

// ---------- টুলস ও ভার্সন ----------
function renderTools(tools) {
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

async function refreshAll() {
  try {
    applyWeb(await window.api.webStatus());
    await loadDbs();
  } catch {}
}

applyStatic();
window.api.setLang(LANG); // মনে রাখা ভাষা main.js-কেও জানানো (বার্তা ও ডায়ালগের জন্য)
window.api.getWww().then((p) => ($('wwwPath').textContent = p));
window.api.getRoot().then((p) => ($('rootPath').textContent = p));
window.api.getPort().then((p) => (portInput.value = p));
loadSites();
refreshAll();
setInterval(refreshAll, 4000); // চলা/বন্ধ অবস্থা নিজে থেকে হালনাগাদ
