import { STATUS, detectStock, extractPrice } from './detect.js';
import { preset } from './retailers.js';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const BLOCK_CODES = new Set([403, 429, 503]);

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function fetchText(url, { fetchImpl, userAgent, timeoutMs, accept }) {
  const res = await fetchImpl(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': userAgent || DEFAULT_USER_AGENT,
      Accept: accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
    },
  });
  const text = await res.text();
  return { httpStatus: res.status, body: text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text };
}

// Official Best Buy Products API (free key: https://developer.bestbuy.com).
// Far more reliable than scraping bestbuy.com, which aggressively blocks bots.
async function checkBestBuyApi(item, ctx) {
  const sku = preset('bestbuy').sku(item.url);
  if (!sku) throw new Error('Could not find a 7-digit SKU in the Best Buy URL');
  const url =
    `https://api.bestbuy.com/v1/products/${sku}.json` +
    `?show=sku,name,onlineAvailability,orderable,salePrice&apiKey=${encodeURIComponent(ctx.settings.bestbuyApiKey)}`;
  const { httpStatus, body } = await fetchText(url, { ...ctx, accept: 'application/json' });
  if (httpStatus === 429 || httpStatus === 403) return { status: STATUS.BLOCKED, httpStatus, error: `Best Buy API HTTP ${httpStatus}` };
  if (httpStatus !== 200) return { status: STATUS.ERROR, httpStatus, error: `Best Buy API HTTP ${httpStatus}` };
  const p = JSON.parse(body);
  return {
    status: p.onlineAvailability ? STATUS.IN_STOCK : STATUS.OUT_OF_STOCK,
    httpStatus,
    price: Number(p.salePrice) || null,
    evidence: { pattern: 'bestbuy-api', snippet: `onlineAvailability=${p.onlineAvailability} orderable=${p.orderable}` },
  };
}

// PS Direct renders stock client-side from its SAP Commerce API. Resolve the
// product code from the page once (cached in state), then poll the JSON API.
const PSD_API = 'https://api.direct.playstation.com/commercewebservices/ps-direct-us/users/anonymous/products/productList?fields=BASIC&productCodes=';

async function checkPsDirectApi(item, ctx) {
  let code = item.state?.productCode;
  if (!code) {
    const page = await fetchText(item.url, ctx);
    if (page.httpStatus >= 400) return { status: BLOCK_CODES.has(page.httpStatus) ? STATUS.BLOCKED : STATUS.ERROR, httpStatus: page.httpStatus, error: `HTTP ${page.httpStatus} resolving product code` };
    code = page.body.match(/class="[^"]*\badd-to-cart\b[^"]*"[^>]*\bdata-product-code="(\d+)"/)?.[1];
    if (!code) return checkPage(item, ctx, page);
  }
  const { httpStatus, body } = await fetchText(PSD_API + code, { ...ctx, accept: 'application/json' });
  if (httpStatus >= 400) return { status: BLOCK_CODES.has(httpStatus) ? STATUS.BLOCKED : STATUS.ERROR, httpStatus, error: `PS Direct API HTTP ${httpStatus}`, productCode: code };
  const p = JSON.parse(body).products?.[0];
  if (!p) return { status: STATUS.ERROR, httpStatus, error: `PS Direct API: unknown product ${code}`, productCode: null };
  const level = p.stock?.stockLevelStatus;
  return {
    status: level === 'inStock' || level === 'lowStock' ? STATUS.IN_STOCK : level === 'outOfStock' ? STATUS.OUT_OF_STOCK : STATUS.UNKNOWN,
    httpStatus,
    price: Number(p.price?.value) || null,
    productCode: code,
    evidence: { pattern: 'psdirect-api', snippet: `${p.name} [${code}] stockLevelStatus=${level} purchasable=${p.purchasable} loginGated=${p.loginGated}` },
  };
}

async function checkPage(item, ctx, prefetched) {
  const { httpStatus, body } = prefetched ?? (await fetchText(item.url, ctx));
  const detection = detectStock(body, item);
  const price = extractPrice(body, item);

  if (detection.status === STATUS.BLOCKED || BLOCK_CODES.has(httpStatus)) {
    return { status: STATUS.BLOCKED, httpStatus, evidence: detection.evidence, error: `HTTP ${httpStatus} / bot wall` };
  }
  if (httpStatus >= 400) return { status: STATUS.ERROR, httpStatus, error: `HTTP ${httpStatus}` };
  return { ...detection, httpStatus, price };
}

export async function checkItem(item, ctx) {
  const full = { fetchImpl: globalThis.fetch, timeoutMs: 20_000, ...ctx, userAgent: ctx.settings?.userAgent };
  try {
    if (item.retailer === 'bestbuy' && ctx.settings?.bestbuyApiKey) return await checkBestBuyApi(item, full);
    if (item.retailer === 'psdirect' && !item.inStockPatterns?.length && !item.outOfStockPatterns?.length) {
      return await checkPsDirectApi(item, full);
    }
    return await checkPage(item, full);
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? `timeout after ${full.timeoutMs}ms` : err?.message ?? String(err);
    return { status: STATUS.ERROR, error: msg };
  }
}
