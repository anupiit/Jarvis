// Retry timing helpers. All public values are in MILLISECONDS.

/**
 * Parse an HTTP Retry-After header value.
 * RFC 9110: either delay-seconds (integer) or an HTTP-date.
 * @returns {number|null} delay in ms, or null when absent/unparseable
 */
function parseRetryAfterHeader(value, nowMs = Date.now()) {
  if (value === undefined || value === null) return null;
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) {
    // delay-seconds — this is SECONDS, never milliseconds
    return Math.round(parseFloat(text) * 1000);
  }
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(0, date - nowMs);
  return null;
}

/**
 * Parse a google.protobuf.Duration JSON string such as "41s", "1.5s", "0.250s"
 * (as used by google.rpc.RetryInfo.retryDelay).
 * @returns {number|null} ms
 */
function parseGoogleDuration(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' && value.seconds !== undefined) {
    const seconds = Number(value.seconds) || 0;
    const nanos = Number(value.nanos) || 0;
    return Math.round(seconds * 1000 + nanos / 1e6);
  }
  const match = /^\s*(\d+(?:\.\d+)?)s\s*$/.exec(String(value));
  return match ? Math.round(parseFloat(match[1]) * 1000) : null;
}

/**
 * Extract "Please retry in 41.62s" / "retry in 500ms" / "retry after 2m" hints from an error message.
 * @returns {number|null} ms
 */
function parseRetryHintFromMessage(message) {
  if (!message) return null;
  const match = /retry (?:in|after) (\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|minutes?|h|hours?)\b/i.exec(String(message));
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit === 'ms') return Math.round(amount);
  if (unit.startsWith('h')) return Math.round(amount * 3600000);
  if (unit === 'm' || unit.startsWith('min')) return Math.round(amount * 60000);
  return Math.round(amount * 1000);
}

/**
 * Exponential backoff with "equal jitter": half deterministic, half random.
 * attempt is 0-based (0 → first retry).
 */
function computeBackoff(attempt, { baseMs = 1000, maxMs = 30000, random = Math.random } = {}) {
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt)));
  const half = exp / 2;
  return Math.round(half + random() * half);
}

/**
 * Decide the delay before the next attempt.
 * A server-provided delay always wins over our own backoff (with a small jitter on top
 * so many clients do not retry in lockstep).
 */
function computeRetryDelay(attempt, serverDelayMs, opts = {}) {
  const random = opts.random || Math.random;
  if (typeof serverDelayMs === 'number' && serverDelayMs >= 0) {
    const jitter = Math.round(random() * Math.min(1000, Math.max(100, serverDelayMs * 0.1)));
    return serverDelayMs + jitter;
  }
  return computeBackoff(attempt, opts);
}

function formatDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'an unknown time';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes} min ${seconds} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes ? `${hours} h ${remMinutes} min` : `${hours} h`;
}

module.exports = {
  parseRetryAfterHeader,
  parseGoogleDuration,
  parseRetryHintFromMessage,
  computeBackoff,
  computeRetryDelay,
  formatDuration
};
