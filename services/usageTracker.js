// Per-provider token usage and ESTIMATED cost (process-local), plus optional spend limits.
// Estimates use list prices below (USD per million tokens) or the AI_PRICE_* overrides; they are not
// invoices. Jarvis never purchases credits or enables paid top-ups — a limit only stops sending
// requests to that provider.

// Anthropic list prices (cached 2026-11): matched by model id, first match wins.
const CLAUDE_PRICES = [
  { match: /^claude-(?:fable|mythos)-5-2/, in: 8, out: 40 },
  { match: /^claude-(?:fable|mythos)-5/, in: 10, out: 50 },
  { match: /^claude-opus-5-5/, in: 4, out: 20 },
  { match: /^claude-opus-/, in: 5, out: 25 },
  { match: /^claude-sonnet-5/, in: 2, out: 10 },
  { match: /^claude-sonnet-4/, in: 3, out: 15 },
  { match: /^claude-haiku-5-5/, in: 0.10, out: 0.50 },
  { match: /^claude-haiku-4/, in: 1, out: 5 }
];

function emptyBucket() {
  return { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, unpricedRequests: 0 };
}

/** Normalise Anthropic ({input_tokens, output_tokens}) and Gemini (usageMetadata) usage objects. */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return { inputTokens: 0, outputTokens: 0 };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    return {
      inputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens) + num(usage.cache_read_input_tokens),
      outputTokens: num(usage.output_tokens)
    };
  }
  // Gemini: thinking tokens are billed as output.
  return {
    inputTokens: num(usage.promptTokenCount),
    outputTokens: num(usage.candidatesTokenCount) + num(usage.thoughtsTokenCount)
  };
}

class UsageTracker {
  /**
   * @param {object} options
   * @param {object} [options.limits]   { claude: USD|null, gemini: USD|null }
   * @param {object} [options.override] { claude: {in,out}, gemini: {in,out} } USD per MTok
   */
  constructor({ limits = {}, override = {} } = {}) {
    this.limits = { claude: null, gemini: null, ...limits };
    this.override = override;
    this.byProvider = { claude: emptyBucket(), gemini: emptyBucket() };
  }

  /** @returns {{in:number,out:number}|null} USD per million tokens, null if unknown */
  price(provider, model) {
    const o = this.override[provider] || {};
    if (o.in !== null && o.in !== undefined && o.out !== null && o.out !== undefined) return { in: o.in, out: o.out };
    if (provider === 'gemini') return { in: 0, out: 0 }; // free tier unless overridden
    const hit = CLAUDE_PRICES.find(p => p.match.test(String(model || '')));
    return hit ? { in: hit.in, out: hit.out } : null;
  }

  /** Record one real (non-cached) request. @returns {{inputTokens,outputTokens,costUsd}} */
  record(provider, model, usage) {
    const bucket = this.byProvider[provider] || (this.byProvider[provider] = emptyBucket());
    const { inputTokens, outputTokens } = normalizeUsage(usage);
    const price = this.price(provider, model);
    let costUsd = null;
    bucket.requests++;
    bucket.inputTokens += inputTokens;
    bucket.outputTokens += outputTokens;
    if (price) {
      costUsd = (inputTokens * price.in + outputTokens * price.out) / 1e6;
      bucket.estimatedCostUsd += costUsd;
    } else {
      bucket.unpricedRequests++;
    }
    return { inputTokens, outputTokens, costUsd };
  }

  spent(provider) {
    return (this.byProvider[provider] || emptyBucket()).estimatedCostUsd;
  }

  /** True once the configured limit for this provider has been reached. */
  limitReached(provider) {
    const limit = this.limits[provider];
    return limit !== null && limit !== undefined && this.spent(provider) >= limit;
  }

  snapshot() {
    const out = {};
    for (const [p, b] of Object.entries(this.byProvider)) {
      out[p] = { ...b, limitUsd: this.limits[p] ?? null, limitReached: this.limitReached(p) };
    }
    return out;
  }
}

module.exports = { UsageTracker, normalizeUsage, CLAUDE_PRICES };
