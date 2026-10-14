import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, defaultData } from './store.js';
import { Monitor } from './monitor.js';
import { sendAlert } from './notify.js';
import { PRESETS, cartUrlFor, detectRetailer } from './retailers.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const SETTINGS_KEYS = ['ntfyServer', 'ntfyTopic', 'ntfyToken', 'discordWebhook', 'webhookUrl', 'bestbuyApiKey', 'userAgent', 'defaultIntervalSec', 'minHostGapSec', 'alertCooldownSec'];
const NUMERIC_SETTINGS = new Set(['defaultIntervalSec', 'minHostGapSec', 'alertCooldownSec']);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function validatePatterns(list, field) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, `${field} must be an array of regex strings`);
  const out = list.map((s) => String(s).trim()).filter(Boolean);
  for (const s of out) {
    try {
      new RegExp(s, 'i');
    } catch (e) {
      throw new HttpError(400, `${field}: invalid regex ${JSON.stringify(s)}: ${e.message}`);
    }
  }
  return out;
}

export function normalizeItem(input, { existing, settings, minIntervalSec }) {
  const merged = { ...existing, ...input };
  let url;
  try {
    url = new URL(String(merged.url ?? '').trim());
  } catch {
    throw new HttpError(400, 'url must be a valid URL');
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'url must be http(s)');

  const retailer = merged.retailer && PRESETS[merged.retailer] ? merged.retailer : detectRetailer(url.href);
  const intervalSec = Math.max(minIntervalSec, Number(merged.intervalSec) || settings.defaultIntervalSec || 30);
  const maxPrice = merged.maxPrice === '' || merged.maxPrice == null ? null : Number(merged.maxPrice);
  if (maxPrice != null && !(maxPrice > 0)) throw new HttpError(400, 'maxPrice must be a positive number');

  const urlChanged = existing && existing.url !== url.href;
  return {
    id: existing?.id ?? randomUUID(),
    name: String(merged.name ?? '').trim() || url.hostname,
    url: url.href,
    retailer,
    intervalSec,
    maxPrice,
    enabled: merged.enabled !== false,
    inStockPatterns: validatePatterns(merged.inStockPatterns, 'inStockPatterns'),
    outOfStockPatterns: validatePatterns(merged.outOfStockPatterns, 'outOfStockPatterns'),
    createdAt: existing?.createdAt ?? Date.now(),
    // Reset state on URL change; force an immediate re-check on any edit.
    state: { ...(urlChanged ? {} : existing?.state), nextCheckAt: 0 },
  };
}

const publicItem = (item) => ({ ...item, cartUrl: cartUrlFor(item), retailerLabel: PRESETS[item.retailer]?.label ?? 'Other' });

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function makeAuth(user, password) {
  if (!password) return () => true;
  const digest = (s) => createHash('sha256').update(s).digest();
  const expected = digest(`${user}:${password}`);
  return (req) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    if (!m) return false;
    return timingSafeEqual(digest(Buffer.from(m[1], 'base64').toString()), expected);
  };
}

