const $ = (id) => document.getElementById(id);
const ago = (t) => (t ? `${Math.round((Date.now() - t) / 1000)}s ago` : '');

async function render() {
  const { status, lastAlert, config } = await chrome.runtime.sendMessage({ type: 'status' });
  $('server').textContent = config.serverUrl;
  $('ws').textContent = status.ws ?? 'disconnected';
  $('ws').className = status.ws === 'connected' ? 'ok' : 'bad';
  $('enabled').checked = config.enabled;
  if (lastAlert) $('alert').textContent = `${lastAlert.name} (${ago(lastAlert.at)})`;
  const p = status.lastProgress;
  if (p) $('progress').textContent = `${p.state}${p.step ? ` · ${p.step}` : ''} (${ago(p.at)})`;
}

$('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }).then(render));
$('reconnect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'reconnect' }).then(() => setTimeout(render, 500)));
$('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
render();
setInterval(render, 2000);
