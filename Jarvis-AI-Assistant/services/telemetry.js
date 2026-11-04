// In-memory, process-local telemetry. Stores ONLY counters, error kinds and durations —
// never prompts, responses, model output or credentials.

const MAX_SAMPLES = 500;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

class Telemetry {
  constructor() {
    this.reset();
  }

  reset() {
    this.counters = {
      requests: 0,          // logical generate() calls
      cacheHits: 0,
      coalesced: 0,         // calls that joined an identical in-flight request
      outboundRequests: 0,  // HTTP attempts actually sent
      continuations: 0,
      successes: 0,
      failures: 0,
      retries: 0,
      rateLimitDelays: 0,   // times dispatch was delayed by the local limiter
      queueRejected: 0,
      circuitRejected: 0,
      cancelled: 0
    };
    this.errorsByKind = {};
    this.latencies = [];
    this.maxQueueDepth = 0;
    this.startedAt = Date.now();
  }

  increment(name, by = 1) {
    if (!(name in this.counters)) this.counters[name] = 0;
    this.counters[name] += by;
  }

  recordError(kind) {
    const key = String(kind || 'UNKNOWN').replace(/[^A-Z_]/gi, '').slice(0, 40) || 'UNKNOWN';
    this.errorsByKind[key] = (this.errorsByKind[key] || 0) + 1;
  }

  recordLatency(ms) {
    if (!Number.isFinite(ms)) return;
    this.latencies.push(ms);
    if (this.latencies.length > MAX_SAMPLES) this.latencies.shift();
  }

  recordQueueDepth(depth) {
    if (depth > this.maxQueueDepth) this.maxQueueDepth = depth;
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      counters: { ...this.counters },
      errorsByKind: { ...this.errorsByKind },
      latencyMs: {
        samples: sorted.length,
        min: sorted.length ? sorted[0] : null,
        mean: sorted.length ? Math.round(sum / sorted.length) : null,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted.length ? sorted[sorted.length - 1] : null
      },
      maxQueueDepth: this.maxQueueDepth,
      uptimeMs: Date.now() - this.startedAt
    };
  }
}

module.exports = { Telemetry };
