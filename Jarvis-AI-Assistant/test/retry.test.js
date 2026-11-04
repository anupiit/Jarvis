const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseRetryAfterHeader, parseGoogleDuration, parseRetryHintFromMessage,
  computeBackoff, computeRetryDelay, formatDuration
} = require('../utils/retry');

test('Retry-After delay-seconds is interpreted as SECONDS (not ms)', () => {
  assert.equal(parseRetryAfterHeader('30'), 30000);
  assert.equal(parseRetryAfterHeader('0'), 0);
  assert.equal(parseRetryAfterHeader('1.5'), 1500);
  assert.equal(parseRetryAfterHeader(['12']), 12000);
});

test('Retry-After HTTP-date is converted to a delay from now', () => {
  const now = Date.parse('Wed, 04 Nov 2026 10:00:00 GMT');
  assert.equal(parseRetryAfterHeader('Wed, 04 Nov 2026 10:02:00 GMT', now), 120000);
  assert.equal(parseRetryAfterHeader('Wed, 04 Nov 2026 09:00:00 GMT', now), 0); // in the past → 0
});

test('Retry-After garbage or absence returns null', () => {
  assert.equal(parseRetryAfterHeader(undefined), null);
  assert.equal(parseRetryAfterHeader(''), null);
  assert.equal(parseRetryAfterHeader('soon'), null);
});

test('google.rpc.RetryInfo durations parse to ms', () => {
  assert.equal(parseGoogleDuration('41s'), 41000);
  assert.equal(parseGoogleDuration('0.250s'), 250);
  assert.equal(parseGoogleDuration('41.620152s'), 41620);
  assert.equal(parseGoogleDuration({ seconds: 3, nanos: 500000000 }), 3500);
  assert.equal(parseGoogleDuration('41'), null);
  assert.equal(parseGoogleDuration(null), null);
});

test('retry hints inside error messages are parsed with units', () => {
  assert.equal(parseRetryHintFromMessage('Please retry in 41.62s.'), 41620);
  assert.equal(parseRetryHintFromMessage('retry after 500ms'), 500);
  assert.equal(parseRetryHintFromMessage('Please retry in 2 minutes'), 120000);
  assert.equal(parseRetryHintFromMessage('nothing here'), null);
});

test('exponential backoff grows, is capped, and jitter stays within [exp/2, exp]', () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const exp = Math.min(30000, 1000 * 2 ** attempt);
    const lo = computeBackoff(attempt, { random: () => 0 });
    const hi = computeBackoff(attempt, { random: () => 0.999999 });
    assert.equal(lo, Math.round(exp / 2));
    assert.ok(hi <= exp && hi >= exp - 1);
  }
  assert.ok(computeBackoff(20, { random: () => 1 }) <= 30000);
});

test('server-specified delay wins over local backoff, with bounded jitter', () => {
  const d = computeRetryDelay(0, 41000, { random: () => 1 });
  assert.ok(d >= 41000 && d <= 42000);
  assert.equal(computeRetryDelay(0, 41000, { random: () => 0 }), 41000);
  assert.equal(computeRetryDelay(2, null, { random: () => 0 }), 2000);
});

test('formatDuration is human readable', () => {
  assert.equal(formatDuration(500), '500 ms');
  assert.equal(formatDuration(41000), '41 s');
  assert.equal(formatDuration(125000), '2 min 5 s');
  assert.equal(formatDuration(7200000), '2 h');
  assert.equal(formatDuration(null), 'an unknown time');
});
