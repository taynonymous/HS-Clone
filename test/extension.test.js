import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sandbox = {};
vm.runInNewContext(fs.readFileSync(new URL('../extension/flows.js', import.meta.url), 'utf8'), sandbox);
const { HS_FORBIDDEN: FORBIDDEN, HS_FLOWS: FLOWS } = sandbox;

test('guard blocks every order-placing label', () => {
  for (const l of ['Place Your Order', 'Place order', 'Place your order in USD', 'Submit Order', 'Buy Now', 'Pay now',
    'Complete purchase', 'Confirm and pay', 'Buy now with 1-Click', 'Purchase now']) {
    assert.ok(FORBIDDEN.test(l), l);
  }
});

test('guard allows the steps the flows need', () => {
  for (const l of ['Checkout', 'Proceed to checkout', 'Continue', 'Add to Cart', 'Go to Cart', 'View cart', 'Secure Checkout']) {
    assert.ok(!FORBIDDEN.test(l), l);
  }
});

test('no flow step targets a forbidden label', () => {
  for (const [retailer, steps] of Object.entries(FLOWS)) {
    for (const s of steps) {
      for (const a of s.actions ?? []) {
        if (!a.click?.text) continue;
        for (const l of ['Place Your Order', 'Buy Now', 'Submit Order']) {
          assert.ok(!a.click.text.test(l), `${retailer}/${s.name} would target "${l}"`);
        }
      }
    }
  }
});

test('flows route each checkout page to the right step', () => {
  const stepFor = (r, url) => FLOWS[r].find((s) => s.url.test(url))?.name;
  assert.equal(stepFor('bestbuy', 'https://api.bestbuy.com/click/-/6601524/cart'), 'click-to-cart');
  assert.equal(stepFor('bestbuy', 'https://www.bestbuy.com/cart'), 'cart');
  assert.equal(stepFor('amazon', 'https://www.amazon.com/associates/addtocart?ASIN.1=X&Quantity.1=1'), 'cart-add-confirm');
  assert.equal(stepFor('bestbuy', 'https://www.bestbuy.com/checkout/r/fast-track'), 'review');
  assert.equal(stepFor('bestbuy', 'https://www.bestbuy.com/identity/signin?token=x'), 'signin');
  assert.equal(stepFor('amazon', 'https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=X'), 'cart-add-confirm');
  assert.equal(stepFor('amazon', 'https://www.amazon.com/gp/cart/view.html'), 'cart');
  assert.equal(stepFor('amazon', 'https://www.amazon.com/gp/buy/spc/handlers/display.html'), 'review');
  assert.equal(stepFor('amazon', 'https://www.amazon.com/ap/signin?x'), 'signin');
  assert.equal(stepFor('psdirect', 'https://direct.playstation.com/en-us/buy-consoles/playstation5-pro-console-2-tb'), 'product');
  assert.equal(stepFor('psdirect', 'https://direct.playstation.com/en-us/checkout'), 'review');
});
