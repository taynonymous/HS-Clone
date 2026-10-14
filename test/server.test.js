import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../src/server.js';

async function boot(env = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-srv-'));
  const app = await createApp({ env: { DATA_DIR: dir, ...env }, startMonitor: false, fetchImpl: async () => new Response('<i>"availability_status":"IN_STOCK"</i>') });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base };
}

test('CRUD + check + seed', async (t) => {
  const { app, base } = await boot();
  t.after(() => app.close());

  let state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.items.length, 2, 'seeded PS5 Pro items');
  assert.deepEqual(state.items.map((i) => i.retailer), ['psdirect', 'bestbuy']);
  assert.equal(state.items[1].cartUrl, 'https://api.bestbuy.com/click/-/6601524/cart');

  const bad = await fetch(`${base}/api/items`, { method: 'POST', body: JSON.stringify({ url: 'ftp://x' }) });
  assert.equal(bad.status, 400);
  const badRe = await fetch(`${base}/api/items`, { method: 'POST', body: JSON.stringify({ url: 'https://x.com', inStockPatterns: ['('] }) });
  assert.equal(badRe.status, 400);

  const created = await (await fetch(`${base}/api/items`, { method: 'POST', body: JSON.stringify({ url: 'https://www.target.com/p/ps5-pro/-/A-1', intervalSec: 1 }) })).json();
  assert.equal(created.retailer, 'target');
  assert.equal(created.intervalSec, 15, 'clamped to MIN_INTERVAL_SEC');

  const checked = await (await fetch(`${base}/api/items/${created.id}/check`, { method: 'POST' })).json();
  assert.equal(checked.state.status, 'in_stock');

  const upd = await (await fetch(`${base}/api/items/${created.id}`, { method: 'PUT', body: JSON.stringify({ enabled: false }) })).json();
  assert.equal(upd.enabled, false);
  assert.equal(upd.state.status, 'in_stock', 'state kept when URL unchanged');

  assert.equal((await fetch(`${base}/api/items/${created.id}`, { method: 'DELETE' })).status, 200);
  state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.items.length, 2);

  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.match(await (await fetch(`${base}/`)).text(), /HS-Clone/);
});

test('basic auth when APP_PASSWORD set', async (t) => {
  const { app, base } = await boot({ APP_PASSWORD: 's3cret' });
  t.after(() => app.close());
  assert.equal((await fetch(`${base}/api/state`)).status, 401);
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const auth = { Authorization: `Basic ${Buffer.from('admin:s3cret').toString('base64')}` };
  assert.equal((await fetch(`${base}/api/state`, { headers: auth })).status, 200);
});
