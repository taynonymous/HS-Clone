// Outbound alert channels. Each returns { channel, ok, error? }.

const ascii = (s) => String(s).replace(/[^\x20-\x7E]/g, '').slice(0, 250);

function fmtPrice(p) {
  return p == null ? 'price unknown' : `$${Number(p).toFixed(2)}`;
}

export function buildMessage(alert) {
  const title = alert.test ? 'HS-Clone test alert' : `IN STOCK: ${alert.name}`;
  const body = alert.test
    ? 'Notifications are working.'
    : `${alert.retailerLabel} - ${fmtPrice(alert.price)}\n${alert.cartUrl ?? alert.url}`;
  return { title, body, click: alert.cartUrl ?? alert.url };
}

async function post(fetchImpl, url, init) {
  const res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(10_000), ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

const channels = {
  async ntfy(s, msg, alert, fetchImpl) {
    if (!s.ntfyTopic) return null;
    const base = (s.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
    const headers = {
      Title: ascii(msg.title),
      Priority: alert.test ? 'default' : 'urgent',
      Tags: 'video_game,rotating_light',
    };
    if (msg.click) {
      headers.Click = msg.click;
      headers.Actions = `view, Buy now, ${msg.click}, clear=true`;
    }
    if (s.ntfyToken) headers.Authorization = `Bearer ${s.ntfyToken}`;
    await post(fetchImpl, `${base}/${encodeURIComponent(s.ntfyTopic)}`, { headers, body: msg.body });
    return true;
  },

  async discord(s, msg, alert, fetchImpl) {
    if (!s.discordWebhook) return null;
    const content = `${alert.test ? '' : '@everyone '}**${msg.title}**\n${msg.body}`;
    await post(fetchImpl, s.discordWebhook, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, allowed_mentions: { parse: ['everyone'] } }),
    });
    return true;
  },

  async webhook(s, msg, alert, fetchImpl) {
    if (!s.webhookUrl) return null;
    await post(fetchImpl, s.webhookUrl, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: alert.test ? 'test' : 'in_stock', title: msg.title, ...alert }),
    });
    return true;
  },
};

export async function sendAlert(settings, alert, fetchImpl = globalThis.fetch) {
  const msg = buildMessage(alert);
  const results = await Promise.all(
    Object.entries(channels).map(async ([channel, fn]) => {
      try {
        const sent = await fn(settings, msg, alert, fetchImpl);
        return sent ? { channel, ok: true } : null;
      } catch (err) {
        return { channel, ok: false, error: err?.message ?? String(err) };
      }
    }),
  );
  return results.filter(Boolean);
}
