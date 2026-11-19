// Gemini reliability engine: cache → coalescing → bounded FIFO queue → rate limiter →
// circuit breaker → HTTP attempt → classified retry. All state is process-local.
const crypto = require('crypto');
const config = require('../config/config');
const { createGeminiClient, buildGenerateContentBody } = require('./geminiClient');
const { ErrorKind, GeminiError, LATCHING, TRIPPING, classifyNetworkError } = require('./geminiErrors');
const { LRUCache } = require('../utils/lruCache');
const { SlidingWindowRateLimiter } = require('../utils/slidingWindowRateLimiter');
const { BoundedQueue } = require('../utils/boundedQueue');
const { CircuitBreaker } = require('../utils/circuitBreaker');
const { computeRetryDelay, formatDuration } = require('../utils/retry');
const { Telemetry } = require('./telemetry');

function cacheKey(request) {
  return crypto.createHash('sha256')
    .update(JSON.stringify([request.model, request.systemInstruction || '', request.prompt, request.generationConfig || {}]))
    .digest('hex');
}

class GeminiEngine {
  /**
   * @param {object} options
   * @param {object} [options.transport]  injectable HTTP transport ({ request() }) — used by tests/benchmarks
   * @param {object} [options.client]     injectable high-level client ({ generateContent, listModels })
   * @param {object} [options.settings]   overrides for config.GEMINI
   * @param {Function} [options.onEvent]  receives { type: 'retry' | 'rate-limit-wait', ... } notices
   */
  constructor(options = {}) {
    const settings = { ...config.GEMINI, ...(options.settings || {}) };
    this.settings = settings;
    this.apiKey = options.apiKey !== undefined ? options.apiKey : config.geminiApiKey;
    this.model = options.model || config.geminiModel;
    this.now = options.now || (() => Date.now());
    this.setTimer = options.setTimeout || setTimeout;
    this.clearTimer = options.clearTimeout || clearTimeout;
    this.random = options.random || Math.random;
    this.client = options.client || createGeminiClient({
      apiKey: this.apiKey, baseUrl: settings.baseUrl, apiVersion: settings.apiVersion, transport: options.transport
    });
    this.cache = new LRUCache({ maxEntries: settings.cacheMaxEntries, ttlMs: settings.cacheTtlMs, now: this.now });
    this.limiter = new SlidingWindowRateLimiter({ maxRequests: settings.rateLimitMaxRequests, windowMs: settings.rateLimitWindowMs, now: this.now });
    this.queue = new BoundedQueue(settings.maxQueueSize);
    this.breaker = new CircuitBreaker({ failureThreshold: settings.circuitFailureThreshold, cooldownMs: settings.circuitCooldownMs, now: this.now });
    this.telemetry = options.telemetry || new Telemetry();
    this.onEvent = options.onEvent || null;
    this.inflight = new Map();
    this.inflightJobs = new Set();
    this.waitingRetry = new Set();
    this.active = 0;
    this.pumpTimer = null;
    this.pumpAt = 0;
    this.closed = false;
  }

  emit(event) {
    if (typeof this.onEvent === 'function') {
      try { this.onEvent(event); } catch (_) { /* never let a listener break the engine */ }
    }
  }

  buildGenerationConfig(opts) {
    const gc = {};
    // Temperature is left at the model default unless a caller asks otherwise
    // (current Gemini models recommend their defaults).
    if (typeof opts.temperature === 'number') gc.temperature = opts.temperature;
    gc.maxOutputTokens = opts.maxOutputTokens || this.settings.maxOutputTokens;
    if (opts.responseMimeType) gc.responseMimeType = opts.responseMimeType;
    if (opts.thinkingConfig) gc.thinkingConfig = opts.thinkingConfig;
    return gc;
  }

