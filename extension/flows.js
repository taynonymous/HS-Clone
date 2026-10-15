// Per-retailer checkout-assist flows. Loaded as a classic content script
// before content.js.
//
// A flow is an ordered list of steps. The first step whose `url` matches the
// current page runs. A step either performs `actions` (click / navigate) or
// `stop`s, which highlights the final order button for the human to click.
//
// Buttons are matched by visible text first and by selector second, because
// retailer class names churn more than button labels do.
//
// SAFETY: content.js refuses to click anything matching FORBIDDEN, whatever a
// flow says. Placing the order is always a manual click.

globalThis.HS_FORBIDDEN =
  /\b(place (your )?order|submit (your )?order|complete (your )?(order|purchase)|confirm (and pay|order|purchase)|pay now|buy now|purchase now|1-click)\b/i;

globalThis.HS_FLOWS = {
  bestbuy: [
    { name: 'signin', url: /bestbuy\.com\/identity\//, stop: 'signin' },
    {
      name: 'review',
      url: /bestbuy\.com\/checkout\//,
      stop: 'review',
      highlight: { text: /place (your )?order/i },
    },
    {
      // api.bestbuy.com/click/-/<sku>/cart adds the SKU via JS, then redirects
      // to the cart. If that stalls, go to the cart anyway.
      name: 'click-to-cart',
      url: /api\.bestbuy\.com\/click\//,
      actions: [{ navigate: 'https://www.bestbuy.com/cart', delayMs: 8_000 }],
    },
    {
      name: 'cart',
      url: /www\.bestbuy\.com\/cart/,
      actions: [{ click: { text: /^checkout$/i, selector: '[data-track="Checkout - Top"], .checkout-buttons__checkout button' }, timeoutMs: 20_000 }],
    },
    {
      // Fallback if the add-to-cart redirect lands on the product page.
      // During drops Best Buy can hold the button in "Please Wait" for minutes.
      name: 'product',
      url: /bestbuy\.com\/(site|product)\//,
      actions: [
        { click: { selector: 'button[data-button-state="ADD_TO_CART"]', text: /^add to cart$/i }, timeoutMs: 300_000 },
        { click: { text: /^go to cart$/i }, timeoutMs: 8_000, optional: true },
        { navigate: '/cart', delayMs: 500 },
      ],
    },
  ],

  amazon: [
    { name: 'signin', url: /amazon\.com\/ap\/(signin|mfa|cvf)/, stop: 'signin' },
    {
      name: 'review',
      url: /amazon\.com\/(gp\/buy|checkout)\//,
      stop: 'review',
      highlight: { text: /place (your )?order/i, selector: '#placeYourOrder, #submitOrderButtonId' },
    },
    {
      // The cart-add link redirects (signed in) to /associates/addtocart.
      name: 'cart-add-confirm',
      url: /amazon\.com\/(gp\/aws\/cart\/add|associates\/addtocart)/,
      actions: [
        {
          click: { selector: 'input[name="add"], input[name="submit.addToCart"]', text: /^(continue|add to cart)$/i },
          timeoutMs: 10_000,
        },
      ],
    },
    {
      name: 'cart',
      url: /amazon\.com\/(gp\/cart\/view|cart)(\.html)?([/?#]|$)/,
      actions: [{ click: { selector: 'input[name="proceedToRetailCheckout"]', text: /^proceed to checkout$/i }, timeoutMs: 15_000 }],
    },
    {
      name: 'product',
      url: /amazon\.com\/(.*\/)?(dp|gp\/product)\//,
      actions: [
        // Never "Buy Now": that's 1-click purchase. Add to cart only.
        { click: { selector: '#add-to-cart-button', text: /^add to cart$/i }, timeoutMs: 15_000 },
        { click: { selector: '#attachSiNoCoverage, #attach-protection-plan-no-thanks' }, timeoutMs: 3_000, optional: true },
        { navigate: '/gp/cart/view.html', delayMs: 1_500 },
      ],
    },
  ],

  psdirect: [
    { name: 'signin', url: /account\.sony\.com\//, stop: 'signin' },
    {
      name: 'review',
      url: /direct\.playstation\.com\/[a-z-]+\/checkout/,
      stop: 'review',
      highlight: { text: /place (your )?order|submit order/i },
    },
    {
      name: 'cart',
      url: /direct\.playstation\.com\/[a-z-]+\/cart/,
      actions: [{ click: { text: /^(secure )?checkout$/i }, timeoutMs: 20_000 }],
    },
    {
      // Stock is rendered client-side: the hidden button is shown once the
      // product API says inStock, so allow a long wait.
      name: 'product',
      url: /direct\.playstation\.com\/[a-z-]+\/buy-/,
      actions: [
        { click: { selector: 'button.add-to-cart:not(.hide)', text: /^add to cart$/i }, timeoutMs: 300_000 },
        { click: { text: /^(view cart|checkout|go to cart)$/i }, timeoutMs: 8_000, optional: true },
      ],
    },
  ],
};
