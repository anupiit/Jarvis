const test = require('node:test');
const assert = require('node:assert/strict');
const { ErrorKind, classifyHttpError, classifyNetworkError, GeminiError } = require('../services/geminiErrors');
const F = require('./fixtures/geminiResponses');

const json = (o) => JSON.stringify(o);

test('[captured live] 400 API_KEY_INVALID is classified as AUTH and not retryable', () => {
  const e = classifyHttpError(400, json(F.CAPTURED_INVALID_KEY_400), {});
  assert.equal(e.kind, ErrorKind.AUTH);
  assert.equal(e.retryable, false);
  assert.equal(e.reason, 'API_KEY_INVALID');
  assert.match(e.toUserMessage(), /GEMINI_API_KEY/);
});

test('[captured live] 400 unknown field is INVALID_REQUEST, not retryable', () => {
  const e = classifyHttpError(400, json(F.CAPTURED_UNKNOWN_FIELD_400), {});
  assert.equal(e.kind, ErrorKind.INVALID_REQUEST);
  assert.equal(e.retryable, false);
  assert.match(e.message, /Unknown name "contentz"/);
});

test('[captured live] 403 PERMISSION_DENIED is PERMISSION', () => {
  const e = classifyHttpError(403, json(F.CAPTURED_UNREGISTERED_403), {});
  assert.equal(e.kind, ErrorKind.PERMISSION);
  assert.equal(e.retryable, false);
});

test('Interactions-style array error body is handled', () => {
  const e = classifyHttpError(400, json([F.CAPTURED_INVALID_KEY_400]), {});
  assert.equal(e.kind, ErrorKind.AUTH);
});

test('401 is AUTH', () => {
  assert.equal(classifyHttpError(401, json({ error: { code: 401, message: 'Unauthenticated', status: 'UNAUTHENTICATED' } })).kind, ErrorKind.AUTH);
});

test('404 is MODEL_NOT_FOUND with guidance to run "models"', () => {
  const e = classifyHttpError(404, json(F.DOC_MODEL_NOT_FOUND_404), {}, { model: 'gemini-2.0-flash-exp' });
  assert.equal(e.kind, ErrorKind.MODEL_NOT_FOUND);
  assert.equal(e.retryable, false);
  assert.match(e.hint, /"models"/);
  assert.match(e.hint, /gemini-2\.0-flash-exp/);
});

test('408 and 504 are retryable TIMEOUT', () => {
  assert.equal(classifyHttpError(408, '').kind, ErrorKind.TIMEOUT);
  const e = classifyHttpError(504, json({ error: { code: 504, message: 'Deadline exceeded', status: 'DEADLINE_EXCEEDED' } }));
  assert.equal(e.kind, ErrorKind.TIMEOUT);
  assert.equal(e.retryable, true);
});

test('429 per-minute is RATE_LIMITED with RetryInfo delay in ms', () => {
  const e = classifyHttpError(429, json(F.DOC_RATE_LIMIT_429), {});
  assert.equal(e.kind, ErrorKind.RATE_LIMITED);
  assert.equal(e.retryable, true);
  assert.equal(e.retryAfterMs, 41000);
  assert.deepEqual(e.quotaIds, ['GenerateRequestsPerMinutePerProjectPerModel-FreeTier']);
});

test('429 Retry-After header (seconds) is used when RetryInfo is absent', () => {
  const e = classifyHttpError(429, json({ error: { code: 429, message: 'Resource has been exhausted', status: 'RESOURCE_EXHAUSTED' } }), { 'retry-after': '7' });
  assert.equal(e.kind, ErrorKind.RATE_LIMITED);
  assert.equal(e.retryAfterMs, 7000);
});

test('429 per-day quota is QUOTA_EXHAUSTED and not retryable', () => {
  const e = classifyHttpError(429, json(F.DOC_DAILY_QUOTA_429), {});
  assert.equal(e.kind, ErrorKind.QUOTA_EXHAUSTED);
  assert.equal(e.retryable, false);
  assert.equal(e.retryAfterMs, 7200000);
});

test('429 with limit 0 is BILLING_REQUIRED', () => {
  const e = classifyHttpError(429, json(F.DOC_ZERO_LIMIT_429), {});
  assert.equal(e.kind, ErrorKind.BILLING_REQUIRED);
  assert.equal(e.retryable, false);
});

test('429 depleted prepayment credits is BILLING_REQUIRED', () => {
  const e = classifyHttpError(429, json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.' } }));
  assert.equal(e.kind, ErrorKind.BILLING_REQUIRED);
});

test('400 FAILED_PRECONDITION location / billing variants', () => {
  assert.equal(classifyHttpError(400, json({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'User location is not supported for the API use.' } })).kind, ErrorKind.PRECONDITION);
  assert.equal(classifyHttpError(400, json({ error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.' } })).kind, ErrorKind.BILLING_REQUIRED);
});

test('500/502/503 are retryable SERVER_UNAVAILABLE', () => {
  for (const status of [500, 502, 503]) {
    const e = classifyHttpError(status, json(F.DOC_OVERLOADED_503));
    assert.equal(e.kind, ErrorKind.SERVER_UNAVAILABLE);
    assert.equal(e.retryable, true);
  }
});

test('non-JSON error bodies still produce a classified error', () => {
  const e = classifyHttpError(502, '<html>Bad Gateway</html>');
  assert.equal(e.kind, ErrorKind.SERVER_UNAVAILABLE);
  assert.match(e.message, /Bad Gateway/);
});

test('network errors: ENOTFOUND/EAI_AGAIN → DNS, ECONNRESET → NETWORK, ETIMEDOUT → TIMEOUT', () => {
  const mk = (code) => Object.assign(new Error(`getaddrinfo ${code} generativelanguage.googleapis.com`), { code });
  const dns = classifyNetworkError(mk('ENOTFOUND'));
  assert.equal(dns.kind, ErrorKind.DNS);
  assert.equal(dns.retryable, true);
  assert.match(dns.hint, /DNS|internet/);
  assert.equal(classifyNetworkError(mk('EAI_AGAIN')).kind, ErrorKind.DNS);
  assert.equal(classifyNetworkError(mk('ECONNRESET')).kind, ErrorKind.NETWORK);
  assert.equal(classifyNetworkError(mk('ECONNREFUSED')).kind, ErrorKind.NETWORK);
  assert.equal(classifyNetworkError(mk('ETIMEDOUT')).kind, ErrorKind.TIMEOUT);
  assert.equal(classifyNetworkError(mk('ABORT_ERR')).kind, ErrorKind.CANCELLED);
  const tls = classifyNetworkError(mk('SELF_SIGNED_CERT_IN_CHAIN'));
  assert.equal(tls.retryable, false);
});

test('error messages and hints never contain the API key', () => {
  require('../utils/redact').registerSecret('AIzaFAKEKEYFORTESTS000000000000000000');
  const e = new GeminiError(ErrorKind.UNKNOWN, 'failed for https://x/?key=AIzaFAKEKEYFORTESTS000000000000000000');
  assert.doesNotMatch(e.message, /AIzaFAKE/);
});
