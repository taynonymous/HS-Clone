// Vanilla JS client. All server/page-derived strings go through textContent.
const $ = (sel) => document.querySelector(sel);

const state = { items: new Map(), events: [], settings: {}, retailers: {}, minIntervalSec: 15 };
const STATUS_LABEL = {
  in_stock: 'IN STOCK',
  out_of_stock: 'Out of stock',
  unknown: 'Unknown',
  blocked: 'Blocked',
  error: 'Error',
  paused: 'Paused',
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleString();
}
const until = (ts) => (ts == null ? '—' : ts <= Date.now() ? 'due' : `in ${Math.round((ts - Date.now()) / 1000)}s`);
const money = (n) => (n == null ? '—' : `$${Number(n).toFixed(2)}`);

// ---------- rendering ----------

function renderItem(item) {
  const s = item.state ?? {};
  const status = item.enabled ? s.status ?? 'unknown' : 'paused';
  const over = item.maxPrice && s.price != null && s.price > item.maxPrice;
  const buyHref = item.cartUrl || item.url;

  return h('article', { class: `card ${status}`, 'data-id': item.id },
    h('div', { class: 'card-top' },
      h('div', { class: 'card-title' }, item.name),
      h('span', { class: `pill pill-${status}` }, STATUS_LABEL[status] ?? status),
    ),
    h('dl', { class: 'card-meta' },
      h('dt', {}, 'Retailer'), h('dd', {}, item.retailerLabel),
      h('dt', {}, 'Price'), h('dd', { class: over ? 'price-over' : null }, money(s.price), item.maxPrice ? ` (max ${money(item.maxPrice)})` : ''),
      h('dt', {}, 'Checked'), h('dd', { 'data-ts': s.lastCheckedAt ?? '' }, `${ago(s.lastCheckedAt)} · ${s.checks ?? 0} checks · every ${item.intervalSec}s`),
      h('dt', {}, 'Next'), h('dd', {}, item.enabled ? until(s.nextCheckAt) : 'paused'),
      s.lastChangeAt ? [h('dt', {}, 'Changed'), h('dd', {}, ago(s.lastChangeAt))] : null,
      s.error ? [h('dt', {}, 'Error'), h('dd', {}, s.error, s.failures > 1 ? ` (×${s.failures}, backing off)` : '')] : null,
    ),
    s.evidence ? h('div', { class: 'evidence', title: `matched: ${s.evidence.pattern}` }, s.evidence.snippet) : null,
    h('div', { class: 'card-actions' },
      h('a', { class: `btn btn-sm ${status === 'in_stock' ? 'btn-buy' : ''}`, href: buyHref, target: '_blank', rel: 'noopener' }, item.cartUrl ? 'Add to cart' : 'Open'),
      item.cartUrl ? h('a', { class: 'btn btn-sm', href: item.url, target: '_blank', rel: 'noopener' }, 'Page') : null,
      h('button', { class: 'btn btn-sm', onclick: (e) => checkNow(item.id, e.currentTarget) }, 'Check now'),
      h('button', { class: 'btn btn-sm', onclick: () => toggle(item) }, item.enabled ? 'Pause' : 'Resume'),
      h('button', { class: 'btn btn-sm', onclick: () => openDialog(item) }, 'Edit'),
      h('button', { class: 'btn btn-sm', onclick: () => remove(item) }, 'Delete'),
    ),
  );
}

function renderItems() {
  const items = [...state.items.values()].sort((a, b) => a.createdAt - b.createdAt);
  $('#items').replaceChildren(...items.map(renderItem));
  $('#empty').hidden = items.length > 0;
  const inStock = items.filter((i) => i.enabled && i.state?.status === 'in_stock').length;
  document.title = inStock ? `(${inStock}) IN STOCK — HS-Clone` : 'HS-Clone';
}

function renderEvents() {
  $('#events').replaceChildren(
    ...state.events.slice(0, 100).map((ev) =>
      h('li', { class: ev.level === 'warn' ? 'ev-warn' : null },
        h('time', { title: new Date(ev.at).toLocaleString() }, new Date(ev.at).toLocaleTimeString()),
        h('span', { class: `ev-${ev.type}` }, ev.itemName ? `${ev.itemName}: ` : '', ev.message),
      ),
    ),
  );
}

function fillSettings() {
  const f = $('#settings');
  for (const [k, v] of Object.entries(state.settings)) if (f.elements[k]) f.elements[k].value = v ?? '';
}

// ---------- actions ----------

