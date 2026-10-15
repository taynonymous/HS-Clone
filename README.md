# HS-Clone

Self-hosted, HotStock-style restock monitor web app. It polls product pages and retailer APIs, then pushes an alert to your phone with an add-to-cart link when an item comes back in stock. It ships with a PS5 Pro watchlist.

Zero npm dependencies. Node ≥ 20, a JSON file for state, and a vanilla-JS UI with live updates over SSE.

## Quick start

```sh
npm start                       # http://localhost:8080
# or
cp .env.example .env && docker compose up -d --build
```

Then:

1. Open the UI. Under **Settings & notifications**, set an **ntfy topic** (use a long random string, because topics on ntfy.sh are public). Install the [ntfy app](https://ntfy.sh) and subscribe to that topic. Click **Send test alert**.
2. Get a free [Best Buy API key](https://developer.bestbuy.com) and paste it in. bestbuy.com blocks scrapers aggressively, and the API is the reliable path.
3. Set **Max price** on each item, so a $1,400 third-party marketplace listing doesn't page you.
4. If you keep the tab open, click **Enable browser alerts** for desktop notifications and sound. **Auto-open** opens the cart link on restock; allow pop-ups for the site.

**Run it from a residential IP** (home server, NAS, Raspberry Pi). Datacenter and cloud IPs get bot-walled by most retailers.

## How checks work

| Retailer | Method | Notes |
|---|---|---|
| PlayStation Direct | Product JSON API. The product code is resolved from the page once. | Reliable. Buying requires a PSN sign-in (`loginGated`), so stay signed in. |
| Best Buy | Official Products API if a key is set, otherwise HTML (`data-button-state`) | HTML is usually 503'd by Akamai from non-residential IPs. |
| Amazon | HTML buybox: `add-to-cart-button` vs `unqualifiedBuyBox` ("No featured offers") | Third-party-only listings count as out of stock. |
| Walmart | `__NEXT_DATA__` `availabilityStatus` | PerimeterX walls are common. |
| GameStop | JSON-LD / `data-ready-to-order` | Cloudflare walls are common. |
| Target | `availability_status` if present | Weak. Target loads stock client-side from a bot-walled API, so expect `unknown`. |
| Anything else | schema.org JSON-LD `offers.availability` | Add custom regexes per item. |

Each check records **evidence**: the matched pattern plus surrounding text, shown on the card. When a classification is wrong, edit the item and set custom in-stock and out-of-stock regexes (one per line; out-of-stock wins).

Statuses: `in_stock`, `out_of_stock`, `unknown` (nothing matched), `blocked` (bot wall, or HTTP 403/429/503), `error`.

### Scheduling and alerting

- Each item has its own interval with ±20% jitter. `MIN_INTERVAL_SEC` (default 15) sets the floor.
- Requests to the same host are serialised, with a minimum gap between them (`minHostGapSec`, default 5).
- On `blocked` or `error`, the interval backs off exponentially (×2 per failure), capped at 15 minutes or the base interval, whichever is larger. It resets on the next clean check.
- Alerts fire only on a transition into `in_stock`. Blocks and errors don't reset the last known stock state, so a 503 blip doesn't cause a re-alert. A per-item cooldown (`alertCooldownSec`, default 600) stops flapping from spamming you.
- If an item is in stock above its `maxPrice`, an `over_price` event is logged and no alert goes out.

### Alert channels

- **ntfy**: urgent priority. Tapping the notification opens the add-to-cart link (Best Buy and Amazon) or the product page. It has a "Buy now" action button.
- **Discord** webhook (`@everyone`).
- **Generic webhook**: JSON POST `{event, title, name, url, cartUrl, price, retailerLabel, at}`.
- **Browser**: Notification API, a beep, a banner, and an optional auto-open.

## Chrome extension: checkout assist

`extension/` is a Manifest V3 extension (Chrome 116+). It keeps a WebSocket open to your HS-Clone server. When a restock alert arrives, it opens the cart in a focused tab of **your signed-in Chrome**. It then steps through checkout to the order-review page and highlights the final button. **You click Place order.**

The extension refuses to click any button whose label matches "Place order", "Submit order", "Buy Now", "Pay now", "1-Click" and similar, whatever the flow says. This is enforced in `content.js` and unit-tested.

| Retailer | Steps |
|---|---|
| Best Buy | add-to-cart link → cart → **Checkout** → review |
| Amazon | cart-add link → **Continue** → cart → **Proceed to checkout** → review. It never uses "Buy Now" (1-Click). |
| PS Direct | product page: waits up to 5 min for **Add to Cart** to appear → cart → **Checkout** → review |

It only acts on tabs that it opened from an alert in the last 10 minutes. Your normal browsing on these sites is never touched. A banner on the page shows progress and has a **Stop assist** button. If it hits a sign-in page or an unknown layout, it stops and notifies you.

Setup:

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select `extension/`.
2. Open the extension's settings. Set the server URL, for example `http://192.168.1.10:8080`, plus the username and password if `APP_PASSWORD` is set. The toolbar badge clears once it connects.
3. In the HS-Clone UI, click **Send test alert**. You should get a "connected" notification from Chrome.
4. Optional: use **Dry run** in the extension settings with a cheap in-stock product. It walks to the review page without ordering. Empty your cart afterwards.
5. Stay signed in on each retailer with your card and address saved, and keep Chrome running.

Retailer markup changes. Steps match on button text first and CSS selector second, and they live in `extension/flows.js`.

## Config

Environment variables (see `.env.example`):

| Var | Default | |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | |
| `DATA_DIR` | `./data` | Holds `db.json`, written atomically. |
| `APP_PASSWORD` / `APP_USER` | unset / `admin` | Enables HTTP basic auth. `/healthz` stays open. |
| `MIN_INTERVAL_SEC` | `15` | |
| `NTFY_*`, `DISCORD_WEBHOOK_URL`, `WEBHOOK_URL`, `BESTBUY_API_KEY` | | Seed the settings on first boot only. After that, edit them in the UI. |
| `SEED_PS5_PRO` | `1` | Seeds the PS Direct and Best Buy PS5 Pro items on first boot. |

Settings are stored in `db.json`. Don't expose the app publicly without `APP_PASSWORD`, because the settings include webhook URLs and API keys.

## API

```
GET    /healthz
GET    /api/state                      items, settings, recent events
GET    /api/stream                     SSE: item | event | alert | removed
GET    /api/ws[?auth=base64(user:pass)] WebSocket: {type: hello|ping|alert, payload?} (used by the extension)
POST   /api/items                      {url, name?, retailer?, intervalSec?, maxPrice?, enabled?, inStockPatterns?, outOfStockPatterns?}
PUT    /api/items/:id                  partial update
DELETE /api/items/:id
POST   /api/items/:id/check            check now
PUT    /api/settings
POST   /api/test-alert
```

## Scope

This is a monitor plus a fast path to the order-review page. Placing the order stays a human click. It doesn't store retailer credentials or try to evade bot protection. Those break retailer ToS and get accounts and orders cancelled. Speed comes from fast, reliable alerts and from staying signed in, with payment saved, on each retailer.

## Dev

```sh
npm test        # node:test, no deps
npm i --no-save playwright && npm run test:e2e   # extension e2e in headless Chromium against local fixture pages
npm run dev     # node --watch
```
