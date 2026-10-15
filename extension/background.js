// Keeps a WebSocket to the HS-Clone server. On an in-stock alert it opens the
// cart in a focused tab and "arms" that tab so content.js walks it to the
// order-review page. Chrome 116+ keeps the worker alive while WebSocket
// messages flow; the server pings every 20s and an alarm reconnects if the
// worker was evicted anyway.

const DEFAULTS = {
  serverUrl: 'http://localhost:8080',
  username: 'admin',
  password: '',
  enabled: true,
  focusWindow: true,
  assist: { bestbuy: true, amazon: true, psdirect: true },
};
const ARM_TTL_MS = 10 * 60_000;
const HOSTS = { bestbuy: /(^|\.)bestbuy\.com$/, amazon: /(^|\.)amazon\.com$/, psdirect: /^direct\.playstation\.com$/ };

let ws = null;
let keepalive = null;
let reconnectTimer = null;

async function config() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...stored, assist: { ...DEFAULTS.assist, ...stored.assist } };
}

async function setStatus(patch) {
  const { status = {} } = await chrome.storage.session.get('status');
  const next = { ...status, ...patch };
  await chrome.storage.session.set({ status: next });
  const connected = next.ws === 'connected';
  chrome.action.setBadgeText({ text: connected ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: connected ? '#15803d' : '#b42318' });
  chrome.action.setTitle({ title: `HS-Clone Checkout Assist — ${next.ws ?? 'disconnected'}` });
}

const b64 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

async function connect() {
  clearTimeout(reconnectTimer);
  const cfg = await config();
  if (!cfg.enabled) {
    ws?.close();
    return setStatus({ ws: 'disabled' });
  }
  if (ws && ws.readyState <= WebSocket.OPEN) return;

  let url;
  try {
    url = new URL('/api/ws', cfg.serverUrl);
  } catch {
    return setStatus({ ws: 'bad server URL' });
  }
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (cfg.password) url.searchParams.set('auth', b64(`${cfg.username}:${cfg.password}`));

  const sock = new WebSocket(url);
  ws = sock;
  setStatus({ ws: 'connecting' });
  sock.onopen = () => {
    setStatus({ ws: 'connected', connectedAt: Date.now() });
    keepalive = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), 20_000);
  };
  sock.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'alert') onAlert(msg.payload);
  };
  sock.onclose = () => {
    clearInterval(keepalive);
    if (ws === sock) ws = null;
    setStatus({ ws: 'disconnected' });
    reconnectTimer = setTimeout(connect, 5_000);
  };
}

async function arm(tabId, record) {
  const { armed = {} } = await chrome.storage.session.get('armed');
  armed[tabId] = { ...record, at: Date.now() };
  await chrome.storage.session.set({ armed });
}

async function disarm(tabId) {
  const { armed = {} } = await chrome.storage.session.get('armed');
  delete armed[tabId];
  await chrome.storage.session.set({ armed });
}

function notify(id, title, message, requireInteraction = false) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, requireInteraction, priority: 2 });
}

async function openAssisted({ url, retailer, name, itemId }) {
  const cfg = await config();
  const tab = await chrome.tabs.create({ url, active: true });
  if (cfg.focusWindow) chrome.windows.update(tab.windowId, { focused: true, drawAttention: true });
  if (retailer && cfg.assist[retailer]) await arm(tab.id, { retailer, name, itemId });
  return tab;
}

async function onAlert(alert) {
  if (alert.test) {
    notify(`test-${Date.now()}`, 'HS-Clone extension connected', 'Test alert received. Alerts will open the cart here.');
    return;
  }
  // De-dupe (e.g. two server tabs, or a reconnect replay).
  const key = `${alert.itemId}:${alert.at}`;
  const { seen = [] } = await chrome.storage.session.get('seen');
  if (seen.includes(key)) return;
  await chrome.storage.session.set({ seen: [key, ...seen].slice(0, 50), lastAlert: alert });

  const price = alert.price != null ? ` — $${Number(alert.price).toFixed(2)}` : '';
  notify(`alert-${key}`, `IN STOCK: ${alert.name}`, `${alert.retailerLabel}${price}. Opening cart…`, true);
  await openAssisted({ url: alert.cartUrl || alert.url, retailer: alert.retailer, name: alert.name, itemId: alert.itemId });
}

function retailerFor(url) {
  try {
    const host = new URL(url).hostname;
    return Object.keys(HOSTS).find((k) => HOSTS[k].test(host)) ?? null;
  } catch {
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    const tabId = sender.tab?.id;
    switch (msg.type) {
      case 'armed?': {
        const { armed = {} } = await chrome.storage.session.get('armed');
        const rec = armed[tabId];
        if (!rec || Date.now() - rec.at > ARM_TTL_MS) return null;
        return rec;
      }
      case 'disarm':
        await disarm(tabId);
        return true;
      case 'progress': {
        if (msg.state === 'review') notify(`review-${tabId}`, 'Ready to place order', 'Review the order and click the highlighted button.', true);
        if (msg.state === 'signin') notify(`signin-${tabId}`, 'Sign-in required', 'Sign in, then return to the cart.', true);
        if (msg.state === 'failed') notify(`failed-${tabId}`, 'Checkout assist stopped', msg.error ?? `Stuck at ${msg.step}. Finish manually.`, true);
        if (msg.state === 'review' || msg.state === 'failed') await disarm(tabId);
        await setStatus({ lastProgress: { ...msg, at: Date.now() } });
        return true;
      }
      case 'status': {
        const { status = {}, lastAlert = null } = await chrome.storage.session.get(['status', 'lastAlert']);
        return { status, lastAlert, config: await config() };
      }
      case 'reconnect':
        ws?.close();
        ws = null;
        await connect();
        return true;
      case 'dryRun': {
        const retailer = retailerFor(msg.url);
        if (!retailer) throw new Error('Dry run supports bestbuy.com, amazon.com and direct.playstation.com URLs');
        await openAssisted({ url: msg.url, retailer, name: 'Dry run', itemId: null });
        return true;
      }
      default:
        return null;
    }
  })().then(reply, (err) => reply({ error: err.message }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => disarm(tabId));
chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('review-') && !id.startsWith('signin-') && !id.startsWith('failed-')) return;
  const tabId = Number(id.split('-')[1]);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) {
    chrome.tabs.update(tabId, { active: true });
    chrome.windows.update(tab.windowId, { focused: true });
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    ws?.close();
    ws = null;
    connect();
  }
});
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();
