const status = document.getElementById('status');
const wwwPath = document.getElementById('wwwPath');

function selectedServer() {
  return document.querySelector('input[name="server"]:checked').value;
}

window.api.onStatus((msg) => {
  status.textContent = msg;
});

// বর্তমান www ফোল্ডার দেখানো
window.api.getWww().then((p) => (wwwPath.textContent = p));
window.api.onWwwChanged((p) => (wwwPath.textContent = p));

document.getElementById('start').addEventListener('click', async () => {
  status.textContent = 'শুরু হচ্ছে...';
  status.textContent = await window.api.startServer(selectedServer());
});

document.getElementById('stop').addEventListener('click', async () => {
  status.textContent = await window.api.stopServer();
});

document.getElementById('changeWww').addEventListener('click', async () => {
  const r = await window.api.chooseWww();
  wwwPath.textContent = r.path;
  if (r.message) status.textContent = r.message;
  else if (r.ok) status.textContent = 'ফোল্ডার বদলানো হয়েছে। এবার Start চাপুন।';
});

document.getElementById('openWww').addEventListener('click', () => {
  window.api.openWww();
});
