// Classification of Gemini API and network failures into actionable error kinds.
const { parseRetryAfterHeader, parseGoogleDuration, parseRetryHintFromMessage, formatDuration } = require('../utils/retry');
const { redactSecrets } = require('../utils/redact');

const ErrorKind = Object.freeze({
  CONFIG: 'CONFIG',                     // missing/invalid local configuration (no request sent)
  INVALID_REQUEST: 'INVALID_REQUEST',   // 400 — malformed request / unsupported parameter
  AUTH: 'AUTH',                         // 401, or 400 API_KEY_INVALID
  PERMISSION: 'PERMISSION',             // 403
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',   // 404
  PRECONDITION: 'PRECONDITION',         // 400 FAILED_PRECONDITION (e.g. unsupported location)
  TIMEOUT: 'TIMEOUT',                   // 408 / 504 / socket timeout / ETIMEDOUT
  RATE_LIMITED: 'RATE_LIMITED',         // 429 short-term (per-minute) limits
  QUOTA_EXHAUSTED: 'QUOTA_EXHAUSTED',   // 429 daily quota exhausted
  BILLING_REQUIRED: 'BILLING_REQUIRED', // 429 with limit 0 / depleted credits / billing needed
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE', // 500/502/503 (high demand, overloaded)
  DNS: 'DNS',                           // ENOTFOUND / EAI_AGAIN
  NETWORK: 'NETWORK',                   // ECONNRESET / ECONNREFUSED / EPIPE ...
  BLOCKED: 'BLOCKED',                   // prompt or response blocked by safety filters
  EMPTY_RESPONSE: 'EMPTY_RESPONSE',     // 200 but no usable text
  INVALID_RESPONSE: 'INVALID_RESPONSE', // 200 but body is not the documented JSON
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',         // local fail-fast while the API is known to be failing
  QUEUE_FULL: 'QUEUE_FULL',             // local bounded queue rejected the request
  CANCELLED: 'CANCELLED',               // cancelled locally (shutdown / Ctrl+C)
  UNKNOWN: 'UNKNOWN'
});

const RETRYABLE = new Set([
  ErrorKind.TIMEOUT, ErrorKind.RATE_LIMITED, ErrorKind.SERVER_UNAVAILABLE,
  ErrorKind.DNS, ErrorKind.NETWORK
]);

// Failures that will not fix themselves within this session: stop sending requests.
const LATCHING = new Set([
  ErrorKind.AUTH, ErrorKind.PERMISSION, ErrorKind.QUOTA_EXHAUSTED, ErrorKind.BILLING_REQUIRED
]);

// Transient failures that count toward opening the circuit breaker.
const TRIPPING = new Set([
  ErrorKind.SERVER_UNAVAILABLE, ErrorKind.NETWORK, ErrorKind.DNS, ErrorKind.TIMEOUT
]);

class GeminiError extends Error {
  constructor(kind, message, extra = {}) {
    super(redactSecrets(message));
    this.name = 'GeminiError';
    this.kind = kind;
    this.httpStatus = extra.httpStatus ?? null;
    this.apiStatus = extra.apiStatus ?? null;
    this.reason = extra.reason ?? null;
    this.quotaIds = extra.quotaIds || [];
    this.retryAfterMs = extra.retryAfterMs ?? null;
    this.retryable = extra.retryable ?? RETRYABLE.has(kind);
    this.hint = extra.hint ? redactSecrets(extra.hint) : hintFor(kind, extra);
    this.code = extra.code ?? null;
    this.model = extra.model ?? null;
    this.attempts = extra.attempts ?? null;
    if (extra.cause) this.cause = extra.cause;
  }

  /** One- or two-line user-facing diagnostic. */
  toUserMessage() {
    const status = this.httpStatus ? `HTTP ${this.httpStatus}${this.apiStatus ? ` ${this.apiStatus}` : ''}` : (this.code || this.kind);
    const lines = [`Gemini ${describeKind(this.kind)} (${status}): ${this.message}`];
    if (this.hint) lines.push(`→ ${this.hint}`);
    return lines.join('\n');
  }
}