export async function createApp({ env = process.env, fetchImpl = globalThis.fetch, startMonitor = true } = {}) {
  const dataDir = env.DATA_DIR || path.join(process.cwd(), 'data');
  const minIntervalSec = Number(env.MIN_INTERVAL_SEC) || 15;
  const store = new Store(path.join(dataDir, 'db.json'));
  await store.load(defaultData(env));
  if (store.fresh && env.SEED_PS5_PRO !== '0') {
    for (const seed of [
      { url: 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb', name: 'PS5 Pro — PlayStation Direct' },
      { url: 'https://www.bestbuy.com/site/6601524.p', name: 'PS5 Pro — Best Buy' },
    ]) {
      store.data.items.push(normalizeItem(seed, { settings: store.data.settings, minIntervalSec }));
    }
    await store.flush();
  }
  const monitor = new Monitor(store, { fetchImpl });
  const authorized = makeAuth(env.APP_USER || 'admin', env.APP_PASSWORD);
  const clients = new Set();

  const broadcast = (type, payload) => {
    const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  monitor.on('item', (item) => broadcast('item', publicItem(item)));
  monitor.on('event', (ev) => broadcast('event', ev));
  monitor.on('alert', (alert) => broadcast('alert', alert));
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  const findItem = (id) => {
    const item = store.data.items.find((i) => i.id === id);
    if (!item) throw new HttpError(404, 'item not found');
    return item;
  };

  const routes = [
    ['GET', /^\/healthz$/, () => ({ ok: true, items: store.data.items.length, sseClients: clients.size })],
    ['GET', /^\/api\/state$/, () => ({
      items: store.data.items.map(publicItem),
      settings: store.data.settings,
      events: store.data.events.slice(0, 100),
      retailers: Object.fromEntries(Object.entries(PRESETS).map(([k, p]) => [k, p.label])),
      minIntervalSec,
    })],
    ['POST', /^\/api\/items$/, async (req) => {
      const item = normalizeItem(await readJson(req), { settings: store.data.settings, minIntervalSec });
      store.data.items.push(item);
      store.save();
      monitor.event(item, 'added', `Watching ${item.url}`);
      return publicItem(item);
    }],
    ['PUT', /^\/api\/items\/([\w-]+)$/, async (req, [, id]) => {
      const existing = findItem(id);
      const item = normalizeItem(await readJson(req), { existing, settings: store.data.settings, minIntervalSec });
      store.data.items[store.data.items.indexOf(existing)] = item;
      store.save();
      broadcast('item', publicItem(item));
      return publicItem(item);
    }],
    ['DELETE', /^\/api\/items\/([\w-]+)$/, (req, [, id]) => {
      const item = findItem(id);
      store.data.items = store.data.items.filter((i) => i !== item);
      store.save();
      monitor.event(item, 'removed', 'Stopped watching');
      broadcast('removed', { id });
      return { ok: true };
    }],
    ['POST', /^\/api\/items\/([\w-]+)\/check$/, async (req, [, id]) => {
      findItem(id);
      return publicItem(await monitor.checkNow(id));
    }],
    ['PUT', /^\/api\/settings$/, async (req) => {
      const body = await readJson(req);
      for (const k of SETTINGS_KEYS) {
        if (!(k in body)) continue;
        store.data.settings[k] = NUMERIC_SETTINGS.has(k) ? Math.max(0, Number(body[k]) || 0) : String(body[k] ?? '').trim();
      }
      store.save();
      return store.data.settings;
    }],
    ['POST', /^\/api\/test-alert$/, async () => {
      const results = await sendAlert(store.data.settings, { test: true, name: 'Test', url: null, at: Date.now() }, fetchImpl);
      broadcast('alert', { test: true, name: 'Test alert', at: Date.now() });
      return { results };
    }],
  ];

  async function serveStatic(req, res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'not found');
    let body;
    try {
      body = await fs.readFile(file);
    } catch {
      throw new HttpError(404, 'not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname !== '/healthz' && !authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="hs-clone"' });
        return res.end('auth required');
      }
      if (req.method === 'GET' && pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      for (const [method, re, handler] of routes) {
        const m = re.exec(pathname);
        if (m && req.method === method) return send(res, 200, await handler(req, m));
      }
      if (pathname.startsWith('/api/')) throw new HttpError(404, 'not found');
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
      await serveStatic(req, res, pathname);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err.message });
      else res.end();
    }
  });

  if (startMonitor) monitor.start();

  const close = async () => {
    monitor.stop();
    clearInterval(heartbeat);
    for (const res of clients) res.end();
    await new Promise((r) => server.close(r));
    await store.flush();
  };

  return { server, store, monitor, close };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT) || 8080;
  const host = process.env.HOST || '0.0.0.0';
  const app = await createApp();
  app.server.listen(port, host, () => {
    console.log(`hs-clone listening on http://${host}:${port} (${app.store.data.items.length} items)`);
    if (!process.env.APP_PASSWORD) console.warn('APP_PASSWORD not set — UI/API are unauthenticated. Do not expose publicly.');
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, async () => {
      console.log(`${sig} received, shutting down`);
      await app.close();
      process.exit(0);
    });
  }
}
