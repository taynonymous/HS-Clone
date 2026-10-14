import { COMMON_BLOCKED, preset } from './retailers.js';

export const STATUS = Object.freeze({
  IN_STOCK: 'in_stock',
  OUT_OF_STOCK: 'out_of_stock',
  UNKNOWN: 'unknown',
  BLOCKED: 'blocked',
  ERROR: 'error',
});

export function compilePatterns(list) {
  return (list ?? []).filter((s) => typeof s === 'string' && s.trim()).map((s) => new RegExp(s, 'i'));
}

function snippet(text, match) {
  const start = Math.max(0, match.index - 60);
  const end = Math.min(text.length, match.index + match[0].length + 60);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return { pattern: re.source, snippet: snippet(text, m) };
  }
  return null;
}

// Collect schema.org Offer data from <script type="application/ld+json"> blocks.
export function parseJsonLdOffers(html) {
  const offers = [];
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(visit);
    const type = [].concat(node['@type'] ?? []);
    if (type.includes('Offer') || type.includes('AggregateOffer')) {
      offers.push({
        availability: typeof node.availability === 'string' ? node.availability : null,
        price: Number(node.price ?? node.lowPrice) || null,
      });
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') visit(v);
  };
  for (const [, body] of blocks) {
    try {
      visit(JSON.parse(body.trim()));
    } catch {
      // malformed JSON-LD is common; ignore
    }
  }
  return offers;
}

/**
 * Classify a product page.
 * Precedence: blocked > out-of-stock > in-stock > JSON-LD availability > unknown.
 * Out-of-stock wins over in-stock so recommendation carousels with their own
 * "Add to Cart" buttons don't produce false alerts.
 */
export function detectStock(html, item = {}) {
  const p = preset(item.retailer);

  const blocked = firstMatch(html, [...COMMON_BLOCKED, ...(p.blocked ?? [])]);
  if (blocked) return { status: STATUS.BLOCKED, evidence: blocked };

  const custom = item.inStockPatterns?.length || item.outOfStockPatterns?.length;
  const outPatterns = custom ? compilePatterns(item.outOfStockPatterns) : p.outOfStock;
  const inPatterns = custom ? compilePatterns(item.inStockPatterns) : p.inStock;

  const out = firstMatch(html, outPatterns);
  if (out) return { status: STATUS.OUT_OF_STOCK, evidence: out };
  const inn = firstMatch(html, inPatterns);
  if (inn) return { status: STATUS.IN_STOCK, evidence: inn };

  if (!custom) {
    const avail = parseJsonLdOffers(html).map((o) => o.availability).filter(Boolean);
    if (avail.some((a) => /(OutOfStock|SoldOut|Discontinued)$/i.test(a))) {
      return { status: STATUS.OUT_OF_STOCK, evidence: { pattern: 'json-ld', snippet: avail.join(', ') } };
    }
    if (avail.some((a) => /(InStock|LimitedAvailability|OnlineOnly|PreOrder)$/i.test(a))) {
      return { status: STATUS.IN_STOCK, evidence: { pattern: 'json-ld', snippet: avail.join(', ') } };
    }
  }

  return { status: STATUS.UNKNOWN, evidence: null };
}

export function extractPrice(html, item = {}) {
  for (const re of preset(item.retailer).price ?? []) {
    const m = re.exec(html);
    if (m) {
      const n = Number(m[1].replace(/,/g, ''));
      if (n > 0) return n;
    }
  }
  return parseJsonLdOffers(html).find((o) => o.price)?.price ?? null;
}