  /**
   * Generate text. Resolves to { text, finishReason, truncated, usage, model, attempts, cached, coalesced }.
   * Rejects with GeminiError (always classified).
   */
  async generate(prompt, opts = {}) {
    this.telemetry.increment('requests');
    if (this.closed) throw new GeminiError(ErrorKind.CANCELLED, 'Jarvis is shutting down', { retryable: false });
    if (!this.apiKey) {
      throw new GeminiError(ErrorKind.CONFIG, 'GEMINI_API_KEY is not set, so no request was sent', { retryable: false });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new GeminiError(ErrorKind.INVALID_REQUEST, 'Prompt is empty', { retryable: false });
    }
    const request = {
      model: opts.model || this.model,
      prompt,
      systemInstruction: opts.systemInstruction || null,
      generationConfig: this.buildGenerationConfig(opts)
    };
    const key = cacheKey(request);

    if (!opts.noCache) {
      const hit = this.cache.get(key);
      if (hit) {
        this.telemetry.increment('cacheHits');
        return { ...hit, cached: true, coalesced: false };
      }
    }

    const existing = this.inflight.get(key);
    if (existing) {
      this.telemetry.increment('coalesced');
      const shared = await existing;
      return { ...shared, cached: false, coalesced: true };
    }

    const promise = this.submit(request, opts).then((result) => {
      if (!opts.noCache && !result.truncated && result.text) this.cache.set(key, result);
      return result;
    });
    this.inflight.set(key, promise);
    // Cleared only when the request settles — identical requests share it for its whole lifetime.
    const cleanup = () => { if (this.inflight.get(key) === promise) this.inflight.delete(key); };
    promise.then(cleanup, cleanup);
    const result = await promise;
    return { ...result, cached: false, coalesced: false };
  }

  /** Back-compatible helper: resolves to the text only. */
  async callGeminiAPI(prompt, opts = {}) {
    const result = await this.generate(prompt, opts);
    return result.text;
  }

  circuitError() {
    const { retryInMs } = this.breaker.peek();
    const last = this.breaker.lastError;
    const cause = last ? `${last.kind}: ${last.message}` : 'repeated failures';
    const hint = `${last && last.hint ? last.hint + ' ' : ''}Requests resume automatically in ${formatDuration(retryInMs)} (restart Jarvis after fixing configuration).`;
    return new GeminiError(ErrorKind.CIRCUIT_OPEN, `Requests paused after ${cause}`, {
      retryable: false, retryAfterMs: retryInMs, hint,
      httpStatus: last ? last.httpStatus : null, apiStatus: last ? last.apiStatus : null
    });
  }

  submit(request, opts) {
    return new Promise((resolve, reject) => {
      if (this.breaker.peek().open) {
        this.telemetry.increment('circuitRejected');
        reject(this.circuitError());
        return;
      }
      const pending = this.queue.length + this.waitingRetry.size;
      if (pending >= this.settings.maxQueueSize) {
        this.telemetry.increment('queueRejected');
        reject(new GeminiError(ErrorKind.QUEUE_FULL, `Request queue is full (${this.settings.maxQueueSize} pending)`, { retryable: false }));
        return;
      }
      const job = { request, opts, resolve, reject, attempt: 0, controller: null, retryTimer: null, cancelled: false };
      if (opts.signal) {
        if (opts.signal.aborted) {
          reject(new GeminiError(ErrorKind.CANCELLED, 'Request cancelled', { retryable: false }));
          return;
        }
        opts.signal.addEventListener('abort', () => this.cancelJob(job, 'Request cancelled'), { once: true });
      }
      this.queue.enqueue(job);
      this.telemetry.recordQueueDepth(this.queue.length);
      this.pump();
    });
  }

  cancelJob(job, message) {
    if (job.cancelled) return;
    job.cancelled = true;
    this.telemetry.increment('cancelled');
    this.queue.remove(job);
    if (job.retryTimer) {
      this.clearTimer(job.retryTimer);
      job.retryTimer = null;
    }
    this.waitingRetry.delete(job);
    if (job.controller) job.controller.abort();
    job.reject(new GeminiError(ErrorKind.CANCELLED, message, { retryable: false }));
  }

  schedulePump(ms) {
    const at = this.now() + ms;
    if (this.pumpTimer && this.pumpAt <= at) return;
    if (this.pumpTimer) this.clearTimer(this.pumpTimer);
    this.pumpAt = at;
    this.pumpTimer = this.setTimer(() => {
      this.pumpTimer = null;
      this.pump();
    }, ms);
  }

