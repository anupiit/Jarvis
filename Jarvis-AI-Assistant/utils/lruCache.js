// Bounded least-recently-used cache with per-entry time-to-live.
// Map preserves insertion order, so the first key is always the least recently used.

class LRUCache {
  constructor({ maxEntries = 100, ttlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
    if (!(maxEntries > 0)) throw new Error('maxEntries must be > 0');
    this.maxEntries = maxEntries;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();
    this.evictions = 0;
    this.expirations = 0;
  }

  get size() {
    return this.map.size;
  }

  has(key) {
    return this.get(key, { touch: false }) !== undefined;
  }

  get(key, { touch = true } = {}) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key);
      this.expirations++;
      return undefined;
    }
    if (touch) {
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry.value;
  }

  set(key, value, ttlMs = this.ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
      this.evictions++;
    }
  }

  delete(key) {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }
}

module.exports = { LRUCache };
