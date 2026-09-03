export class TtlCache {
  #items = new Map();
  #inflight = new Map();

  constructor({ ttlMs = 600_000, max = 300 } = {}) {
    this.ttlMs = ttlMs;
    this.max = max;
  }

  get(key) {
    const hit = this.#items.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.#items.delete(key);
      return undefined;
    }
    // Move to the end for a simple LRU policy.
    this.#items.delete(key);
    this.#items.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    this.#items.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.#items.size > this.max) {
      const oldest = this.#items.keys().next().value;
      this.#items.delete(oldest);
    }
    return value;
  }

  async remember(key, loader, ttlMs = this.ttlMs) {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    if (this.#inflight.has(key)) return this.#inflight.get(key);

    const pending = Promise.resolve()
      .then(loader)
      .then((value) => this.set(key, value, ttlMs))
      .finally(() => this.#inflight.delete(key));

    this.#inflight.set(key, pending);
    return pending;
  }
}
