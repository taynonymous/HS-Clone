// Checkout-assist engine. Runs on retailer pages but stays inert unless the
// background worker says this tab was opened by an HS-Clone alert ("armed").
(() => {
  const FLOWS = globalThis.HS_FLOWS;
  const FORBIDDEN = globalThis.HS_FORBIDDEN;
  const CLICKABLE = 'button, a[href], input[type=submit], input[type=button], [role=button]';
  const MAX_ATTEMPTS = 3;

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const label = (el) =>
    (el.innerText || el.value || el.getAttribute('aria-label') || el.title || '').replace(/\s+/g, ' ').trim();

  function usable(el) {
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }

  // Text match first (labels are stabler than class names), then selector.
  function find(spec) {
    if (spec.text) {
      const el = [...document.querySelectorAll(CLICKABLE)].find((e) => usable(e) && spec.text.test(label(e)));
      if (el) return el;
    }
    if (spec.selector) {
      return [...document.querySelectorAll(spec.selector)].find(usable) ?? null;
    }
    return null;
  }

  function waitFor(spec, timeoutMs) {
    return new Promise((resolve) => {
      const hit = find(spec);
      if (hit) return resolve(hit);
      const obs = new MutationObserver(() => {
        const el = find(spec);
        if (el) {
          cleanup();
          resolve(el);
        }
      });
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = () => {
        obs.disconnect();
        clearTimeout(timer);
      };
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  function safeClick(el) {
    const text = label(el);
    if (FORBIDDEN.test(text)) throw new Error(`refused to click "${text}" — ordering is manual`);
    el.scrollIntoView({ block: 'center' });
    el.click();
    return text;
  }

  // ---------- UI (shadow DOM so retailer CSS can't touch it) ----------

  let bannerText;
  function banner(text, tone = 'info') {
    if (!bannerText) {
      const host = document.createElement('div');
      host.id = 'hs-clone-assist';
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          .bar { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%);
            max-width: min(720px, calc(100vw - 24px)); display: flex; gap: 12px; align-items: center;
            font: 600 14px/1.35 system-ui, sans-serif; color: #fff; background: #1d4ed8;
            padding: 10px 14px; border-radius: 10px; box-shadow: 0 6px 24px rgb(0 0 0 / .3); }
          .bar.ok { background: #15803d; } .bar.warn { background: #b45309; }
          button { font: inherit; border: 0; border-radius: 6px; padding: 4px 10px; cursor: pointer; background: rgb(255 255 255 / .2); color: #fff; }
        </style>
        <div class="bar"><span>🔥 </span><span class="t"></span><button type="button">Stop assist</button></div>`;
      root.querySelector('button').addEventListener('click', () => {
        stopped = true;
        send({ type: 'disarm' });
        host.remove();
      });
      document.documentElement.append(host);
      bannerText = root.querySelector('.t');
      bannerText.bar = root.querySelector('.bar');
    }
    bannerText.textContent = text;
    bannerText.bar.className = `bar ${tone}`;
  }

  function highlight(el) {
    el.scrollIntoView({ block: 'center' });
    el.style.setProperty('outline', '5px solid #16a34a', 'important');
    el.style.setProperty('outline-offset', '3px', 'important');
    el.style.setProperty('box-shadow', '0 0 0 12px rgb(22 163 74 / .35)', 'important');
    el.focus?.({ preventScroll: true });
  }

  // ---------- engine ----------

  let stopped = false;
  let busy = false;
  const done = new Set();

  function attempts(step) {
    const key = `hs-attempts:${step.name}`;
    const n = Number(sessionStorage.getItem(key) || 0) + 1;
    sessionStorage.setItem(key, String(n));
    return n;
  }

  async function runStep(step, armed) {
    if (step.stop === 'signin') {
      banner(`Sign in to continue — then reopen the cart. (${armed.name})`, 'warn');
      send({ type: 'progress', state: 'signin' });
      return;
    }
    if (step.stop === 'review') {
      const btn = step.highlight ? await waitFor(step.highlight, 20_000) : null;
      if (btn) highlight(btn);
      banner(btn ? 'Review shipping & payment, then click the highlighted button to place your order.' : 'Order review page — check details and place your order.', 'ok');
      send({ type: 'progress', state: 'review' });
      return;
    }
    if (attempts(step) > MAX_ATTEMPTS) {
      banner(`Assist gave up on "${step.name}" after ${MAX_ATTEMPTS} tries — finish manually.`, 'warn');
      send({ type: 'progress', state: 'failed', step: step.name });
      return;
    }
    for (const action of step.actions) {
      if (stopped) return;
      if (action.navigate) {
        await sleep(action.delayMs ?? 0);
        location.assign(new URL(action.navigate, location.origin).href);
        return;
      }
      banner(`Working: ${step.name}…`);
      const el = await waitFor(action.click, action.timeoutMs ?? 15_000);
      if (!el) {
        if (action.optional) continue;
        throw new Error(`couldn't find the button for "${step.name}"`);
      }
      const clicked = safeClick(el);
      send({ type: 'progress', state: 'clicked', step: step.name, label: clicked });
      await sleep(action.delayMs ?? 400);
    }
  }

  async function main() {
    const armed = await send({ type: 'armed?' });
    if (!armed) return;
    const flow = FLOWS[armed.retailer];
    if (!flow) return;
    banner(`Checkout assist active for ${armed.name}`);

    // Retailer carts/checkouts are SPAs: re-evaluate on URL changes.
    let lastHref = null;
    const tick = async () => {
      if (stopped || busy || location.href === lastHref) return;
      lastHref = location.href;
      const step = flow.find((s) => s.url.test(location.href));
      if (!step || done.has(`${step.name}|${location.pathname}`)) return;
      done.add(`${step.name}|${location.pathname}`);
      busy = true;
      try {
        await runStep(step, armed);
      } catch (err) {
        banner(`Assist stopped: ${err.message}. Finish manually.`, 'warn');
        send({ type: 'progress', state: 'failed', step: step.name, error: err.message });
      } finally {
        busy = false;
        lastHref = null; // allow the next URL (or same URL after SPA nav) to be evaluated
        if (step) done.add(`${step.name}|${location.pathname}`);
      }
    };
    setInterval(tick, 500);
    tick();
  }

  main();
})();
