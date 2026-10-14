// Retailer presets: regexes that classify a product page as in/out of stock.
// Retailers change markup often — every match is surfaced in the UI as
// "evidence" so a wrong classification is easy to spot and override per item.

const skuFromBestBuyUrl = (url) =>
  url.match(/\/(\d{7})\.p\b/)?.[1] ?? url.match(/\/(\d{7})(?:[/?#]|$)/)?.[1] ?? null;

const asinFromAmazonUrl = (url) =>
  url.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1]?.toUpperCase() ?? null;

export const PRESETS = {
  bestbuy: {
    label: 'Best Buy',
    hosts: ['bestbuy.com'],
    inStock: [
      /data-button-state="ADD_TO_CART"/,
      /"buttonState"\s*:\s*"ADD_TO_CART"/,
    ],
    outOfStock: [
      /data-button-state="(?:SOLD_OUT|COMING_SOON|CHECK_STORES|UNAVAILABLE)"/,
      /"buttonState"\s*:\s*"(?:SOLD_OUT|COMING_SOON|CHECK_STORES|UNAVAILABLE)"/,
    ],
    price: [/"currentPrice"\s*:\s*(\d+(?:\.\d+)?)/],
    sku: skuFromBestBuyUrl,
    // Best Buy's public add-to-cart redirect.
    cartUrl: (url) => {
      const sku = skuFromBestBuyUrl(url);
      return sku ? `https://api.bestbuy.com/click/-/${sku}/cart` : null;
    },
  },
  // Target renders fulfillment client-side from an API that is bot-walled; the
  // SSR page usually lacks stock data, so expect "unknown" here.
  target: {
    label: 'Target',
    hosts: ['target.com'],
    inStock: [/"availability_status"\s*:\s*"IN_STOCK"/],
    outOfStock: [/"availability_status"\s*:\s*"(?:OUT_OF_STOCK|UNAVAILABLE|DISCONTINUED|PRE_ORDER_UNSELLABLE)"/],
    price: [/"current_retail"\s*:\s*(\d+(?:\.\d+)?)/],
  },
  walmart: {
    label: 'Walmart',
    hosts: ['walmart.com'],
    inStock: [/"availabilityStatus"\s*:\s*"IN_STOCK"/],
    outOfStock: [/"availabilityStatus"\s*:\s*"OUT_OF_STOCK"/],
    blocked: [/Robot or human\?/i, /px-captcha/],
    price: [/"currentPrice"\s*:\s*\{[^}]*?"price"\s*:\s*(\d+(?:\.\d+)?)/],
  },
  amazon: {
    label: 'Amazon',
    hosts: ['amazon.com'],
    inStock: [/id="add-to-cart-button"/, /id="buy-now-button"/],
    // unqualifiedBuyBox = "No featured offers": only third-party sellers, i.e. no MSRP stock.
    outOfStock: [/id="outOfStock"/, /Currently unavailable\./i, /id="unqualifiedBuyBox"/, /No featured offers available/],
    blocked: [/Enter the characters you see below/i, /validateCaptcha/, /api-services-support@amazon\.com/],
    price: [
      /"priceAmount"\s*:\s*(\d+(?:\.\d+)?)/,
      /id="corePrice(?:Display)?_desktop(?:_feature_div)?"[\s\S]{0,3000}?class="a-offscreen">\s*\$([\d,]+\.\d{2})/,
    ],
    sku: asinFromAmazonUrl,
    // Amazon's documented "add to cart form" URL.
    cartUrl: (url) => {
      const asin = asinFromAmazonUrl(url);
      return asin ? `https://www.amazon.com/gp/aws/cart/add.html?ASIN.1=${asin}&Quantity.1=1` : null;
    },
  },
  // Checked via PS Direct's product API (see checker.js); these patterns are
  // only a fallback and match the API JSON shape.
  psdirect: {
    label: 'PlayStation Direct',
    hosts: ['direct.playstation.com'],
    inStock: [/"stockLevelStatus"\s*:\s*"(?:inStock|lowStock)"/],
    outOfStock: [/"stockLevelStatus"\s*:\s*"outOfStock"/],
  },
  gamestop: {
    label: 'GameStop',
    hosts: ['gamestop.com'],
    inStock: [/"availability"\s*:\s*"InStock"/, /data-ready-to-order="true"/],
    outOfStock: [/"availability"\s*:\s*"(?:OutOfStock|NotAvailable)"/, /data-ready-to-order="false"/],
  },
  generic: {
    label: 'Other',
    hosts: [],
    inStock: [],
    outOfStock: [],
  },
};

// Applied to every page: anti-bot interstitials.
export const COMMON_BLOCKED = [
  /<title>\s*Attention Required! \| Cloudflare/i,
  /cf-chl-(?:bypass|widget)/,
  /<title>\s*Access Denied\s*<\/title>/i,
  /<title>\s*Just a moment\.\.\.\s*<\/title>/i,
  /<title>\s*Access to this page has been denied/i, // PerimeterX
];

export function detectRetailer(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  for (const [key, p] of Object.entries(PRESETS)) {
    if (p.hosts.some((h) => host === h || host.endsWith(`.${h}`))) return key;
  }
  return 'generic';
}

export function preset(key) {
  return PRESETS[key] ?? PRESETS.generic;
}

export function cartUrlFor(item) {
  try {
    return preset(item.retailer).cartUrl?.(item.url) ?? null;
  } catch {
    return null;
  }
}
