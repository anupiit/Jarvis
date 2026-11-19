// Reliability engine tests with a mocked transport (deterministic, no network).
const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiEngine } = require('../services/geminiService');
const { ErrorKind } = require('../services/geminiErrors');
const { createMockTransport, netError } = require('./helpers/mockTransport');
const F = require('./fixtures/geminiResponses');

const FAST = { baseBackoffMs: 5, maxBackoffMs: 20, rateLimitMaxRequests: 1000, concurrency: 2 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeEngine(handler, settings = {}, extra = {}) {
  const transport = createMockTransport(handler);
  const engine = new GeminiEngine({
    apiKey: 'test-key-abcdefghijklmnopqrstuvwxyz', model: 'gemini-test', transport,
    settings: { ...FAST, ...settings }, random: () => 0.5, ...extra
  });
  return { engine, transport };
}

const ok = (text = 'hello', extra = {}) => ({ body: F.docSuccess(text), ...extra });
const promptOf = (req) => req.body.contents[0].parts[0].text;

test('valid request → parsed text, single outbound attempt, documented body', async () => {
  const { engine, transport } = makeEngine(() => ok('Hi there'));
  const r = await engine.generate('Say hi', { systemInstruction: 'brief' });
  assert.equal(r.text, 'Hi there');
  assert.equal(r.attempts, 1);
  assert.equal(r.cached, false);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].path, '/v1beta/models/gemini-test:generateContent');
  assert.equal(transport.calls[0].body.systemInstruction.parts[0].text, 'brief');
  assert.ok(transport.calls[0].body.generationConfig.maxOutputTokens >= 8192, 'output budget large enough for whole files');
});

test('missing API key → CONFIG error and no request is sent', async () => {
  const { engine, transport } = makeEngine(() => ok());
  engine.apiKey = '';
  await assert.rejects(engine.generate('x'), (e) => e.kind === ErrorKind.CONFIG);
  assert.equal(transport.calls.length, 0);
});

test('cache hit: identical request is served without an outbound call', async () => {
  const { engine, transport } = makeEngine(() => ok('cached!'));
  await engine.generate('same prompt');
  const second = await engine.generate('same prompt');
  assert.equal(second.cached, true);
  assert.equal(second.text, 'cached!');
  assert.equal(transport.calls.length, 1);
  assert.equal(engine.stats().counters.cacheHits, 1);
});

test('cache expiration: after TTL the request goes out again', async () => {
  const { engine, transport } = makeEngine(() => ok(), { cacheTtlMs: 30 });
  await engine.generate('p');
  await sleep(45);
  const again = await engine.generate('p');
  assert.equal(again.cached, false);
  assert.equal(transport.calls.length, 2);
});

test('noCache bypasses the cache (used by self-correction)', async () => {
  const { engine, transport } = makeEngine(() => ok());
  await engine.generate('p');
  await engine.generate('p', { noCache: true });
  assert.equal(transport.calls.length, 2);
});

test('concurrent identical requests are coalesced into one outbound request', async () => {
  const { engine, transport } = makeEngine(() => ok('shared', { delayMs: 40 }));
  const results = await Promise.all(Array.from({ length: 10 }, () => engine.generate('identical')));
  assert.equal(transport.calls.length, 1);
  assert.ok(results.every(r => r.text === 'shared'));
  assert.equal(results.filter(r => r.coalesced).length, 9);
  assert.equal(engine.stats().counters.coalesced, 9);
});

test('coalescing lasts for the whole flight (no 1-second debounce expiry)', async () => {
  const { engine, transport } = makeEngine(() => ok('slow', { delayMs: 120 }));
  const first = engine.generate('long flight', { noCache: true });
  await sleep(80);
  const second = engine.generate('long flight', { noCache: true });
  await Promise.all([first, second]);
  assert.equal(transport.calls.length, 1);
  // after settling, the in-flight entry is gone
  assert.equal(engine.inflight.size, 0);
});

test('coalesced callers all receive the same failure', async () => {
  const { engine, transport } = makeEngine(() => ({ status: 404, body: F.DOC_MODEL_NOT_FOUND_404, delayMs: 20 }));
  const results = await Promise.allSettled([engine.generate('x'), engine.generate('x'), engine.generate('x')]);
  assert.equal(transport.calls.length, 1);
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.kind === ErrorKind.MODEL_NOT_FOUND));
});