async function checkNow(id, btn) {
  btn.disabled = true;
  try {
    const item = await api('POST', `/api/items/${id}/check`);
    state.items.set(item.id, item);
    renderItems();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function toggle(item) {
  const updated = await api('PUT', `/api/items/${item.id}`, { enabled: !item.enabled });
  state.items.set(updated.id, updated);
  renderItems();
}

async function remove(item) {
  if (!confirm(`Stop watching "${item.name}"?`)) return;
  await api('DELETE', `/api/items/${item.id}`);
  state.items.delete(item.id);
  renderItems();
}

const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);

function openDialog(item) {
  const f = $('#item-form');
  f.reset();
  $('#item-error').textContent = '';
  $('#item-dialog-title').textContent = item ? 'Edit product' : 'Add product';
  f.elements.retailer.replaceChildren(
    h('option', { value: '' }, 'Auto-detect'),
    ...Object.entries(state.retailers).map(([k, label]) => h('option', { value: k }, label)),
  );
  f.elements.intervalSec.min = state.minIntervalSec;
  f.elements.intervalSec.placeholder = state.settings.defaultIntervalSec;
  if (item) {
    for (const k of ['id', 'url', 'name', 'retailer', 'intervalSec']) f.elements[k].value = item[k] ?? '';
    f.elements.maxPrice.value = item.maxPrice ?? '';
    f.elements.enabled.checked = item.enabled;
    f.elements.inStockPatterns.value = (item.inStockPatterns ?? []).join('\n');
    f.elements.outOfStockPatterns.value = (item.outOfStockPatterns ?? []).join('\n');
  } else {
    f.elements.id.value = '';
  }
  $('#item-dialog').showModal();
}

$('#item-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    url: f.elements.url.value,
    name: f.elements.name.value,
    retailer: f.elements.retailer.value || null,
    intervalSec: f.elements.intervalSec.value || null,
    maxPrice: f.elements.maxPrice.value,
    enabled: f.elements.enabled.checked,
    inStockPatterns: lines(f.elements.inStockPatterns.value),
    outOfStockPatterns: lines(f.elements.outOfStockPatterns.value),
  };
  try {
    const id = f.elements.id.value;
    const item = id ? await api('PUT', `/api/items/${id}`, body) : await api('POST', '/api/items', body);
    state.items.set(item.id, item);
    renderItems();
    $('#item-dialog').close();
  } catch (err) {
    $('#item-error').textContent = err.message;
  }
});
$('#item-cancel').addEventListener('click', () => $('#item-dialog').close());
$('#add-btn').addEventListener('click', () => openDialog(null));

$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    state.settings = await api('PUT', '/api/settings', body);
    fillSettings();
    $('#settings-msg').textContent = 'Saved.';
  } catch (err) {
    $('#settings-msg').textContent = err.message;
  }
});

$('#test-alert').addEventListener('click', async () => {
  $('#settings-msg').textContent = 'Sending…';
  try {
    const { results } = await api('POST', '/api/test-alert');
    $('#settings-msg').textContent = results.length
      ? results.map((r) => `${r.channel}: ${r.ok ? 'ok' : r.error}`).join(' · ')
      : 'No push channels configured (save settings first). Browser alert only.';
  } catch (err) {
    $('#settings-msg').textContent = err.message;
  }
});

// ---------- browser alerts ----------

const autoOpen = $('#auto-open');
try {
  autoOpen.checked = localStorage.getItem('autoOpen') === '1';
} catch {}
autoOpen.addEventListener('change', () => {
  try {
    localStorage.setItem('autoOpen', autoOpen.checked ? '1' : '0');
  } catch {}
});

let audioCtx;
function updateAlertButton() {
  const btn = $('#enable-alerts');
  const granted = 'Notification' in window && Notification.permission === 'granted';
  btn.textContent = granted && audioCtx ? 'Alerts on ✓' : 'Enable browser alerts';
}
$('#enable-alerts').addEventListener('click', async () => {
  // AudioContext must be created from a user gesture to be allowed to play later.
  audioCtx ??= new AudioContext();
  await audioCtx.resume();
  if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
  updateAlertButton();
  beep(1);
});

function beep(times = 6) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime;
  for (let i = 0; i < times; i++) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = i % 2 ? 660 : 880;
    gain.gain.setValueAtTime(0.12, t0 + i * 0.25);
    gain.gain.setValueAtTime(0, t0 + i * 0.25 + 0.18);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + i * 0.25);
    osc.stop(t0 + i * 0.25 + 0.2);
  }
}

function onAlert(alert) {
  const href = alert.cartUrl || alert.url;
  beep(alert.test ? 2 : 8);
  if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(alert.test ? 'HS-Clone test alert' : `IN STOCK: ${alert.name}`, {
      body: alert.test ? 'Browser alerts work.' : `${alert.retailerLabel} — ${money(alert.price)}`,
      requireInteraction: !alert.test,
      tag: alert.itemId ?? 'test',
    });
    n.onclick = () => {
      if (href) window.open(href, '_blank', 'noopener');
      n.close();
    };
  }
  if (alert.test) return;
  $('#banner-title').textContent = `IN STOCK: ${alert.name}`;
  $('#banner-sub').textContent = ` — ${alert.retailerLabel} · ${money(alert.price)}`;
  $('#banner-buy').href = href;
  $('#banner-buy').textContent = alert.cartUrl ? 'Add to cart now' : 'Buy now';
  $('#banner').hidden = false;
  if (autoOpen.checked && href) window.open(href, '_blank', 'noopener');
}
$('#banner-dismiss').addEventListener('click', () => ($('#banner').hidden = true));

// ---------- live updates ----------

function connect() {
  const es = new EventSource('/api/stream');
  const conn = $('#conn');
  es.onopen = () => {
    conn.textContent = 'live';
    conn.className = 'pill pill-live';
    load(); // resync after reconnect
  };
  es.onerror = () => {
    conn.textContent = 'reconnecting';
    conn.className = 'pill pill-error';
  };
  es.addEventListener('item', (e) => {
    const item = JSON.parse(e.data);
    state.items.set(item.id, item);
    renderItems();
  });
  es.addEventListener('removed', (e) => {
    state.items.delete(JSON.parse(e.data).id);
    renderItems();
  });
  es.addEventListener('event', (e) => {
    state.events.unshift(JSON.parse(e.data));
    renderEvents();
  });
  es.addEventListener('alert', (e) => onAlert(JSON.parse(e.data)));
}

async function load() {
  const data = await api('GET', '/api/state');
  state.items = new Map(data.items.map((i) => [i.id, i]));
  state.events = data.events;
  state.settings = data.settings;
  state.retailers = data.retailers;
  state.minIntervalSec = data.minIntervalSec;
  renderItems();
  renderEvents();
  fillSettings();
}

updateAlertButton();
await load();
connect();
// Keep relative times fresh without a full refetch.
setInterval(renderItems, 5000);
