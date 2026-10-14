import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, defaultData } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

const IN = '<button data-button-state="ADD_TO_CART">"currentPrice":749.99,</button>';
const OUT = '<button data-button-state="SOLD_OUT"></button>';

async function setup({ pages, settings = {}, item = {} }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-'));
  const store = new Store(path.join(dir, 'db.json'), { debounceMs: 0 });
  await store.load(defaultData({}));
  Object.assign(store.data.settings, { ntfyTopic: 't', minHostGapSec: 0, ...settings });
  store.data.items.push({ id: 'a', name: 'PS5 Pro', url: 'https://www.bestbuy.com/site/6601524.p', retailer: 'bestbuy', intervalSec: 30, enabled: true, state: {}, ...item });
  let clock = 1_000_000;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https://ntfy.sh')) return new Response('ok');
    const next = pages.shift();
    return typeof next === 'number' ? new Response('', { status: next }) : new Response(next);
  };
  const monitor = new Monitor(store, { fetchImpl, now: () => clock, random: () => 0.5 });
  const alerts = [];
  monitor.on('alert', (a) => alerts.push(a));
  const advance = async (ms) => {
    clock += ms;
    await monitor.tick();
  };
  return { store, monitor, alerts, calls, advance, item: store.data.items[0], ntfy: () => calls.filter((c) => c.url.startsWith('https://ntfy.sh')) };
}

test('alerts once on transition to in stock, with cart link', async () => {
  const t = await setup({ pages: [OUT, IN, IN, OUT, IN] });
  await t.advance(0);
  assert.equal(t.item.state.status, 'out_of_stock');
  assert.equal(t.alerts.length, 0);

  await t.advance(30_000);
  assert.equal(t.item.state.status, 'in_stock');
  assert.equal(t.alerts.length, 1);
  assert.equal(t.alerts[0].cartUrl, 'https://api.bestbuy.com/click/-/6601524/cart');
  assert.equal(t.alerts[0].price, 749.99);
  const [n] = t.ntfy();
  assert.equal(n.init.headers.Priority, 'urgent');
  assert.equal(n.init.headers.Click, 'https://api.bestbuy.com/click/-/6601524/cart');

  await t.advance(30_000); // still in stock: no repeat
  assert.equal(t.alerts.length, 1);

  await t.advance(30_000); // sold out
  await t.advance(30_000); // back in stock, but inside cooldown
  assert.equal(t.alerts.length, 1);
  assert.ok(t.store.data.events.some((e) => /cooldown/.test(e.message)));
});

test('respects interval and does not re-check early', async () => {
  const t = await setup({ pages: [OUT, OUT] });
  await t.advance(0);
  await t.advance(10_000);
  assert.equal(t.item.state.checks, 1);
  await t.advance(20_000);
  assert.equal(t.item.state.checks, 2);
});

test('maxPrice suppresses scalper-priced alerts', async () => {
  const t = await setup({ pages: [IN], item: { maxPrice: 700 } });
  await t.advance(0);
  assert.equal(t.item.state.status, 'in_stock');
  assert.equal(t.alerts.length, 0);
  assert.equal(t.store.data.events[0].type, 'over_price');
});

test('blocks back off exponentially and do not reset last known stock', async () => {
  const t = await setup({ pages: [OUT, 403, 429] });
  await t.advance(0);
  await t.advance(30_000);
  assert.equal(t.item.state.status, 'blocked');
  assert.equal(t.item.state.failures, 1);
  assert.equal(t.item.state.lastDefinitive, 'out_of_stock');
  assert.equal(t.item.state.nextCheckAt - 1_030_000, 60_000);
  await t.advance(60_000);
  assert.equal(t.item.state.failures, 2);
  assert.equal(t.item.state.nextCheckAt - 1_090_000, 120_000);
});

test('uses Best Buy API when key configured', async () => {
  const t = await setup({ pages: [JSON.stringify({ sku: 6601524, onlineAvailability: true, salePrice: 749.99 })], settings: { bestbuyApiKey: 'k' } });
  await t.advance(0);
  assert.match(t.calls[0].url, /^https:\/\/api\.bestbuy\.com\/v1\/products\/6601524\.json\?.*apiKey=k/);
  assert.equal(t.item.state.status, 'in_stock');
  assert.equal(t.alerts.length, 1);
});

test('serialises requests to the same host', async () => {
  const t = await setup({ pages: [OUT, OUT], settings: { minHostGapSec: 5 } });
  t.store.data.items.push({ ...t.item, id: 'b', state: {} });
  await t.advance(0);
  assert.equal(t.calls.length, 1);
  await t.advance(5_000);
  assert.equal(t.calls.length, 2);
});

test('PS Direct: resolves product code once, then polls the API', async () => {
  const page = '<button class="btn add-to-cart hide" data-product-code="1000050928" type="button">';
  const api = (lvl) => JSON.stringify({ products: [{ code: '1000050928', name: 'PS5 Pro', price: { value: 899 }, stock: { stockLevelStatus: lvl } }] });
  const t = await setup({
    pages: [page, api('outOfStock'), api('inStock')],
    item: { url: 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb', retailer: 'psdirect' },
  });
  await t.advance(0);
  assert.equal(t.item.state.status, 'out_of_stock');
  assert.equal(t.item.state.productCode, '1000050928');
  assert.equal(t.item.state.price, 899);
  await t.advance(30_000);
  const fetched = t.calls.filter((c) => !c.url.startsWith('https://ntfy.sh')).map((c) => c.url);
  assert.equal(fetched.length, 3, 'page fetched only once');
  assert.match(fetched[2], /productCodes=1000050928$/);
  assert.equal(t.item.state.status, 'in_stock');
  assert.equal(t.alerts.length, 1);
});