test('FIFO: with one worker, requests are dispatched in submission order', async () => {
  const { engine, transport } = makeEngine(() => ok('x', { delayMs: 5 }), { concurrency: 1 });
  const prompts = ['p1', 'p2', 'p3', 'p4', 'p5'];
  await Promise.all(prompts.map(p => engine.generate(p)));
  assert.deepEqual(transport.calls.map(promptOf), prompts);
});

test('concurrency limit is respected', async () => {
  const { engine, transport } = makeEngine(() => ok('x', { delayMs: 20 }), { concurrency: 2 });
  await Promise.all(Array.from({ length: 6 }, (_, i) => engine.generate(`distinct ${i}`)));
  assert.equal(transport.maxInFlight, 2);
  assert.equal(transport.calls.length, 6);
});

test('queue overflow is rejected with QUEUE_FULL and does not disturb admitted work', async () => {
  const { engine, transport } = makeEngine(() => ok('x', { delayMs: 30 }), { concurrency: 1, maxQueueSize: 2 });
  const settled = await Promise.allSettled(['a', 'b', 'c', 'd'].map(p => engine.generate(p)));
  assert.deepEqual(settled.map(s => s.status), ['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
  assert.equal(settled[3].reason.kind, ErrorKind.QUEUE_FULL);
  assert.equal(transport.calls.length, 3);
  assert.equal(engine.stats().counters.queueRejected, 1);
});

test('sliding-window rate limit delays dispatch instead of sending', async () => {
  const { engine, transport } = makeEngine(() => ok(), { rateLimitMaxRequests: 2, rateLimitWindowMs: 150, concurrency: 5 });
  const t0 = Date.now();
  await Promise.all(['a', 'b', 'c'].map(p => engine.generate(p)));
  const third = transport.calls[2].startedAt - t0;
  assert.ok(third >= 130, `third request waited for the window (started at ${third} ms)`);
  assert.ok(engine.stats().counters.rateLimitDelays >= 1);
});

test('429 with RetryInfo is retried after the server delay, then succeeds', async () => {
  const body429 = JSON.parse(JSON.stringify(F.DOC_RATE_LIMIT_429));
  body429.error.details[1].retryDelay = '0.05s';
  const events = [];
  const { engine, transport } = makeEngine((req, i) => (i === 0 ? { status: 429, body: body429 } : ok('after wait')), {}, { onEvent: (e) => events.push(e) });
  const r = await engine.generate('rate limited');
  assert.equal(r.text, 'after wait');
  assert.equal(r.attempts, 2);
  const gap = transport.calls[1].startedAt - transport.calls[0].startedAt;
  assert.ok(gap >= 45, `waited the Retry-After delay (gap ${gap} ms)`);
  assert.equal(events[0].type, 'retry');
  assert.equal(events[0].kind, ErrorKind.RATE_LIMITED);
});

test('very long Retry-After returns control immediately with the estimated wait', async () => {
  const body429 = JSON.parse(JSON.stringify(F.DOC_RATE_LIMIT_429));
  body429.error.details[1].retryDelay = '3600s';
  const { engine, transport } = makeEngine(() => ({ status: 429, body: body429 }));
  const t0 = Date.now();
  await assert.rejects(engine.generate('x'), (e) => {
    assert.equal(e.kind, ErrorKind.RATE_LIMITED);
    assert.match(e.hint, /about 1 h/);
    assert.match(e.hint, /will not block/);
    return true;
  });
  assert.ok(Date.now() - t0 < 500, 'did not freeze');
  assert.equal(transport.calls.length, 1);
});

test('daily quota exhausted is not retried and pauses further requests', async () => {
  const { engine, transport } = makeEngine(() => ({ status: 429, body: F.DOC_DAILY_QUOTA_429 }));
  await assert.rejects(engine.generate('a'), (e) => e.kind === ErrorKind.QUOTA_EXHAUSTED);
  await assert.rejects(engine.generate('b'), (e) => e.kind === ErrorKind.CIRCUIT_OPEN && /QUOTA_EXHAUSTED/.test(e.message));
  assert.equal(transport.calls.length, 1, 'no repeated requests after quota exhaustion');
});

test('503 is retried with backoff until success', async () => {
  const { engine, transport } = makeEngine((req, i) => (i < 2 ? { status: 503, body: F.DOC_OVERLOADED_503 } : ok('recovered')));
  const r = await engine.generate('busy');
  assert.equal(r.text, 'recovered');
  assert.equal(r.attempts, 3);
  assert.equal(transport.calls.length, 3);
  assert.equal(engine.stats().counters.retries, 2);
});

test('persistent 503 gives up after the bounded number of retries', async () => {
  const { engine, transport } = makeEngine(() => ({ status: 503, body: F.DOC_OVERLOADED_503 }), { maxRetries: 3, circuitFailureThreshold: 100 });
  await assert.rejects(engine.generate('busy'), (e) => e.kind === ErrorKind.SERVER_UNAVAILABLE && /gave up after 4 attempts/.test(e.hint));
  assert.equal(transport.calls.length, 4);
});

test('permanent errors are never retried: 400 invalid request, 404 model not found', async () => {
  const a = makeEngine(() => ({ status: 400, body: F.CAPTURED_UNKNOWN_FIELD_400 }));
  await assert.rejects(a.engine.generate('x'), (e) => e.kind === ErrorKind.INVALID_REQUEST);
  assert.equal(a.transport.calls.length, 1);
  const b = makeEngine(() => ({ status: 404, body: F.DOC_MODEL_NOT_FOUND_404 }));
  await assert.rejects(b.engine.generate('x'), (e) => e.kind === ErrorKind.MODEL_NOT_FOUND && e.attempts === 1);
  assert.equal(b.transport.calls.length, 1);
});

test('authentication failure is not retried and latches: later requests fail fast', async () => {
  const { engine, transport } = makeEngine(() => ({ status: 400, body: F.CAPTURED_INVALID_KEY_400 }));
  await assert.rejects(engine.generate('a'), (e) => e.kind === ErrorKind.AUTH);
  await assert.rejects(engine.generate('b'), (e) => e.kind === ErrorKind.CIRCUIT_OPEN && /GEMINI_API_KEY/.test(e.hint));
  assert.equal(transport.calls.length, 1);
});

test('DNS failure is retried a bounded number of times then reported with a DNS hint', async () => {
  const { engine, transport } = makeEngine(() => { throw netError('ENOTFOUND', 'getaddrinfo ENOTFOUND generativelanguage.googleapis.com'); }, { maxRetries: 2, circuitFailureThreshold: 100 });
  await assert.rejects(engine.generate('x'), (e) => e.kind === ErrorKind.DNS && /could not be resolved/.test(e.hint));
  assert.equal(transport.calls.length, 3);
});

test('timeouts are classified and retried', async () => {
  const { engine, transport } = makeEngine((req, i) => { if (i === 0) throw netError('ETIMEDOUT'); return ok('late but fine'); });
  const r = await engine.generate('x');
  assert.equal(r.text, 'late but fine');
  assert.equal(transport.calls.length, 2);
});

test('circuit breaker opens after repeated transient failures and recovers via a probe', async () => {
  let healthy = false;
  const { engine, transport } = makeEngine(() => (healthy ? ok('back') : { status: 503, body: F.DOC_OVERLOADED_503 }),
    { maxRetries: 0, circuitFailureThreshold: 2, circuitCooldownMs: 80 });
  await assert.rejects(engine.generate('a'), (e) => e.kind === ErrorKind.SERVER_UNAVAILABLE);
  await assert.rejects(engine.generate('b'), (e) => e.kind === ErrorKind.SERVER_UNAVAILABLE);
  await assert.rejects(engine.generate('c'), (e) => e.kind === ErrorKind.CIRCUIT_OPEN);
  assert.equal(transport.calls.length, 2, 'open circuit sends nothing');
  healthy = true;
  await sleep(100);
  const r = await engine.generate('d');
  assert.equal(r.text, 'back');
  assert.equal(engine.stats().circuit.state, 'CLOSED');
});

test('worker slot is released during retry backoff (other work proceeds)', async () => {
  const body503 = F.DOC_OVERLOADED_503;
  const { engine, transport } = makeEngine((req) => {
    const p = promptOf(req);
    if (p === 'A' && transport.calls.filter(c => promptOf(c) === 'A').length === 1) return { status: 503, body: body503, headers: { 'retry-after': '0.15' } };
    return ok(p);
  }, { concurrency: 1 });
  const a = engine.generate('A');
  await sleep(10); // A has failed once and is sleeping in backoff
  const b = engine.generate('B');
  await Promise.all([a, b]);
  const order = transport.calls.map(promptOf);
  assert.deepEqual(order, ['A', 'B', 'A'], 'B ran while A was backing off');
});

test('failed requests do not corrupt queue state', async () => {
  const { engine } = makeEngine((req) => (promptOf(req).startsWith('bad') ? { status: 400, body: F.CAPTURED_UNKNOWN_FIELD_400 } : ok('fine')), { concurrency: 1 });
  const settled = await Promise.allSettled(['bad1', 'good1', 'bad2', 'good2'].map(p => engine.generate(p)));
  assert.deepEqual(settled.map(s => s.status), ['rejected', 'fulfilled', 'rejected', 'fulfilled']);
  const s = engine.stats();
  assert.equal(s.active, 0);
  assert.equal(s.queued, 0);
  assert.equal(s.waitingRetry, 0);
  assert.equal(s.counters.successes, 2);
  assert.equal(s.counters.failures, 2);
});

test('truncated (MAX_TOKENS) output is returned flagged and is not cached', async () => {
  const { engine, transport } = makeEngine(() => ({ body: F.docSuccess('<html>', { finishReason: 'MAX_TOKENS' }) }));
  const r = await engine.generate('big file');
  assert.equal(r.truncated, true);
  await engine.generate('big file');
  assert.equal(transport.calls.length, 2);
});

test('CONTINUATION responses are followed with the token and an increased output budget', async () => {
  const { engine, transport } = makeEngine((req, i) => {
    if (i === 0) {
      const b = F.docSuccess('part one, ', { finishReason: 'CONTINUATION' });
      b.candidates[0].continuationToken = 'tok-1';
      return { body: b };
    }
    return ok('part two');
  });
  const r = await engine.generate('long', { maxOutputTokens: 1000 });
  assert.equal(r.text, 'part one, part two');
  assert.equal(transport.calls[1].body.continuationToken, 'tok-1');
  assert.deepEqual(transport.calls[1].body.contents, transport.calls[0].body.contents, 'contents replicated identically');
  assert.equal(transport.calls[1].body.generationConfig.maxOutputTokens, 2000);
  assert.equal(engine.stats().counters.continuations, 1);
});

test('telemetry never contains prompts, responses or the API key', async () => {
  const secretPrompt = 'TOP-SECRET-PROMPT-CONTENT-123';
  const { engine } = makeEngine((req, i) => (i === 0 ? { status: 503, body: F.DOC_OVERLOADED_503 } : ok('SECRET-RESPONSE-456')));
  await engine.generate(secretPrompt);
  const dump = JSON.stringify(engine.stats());
  assert.doesNotMatch(dump, /TOP-SECRET-PROMPT/);
  assert.doesNotMatch(dump, /SECRET-RESPONSE/);
  assert.doesNotMatch(dump, /test-key-abcdef/);
  assert.equal(engine.stats().counters.outboundRequests, 2);
});

test('shutdown cancels queued and in-flight work', async () => {
  const { engine } = makeEngine(() => ok('x', { delayMs: 200 }), { concurrency: 1 });
  const p1 = engine.generate('one');
  const p2 = engine.generate('two');
  await sleep(10);
  engine.shutdown();
  const settled = await Promise.allSettled([p1, p2]);
  assert.ok(settled.every(s => s.status === 'rejected' && s.reason.kind === ErrorKind.CANCELLED));
});

test('AbortSignal cancels a queued request', async () => {
  const { engine, transport } = makeEngine(() => ok('x', { delayMs: 50 }), { concurrency: 1 });
  const controller = new AbortController();
  const p1 = engine.generate('first');
  const p2 = engine.generate('second', { signal: controller.signal });
  const p2Rejected = assert.rejects(p2, (e) => e.kind === ErrorKind.CANCELLED);
  controller.abort();
  await p1;
  await p2Rejected;
  assert.equal(transport.calls.length, 1);
});
