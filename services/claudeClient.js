// Claude (Anthropic Messages API) client with the same interface as geminiClient:
//   generateContent({ model, body, timeoutMs, signal }) -> { text, finishReason, truncated, ... }
//   listModels() -> { models: [...] } in the shape modelDiscovery expects
// The reliability engine (cache, queue, rate limit, circuit breaker, retries) is provider-neutral
// and sits on top of this, so the SDK's own retries are disabled (maxRetries: 0).
const Anthropic = require('@anthropic-ai/sdk');
const { ErrorKind, GeminiError, classifyHttpError, classifyNetworkError } = require('./geminiErrors');

// Models that accept the server-side `fallbacks: "default"` safety fallback (beta).
const FALLBACK_MODELS = /^claude-(?:opus-5-5|sonnet-5-5|opus-5|fable-5(?:-\d)?)$/;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Engine hands us provider-neutral request parts; the SDK call is built in generateContent. */
function buildBody({ prompt, systemInstruction, generationConfig }) {
  return { prompt: String(prompt), systemInstruction: systemInstruction || null, generationConfig: generationConfig || {} };
}

const STOP_TO_FINISH = {
  end_turn: 'STOP',
  stop_sequence: 'STOP',
  max_tokens: 'MAX_TOKENS',
  pause_turn: 'MAX_TOKENS',
  refusal: 'REFUSAL',
  tool_use: 'STOP'
};

function claudeError(err, kind, message, extra = {}) {
  const e = new GeminiError(kind, message, { ...extra, model: extra.model });
  e.provider = 'Claude';
  if (err && !e.cause) e.cause = err;
  const hints = {
    [ErrorKind.CONFIG]: 'Add ANTHROPIC_API_KEY to .env (copy .env.example) and restart Jarvis. Keys: https://console.anthropic.com/settings/keys',
    [ErrorKind.AUTH]: 'Check ANTHROPIC_API_KEY in .env (no quotes or spaces), then restart Jarvis. Keys: https://console.anthropic.com/settings/keys',
    [ErrorKind.PERMISSION]: 'The API key is not allowed to use this model or feature. Check its workspace and permissions in the Anthropic Console.',
    [ErrorKind.MODEL_NOT_FOUND]: `Model "${extra.model || ''}" is not available to this key. Run "models" to list available models, then set CLAUDE_MODEL in .env.`,
    [ErrorKind.INVALID_REQUEST]: 'The request was rejected as invalid. Run "diagnose" to verify the configured model works.',
    [ErrorKind.RATE_LIMITED]: 'Too many requests or tokens per minute for this key. Jarvis retries automatically.',
    [ErrorKind.BILLING_REQUIRED]: 'The Anthropic account has no usable credit. Add credits at https://console.anthropic.com/settings/billing.',
    [ErrorKind.SERVER_UNAVAILABLE]: 'Claude is overloaded or having an outage. Try again in a few minutes.',
    [ErrorKind.DNS]: 'api.anthropic.com could not be resolved. Check your internet connection, DNS, VPN, proxy or firewall.',
    [ErrorKind.NETWORK]: 'The connection to Claude failed. Check your internet connection, proxy or firewall.',
    [ErrorKind.BLOCKED]: 'Rephrase the request; Claude declined it for safety reasons.',
    [ErrorKind.EMPTY_RESPONSE]: 'The model returned no text (possibly the output limit was consumed). Try again.',
    [ErrorKind.CIRCUIT_OPEN]: 'Jarvis paused Claude requests after repeated failures.'
  };
  if (!extra.hint && hints[kind]) e.hint = hints[kind];
  return e;
}

function headersToObject(h) {
  if (!h) return {};
  if (typeof h.get === 'function') {
    const ra = h.get('retry-after');
    return ra ? { 'retry-after': ra } : {};
  }
  return h;
}

