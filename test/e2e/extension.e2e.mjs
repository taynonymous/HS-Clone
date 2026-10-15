// End-to-end: real HS-Clone server + unpacked extension in Chromium. Retailer
// domains are intercepted and served fake cart/checkout pages that record any
// click on order-placing buttons.
//
//   npm i --no-save playwright && npm run test:e2e
//   (or PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs npm run test:e2e)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../src/server.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright').catch(() => {
  console.error('playwright not found: npm i --no-save playwright (or set PLAYWRIGHT_MODULE)');
  process.exit(2);
});

const EXT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each order button flips document.title so we can detect a forbidden click.
const ORDER_BUTTONS = `
  <button id="po" onclick="document.title='ORDERED'">Place Your Order</button>
  <button onclick="document.title='ORDERED'">Buy Now</button>`;
const page = (body, delayed = '') => `<!doctype html><html><head><title>fake</title></head><body>${body}
  <script>setTimeout(() => { ${delayed} }, 700)</script></body></html>`;

const FAKE = {
  // Stalled add-to-cart page (as seen when its XHR is blocked) → exercises the 8s fallback.
  'https://api.bestbuy.com/click/-/6601524/cart': page('<title>Add to Cart</title><a href="https://www.bestbuy.com/cart?cmp=RMX">cart</a>'),
  'https://www.bestbuy.com/cart': page('<div id="root">loading…</div>' + '<button onclick="document.title=\'ORDERED\'">Buy Now</button>',
    `root.innerHTML = '<button onclick="location.href=\\'/checkout/r/fast-track\\'">Checkout</button>'`),
  'https://www.bestbuy.com/checkout/r/fast-track': page(ORDER_BUTTONS),

  // Real behavior: the cart-add link redirects to /associates/addtocart when signed in.
  'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0DGY63Z2H&Quantity.1=1':
    { redirect: 'https://www.amazon.com/associates/addtocart?ASIN.1=B0DGY63Z2H&Quantity.1=1' },
  'https://www.amazon.com/associates/addtocart?ASIN.1=B0DGY63Z2H&Quantity.1=1':
    page('<button onclick="document.title=\'ORDERED\'">Buy Now</button><form action="/gp/cart/view.html"><input type="submit" name="add" value="Add to Cart"></form>'),
  'https://www.amazon.com/gp/cart/view.html?add=Add+to+Cart':
    page('<form action="/gp/buy/spc/handlers/display.html"><input type="submit" name="proceedToRetailCheckout" value="Proceed to checkout"></form>'),
  'https://www.amazon.com/gp/buy/spc/handlers/display.html?proceedToRetailCheckout=Proceed+to+checkout': page(ORDER_BUTTONS),

  'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb': page(
    '<button class="add-to-cart hide" style="" onclick="location.href=\'/en-us/cart\'">Add to Cart</button><style>.hide{display:none}</style>',
    `document.querySelector('.add-to-cart').classList.remove('hide')`),
  'https://direct.playstation.com/en-us/cart': page('<a href="/en-us/checkout">Checkout</a>'),
  'https://direct.playstation.com/en-us/checkout': page(ORDER_BUTTONS.replace('Place Your Order', 'Place Order')),
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hs-e2e-'));
const app = await createApp({
  env: { DATA_DIR: path.join(dir, 'data'), APP_PASSWORD: 'pw', SEED_PS5_PRO: '0' },
  startMonitor: false,
  fetchImpl: async () => new Response('IN_STOCK'),
});
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${app.server.address().port}`;
const auth = { Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` };

// Playwright's ctx.route() doesn't see the first navigation of tabs the
// extension opens, so serve fixtures from a local HTTPS server and point the
// retailer hostnames at it with Chromium's host resolver rules.
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=hs-e2e',
  '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
const fixtures = https.createServer(
  { key: await fs.readFile(path.join(dir, 'key.pem')), cert: await fs.readFile(path.join(dir, 'cert.pem')) },
  (req, res) => {
    const url = `https://${req.headers.host}${req.url}`;
    const fake = FAKE[url];
    if (!fake) return res.writeHead(404).end(`no fixture for ${url}`);
    if (fake.redirect) return res.writeHead(302, { Location: fake.redirect }).end();
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(fake);
  },
);
await new Promise((r) => fixtures.listen(0, '127.0.0.1', r));
const fport = fixtures.address().port;
const FAKE_HOSTS = ['api.bestbuy.com', 'www.bestbuy.com', 'www.amazon.com', 'direct.playstation.com'];

const ctx = await chromium.launchPersistentContext(path.join(dir, 'profile'), {
  headless: true,
  channel: 'chromium', // full Chromium (new headless); headless-shell can't load extensions
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  ignoreHTTPSErrors: true,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-proxy-server',
    '--ignore-certificate-errors',
    `--host-resolver-rules=${FAKE_HOSTS.map((h) => `MAP ${h}:443 127.0.0.1:${fport}`).join(',')}`,
  ],
});
const failures = [];
try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  await sw.evaluate((url) => chrome.storage.local.set({ serverUrl: url, password: 'pw', focusWindow: false }), base);
  for (let i = 0; i < 50; i++) {
    const { status } = await sw.evaluate(() => chrome.storage.session.get('status'));
    if (status?.ws === 'connected') break;
    await sleep(200);
  }
  assert.equal((await (await fetch(`${base}/healthz`)).json()).wsClients, 1, 'extension connected over WebSocket');

  const cases = [
    { url: 'https://www.bestbuy.com/site/6601524.p', review: /bestbuy\.com\/checkout\// },
    { url: 'https://www.amazon.com/dp/B0DGY63Z2H', review: /amazon\.com\/gp\/buy\// },
    { url: 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb', review: /playstation\.com\/en-us\/checkout/ },
  ];
  for (const c of cases) {
    const item = await (await fetch(`${base}/api/items`, {
      method: 'POST', headers: auth, body: JSON.stringify({ url: c.url, name: `Test ${c.url}`, inStockPatterns: ['IN_STOCK'] }),
    })).json();
    const opened = ctx.waitForEvent('page', { timeout: 10_000 });
    await fetch(`${base}/api/items/${item.id}/check`, { method: 'POST', headers: auth });
    const tab = await opened;
    try {
      await tab.waitForURL(c.review, { timeout: 25_000 });
      const btn = tab.locator('#po');
      await btn.waitFor();
      await tab.waitForFunction(() => document.querySelector('#po').style.outline.includes('5px'), null, { timeout: 10_000 });
      await sleep(1_500); // give a buggy engine time to misbehave
      assert.notEqual(await tab.title(), 'ORDERED', 'order button must never be clicked');
      assert.ok(await tab.locator('#hs-clone-assist').count(), 'assist banner shown');
      console.log(`ok   ${new URL(c.url).hostname}: reached review, order button highlighted, not clicked`);
    } catch (err) {
      failures.push(c.url);
      console.log(`FAIL ${new URL(c.url).hostname}: ${err.message.split('\n')[0]} (at ${tab.url()}, title=${await tab.title()})`);
    }
    await tab.close();
  }

  // Unarmed tabs (user browsing normally) must be left alone.
  const plain = await ctx.newPage();
  await plain.goto('https://www.bestbuy.com/cart');
  await sleep(2_000);
  assert.equal(new URL(plain.url()).pathname, '/cart', 'unarmed tab untouched');
  assert.equal(await plain.locator('#hs-clone-assist').count(), 0);
  console.log('ok   unarmed tab untouched');
} finally {
  await ctx.close();
  await app.close();
  fixtures.close();
}
if (failures.length) process.exit(1);
