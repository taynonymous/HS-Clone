import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectStock, extractPrice, STATUS } from '../src/detect.js';
import { detectRetailer, cartUrlFor } from '../src/retailers.js';

test('detectRetailer maps hosts to presets', () => {
  assert.equal(detectRetailer('https://www.bestbuy.com/site/6601524.p'), 'bestbuy');
  assert.equal(detectRetailer('https://www.target.com/p/x/-/A-1'), 'target');
  assert.equal(detectRetailer('https://direct.playstation.com/en-us/x'), 'psdirect');
  assert.equal(detectRetailer('https://example.com/x'), 'generic');
  assert.equal(detectRetailer('not a url'), 'generic');
});

test('cartUrlFor builds quick-cart links', () => {
  assert.equal(cartUrlFor({ retailer: 'bestbuy', url: 'https://www.bestbuy.com/site/6601524.p?skuId=6601524' }), 'https://api.bestbuy.com/click/-/6601524/cart');
  assert.equal(cartUrlFor({ retailer: 'bestbuy', url: 'https://www.bestbuy.com/product/playstation-5-pro-console/6601524' }), 'https://api.bestbuy.com/click/-/6601524/cart');
  assert.equal(cartUrlFor({ retailer: 'amazon', url: 'https://www.amazon.com/dp/B0DGY63Z2H/ref=x' }), 'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=B0DGY63Z2H&Quantity.1=1');
  assert.equal(cartUrlFor({ retailer: 'target', url: 'https://www.target.com/p/x' }), null);
});

test('bestbuy preset', () => {
  const inS = '<button data-button-state="ADD_TO_CART">Add to Cart</button>';
  const outS = '<button data-button-state="SOLD_OUT">Sold Out</button>';
  assert.equal(detectStock(inS, { retailer: 'bestbuy' }).status, STATUS.IN_STOCK);
  assert.equal(detectStock(outS, { retailer: 'bestbuy' }).status, STATUS.OUT_OF_STOCK);
  // out-of-stock wins when a carousel item is purchasable
  assert.equal(detectStock(outS + inS, { retailer: 'bestbuy' }).status, STATUS.OUT_OF_STOCK);
});

test('amazon third-party-only listing is out of stock', () => {
  assert.equal(detectStock('<div id="unqualifiedBuyBox"> No featured offers available', { retailer: 'amazon' }).status, STATUS.OUT_OF_STOCK);
  assert.equal(detectStock('<input id="add-to-cart-button">', { retailer: 'amazon' }).status, STATUS.IN_STOCK);
});

test('bot walls are reported as blocked', () => {
  assert.equal(detectStock('<h1>Robot or human?</h1>', { retailer: 'walmart' }).status, STATUS.BLOCKED);
  assert.equal(detectStock('<title>Just a moment...</title>', { retailer: 'generic' }).status, STATUS.BLOCKED);
});

test('json-ld availability fallback', () => {
  const ld = (a) => `<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', offers: { '@type': 'Offer', price: '749.99', availability: `https://schema.org/${a}` } })}</script>`;
  assert.equal(detectStock(ld('InStock')).status, STATUS.IN_STOCK);
  assert.equal(detectStock(ld('OutOfStock')).status, STATUS.OUT_OF_STOCK);
  assert.equal(extractPrice(ld('InStock')), 749.99);
  assert.equal(detectStock('<html>nothing</html>').status, STATUS.UNKNOWN);
});

test('custom patterns replace preset', () => {
  const item = { retailer: 'bestbuy', inStockPatterns: ['ship it'], outOfStockPatterns: ['nope'] };
  assert.equal(detectStock('data-button-state="SOLD_OUT" Ship It', item).status, STATUS.IN_STOCK);
  assert.equal(detectStock('ship it nope', item).status, STATUS.OUT_OF_STOCK);
  const ev = detectStock('xx ship it yy', item).evidence;
  assert.equal(ev.pattern, 'ship it');
  assert.match(ev.snippet, /ship it/);
});

test('preset price extraction', () => {
  assert.equal(extractPrice('"currentPrice":749.99,', { retailer: 'bestbuy' }), 749.99);
  assert.equal(extractPrice('<div id="corePrice_desktop"><span class="a-offscreen">$1,049.00</span>', { retailer: 'amazon' }), 1049);
  assert.equal(extractPrice('"priceAmount":749.99,', { retailer: 'amazon' }), 749.99);
  // carousel prices outside the buybox are ignored
  assert.equal(extractPrice('<span class="a-offscreen">$79.00</span>', { retailer: 'amazon' }), null);
  assert.equal(extractPrice('nothing', { retailer: 'amazon' }), null);
});