/** Map any SDK / network error to a classified GeminiError (provider "Claude"). */
function mapSdkError(error, model) {
  if (error instanceof GeminiError) return error;
  if (error instanceof Anthropic.APIUserAbortError) {
    return claudeError(error, ErrorKind.CANCELLED, 'Request cancelled', { retryable: false, model });
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return claudeError(error, ErrorKind.TIMEOUT, 'No response within the timeout', { model });
  }
  if (error instanceof Anthropic.APIError && typeof error.status === 'number') {
    const body = JSON.stringify({ error: { message: error.error && error.error.error ? error.error.error.message : error.message } });
    const base = classifyHttpError(error.status, body, headersToObject(error.headers), { model });
    let kind = base.kind;
    // Anthropic reports an empty credit balance as 400 invalid_request_error.
    if (error.status === 400 && /credit balance|billing/i.test(base.message)) kind = ErrorKind.BILLING_REQUIRED;
    const retryable = kind === ErrorKind.BILLING_REQUIRED ? false : base.retryable;
    return claudeError(error, kind, base.message, {
      httpStatus: error.status, apiStatus: error.error && error.error.error ? error.error.error.type : null,
      retryAfterMs: base.retryAfterMs, retryable, model
    });
  }
  const net = classifyNetworkError(error, { model });
  net.provider = 'Claude';
  return net;
}

function createClaudeClient({ apiKey, baseURL, sdk, settings = {} } = {}) {
  const anthropic = sdk || new Anthropic({ apiKey, baseURL, maxRetries: 0 });

  async function generateContent({ model, body, timeoutMs, signal }) {
    const gc = body.generationConfig || {};
    const params = {
      model,
      max_tokens: gc.maxOutputTokens || 16000,
      messages: [{ role: 'user', content: body.prompt }]
    };
    if (body.systemInstruction) params.system = body.systemInstruction;
    // No temperature/top_p/top_k and no `thinking` parameter: current Claude models reject
    // sampling overrides, and thinking is adaptive by default.
    if (settings.effort) params.output_config = { effort: settings.effort };

    const useFallback = settings.fallback !== false && FALLBACK_MODELS.test(model);
    const requestOptions = { signal, timeout: timeoutMs };
    let message;
    try {
      // Streaming avoids HTTP timeouts with a large max_tokens; finalMessage() assembles the reply.
      const stream = useFallback
        ? anthropic.beta.messages.stream({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' }, requestOptions)
        : anthropic.messages.stream(params, requestOptions);
      message = await stream.finalMessage();
    } catch (error) {
      throw mapSdkError(error, model);
    }

    const text = (message.content || [])
      .filter(b => b && b.type === 'text' && typeof b.text === 'string')
      .map(b => b.text)
      .join('');
    const stop = message.stop_reason || null;

    if (stop === 'refusal' && !text) {
      const cat = message.stop_details && message.stop_details.category;
      throw claudeError(null, ErrorKind.BLOCKED, `Claude declined the request${cat ? ` (${cat})` : ''}`, { httpStatus: 200, model, retryable: false });
    }
    if (!text) {
      throw claudeError(null, ErrorKind.EMPTY_RESPONSE, `Response contained no text (stop_reason ${stop || 'none'})`, { httpStatus: 200, model, retryable: false });
    }
    return {
      text,
      finishReason: STOP_TO_FINISH[stop] || stop,
      truncated: stop === 'max_tokens',
      continuationToken: null,
      usage: message.usage || null,
      modelVersion: message.model || null,
      modelStatus: null
    };
  }

  async function listModels({ pageToken, signal } = {}) {
    const models = [];
    try {
      for await (const m of anthropic.models.list({ limit: 100 }, { signal })) {
        models.push({
          name: `models/${m.id}`,
          displayName: m.display_name || m.id,
          supportedGenerationMethods: ['generateContent'],
          inputTokenLimit: m.max_input_tokens || null,
          outputTokenLimit: m.max_tokens || null
        });
      }
    } catch (error) {
      throw mapSdkError(error, null);
    }
    return { models };
  }

  return { generateContent, listModels, buildBody, provider: 'claude' };
}

module.exports = { createClaudeClient, mapSdkError, FALLBACK_MODELS };
