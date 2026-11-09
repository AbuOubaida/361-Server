const status = document.getElementById('status');
const wwwPath = document.getElementById('wwwPath');
const sitesEl = document.getElementById('sites');
const dbsEl = document.getElementById('dbs');
const portInput = document.getElementById('port');

function selectedServer() {
  return document.querySelector('input[name="server"]:checked').value;
}

// ---------- সাইট ----------
function renderSites(sites) {
  sitesEl.textContent = '';
  for (const s of sites) {
    const row = document.createElement('div');
    const a = document.createElement('a');
    a.textContent = s.url;
    a.addEventListener('click', () => window.api.openUrl(s.url));
    row.appendChild(a);
    sitesEl.appendChild(row);
  }
  if (sites.length <= 1) {
    const note = document.createElement('div');
    note.className = 'hint';
    note.textContent = 'www ফোল্ডারে একটা সাবফোল্ডার (যেমন blog) বানালে এখানে নতুন সাইট আসবে।';
    sitesEl.appendChild(note);
  }
}

async function loadSites() {
  renderSites(await window.api.listSites());
}

// ---------- ডাটাবেস ----------
function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function loadDbs() {
  const dbs = await window.api.listDbs();
  dbsEl.textContent = '';
  for (const db of dbs) {
    const dot = el('span', { className: 'dot' + (db.running ? ' on' : '') });
    const portIn = el('input', { type: 'number', min: 1, max: 65535, value: db.port });
    const saveBtn = el('button', { textContent: 'সেভ' });
    const startBtn = el('button', { textContent: 'Start' });
    const stopBtn = el('button', { textContent: 'Stop' });
    const auto = el('input', { type: 'checkbox', checked: db.auto });

    saveBtn.addEventListener('click', async () => {
      const r = await window.api.setPort(db.id, portIn.value);
      portIn.value = r.port;
      status.textContent = r.message;
    });
    startBtn.addEventListener('click', async () => {
      status.textContent = `${db.label} শুরু হচ্ছে...`;
      status.textContent = await window.api.startDb(db.id);
      loadDbs();
    });
    stopBtn.addEventListener('click', async () => {
      status.textContent = await window.api.stopDb(db.id);
      loadDbs();
    });
    auto.addEventListener('change', () => window.api.setDbAuto(db.id, auto.checked));

    dbsEl.appendChild(
      el(
        'div',
        { className: 'row' },
        el('div', { className: 'name' }, dot, db.label),
        el('div', {}, 'পোর্ট: ', portIn, ' ', saveBtn, ' ', startBtn, stopBtn),
        el('div', {}, el('label', {}, auto, ' Start All-এ যুক্ত')),
        el('div', { className: 'hint' }, db.info)
      )
    );
  }
}

// ---------- শুরুতে ----------
window.api.onStatus((msg) => {
  status.textContent = msg;
});
window.api.getWww().then((p) => (wwwPath.textContent = p));
window.api.onWwwChanged((p) => {
  wwwPath.textContent = p;
  loadSites();
});
window.api.getPort().then((p) => (portInput.value = p));
loadSites();
loadDbs();

// ---------- Start All / Stop All ----------
document.getElementById('startAll').addEventListener('click', async () => {
  status.textContent = 'সব শুরু হচ্ছে...';
  status.textContent = await window.api.startAll(selectedServer());
  loadSites();
  loadDbs();
});

document.getElementById('stopAll').addEventListener('click', async () => {
  status.textContent = 'সব বন্ধ হচ্ছে...';
  status.textContent = await window.api.stopAll();
  loadDbs();
});

// ---------- ওয়েব সার্ভার আলাদাভাবে ----------
document.getElementById('start').addEventListener('click', async () => {
  status.textContent = 'শুরু হচ্ছে...';
  status.textContent = await window.api.startServer(selectedServer());
  loadSites();
});

document.getElementById('stop').addEventListener('click', async () => {
  status.textContent = await window.api.stopServer();
});

document.getElementById('savePort').addEventListener('click', async () => {
  const r = await window.api.setPort('web', portInput.value);
  portInput.value = r.port;
  status.textContent = r.message;
  loadSites();
});

// ---------- www ফোল্ডার ও সাইট ----------
document.getElementById('changeWww').addEventListener('click', async () => {
  const r = await window.api.chooseWww();
  wwwPath.textContent = r.path;
  if (r.message) status.textContent = r.message;
  else if (r.ok) status.textContent = 'ফোল্ডার বদলানো হয়েছে। এবার Start চাপুন।';
  loadSites();
});

document.getElementById('openWww').addEventListener('click', () => {
  window.api.openWww();
});

document.getElementById('refreshSites').addEventListener('click', async () => {
  status.textContent = 'সাইট খোঁজা হচ্ছে...';
  const r = await window.api.refreshSites();
  renderSites(r.sites);
  status.textContent = r.message;
});