  pump() {
    if (this.closed) return;
    while (this.active < this.settings.concurrency && this.queue.length > 0) {
      const wait = this.limiter.timeUntilAvailable();
      if (wait > 0) {
        this.telemetry.increment('rateLimitDelays');
        this.emit({ type: 'rate-limit-wait', delayMs: wait, queued: this.queue.length });
        this.schedulePump(wait);
        return;
      }
      if (this.breaker.peek().open) {
        // Fail fast: return control to the user instead of holding work for the cooldown.
        for (const job of this.queue.drain()) {
          this.telemetry.increment('circuitRejected');
          job.reject(this.circuitError());
        }
        return;
      }
      const gate = this.breaker.check();
      if (!gate.allowed) return; // half-open probe in flight; pump() runs again when it settles
      const job = this.queue.dequeue();
      this.limiter.tryAcquire();
      this.active++;
      this.runAttempt(job);
    }
  }

  async executeWithContinuations(job) {
    const { model, prompt, systemInstruction, generationConfig } = job.request;
    const timeoutMs = job.opts.timeoutMs || this.settings.requestTimeoutMs;
    const signal = job.controller.signal;
    this.telemetry.increment('outboundRequests');
    let res = await this.client.generateContent({
      model, body: buildGenerateContentBody({ prompt, systemInstruction, generationConfig }), timeoutMs, signal
    });
    let text = res.text || '';
    let hops = 0;
    while (res.finishReason === 'CONTINUATION' && res.continuationToken && hops < this.settings.maxContinuations) {
      hops++;
      // maxOutputTokens is cumulative across continuation hops and must increase.
      const gc = { ...generationConfig };
      if (gc.maxOutputTokens) gc.maxOutputTokens = generationConfig.maxOutputTokens * (hops + 1);
      this.limiter.record();
      this.telemetry.increment('outboundRequests');
      this.telemetry.increment('continuations');
      res = await this.client.generateContent({
        model,
        body: buildGenerateContentBody({ prompt, systemInstruction, generationConfig: gc, continuationToken: res.continuationToken }),
        timeoutMs,
        signal
      });
      text += res.text || '';
    }
    if (!text) {
      throw new GeminiError(ErrorKind.EMPTY_RESPONSE, `Response contained no text (finishReason ${res.finishReason || 'none'})`, { model, retryable: false });
    }
    return {
      text,
      finishReason: res.finishReason,
      truncated: res.finishReason === 'MAX_TOKENS' || res.finishReason === 'CONTINUATION',
      usage: res.usage || null,
      modelVersion: res.modelVersion || null,
      modelStatus: res.modelStatus || null,
      model
    };
  }

  retryDecision(job, error) {
    if (!error.retryable) return { retry: false };
    if (job.attempt > this.settings.maxRetries) return { retry: false, reason: 'max-retries' };
    const delayMs = computeRetryDelay(job.attempt - 1, error.retryAfterMs, {
      baseMs: this.settings.baseBackoffMs, maxMs: this.settings.maxBackoffMs, random: this.random
    });
    if (delayMs > this.settings.maxRetryWaitMs) return { retry: false, reason: 'wait-too-long', delayMs };
    return { retry: true, delayMs };
  }

