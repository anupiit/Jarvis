// Sliding-window-log rate limiter (process-local).
// At most `maxRequests` acquisitions in any rolling window of `windowMs`.
// Also supports a global pause (e.g. when the server returns Retry-After on a 429).

class SlidingWindowRateLimiter {
  constructor({ maxRequests = 10, windowMs = 60000, now = () => Date.now() } = {}) {
    if (!(maxRequests > 0)) throw new Error('maxRequests must be > 0');
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = now;
    this.timestamps = [];
    this.pausedUntil = 0;
  }

  prune(nowMs) {
    const cutoff = nowMs - this.windowMs;
    let i = 0;
    while (i < this.timestamps.length && this.timestamps[i] <= cutoff) i++;
    if (i) this.timestamps.splice(0, i);
  }

  /** Milliseconds until a slot is available (0 = available now). Does not consume. */
  timeUntilAvailable(nowMs = this.now()) {
    this.prune(nowMs);
    const pauseWait = Math.max(0, this.pausedUntil - nowMs);
    let windowWait = 0;
    if (this.timestamps.length >= this.maxRequests) {
      windowWait = this.timestamps[0] + this.windowMs - nowMs;
    }
    return Math.max(pauseWait, windowWait, 0);
  }

  /** Consume a slot if available. @returns {number} 0 if acquired, else ms to wait. */
  tryAcquire(nowMs = this.now()) {
    const wait = this.timeUntilAvailable(nowMs);
    if (wait > 0) return wait;
    this.timestamps.push(nowMs);
    return 0;
  }

  /** Record an extra request that was sent without asking (e.g. continuation hop). */
  record(nowMs = this.now()) {
    this.prune(nowMs);
    this.timestamps.push(nowMs);
  }

  /** Pause all acquisitions until nowMs + ms (never shortens an existing pause). */
  pauseFor(ms, nowMs = this.now()) {
    this.pausedUntil = Math.max(this.pausedUntil, nowMs + Math.max(0, ms));
  }

  inWindow(nowMs = this.now()) {
    this.prune(nowMs);
    return this.timestamps.length;
  }
}

module.exports = { SlidingWindowRateLimiter };
