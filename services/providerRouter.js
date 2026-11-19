// Smart provider routing: Claude first, Gemini as the fallback.
//
// The router exposes the same surface as GeminiEngine (generate, callGeminiAPI, listModels, stats,
// resetCircuit, clearCache, shutdown, onEvent, model, apiKey) so the planner, generator, self-corrector
// and controller work unchanged. It owns one GeminiEngine per provider, so each provider keeps its own
// cache, queue, rate limiter, circuit breaker and telemetry; the router only adds provider health,
// fallback and usage/cost accounting on top.
//
// A fallback re-sends ONE text-generation request to the next provider. generate() has no side
// effects (files are written by FileGenerator only after a result is returned), so a fallback can
// never duplicate a write, and every failed provider attempt is accounted exactly once.
const config = require('../config/config');
const { GeminiEngine } = require('./geminiService');
const { ErrorKind, GeminiError, classifyNetworkError } = require('./geminiErrors');
const { UsageTracker } = require('./usageTracker');
const { formatDuration } = require('../utils/retry');

const PROVIDERS = ['claude', 'gemini'];
const NAMES = { claude: 'Claude', gemini: 'Gemini' };

// Failures that are about the provider/account/availability, not about this particular request.
const SWITCHABLE = new Set([
  ErrorKind.AUTH, ErrorKind.PERMISSION, ErrorKind.BILLING_REQUIRED, ErrorKind.QUOTA_EXHAUSTED,
  ErrorKind.MODEL_NOT_FOUND, ErrorKind.PRECONDITION, ErrorKind.CONFIG,
  ErrorKind.RATE_LIMITED, ErrorKind.SERVER_UNAVAILABLE, ErrorKind.TIMEOUT,
  ErrorKind.NETWORK, ErrorKind.DNS, ErrorKind.CIRCUIT_OPEN
]);
// Persistent problems: pause the provider for the long cooldown.
const LONG_COOLDOWN = new Set([
  ErrorKind.AUTH, ErrorKind.PERMISSION, ErrorKind.BILLING_REQUIRED, ErrorKind.QUOTA_EXHAUSTED,
  ErrorKind.MODEL_NOT_FOUND, ErrorKind.PRECONDITION, ErrorKind.CONFIG
]);

function providerOfModel(model) {
  return /^(?:models\/)?claude/i.test(String(model || '')) ? 'claude' : 'gemini';
}

class ProviderRouter {
  /**
   * @param {object} [options]
   * @param {string} [options.mode]      'auto' | 'claude' | 'gemini' (default config.provider)
   * @param {object} [options.engines]   injectable { claude, gemini } engines (tests)
   * @param {object} [options.settings]  overrides for config.ROUTER
   * @param {object} [options.usage]     injectable UsageTracker
   * @param {Function} [options.now]
   * @param {Function} [options.onEvent]
   */
  constructor(options = {}) {
    this.mode = options.mode || config.provider || 'auto';
    this.settings = { ...config.ROUTER, ...(options.settings || {}) };
    this.now = options.now || (() => Date.now());
    this.usage = options.usage || new UsageTracker({ limits: this.settings.spendLimitUsd, override: this.settings.priceOverride });
    this.onEvent = options.onEvent || null;
    this.fallbacks = 0;
    this.health = {};
    for (const p of PROVIDERS) this.health[p] = { down: false, until: 0, kind: null, reason: null, since: null };
    this.engines = options.engines || this.buildEngines();
    for (const [p, engine] of Object.entries(this.engines)) {
      if (engine && 'onEvent' in engine) engine.onEvent = (e) => this.emit({ ...e, provider: p });
    }
  }

  buildEngines() {
    const wanted = this.mode === 'auto' ? PROVIDERS : [this.mode];
    const engines = {};
    const configured = wanted.filter(p => config.isProviderConfigured(p));
    const withFallback = this.mode === 'auto' && this.settings.fallbackEnabled && configured.length > 1;
    for (const p of configured) {
      const settings = {};
      if (withFallback && p === 'claude') {
        // Fail over quickly instead of retrying Claude for a long time.
        settings.maxRetries = this.settings.retriesWithFallback;
        settings.maxRetryWaitMs = this.settings.maxRetryWaitWithFallbackMs;
      }
      engines[p] = new GeminiEngine({ provider: p, settings });
    }
    return engines;
  }

  emit(event) {
    if (typeof this.onEvent === 'function') {
      try { this.onEvent(event); } catch (_) { /* a listener must never break routing */ }
    }
  }

