// Exercises the real HTTP transport against a local server (no external network).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createGeminiClient, buildGenerateContentBody, parseGenerateContentResponse } = require('../services/geminiClient');
const { ErrorKind } = require('../services/geminiErrors');
const F = require('./fixtures/geminiResponses');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('generateContent sends the documented request: POST /v1beta/models/{model}:generateContent, key in x-goog-api-key header', async () => {
  let seen;
  const { server, baseUrl } = await startServer((req, res, body) => {
    seen = { method: req.method, url: req.url, key: req.headers['x-goog-api-key'], ct: req.headers['content-type'], body: JSON.parse(body) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(F.docSuccess('hello')));
  });
  try {
    const client = createGeminiClient({ apiKey: 'test-key-123', baseUrl });
    const body = buildGenerateContentBody({ prompt: 'Say hi', systemInstruction: 'Be brief', generationConfig: { maxOutputTokens: 100, responseMimeType: 'application/json' } });
    const out = await client.generateContent({ model: 'gemini-flash-latest', body, timeoutMs: 5000 });
    assert.equal(out.text, 'hello');
    assert.equal(seen.method, 'POST');
    assert.equal(seen.url, '/v1beta/models/gemini-flash-latest:generateContent');
    assert.doesNotMatch(seen.url, /key=/, 'API key must not be in the URL');
    assert.equal(seen.key, 'test-key-123');
    assert.equal(seen.ct, 'application/json');
    assert.deepEqual(seen.body, {
      contents: [{ role: 'user', parts: [{ text: 'Say hi' }] }],
      systemInstruction: { parts: [{ text: 'Be brief' }] },
      generationConfig: { maxOutputTokens: 100, responseMimeType: 'application/json' }
    });
  } finally { server.close(); }
});

test('response parsing joins text parts and skips thought parts', () => {
  const out = parseGenerateContentResponse(JSON.stringify(F.docSuccess('B', { thought: 'internal', extraParts: [{ text: 'C' }] })));
  assert.equal(out.text, 'BC');
  assert.equal(out.finishReason, 'STOP');
  assert.equal(out.truncated, false);
  assert.equal(out.usage.totalTokenCount, 30);
});

test('MAX_TOKENS with partial text is returned flagged as truncated', () => {
  const out = parseGenerateContentResponse(JSON.stringify(F.docSuccess('<html><body>', { finishReason: 'MAX_TOKENS' })));
  assert.equal(out.truncated, true);
});

test('thinking-only MAX_TOKENS candidate → EMPTY_RESPONSE with a clear reason', () => {
  assert.throws(() => parseGenerateContentResponse(JSON.stringify(F.DOC_THINKING_ONLY_MAX_TOKENS)),
    (e) => e.kind === ErrorKind.EMPTY_RESPONSE && /output token limit/.test(e.message));
});

test('blocked prompt → BLOCKED; invalid JSON → INVALID_RESPONSE', () => {
  assert.throws(() => parseGenerateContentResponse(JSON.stringify(F.DOC_BLOCKED_PROMPT)), (e) => e.kind === ErrorKind.BLOCKED);
  assert.throws(() => parseGenerateContentResponse('not json'), (e) => e.kind === ErrorKind.INVALID_RESPONSE);
  assert.throws(() => parseGenerateContentResponse(JSON.stringify({ candidates: [] })), (e) => e.kind === ErrorKind.EMPTY_RESPONSE);
});

test('HTTP error responses are classified (404 model not found)', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(F.DOC_MODEL_NOT_FOUND_404));
  });
  try {
    const client = createGeminiClient({ apiKey: 'k', baseUrl });
    await assert.rejects(client.generateContent({ model: 'nope', body: buildGenerateContentBody({ prompt: 'x' }), timeoutMs: 5000 }),
      (e) => e.kind === ErrorKind.MODEL_NOT_FOUND && e.httpStatus === 404);
  } finally { server.close(); }
});

test('Retry-After header from a real HTTP response reaches the error', async () => {
  const { server, baseUrl } = await startServer((req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' });
    res.end(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Too many requests' } }));
  });
  try {
    const client = createGeminiClient({ apiKey: 'k', baseUrl });
    await assert.rejects(client.generateContent({ model: 'm', body: buildGenerateContentBody({ prompt: 'x' }), timeoutMs: 5000 }),
      (e) => e.kind === ErrorKind.RATE_LIMITED && e.retryAfterMs === 3000);
  } finally { server.close(); }
});

test('timeout aborts a stalled request and is classified as TIMEOUT', async () => {
  const { server, baseUrl } = await startServer(() => { /* never respond */ });
  try {
    const client = createGeminiClient({ apiKey: 'k', baseUrl });
    const started = Date.now();
    await assert.rejects(client.generateContent({ model: 'm', body: buildGenerateContentBody({ prompt: 'x' }), timeoutMs: 150 }),
      (e) => e.kind === ErrorKind.TIMEOUT);
    assert.ok(Date.now() - started < 2000);
  } finally { server.closeAllConnections(); server.close(); }
});

test('connection refused is classified as NETWORK', async () => {
  const { server, baseUrl } = await startServer(() => {});
  server.close();
  await new Promise(r => server.once('close', r));
  const client = createGeminiClient({ apiKey: 'k', baseUrl });
  await assert.rejects(client.generateContent({ model: 'm', body: buildGenerateContentBody({ prompt: 'x' }), timeoutMs: 2000 }),
    (e) => e.kind === ErrorKind.NETWORK && e.code === 'ECONNREFUSED');
});

test('DNS failure (ENOTFOUND) is classified as DNS with an actionable hint', async () => {
  const lookup = (hostname, opts, cb) => {
    const err = Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
    (typeof opts === 'function' ? opts : cb)(err);
  };
  const client = createGeminiClient({ apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com', lookup });
  await assert.rejects(client.generateContent({ model: 'm', body: buildGenerateContentBody({ prompt: 'x' }), timeoutMs: 2000 }),
    (e) => e.kind === ErrorKind.DNS && /generativelanguage\.googleapis\.com could not be resolved/.test(e.hint));
});

test('listModels uses GET /v1beta/models with pageSize and header auth', async () => {
  let url;
  const { server, baseUrl } = await startServer((req, res) => {
    url = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-x', supportedGenerationMethods: ['generateContent'] }] }));
  });
  try {
    const client = createGeminiClient({ apiKey: 'k', baseUrl });
    const page = await client.listModels();
    assert.equal(url, '/v1beta/models?pageSize=1000');
    assert.equal(page.models[0].name, 'models/gemini-x');
  } finally { server.close(); }
});
