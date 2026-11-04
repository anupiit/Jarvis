const test = require('node:test');
const assert = require('node:assert/strict');
const { LRUCache } = require('../utils/lruCache');
const { SlidingWindowRateLimiter } = require('../utils/slidingWindowRateLimiter');
const { BoundedQueue, QueueFullError } = require('../utils/boundedQueue');
const { CircuitBreaker, CircuitState } = require('../utils/circuitBreaker');
const { Telemetry } = require('../services/telemetry');

function clock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('LRU cache evicts the least recently used entry when full', () => {
  const c = new LRUCache({ maxEntries: 2, ttlMs: 1000 });
  c.set('a', 1); c.set('b', 2);
  assert.equal(c.get('a'), 1); // a is now most recent
  c.set('c', 3);               // evicts b
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 1);
  assert.equal(c.get('c'), 3);
  assert.equal(c.size, 2);
  assert.equal(c.evictions, 1);
});

test('LRU cache entries expire after their TTL', () => {
  const k = clock();
  const c = new LRUCache({ maxEntries: 10, ttlMs: 100, now: k.now });
  c.set('a', 1);
  k.advance(99);
  assert.equal(c.get('a'), 1);
  k.advance(1);
  assert.equal(c.get('a'), undefined);
  assert.equal(c.expirations, 1);
  assert.equal(c.size, 0);
});

test('sliding window limiter allows N per window and reports the exact wait', () => {
  const k = clock(1000);
  const rl = new SlidingWindowRateLimiter({ maxRequests: 3, windowMs: 1000, now: k.now });
  assert.equal(rl.tryAcquire(), 0);
  k.advance(100); assert.equal(rl.tryAcquire(), 0);
  k.advance(100); assert.equal(rl.tryAcquire(), 0);
  assert.equal(rl.tryAcquire(), 800);          // oldest (t=1000) leaves the window at t=2000
  k.advance(800);
  assert.equal(rl.tryAcquire(), 0);            // window slid
  assert.equal(rl.inWindow(), 3);
});

test('sliding window limiter honours a global pause (Retry-After)', () => {
  const k = clock();
  const rl = new SlidingWindowRateLimiter({ maxRequests: 100, windowMs: 1000, now: k.now });
  rl.pauseFor(5000);
  assert.equal(rl.timeUntilAvailable(), 5000);
  rl.pauseFor(1000); // never shortens
  assert.equal(rl.timeUntilAvailable(), 5000);
  k.advance(5000);
  assert.equal(rl.tryAcquire(), 0);
});

test('bounded queue is FIFO and rejects overflow', () => {
  const q = new BoundedQueue(3);
  q.enqueue('a'); q.enqueue('b'); q.enqueue('c');
  assert.throws(() => q.enqueue('d'), QueueFullError);
  assert.deepEqual([q.dequeue(), q.dequeue(), q.dequeue()], ['a', 'b', 'c']);
  assert.equal(q.dequeue(), undefined);
  assert.equal(q.highWaterMark, 3);
});

test('bounded queue: requeueFront keeps retried work first; remove() works', () => {
  const q = new BoundedQueue(5);
  q.enqueue('a'); q.enqueue('b');
  q.requeueFront('retry');
  assert.equal(q.peek(), 'retry');
  assert.equal(q.remove('a'), true);
  assert.deepEqual(q.drain(), ['retry', 'b']);
});

test('circuit breaker opens after N consecutive transient failures and fails fast', () => {
  const k = clock();
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, now: k.now });
  cb.onFailure(); cb.onFailure();
  assert.equal(cb.state, CircuitState.CLOSED);
  cb.onFailure();
  assert.equal(cb.state, CircuitState.OPEN);
  assert.deepEqual(cb.check(), { allowed: false, retryInMs: 1000, isProbe: false });
});

test('circuit breaker half-opens after cooldown, allows one probe, closes on success', () => {
  const k = clock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: k.now });
  cb.onFailure();
  k.advance(1000);
  const probe = cb.check();
  assert.equal(probe.allowed, true);
  assert.equal(probe.isProbe, true);
  assert.equal(cb.check().allowed, false, 'only one probe at a time');
  cb.onSuccess();
  assert.equal(cb.state, CircuitState.CLOSED);
  assert.equal(cb.check().allowed, true);
});

test('circuit breaker: failed probe re-opens with a longer cooldown', () => {
  const k = clock();
  const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, now: k.now });
  cb.onFailure();
  k.advance(1000);
  cb.check();
  cb.onFailure();
  assert.equal(cb.state, CircuitState.OPEN);
  assert.equal(cb.peek().retryInMs, 2000);
});

test('circuit breaker trip() latches for a fixed time; reset() clears', () => {
  const k = clock();
  const cb = new CircuitBreaker({ now: k.now });
  cb.trip(60000, { kind: 'AUTH' });
  assert.equal(cb.peek().open, true);
  assert.equal(cb.lastError.kind, 'AUTH');
  cb.reset();
  assert.equal(cb.peek().open, false);
});

test('telemetry records counters and latency percentiles only', () => {
  const t = new Telemetry();
  t.increment('requests', 3);
  [10, 20, 30, 40, 100].forEach(ms => t.recordLatency(ms));
  t.recordError('RATE_LIMITED');
  t.recordError('<script>bad'); // sanitized to letters/underscores only
  const s = t.snapshot();
  assert.equal(s.counters.requests, 3);
  assert.equal(s.latencyMs.p50, 30);
  assert.equal(s.latencyMs.p95, 100);
  assert.equal(s.latencyMs.max, 100);
  assert.equal(s.errorsByKind.RATE_LIMITED, 1);
  assert.equal(s.errorsByKind.scriptbad, 1);
});