function describeKind(kind) {
  return ({
    CONFIG: 'is not configured',
    INVALID_REQUEST: 'rejected the request',
    AUTH: 'rejected the API key',
    PERMISSION: 'denied permission',
    MODEL_NOT_FOUND: 'model not found',
    PRECONDITION: 'precondition failed',
    TIMEOUT: 'request timed out',
    RATE_LIMITED: 'rate limit reached',
    QUOTA_EXHAUSTED: 'quota exhausted',
    BILLING_REQUIRED: 'requires billing for this model',
    SERVER_UNAVAILABLE: 'is temporarily unavailable',
    DNS: 'host could not be resolved',
    NETWORK: 'network error',
    BLOCKED: 'blocked the content',
    EMPTY_RESPONSE: 'returned no text',
    INVALID_RESPONSE: 'returned an unexpected response',
    CIRCUIT_OPEN: 'requests paused',
    QUEUE_FULL: 'request queue is full',
    CANCELLED: 'request cancelled',
    UNKNOWN: 'error'
  })[kind] || 'error';
}

function hintFor(kind, extra = {}) {
  const model = extra.model ? `"${extra.model}"` : 'the configured model';
  const wait = extra.retryAfterMs ? ` Google suggests waiting ${formatDuration(extra.retryAfterMs)}.` : '';
  const quota = extra.quotaIds && extra.quotaIds.length ? ` (quota: ${extra.quotaIds.join(', ')})` : '';
  switch (kind) {
    case ErrorKind.CONFIG: return 'Create .env next to package.json (copy .env.example) and restart Jarvis.';
    case ErrorKind.AUTH: return 'Check GEMINI_API_KEY in .env (no quotes or spaces), then restart Jarvis. Keys: https://aistudio.google.com/app/apikey';
    case ErrorKind.PERMISSION: return 'The key is not allowed to call the Generative Language API (API not enabled for its project, or key restrictions). Check the key in Google AI Studio.';
    case ErrorKind.MODEL_NOT_FOUND: return `Model ${model} is not available to this key for generateContent. Run "models" to list available models, then set GEMINI_MODEL in .env.`;
    case ErrorKind.INVALID_REQUEST: return `The request was rejected as invalid for ${model}. Run "diagnose" to verify the model supports generateContent.`;
    case ErrorKind.PRECONDITION: return 'The API refused the request for an account/region reason (see message). This will not succeed by retrying.';
    case ErrorKind.TIMEOUT: return 'The request took too long. Check your connection; large files can take a while — retry later.';
    case ErrorKind.RATE_LIMITED: return `Too many requests per minute for this key/model.${wait}${quota}`;
    case ErrorKind.QUOTA_EXHAUSTED: return `The daily quota for ${model} is used up.${wait} Try again after the quota resets, switch GEMINI_MODEL, or enable billing.${quota}`;
    case ErrorKind.BILLING_REQUIRED: return `${model} is not available on your current tier (quota limit 0 or credits depleted). Enable billing in Google AI Studio or choose another model ("models").`;
    case ErrorKind.SERVER_UNAVAILABLE: return 'Gemini is overloaded or having an outage. Try again in a few minutes.';
    case ErrorKind.DNS: return 'generativelanguage.googleapis.com could not be resolved. Check your internet connection, DNS, VPN, proxy or firewall.';
    case ErrorKind.NETWORK: return 'The connection to Gemini failed. Check your internet connection, proxy or firewall.';
    case ErrorKind.BLOCKED: return 'Rephrase the request; the content was blocked by Gemini safety filters.';
    case ErrorKind.EMPTY_RESPONSE: return 'The model returned no text (possibly the output limit was consumed). Try again or use a different model.';
    case ErrorKind.INVALID_RESPONSE: return 'The response did not match the documented generateContent format.';
    case ErrorKind.CIRCUIT_OPEN: return 'Jarvis paused Gemini requests after repeated failures to avoid wasting quota.';
    case ErrorKind.QUEUE_FULL: return 'Too many requests are waiting. Try again when the current work finishes.';
    default: return null;
  }
}

function findDetail(details, typeSuffix) {
  return (details || []).find(d => typeof d['@type'] === 'string' && d['@type'].endsWith(typeSuffix));
}

/**
 * Classify a non-2xx HTTP response from the Gemini API.
 * @param {number} status HTTP status
 * @param {string} bodyText raw response body
 * @param {object} headers response headers
 */
