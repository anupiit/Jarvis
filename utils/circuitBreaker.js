// Circuit breaker for the Gemini API (process-local).
//
// CLOSED     → requests flow. Consecutive transient failures are counted.
// OPEN       → requests fail fast until `openUntil`.
// HALF_OPEN  → exactly one probe request is allowed; success closes, failure re-opens.
//
// trip(ms, reason) opens the circuit for a fixed time regardless of the counter. It is
// used for failures that retrying cannot fix (bad key, exhausted quota, billing).

const State = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreaker {
  constructor({ failureThreshold = 5, cooldownMs = 30000, maxCooldownMs = 5 * 60000, now = () => Date.now() } = {}) {
    this.failureThreshold = failureThreshold;
    this.baseCooldownMs = cooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.now = now;
    this.state = State.CLOSED;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.currentCooldownMs = cooldownMs;
    this.probeInFlight = false;
    this.lastError = null;
    this.openCount = 0;
  }

  /** Non-consuming look: is the circuit currently refusing requests? */
  peek() {
    const nowMs = this.now();
    if (this.state === State.OPEN && nowMs < this.openUntil) {
      return { open: true, retryInMs: this.openUntil - nowMs };
    }
    return { open: false, retryInMs: 0 };
  }

  /** @returns {{ allowed: boolean, retryInMs: number, isProbe: boolean }} */
  check() {
    const nowMs = this.now();
    if (this.state === State.CLOSED) return { allowed: true, retryInMs: 0, isProbe: false };
    if (this.state === State.OPEN) {
      if (nowMs < this.openUntil) return { allowed: false, retryInMs: this.openUntil - nowMs, isProbe: false };
      this.state = State.HALF_OPEN;
      this.probeInFlight = false;
    }
    // HALF_OPEN
    if (this.probeInFlight) return { allowed: false, retryInMs: 1000, isProbe: false };
    this.probeInFlight = true;
    return { allowed: true, retryInMs: 0, isProbe: true };
  }

  onSuccess() {
    this.state = State.CLOSED;
    this.consecutiveFailures = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.probeInFlight = false;
    this.lastError = null;
  }

  /** Record a transient failure (server/network/timeout). */
  onFailure(error) {
    this.lastError = error || null;
    if (this.state === State.HALF_OPEN) {
      // Probe failed: back off harder.
      this.currentCooldownMs = Math.min(this.maxCooldownMs, this.currentCooldownMs * 2);
      this.open(this.currentCooldownMs);
      return;
    }
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.failureThreshold) this.open(this.currentCooldownMs);
  }

  /** A response arrived but was not a transient failure (e.g. 400): the API is reachable. */
  onNeutral() {
    if (this.state === State.HALF_OPEN) {
      this.state = State.CLOSED;
      this.probeInFlight = false;
    }
    this.consecutiveFailures = 0;
  }

  /** Open immediately for `ms` (latching failures). */
  trip(ms, error) {
    this.lastError = error || this.lastError;
    this.open(ms);
  }

  open(ms) {
    this.state = State.OPEN;
    this.openUntil = this.now() + ms;
    this.probeInFlight = false;
    this.openCount++;
  }

  reset() {
    this.state = State.CLOSED;
    this.consecutiveFailures = 0;
    this.openUntil = 0;
    this.currentCooldownMs = this.baseCooldownMs;
    this.probeInFlight = false;
    this.lastError = null;
  }

  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openForMs: this.state === State.OPEN ? Math.max(0, this.openUntil - this.now()) : 0,
      openCount: this.openCount
    };
  }
}

module.exports = { CircuitBreaker, CircuitState: State };