  // ------------------------------------------------------------ introspection (engine-compatible)
  /** Providers to try, in priority order. */
  candidates() {
    const present = PROVIDERS.filter(p => this.engines[p]);
    if (this.mode !== 'auto') return present.filter(p => p === this.mode);
    return this.settings.fallbackEnabled ? present : present.slice(0, 1);
  }

  get provider() { return this.mode; }

  get primary() { return this.candidates()[0] || null; }

  get providerName() {
    const c = this.candidates();
    return c.length ? c.map(p => NAMES[p]).join(' → ') : 'AI';
  }

  get model() { return this.primary ? this.engines[this.primary].model : ''; }

  get apiKey() { return this.primary ? this.engines[this.primary].apiKey : ''; }

  /** Engines for diagnostics / model listing: [{ provider, name, engine }]. */
  providerEngines() {
    return PROVIDERS.filter(p => this.engines[p]).map(p => ({ provider: p, name: NAMES[p], engine: this.engines[p] }));
  }

  // ------------------------------------------------------------ health
  availability(provider) {
    if (this.usage.limitReached(provider)) {
      const limit = this.usage.limits[provider];
      return { ok: false, kind: 'SPEND_LIMIT', reason: `estimated spend limit reached ($${this.usage.spent(provider).toFixed(4)} of $${limit})`, retryInMs: null };
    }
    const h = this.health[provider];
    if (!h.down) return { ok: true, probe: false };
    const left = h.until - this.now();
    if (left > 0) return { ok: false, kind: h.kind, reason: h.reason, retryInMs: left };
    return { ok: true, probe: true }; // cooldown over: let one real request test recovery
  }

  markFailure(provider, error) {
    const s = this.settings;
    let cooldown;
    if (LONG_COOLDOWN.has(error.kind)) {
      cooldown = s.cooldownMs;
    } else if (error.kind === ErrorKind.RATE_LIMITED || error.kind === ErrorKind.CIRCUIT_OPEN) {
      cooldown = Math.min(s.cooldownMs, Math.max(s.transientCooldownMs, error.retryAfterMs || 0));
    } else {
      cooldown = s.transientCooldownMs;
    }
    const h = this.health[provider];
    const wasDown = h.down;
    h.down = true;
    h.until = this.now() + cooldown;
    h.kind = error.kind;
    h.reason = `${error.kind}: ${error.message}`;
    if (!wasDown) h.since = this.now();
    this.emit({ type: 'provider-unavailable', provider, kind: error.kind, message: error.message, cooldownMs: cooldown });
  }

  markHealthy(provider) {
    const h = this.health[provider];
    if (!h.down) return;
    const downMs = this.now() - h.since;
    h.down = false; h.until = 0; h.kind = null; h.reason = null; h.since = null;
    this.emit({ type: 'provider-recovered', provider, downMs });
  }

  /** Is this failure about the provider (switch) rather than the request (surface it)? */
  shouldSwitch(error) {
    return SWITCHABLE.has(error.kind);
  }

  // ------------------------------------------------------------ generation
  optsFor(provider, opts) {
    const o = { ...opts };
    if (o.model && providerOfModel(o.model) !== provider) delete o.model;
    return o;
  }

  async generate(prompt, opts = {}) {
    const order = this.candidates();
    if (!order.length) {
      throw new GeminiError(ErrorKind.CONFIG,
        'No AI provider is configured: set ANTHROPIC_API_KEY and/or GEMINI_API_KEY in .env',
        { retryable: false, provider: 'Jarvis' });
    }
    const multi = order.length > 1;
    const failures = [];

    for (let i = 0; i < order.length; i++) {
      const provider = order[i];
      const engine = this.engines[provider];
      const avail = this.availability(provider);
      if (!avail.ok && (multi || avail.kind === 'SPEND_LIMIT')) {
        failures.push({ provider, skipped: true, kind: avail.kind, reason: avail.reason, retryInMs: avail.retryInMs });
        continue;
      }
      if (avail.probe) {
        engine.resetCircuit(); // the engine's own breaker may still be latched from the earlier failure
        this.emit({ type: 'provider-probe', provider });
      }

      let res;
      try {
        res = await engine.generate(prompt, this.optsFor(provider, opts));
      } catch (e) {
        const error = e instanceof GeminiError ? e : classifyNetworkError(e, { model: engine.model });
        if (error.kind === ErrorKind.CANCELLED || !this.shouldSwitch(error)) throw error;
        if (multi) this.markFailure(provider, error);
        failures.push({ provider, error });
        const next = order.slice(i + 1).find(p => this.availability(p).ok);
        if (next) {
          this.fallbacks++;
          this.emit({ type: 'provider-fallback', from: provider, to: next, kind: error.kind, message: error.message });
        }
        continue;
      }

      if (multi) this.markHealthy(provider);
      let usage = null;
      if (!res.cached && !res.coalesced) usage = this.usage.record(provider, res.model || engine.model, res.usage);
      const fellBackFrom = failures.filter(f => !f.skipped).map(f => f.provider);
      const skipped = failures.filter(f => f.skipped).map(f => f.provider);
      const result = { ...res, provider, providerName: NAMES[provider], fellBackFrom: fellBackFrom.concat(skipped) };
      this.emit({
        type: 'provider-used', provider, providerName: NAMES[provider], model: res.model || engine.model,
        cached: Boolean(res.cached), coalesced: Boolean(res.coalesced), fellBackFrom: result.fellBackFrom,
        usage, estimatedCostUsd: usage ? usage.costUsd : null
      });
      return result;
    }

    throw this.unavailableError(order, failures);
  }

