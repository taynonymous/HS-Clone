const form = document.getElementById('form');
const $ = (id) => document.getElementById(id);

async function load() {
  const { config, status } = await chrome.runtime.sendMessage({ type: 'status' });
  for (const el of form.elements) {
    if (!el.name) continue;
    const [k, sub] = el.name.split('.');
    const v = sub ? config[k]?.[sub] : config[k];
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v ?? '';
  }
  $('status').textContent = `Connection: ${status.ws ?? 'disconnected'}`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const next = { assist: {} };
  for (const el of form.elements) {
    if (!el.name) continue;
    const [k, sub] = el.name.split('.');
    const v = el.type === 'checkbox' ? el.checked : el.value.trim();
    if (sub) next[k][sub] = v;
    else next[k] = v;
  }
  await chrome.storage.local.set(next);
  $('status').textContent = 'Saved. Connecting…';
  setTimeout(load, 1500);
});

$('dry-run').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'dryRun', url: $('dry-url').value.trim() });
  $('dry-status').textContent = res?.error ?? 'Opened in a new tab.';
});

load();