  async runAttempt(job) {
    const started = this.now();
    job.attempt++;
    job.controller = new AbortController();
    this.inflightJobs.add(job);
    let result = null;
    let error = null;
    try {
      result = await this.executeWithContinuations(job);
    } catch (e) {
      error = e instanceof GeminiError ? e : classifyNetworkError(e, { model: job.request.model });
    }
    this.inflightJobs.delete(job);
    job.controller = null;
    this.active--;
    this.telemetry.recordLatency(this.now() - started);

    if (job.cancelled) { this.pump(); return; }

    if (!error) {
      this.breaker.onSuccess();
      this.telemetry.increment('successes');
      job.resolve({ ...result, attempts: job.attempt });
      this.pump();
      return;
    }

    this.telemetry.recordError(error.kind);
    if (LATCHING.has(error.kind)) {
      const latch = error.kind === ErrorKind.QUOTA_EXHAUSTED && error.retryAfterMs
        ? Math.max(error.retryAfterMs, this.settings.circuitCooldownMs)
        : this.settings.circuitLatchMs;
      this.breaker.trip(latch, error);
    } else if (TRIPPING.has(error.kind)) {
      this.breaker.onFailure(error);
    } else {
      this.breaker.onNeutral();
    }

    const decision = this.retryDecision(job, error);
    if (decision.retry && !this.breaker.peek().open && !this.closed) {
      this.telemetry.increment('retries');
      if (error.kind === ErrorKind.RATE_LIMITED && error.retryAfterMs !== null) {
        this.limiter.pauseFor(decision.delayMs); // everyone waits, not just this request
      }
      this.emit({
        type: 'retry', kind: error.kind, httpStatus: error.httpStatus, message: error.message,
        attempt: job.attempt, maxRetries: this.settings.maxRetries, delayMs: decision.delayMs
      });
      // The worker slot is already released; the job sleeps outside the pool.
      this.waitingRetry.add(job);
      job.retryTimer = this.setTimer(() => {
        job.retryTimer = null;
        this.waitingRetry.delete(job);
        if (job.cancelled || this.closed) return;
        this.queue.requeueFront(job);
        this.pump();
      }, decision.delayMs);
    } else {
      this.telemetry.increment('failures');
      error.attempts = job.attempt;
      if (decision.reason === 'wait-too-long') {
        error.hint = `${error.hint ? error.hint + ' ' : ''}Gemini asked to wait about ${formatDuration(decision.delayMs)}; Jarvis will not block that long — try again later.`;
      } else if (decision.reason === 'max-retries') {
        error.hint = `${error.hint ? error.hint + ' ' : ''}(gave up after ${job.attempt} attempts)`;
      } else if (decision.retry && this.breaker.peek().open) {
        error.hint = `${error.hint ? error.hint + ' ' : ''}Further requests are paused for ${formatDuration(this.breaker.peek().retryInMs)} to avoid wasting quota.`;
      }
      job.reject(error);
    }
    this.pump();
  }

  /** List models visible to this key (follows pagination). */
  async listModels() {
    if (!this.apiKey) throw new GeminiError(ErrorKind.CONFIG, 'GEMINI_API_KEY is not set, so no request was sent', { retryable: false });
    const models = [];
    let pageToken;
    let pages = 0;
    do {
      const page = await this.client.listModels({ pageToken });
      models.push(...(page.models || []));
      pageToken = page.nextPageToken;
      pages++;
    } while (pageToken && pages < 20);
    return models;
  }

  resetCircuit() {
    this.breaker.reset();
    this.limiter.pausedUntil = 0;
  }

  clearCache() {
    this.cache.clear();
  }

  stats() {
    return {
      model: this.model,
      ...this.telemetry.snapshot(),
      cacheEntries: this.cache.size,
      queued: this.queue.length,
      active: this.active,
      waitingRetry: this.waitingRetry.size,
      rateWindowUsed: this.limiter.inWindow(),
      rateWindowMax: this.limiter.maxRequests,
      circuit: this.breaker.snapshot()
    };
  }

  /** Reject queued work, stop retry timers and abort in-flight requests. */
  shutdown() {
    this.closed = true;
    if (this.pumpTimer) { this.clearTimer(this.pumpTimer); this.pumpTimer = null; }
    for (const job of this.queue.drain()) this.cancelJob(job, 'Jarvis is shutting down');
    for (const job of [...this.waitingRetry]) this.cancelJob(job, 'Jarvis is shutting down');
    for (const job of [...this.inflightJobs]) this.cancelJob(job, 'Jarvis is shutting down');
  }
}

let defaultEngine = null;

function getDefaultEngine() {
  if (!defaultEngine) defaultEngine = new GeminiEngine();
  return defaultEngine;
}

function setDefaultEngine(engine) {
  defaultEngine = engine;
}

async function callGeminiAPI(prompt, opts = {}) {
  return getDefaultEngine().callGeminiAPI(prompt, opts);
}

async function generate(prompt, opts = {}) {
  return getDefaultEngine().generate(prompt, opts);
}

module.exports = {
  GeminiEngine,
  getDefaultEngine,
  setDefaultEngine,
  callGeminiAPI,
  generate,
  cacheKey
};
