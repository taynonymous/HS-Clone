import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { checkItem } from './checker.js';
import { STATUS } from './detect.js';
import { sendAlert } from './notify.js';
import { cartUrlFor, preset } from './retailers.js';

const MAX_BACKOFF_MS = 15 * 60_000;
const DEFINITIVE = new Set([STATUS.IN_STOCK, STATUS.OUT_OF_STOCK]);

export function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Polls enabled items on their interval (±20% jitter), serialising requests
 * per host with a minimum gap, and backing off exponentially on blocks/errors.
 * Emits: 'item' (item), 'event' (event), 'alert' (alert).
 */
export class Monitor extends EventEmitter {
  constructor(store, { fetchImpl = globalThis.fetch, now = Date.now, random = Math.random, tickMs = 1000 } = {}) {
    super();
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.random = random;
    this.tickMs = tickMs;
    this.inflight = new Set();
    this.hostLast = new Map();
    this.timer = null;
  }

  get settings() {
    return this.store.data.settings;
  }

  start() {
    if (this.timer) return;
    const loop = () => {
      this.tick();
      this.timer = setTimeout(loop, this.tickMs);
      this.timer.unref?.();
    };
    loop();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  // Start every due check; returns their promises (handy for tests).
  tick() {
    const now = this.now();
    const gapMs = (this.settings.minHostGapSec ?? 5) * 1000;
    const started = [];
    for (const item of this.store.data.items) {
      if (!item.enabled || this.inflight.has(item.id)) continue;
      if ((item.state?.nextCheckAt ?? 0) > now) continue;
      const host = hostOf(item.url);
      if (now - (this.hostLast.get(host) ?? -Infinity) < gapMs) continue;
      started.push(this.run(item));
    }
    return Promise.all(started);
  }

  checkNow(id) {
    const item = this.store.data.items.find((i) => i.id === id);
    if (!item) return null;
    if (this.inflight.has(id)) return Promise.resolve(item);
    return this.run(item);
  }

  async run(item) {
    this.inflight.add(item.id);
    this.hostLast.set(hostOf(item.url), this.now());
    try {
      const result = await checkItem(item, { fetchImpl: this.fetchImpl, settings: this.settings });
      // The item may have been deleted/replaced while in flight.
      const live = this.store.data.items.find((i) => i.id === item.id);
      if (live && live.url === item.url) await this.apply(live, result);
      return live;
    } finally {
      this.inflight.delete(item.id);
    }
  }

  nextDelayMs(item, failures) {
    const base = item.intervalSec * 1000;
    const jitter = 0.8 + this.random() * 0.4;
    const backoff = failures > 0 ? Math.min(base * 2 ** Math.min(failures, 6), Math.max(base, MAX_BACKOFF_MS)) : base;
    return Math.round(backoff * jitter);
  }

  async apply(item, result) {
    const now = this.now();
    const s = (item.state ??= {});
    s.status = result.status;
    s.lastCheckedAt = now;
    s.httpStatus = result.httpStatus ?? null;
    s.evidence = result.evidence ?? null;
    s.error = result.error ?? null;
    if (result.price != null) s.price = result.price;
    if (result.productCode !== undefined) s.productCode = result.productCode;
    s.checks = (s.checks ?? 0) + 1;

    if (result.status === STATUS.BLOCKED || result.status === STATUS.ERROR) {
      s.failures = (s.failures ?? 0) + 1;
    } else {
      s.failures = 0;
    }

    if (DEFINITIVE.has(result.status) && s.lastDefinitive !== result.status) {
      const wasKnown = s.lastDefinitive != null;
      s.lastDefinitive = result.status;
      s.lastChangeAt = now;
      if (result.status === STATUS.IN_STOCK) {
        await this.onInStock(item);
      } else if (wasKnown) {
        this.event(item, 'sold_out', 'Went out of stock');
      }
    }

    s.nextCheckAt = now + this.nextDelayMs(item, s.failures);
    this.store.save();
    this.emit('item', item);
  }

  async onInStock(item) {
    const s = item.state;
    const priceTxt = s.price != null ? `$${s.price}` : 'price unknown';
    if (item.maxPrice && s.price != null && s.price > item.maxPrice) {
      this.event(item, 'over_price', `In stock at ${priceTxt}, above max $${item.maxPrice} — not alerting`);
      return;
    }
    const cooldownMs = (this.settings.alertCooldownSec ?? 600) * 1000;
    if (s.lastAlertAt && this.now() - s.lastAlertAt < cooldownMs) {
      this.event(item, 'restock', `In stock (${priceTxt}) — alert suppressed by cooldown`);
      return;
    }
    s.lastAlertAt = this.now();
    const alert = {
      itemId: item.id,
      name: item.name,
      url: item.url,
      cartUrl: cartUrlFor(item),
      retailer: item.retailer,
      retailerLabel: preset(item.retailer).label,
      price: s.price ?? null,
      at: s.lastAlertAt,
    };
    this.emit('alert', alert);
    const results = await sendAlert(this.settings, alert, this.fetchImpl);
    const failed = results.filter((r) => !r.ok);
    const channelsTxt = results.length
      ? results.map((r) => `${r.channel}:${r.ok ? 'ok' : r.error}`).join(', ')
      : 'no push channels configured';
    this.event(item, 'restock', `IN STOCK (${priceTxt}) — ${channelsTxt}`, failed.length ? 'warn' : 'info');
  }

  event(item, type, message, level = 'info') {
    const ev = { id: randomUUID(), at: this.now(), itemId: item?.id ?? null, itemName: item?.name ?? null, type, level, message };
    this.store.addEvent(ev);
    this.emit('event', ev);
    return ev;
  }
}
