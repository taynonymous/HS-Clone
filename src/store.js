import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_EVENTS = 300;

export function defaultData(env = process.env) {
  return {
    version: 1,
    settings: {
      ntfyServer: env.NTFY_SERVER || 'https://ntfy.sh',
      ntfyTopic: env.NTFY_TOPIC || '',
      ntfyToken: env.NTFY_TOKEN || '',
      discordWebhook: env.DISCORD_WEBHOOK_URL || '',
      webhookUrl: env.WEBHOOK_URL || '',
      bestbuyApiKey: env.BESTBUY_API_KEY || '',
      userAgent: '',
      defaultIntervalSec: 30,
      minHostGapSec: 5,
      alertCooldownSec: 600,
    },
    items: [],
    events: [],
  };
}

// JSON file persistence with debounced atomic writes (tmp + rename).
export class Store {
  constructor(file, { debounceMs = 250 } = {}) {
    this.file = file;
    this.debounceMs = debounceMs;
    this.data = null;
    this.timer = null;
    this.writing = Promise.resolve();
  }

  async load(seed = defaultData()) {
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.data = { ...seed, ...parsed, settings: { ...seed.settings, ...parsed.settings } };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.data = seed;
      this.fresh = true;
      await this.flush();
    }
    return this.data;
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
    this.timer.unref?.();
  }

  flush() {
    clearTimeout(this.timer);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2));
      await fs.rename(tmp, this.file);
    });
    return this.writing;
  }

  addEvent(ev) {
    this.data.events.unshift(ev);
    this.data.events.length = Math.min(this.data.events.length, MAX_EVENTS);
    this.save();
    return ev;
  }
}
