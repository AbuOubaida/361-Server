const status = document.getElementById('status');
const wwwPath = document.getElementById('wwwPath');
const sitesEl = document.getElementById('sites');

function selectedServer() {
  return document.querySelector('input[name="server"]:checked').value;
}

function renderSites(sites) {
  sitesEl.textContent = '';
  if (!sites.length) {
    sitesEl.textContent = 'কোনো সাবফোল্ডার নেই। www ফোল্ডারে একটা ফোল্ডার বানান।';
    return;
  }
  for (const s of sites) {
    const row = document.createElement('div');
    const a = document.createElement('a');
    const url = `http://${s.domain}`;
    a.textContent = url;
    a.addEventListener('click', () => window.api.openUrl(url));
    row.appendChild(a);
    sitesEl.appendChild(row);
  }
}

async function loadSites() {
  renderSites(await window.api.listSites());
}

window.api.onStatus((msg) => {
  status.textContent = msg;
});

// বর্তমান www ফোল্ডার ও সাইট দেখানো
window.api.getWww().then((p) => (wwwPath.textContent = p));
window.api.onWwwChanged((p) => {
  wwwPath.textContent = p;
  loadSites();
});
loadSites();

document.getElementById('start').addEventListener('click', async () => {
  status.textContent = 'শুরু হচ্ছে...';
  status.textContent = await window.api.startServer(selectedServer());
  loadSites();
});

document.getElementById('stop').addEventListener('click', async () => {
  status.textContent = await window.api.stopServer();
});

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
