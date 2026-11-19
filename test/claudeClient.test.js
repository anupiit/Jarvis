const test = require('node:test');
const assert = require('node:assert/strict');
const Anthropic = require('@anthropic-ai/sdk');
const config = require('../config/config');
const { createClaudeClient, mapSdkError } = require('../services/claudeClient');
const { GeminiEngine } = require('../services/geminiService');
const { ErrorKind } = require('../services/geminiErrors');

function fakeSdk(message, { fail } = {}) {
  const calls = [];
  const make = (kind) => ({
    stream: (params, opts) => {
      calls.push({ kind, params, opts });
      return { finalMessage: async () => { if (fail) throw fail; return message; } };
    }
  });
  return {
    calls,
    messages: make('stable'),
    beta: { messages: make('beta') },
    models: { list: () => (async function* () { yield { id: 'claude-opus-5-5', display_name: 'Opus', max_input_tokens: 1000000, max_tokens: 128000 }; })() }
  };
}

const okMessage = { content: [{ type: 'text', text: 'hello ' }, { type: 'thinking', thinking: '' }, { type: 'text', text: 'world' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 }, model: 'claude-opus-5-5' };

test('Claude client sends system, max_tokens, effort and no sampling/thinking params; joins text blocks', async () => {
  const sdk = fakeSdk(okMessage);
  const client = createClaudeClient({ sdk, settings: { effort: 'high', fallback: false } });
  const res = await client.generateContent({ model: 'claude-opus-5-5', body: client.buildBody({ prompt: 'hi', systemInstruction: 'sys', generationConfig: { maxOutputTokens: 4000, temperature: 0.2 } }), timeoutMs: 1000 });
  assert.equal(res.text, 'hello world');
  assert.equal(res.finishReason, 'STOP');
  assert.equal(res.truncated, false);
  const { kind, params } = sdk.calls[0];
  assert.equal(kind, 'stable');
  assert.equal(params.max_tokens, 4000);
  assert.equal(params.system, 'sys');
  assert.deepEqual(params.output_config, { effort: 'high' });
  assert.equal('temperature' in params, false);
  assert.equal('thinking' in params, false);
});

test('Claude client uses the server-side refusal fallback for supported models when enabled', async () => {
  const sdk = fakeSdk(okMessage);
  const client = createClaudeClient({ sdk, settings: { effort: '', fallback: true } });
  await client.generateContent({ model: 'claude-opus-5-5', body: client.buildBody({ prompt: 'hi' }) });
  const { kind, params } = sdk.calls[0];
  assert.equal(kind, 'beta');
  assert.equal(params.fallbacks, 'default');
  assert.deepEqual(params.betas, ['server-side-fallback-2026-07-01']);
  assert.equal('output_config' in params, false);
});

test('max_tokens stop reason is reported as truncated', async () => {
  const sdk = fakeSdk({ ...okMessage, stop_reason: 'max_tokens' });
  const client = createClaudeClient({ sdk, settings: { fallback: false } });
  const res = await client.generateContent({ model: 'claude-opus-5-5', body: client.buildBody({ prompt: 'hi' }) });
  assert.equal(res.finishReason, 'MAX_TOKENS');
  assert.equal(res.truncated, true);
});

test('refusal without text becomes a BLOCKED error; empty text becomes EMPTY_RESPONSE', async () => {
  const client1 = createClaudeClient({ sdk: fakeSdk({ content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' } }), settings: { fallback: false } });
  await assert.rejects(client1.generateContent({ model: 'm', body: client1.buildBody({ prompt: 'x' }) }), (e) => e.kind === ErrorKind.BLOCKED && e.provider === 'Claude');
  const client2 = createClaudeClient({ sdk: fakeSdk({ content: [], stop_reason: 'end_turn' }), settings: { fallback: false } });
  await assert.rejects(client2.generateContent({ model: 'm', body: client2.buildBody({ prompt: 'x' }) }), (e) => e.kind === ErrorKind.EMPTY_RESPONSE);
});

test('SDK HTTP errors are classified (auth, not found, rate limit, overloaded, billing)', () => {
  const mk = (status, message) => new Anthropic.APIError(status, { type: 'error', error: { type: 'x', message } }, message, new Headers({ 'retry-after': '3' }));
  assert.equal(mapSdkError(mk(401, 'invalid x-api-key'), 'm').kind, ErrorKind.AUTH);
  assert.equal(mapSdkError(mk(404, 'model: nope'), 'm').kind, ErrorKind.MODEL_NOT_FOUND);
  const rl = mapSdkError(mk(429, 'rate limited'), 'm');
  assert.equal(rl.kind, ErrorKind.RATE_LIMITED);
  assert.equal(rl.retryable, true);
  assert.equal(rl.retryAfterMs, 3000);
  assert.equal(mapSdkError(mk(529, 'Overloaded'), 'm').kind, ErrorKind.SERVER_UNAVAILABLE);
  const bill = mapSdkError(mk(400, 'Your credit balance is too low'), 'm');
  assert.equal(bill.kind, ErrorKind.BILLING_REQUIRED);
  assert.equal(bill.retryable, false);
  assert.match(bill.toUserMessage(), /^Claude /);
});

test('listModels maps the Models API into the discovery shape', async () => {
  const client = createClaudeClient({ sdk: fakeSdk(okMessage) });
  const out = await client.listModels();
  assert.equal(out.models[0].name, 'models/claude-opus-5-5');
  assert.deepEqual(out.models[0].supportedGenerationMethods, ['generateContent']);
  assert.equal(out.models[0].outputTokenLimit, 128000);
});

test('engine with provider=claude runs end to end on the Claude client', async () => {
  const sdk = fakeSdk(okMessage);
  const client = createClaudeClient({ sdk, settings: { fallback: false } });
  const engine = new GeminiEngine({ provider: 'claude', apiKey: 'k'.repeat(40), model: 'claude-opus-5-5', client });
  const res = await engine.generate('hi');
  assert.equal(res.text, 'hello world');
  assert.equal(engine.providerName, 'Claude');
  engine.shutdown();
});

test('validateConfig checks the Anthropic key when provider is claude', () => {
  const missing = config.validateConfig({ ...config, provider: 'claude', anthropicApiKey: '' });
  assert.equal(missing.ok, false);
  assert.match(missing.problems[0], /ANTHROPIC_API_KEY is not set/);
  assert.equal(config.validateConfig({ ...config, provider: 'claude', anthropicApiKey: 'k'.repeat(40), claudeModel: 'claude-opus-5-5' }).ok, true);
});
