#!/usr/bin/env node
// Reliability-engine benchmark with a MOCKED HTTP transport (no network, no Gemini).
// Measures how many outbound HTTP requests the engine sends for controlled workloads.
// These numbers describe the caching/coalescing logic only — they are not real-world savings.
const { GeminiEngine } = require('../services/geminiService');
const { createMockTransport } = require('../test/helpers/mockTransport');
const F = require('../test/fixtures/geminiResponses');
const { stats, writeResult, prng } = require('./lib/benchUtil');

function makeEngine({ latencyMs = 50, fail = () => false, settings = {} } = {}) {
  const transport = createMockTransport((req, i) => {
    if (fail(req, i)) return { status: 503, body: F.DOC_OVERLOADED_503, delayMs: latencyMs };
    return { body: F.docSuccess('ok'), delayMs: latencyMs };
  });
  const engine = new GeminiEngine({
    apiKey: 'benchmark-key', model: 'bench-model', transport,
    settings: { rateLimitMaxRequests: 1e9, concurrency: 4, maxQueueSize: 10000, baseBackoffMs: 1, maxBackoffMs: 5, circuitFailureThreshold: 1e9, ...settings }
  });
  return { engine, transport };
}

const row = (name, calls, outbound, extra = {}) => ({
  scenario: name, logicalCalls: calls, outboundRequests: outbound,
  reductionVsOneRequestPerCall: `${Math.round((1 - outbound / calls) * 1000) / 10}%`, ...extra
});

(async () => {
  const results = [];

  { // 1. concurrent identical prompts → coalescing
    const { engine, transport } = makeEngine();
    await Promise.all(Array.from({ length: 20 }, () => engine.generate('identical prompt')));
    results.push(row('20 concurrent identical prompts (coalescing)', 20, transport.calls.length, { coalesced: engine.stats().counters.coalesced }));
  }
  { // 2. sequential identical prompts → cache
    const { engine, transport } = makeEngine();
    for (let i = 0; i < 20; i++) await engine.generate('identical prompt');
    results.push(row('20 sequential identical prompts (cache)', 20, transport.calls.length, { cacheHits: engine.stats().counters.cacheHits }));
  }
  { // 3. control: all distinct
    const { engine, transport } = makeEngine();
    await Promise.all(Array.from({ length: 20 }, (_, i) => engine.generate(`distinct prompt ${i}`)));
    results.push(row('20 distinct prompts (control — nothing to reuse)', 20, transport.calls.length));
  }
  { // 4. mixed, reproducible workload: 200 calls over 25 prompts (skewed), waves of 10 concurrent
    const rand = prng(42);
    const { engine, transport } = makeEngine({ latencyMs: 20 });
    const pick = () => Math.min(24, Math.floor(Math.pow(rand(), 2) * 25));
    for (let wave = 0; wave < 20; wave++) {
      await Promise.all(Array.from({ length: 10 }, () => engine.generate(`prompt #${pick()}`)));
    }
    const s = engine.stats().counters;
    results.push(row('200 calls over 25 prompts, skewed, 10 concurrent per wave (seed 42)', 200, transport.calls.length, { cacheHits: s.cacheHits, coalesced: s.coalesced }));
  }
  { // 5. transient failures: every first attempt fails with 503
    const seen = new Set();
    const { engine, transport } = makeEngine({ latencyMs: 5, fail: (req) => { const p = req.body.contents[0].parts[0].text; if (seen.has(p)) return false; seen.add(p); return true; } });
    const settled = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => engine.generate(`flaky ${i}`)));
    results.push(row('20 distinct prompts, first attempt of each returns 503', 20, transport.calls.length, {
      succeeded: settled.filter(s => s.status === 'fulfilled').length, retries: engine.stats().counters.retries,
      note: 'retries ADD requests; bounded retry trades requests for success'
    }));
  }

  // Engine overhead per call (0 ms transport latency, distinct prompts so nothing is cached)
  const { engine } = makeEngine({ latencyMs: 0 });
  const overhead = [];
  for (let i = 0; i < 2000; i++) {
    const t = process.hrtime.bigint();
    await engine.generate(`overhead ${i}`);
    overhead.push(Number(process.hrtime.bigint() - t) / 1e6);
  }

  const output = {
    benchmark: 'reliability-engine',
    transport: 'MOCKED (in-memory, fixed latency) — no network, no Gemini',
    results,
    engineOverheadMsPerCall: stats(overhead.slice(200)) // first 200 discarded as warm-up
  };
  console.table(results.map(r => ({ scenario: r.scenario, calls: r.logicalCalls, outbound: r.outboundRequests, reduction: r.reductionVsOneRequestPerCall })));
  console.log('Engine overhead per call (ms, mocked 0 ms transport):', output.engineOverheadMsPerCall);
  console.log('Saved:', writeResult('reliability', output));
})();