  unavailableError(order, failures) {
    // One configured provider and it really failed: surface its own, more specific error.
    const real = failures.filter(f => f.error);
    if (order.length === 1 && real.length === 1) return real[0].error;
    const parts = failures.map((f) => {
      const name = NAMES[f.provider];
      if (f.skipped) {
        const when = f.retryInMs ? `, retry in ${formatDuration(f.retryInMs)}` : '';
        return `${name} paused (${f.reason}${when})`;
      }
      return `${name} failed (${f.error.kind}: ${f.error.message})`;
    });
    const retryIns = failures.map(f => (f.skipped ? f.retryInMs : this.health[f.provider].until - this.now())).filter(n => n > 0);
    const retryAfterMs = retryIns.length ? Math.min(...retryIns) : null;
    const err = new GeminiError(ErrorKind.ALL_PROVIDERS_UNAVAILABLE, parts.join('; '), {
      retryable: false, retryAfterMs, provider: 'Jarvis',
      hint: `Check your API keys, credits and quota in .env / the provider consoles${retryAfterMs ? `; automatic retry in about ${formatDuration(retryAfterMs)}` : ''}. Run "stats" to see provider health.`
    });
    err.causes = failures;
    return err;
  }

  async callGeminiAPI(prompt, opts = {}) {
    return (await this.generate(prompt, opts)).text;
  }

  // ------------------------------------------------------------ discovery / admin
  /** Models from the primary provider (use providerEngines() to list every provider). */
  async listModels() {
    if (!this.primary) throw new GeminiError(ErrorKind.CONFIG, 'No AI provider is configured', { retryable: false, provider: 'Jarvis' });
    return this.engines[this.primary].listModels();
  }

  resetCircuit() {
    for (const p of PROVIDERS) {
      if (this.engines[p]) this.engines[p].resetCircuit();
      this.health[p] = { down: false, until: 0, kind: null, reason: null, since: null };
    }
  }

  clearCache() {
    for (const p of PROVIDERS) if (this.engines[p]) this.engines[p].clearCache();
  }

  stats() {
    const per = {};
    for (const { provider, engine } of this.providerEngines()) per[provider] = engine.stats();
    const first = per[this.primary] || Object.values(per)[0];
    const counters = {};
    const errorsByKind = {};
    let cacheEntries = 0;
    let queued = 0;
    for (const s of Object.values(per)) {
      for (const [k, v] of Object.entries(s.counters)) counters[k] = (counters[k] || 0) + v;
      for (const [k, v] of Object.entries(s.errorsByKind)) errorsByKind[k] = (errorsByKind[k] || 0) + v;
      cacheEntries += s.cacheEntries;
      queued += s.queued;
    }
    const usage = this.usage.snapshot();
    const providers = {};
    for (const p of PROVIDERS) {
      const avail = this.engines[p] ? this.availability(p) : null;
      providers[p] = {
        configured: Boolean(this.engines[p]),
        model: this.engines[p] ? this.engines[p].model : null,
        status: !this.engines[p] ? 'not configured' : avail.ok ? (this.health[p].down ? 'recovering' : 'healthy') : 'paused',
        reason: avail && !avail.ok ? avail.reason : null,
        retryInMs: avail && !avail.ok ? avail.retryInMs : null,
        usage: usage[p],
        engine: per[p] || null
      };
    }
    return {
      ...(first || { latencyMs: {}, circuit: { state: 'n/a' } }),
      model: this.model,
      mode: this.mode,
      fallbackEnabled: this.settings.fallbackEnabled,
      fallbacks: this.fallbacks,
      counters, errorsByKind, cacheEntries, queued,
      providers
    };
  }

  shutdown() {
    for (const p of PROVIDERS) if (this.engines[p]) this.engines[p].shutdown();
  }
}

module.exports = { ProviderRouter, SWITCHABLE, providerOfModel };
