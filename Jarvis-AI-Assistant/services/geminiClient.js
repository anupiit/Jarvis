// Low-level Gemini REST client: one HTTP attempt, documented request/response formats.
// Uses generateContent (v1beta) — see docs/JARVIS_CURRENT_ARCHITECTURE.md for why the
// Interactions API is not used.
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { ErrorKind, GeminiError, classifyHttpError, classifyNetworkError } = require('./geminiErrors');

const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const USER_AGENT = 'jarvis-ai-assistant/2.0 (node)';
const SOCKET_GUARD = Symbol('jarvisSocketErrorGuard');

/**
 * Create a transport that performs a single HTTP request.
 * The API key is sent in the documented `x-goog-api-key` header, never in the URL.
 */
function createHttpTransport({ apiKey, baseUrl = 'https://generativelanguage.googleapis.com', lookup } = {}) {
  const base = new URL(baseUrl);
  const mod = base.protocol === 'http:' ? http : https;

  function request({ method = 'GET', path, body, timeoutMs = 60000, signal } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const headers = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
      if (apiKey) headers['x-goog-api-key'] = apiKey;
      if (payload) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = payload.length;
      }
      const options = {
        method,
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port || undefined,
        path,
        headers
      };
      if (lookup) options.lookup = lookup;

      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };

      const req = mod.request(options, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(Object.assign(new Error('Response too large'), { code: 'ERESPONSETOOLARGE' }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(resolve, {
          status: res.statusCode,
          headers: res.headers,
          bodyText: Buffer.concat(chunks).toString('utf8')
        }));
        res.on('error', (e) => finish(reject, e));
      });

      const timer = setTimeout(() => {
        req.destroy(Object.assign(new Error(`No response within ${Math.round(timeoutMs / 1000)} s`), { code: 'ETIMEDOUT' }));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const onAbort = () => req.destroy(Object.assign(new Error('Request cancelled'), { code: 'ABORT_ERR' }));
      if (signal) {
        if (signal.aborted) { onAbort(); } else { signal.addEventListener('abort', onAbort, { once: true }); }
      }

      req.on('error', (e) => finish(reject, e));
      // A pooled/proxied socket can emit a late error (e.g. ECONNRESET) after this request
      // has settled. Without a listener Node would crash the whole CLI.
      req.on('socket', (socket) => {
        if (!socket[SOCKET_GUARD]) {
          socket[SOCKET_GUARD] = true;
          socket.on('error', () => {});
        }
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  return { request };
}

/** Build a documented GenerateContentRequest body. */
function buildGenerateContentBody({ prompt, systemInstruction, generationConfig, continuationToken }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: String(prompt) }] }]
  };
  if (systemInstruction) body.systemInstruction = { parts: [{ text: String(systemInstruction) }] };
  if (generationConfig && Object.keys(generationConfig).length) body.generationConfig = { ...generationConfig };
  if (continuationToken) body.continuationToken = continuationToken;
  return body;
}

const BLOCKING_FINISH_REASONS = new Set([
  'SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE', 'PUP_LIMITED_DISABLED'
]);

/**
 * Parse a GenerateContentResponse. Joins every non-thought text part of the first candidate.
 * @returns {{ text, finishReason, truncated, continuationToken, usage, modelVersion, modelStatus }}
 */
function parseGenerateContentResponse(bodyText, { model } = {}) {
  let json;
  try {
    json = JSON.parse(bodyText);
  } catch (e) {
    throw new GeminiError(ErrorKind.INVALID_RESPONSE, `Response is not valid JSON: ${e.message}`, { httpStatus: 200, model, retryable: true });
  }
  if (!json || typeof json !== 'object') {
    throw new GeminiError(ErrorKind.INVALID_RESPONSE, 'Response body is empty', { httpStatus: 200, model, retryable: true });
  }
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const blockReason = json.promptFeedback && json.promptFeedback.blockReason;
  if (!candidates.length) {
    if (blockReason) {
      throw new GeminiError(ErrorKind.BLOCKED, `Prompt was blocked (${blockReason})`, { httpStatus: 200, model, reason: blockReason, retryable: false });
    }
    throw new GeminiError(ErrorKind.EMPTY_RESPONSE, 'Response contained no candidates', { httpStatus: 200, model, retryable: false });
  }
  const candidate = candidates[0];
  const parts = (candidate.content && Array.isArray(candidate.content.parts)) ? candidate.content.parts : [];
  const text = parts
    .filter(p => p && typeof p.text === 'string' && !p.thought)
    .map(p => p.text)
    .join('');
  const finishReason = candidate.finishReason || null;

  if (!text) {
    if (BLOCKING_FINISH_REASONS.has(finishReason)) {
      throw new GeminiError(ErrorKind.BLOCKED, `Response was blocked (finishReason ${finishReason})`, { httpStatus: 200, model, reason: finishReason, retryable: false });
    }
    if (finishReason === 'MAX_TOKENS') {
      throw new GeminiError(ErrorKind.EMPTY_RESPONSE,
        'The output token limit was reached before any text was produced (thinking may have used the whole budget)',
        { httpStatus: 200, model, reason: finishReason, retryable: false });
    }
    if (finishReason !== 'CONTINUATION') {
      throw new GeminiError(ErrorKind.EMPTY_RESPONSE, `Response contained no text (finishReason ${finishReason || 'none'})`,
        { httpStatus: 200, model, reason: finishReason, retryable: false });
    }
  }

  return {
    text,
    finishReason,
    truncated: finishReason === 'MAX_TOKENS',
    continuationToken: candidate.continuationToken || null,
    usage: json.usageMetadata || null,
    modelVersion: json.modelVersion || null,
    modelStatus: json.modelStatus || null
  };
}

/**
 * High-level client: one attempt per call, errors always thrown as GeminiError.
 */
function createGeminiClient({ apiKey, baseUrl, apiVersion = 'v1beta', transport, lookup } = {}) {
  const tx = transport || createHttpTransport({ apiKey, baseUrl, lookup });

  async function send(model, reqOpts) {
    let res;
    try {
      res = await tx.request(reqOpts);
    } catch (e) {
      throw classifyNetworkError(e, { model });
    }
    if (res.status < 200 || res.status >= 300) {
      throw classifyHttpError(res.status, res.bodyText, res.headers || {}, { model });
    }
    return res;
  }

  async function generateContent({ model, body, timeoutMs, signal }) {
    const path = `/${apiVersion}/models/${encodeURIComponent(model)}:generateContent`;
    const res = await send(model, { method: 'POST', path, body, timeoutMs, signal });
    return parseGenerateContentResponse(res.bodyText, { model });
  }

  async function listModels({ pageSize = 1000, pageToken, timeoutMs = 30000, signal } = {}) {
    const qs = new URLSearchParams({ pageSize: String(pageSize) });
    if (pageToken) qs.set('pageToken', pageToken);
    const res = await send(null, { method: 'GET', path: `/${apiVersion}/models?${qs}`, timeoutMs, signal });
    try {
      return JSON.parse(res.bodyText);
    } catch (e) {
      throw new GeminiError(ErrorKind.INVALID_RESPONSE, `ListModels response is not valid JSON: ${e.message}`, { httpStatus: res.status });
    }
  }

  return { generateContent, listModels, transport: tx };
}

module.exports = {
  createHttpTransport,
  createGeminiClient,
  buildGenerateContentBody,
  parseGenerateContentResponse
};