function classifyHttpError(status, bodyText, headers = {}, { model, nowMs = Date.now() } = {}) {
  let body = null;
  try {
    body = JSON.parse(bodyText);
    if (Array.isArray(body)) body = body[0];
  } catch (_) { /* non-JSON error body */ }

  const err = (body && body.error) || {};
  const apiStatus = err.status || null;
  const rawMessage = err.message || (bodyText ? String(bodyText).slice(0, 300) : `HTTP ${status}`);
  const message = String(rawMessage).split('\n')[0];
  const details = Array.isArray(err.details) ? err.details : [];
  const errorInfo = findDetail(details, 'google.rpc.ErrorInfo');
  const reason = errorInfo ? errorInfo.reason : null;
  const retryInfo = findDetail(details, 'google.rpc.RetryInfo');
  const quotaFailure = findDetail(details, 'google.rpc.QuotaFailure');
  const violations = (quotaFailure && quotaFailure.violations) || [];
  const quotaIds = violations.map(v => v.quotaId).filter(Boolean);

  const retryAfterMs =
    parseGoogleDuration(retryInfo && retryInfo.retryDelay) ??
    parseRetryAfterHeader(headers['retry-after'], nowMs) ??
    parseRetryHintFromMessage(rawMessage);

  const base = { httpStatus: status, apiStatus, reason, quotaIds, retryAfterMs, model };

  if (status === 400) {
    if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(rawMessage)) {
      return new GeminiError(ErrorKind.AUTH, message, base);
    }
    if (apiStatus === 'FAILED_PRECONDITION') {
      if (/billing|free tier is not available/i.test(rawMessage)) {
        return new GeminiError(ErrorKind.BILLING_REQUIRED, message, base);
      }
      return new GeminiError(ErrorKind.PRECONDITION, message, base);
    }
    return new GeminiError(ErrorKind.INVALID_REQUEST, message, base);
  }
  if (status === 401) return new GeminiError(ErrorKind.AUTH, message, base);
  if (status === 403) {
    if (reason === 'API_KEY_INVALID' || reason === 'API_KEY_SERVICE_BLOCKED') {
      return new GeminiError(ErrorKind.AUTH, message, base);
    }
    return new GeminiError(ErrorKind.PERMISSION, message, base);
  }
  if (status === 404) return new GeminiError(ErrorKind.MODEL_NOT_FOUND, message, base);
  if (status === 408) return new GeminiError(ErrorKind.TIMEOUT, message, base);
  if (status === 429) {
    const zeroLimit = violations.some(v => String(v.quotaValue) === '0') || /\blimit:\s*0\b/i.test(rawMessage);
    const billing = /credits? (?:are |is )?depleted|prepayment|enable billing|billing account/i.test(rawMessage);
    if (zeroLimit || billing) return new GeminiError(ErrorKind.BILLING_REQUIRED, message, { ...base, retryable: false });
    const daily = quotaIds.some(id => /per ?day/i.test(id)) || /per[ _-]?day|daily/i.test(rawMessage);
    if (daily) return new GeminiError(ErrorKind.QUOTA_EXHAUSTED, message, { ...base, retryable: false });
    return new GeminiError(ErrorKind.RATE_LIMITED, message, base);
  }
  if (status === 504) return new GeminiError(ErrorKind.TIMEOUT, message, base);
  if (status >= 500 && status <= 599) return new GeminiError(ErrorKind.SERVER_UNAVAILABLE, message, base);
  return new GeminiError(ErrorKind.UNKNOWN, message, { ...base, retryable: false });
}

/** Classify a Node.js network/socket error. */
function classifyNetworkError(error, { model } = {}) {
  if (error instanceof GeminiError) return error;
  const code = error && (error.code || (error.cause && error.cause.code));
  const msg = (error && error.message) || String(error);
  const extra = { code, model, cause: error };
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_FAIL':
      return new GeminiError(ErrorKind.DNS, `DNS lookup failed (${code}): ${msg}`, extra);
    case 'ETIMEDOUT':
    case 'ESOCKETTIMEDOUT':
    case 'ERR_TIMEOUT':
      return new GeminiError(ErrorKind.TIMEOUT, `Network timeout (${code}): ${msg}`, extra);
    case 'ECONNRESET':
    case 'ECONNREFUSED':
    case 'ECONNABORTED':
    case 'EPIPE':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'ENETDOWN':
    case 'UND_ERR_SOCKET':
      return new GeminiError(ErrorKind.NETWORK, `Connection failed (${code}): ${msg}`, extra);
    case 'ABORT_ERR':
      return new GeminiError(ErrorKind.CANCELLED, 'Request cancelled', { ...extra, retryable: false });
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return new GeminiError(ErrorKind.NETWORK, `TLS certificate problem (${code}): ${msg}`,
        { ...extra, retryable: false, hint: 'A proxy or antivirus may be intercepting HTTPS. Set NODE_EXTRA_CA_CERTS to its CA certificate.' });
    default:
      return new GeminiError(ErrorKind.NETWORK, `Request failed${code ? ` (${code})` : ''}: ${msg}`, extra);
  }
}

module.exports = {
  ErrorKind,
  GeminiError,
  RETRYABLE,
  LATCHING,
  TRIPPING,
  classifyHttpError,
  classifyNetworkError
};
