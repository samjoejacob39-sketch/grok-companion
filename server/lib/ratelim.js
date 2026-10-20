/** In-memory sliding-window rate limiters used across the app. */

export class SlidingWindow {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();   // key -> [timestamps]
  }

  tryConsume(key, n = 1) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length + n > this.limit) {
      this.hits.set(key, arr);
      return { ok: false, retryAfterMs: arr.length ? this.windowMs - (now - arr[0]) : this.windowMs, remaining: Math.max(0, this.limit - arr.length) };
    }
    for (let i = 0; i < n; i++) arr.push(now);
    this.hits.set(key, arr);
    return { ok: true, retryAfterMs: 0, remaining: this.limit - arr.length };
  }

  count(key) {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    this.hits.set(key, arr);
    return arr.length;
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune() {
    const now = Date.now();
    for (const [k, arr] of this.hits) {
      const fresh = arr.filter((t) => now - t < this.windowMs);
      if (fresh.length === 0) this.hits.delete(k);
      else this.hits.set(k, fresh);
    }
  }
}

/** token-bucket style queue for reply bursts */
export class CooldownGate {
  constructor(secondsKey) {
    this.lastBy = new Map();   // key -> ts
    this.secondsDefault = secondsKey || 60;
  }

  ready(key, seconds) {
    const now = Date.now();
    const last = this.lastBy.get(key) || 0;
    if (now - last < seconds * 1000) return { ok: false, retryInMs: seconds * 1000 - (now - last) };
    return { ok: true, retryInMs: 0 };
  }

  mark(key) {
    this.lastBy.set(key, Date.now());
  }

  resetAll() {
    this.lastBy.clear();
  }
}
