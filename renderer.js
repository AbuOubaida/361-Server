const status = document.getElementById('status');

window.api.onStatus((msg) => {
  status.textContent = msg;
});

document.getElementById('start').addEventListener('click', async () => {
  status.textContent = await window.api.startApache();
});

document.getElementById('stop').addEventListener('click', async () => {
  status.textContent = await window.api.stopApache();
});