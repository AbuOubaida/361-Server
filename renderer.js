const status = document.getElementById('status');

function selectedServer() {
  return document.querySelector('input[name="server"]:checked').value;
}

window.api.onStatus((msg) => {
  status.textContent = msg;
});

document.getElementById('start').addEventListener('click', async () => {
  status.textContent = 'শুরু হচ্ছে...';
  status.textContent = await window.api.startServer(selectedServer());
});

document.getElementById('stop').addEventListener('click', async () => {
  status.textContent = await window.api.stopServer();
});
