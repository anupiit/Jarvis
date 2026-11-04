const test = require('node:test');
const assert = require('node:assert/strict');
const { GeminiEngine } = require('../services/geminiService');
const { discoverModels, suggestAlternatives, probeModel, diagnose, normalizeModel } = require('../services/modelDiscovery');
const { ErrorKind } = require('../services/geminiErrors');
const { createMockTransport } = require('./helpers/mockTransport');
const F = require('./fixtures/geminiResponses');

const MODELS_PAGE_1 = {
  models: [
    { name: 'models/gemini-a-flash', displayName: 'A Flash', supportedGenerationMethods: ['generateContent', 'countTokens'], inputTokenLimit: 1000, outputTokenLimit: 500, thinking: true },
    { name: 'models/text-embedding-x', supportedGenerationMethods: ['embedContent'] }
  ],
  nextPageToken: 'p2'
};
const MODELS_PAGE_2 = {
  models: [
    { name: 'models/gemini-b-pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-c-tts', supportedGenerationMethods: ['generateContent'] }
  ]
};

function engineWith(handler) {
  const transport = createMockTransport(handler);
  const engine = new GeminiEngine({ apiKey: 'k', model: 'gemini-a-flash', transport, settings: { baseBackoffMs: 1, maxBackoffMs: 2 } });
  return { engine, transport };
}

test('ListModels pagination is followed and models normalized with supported methods', async () => {
  const { engine, transport } = engineWith((req) => {
    if (req.path.includes('pageToken=p2')) return { body: MODELS_PAGE_2 };
    return { body: MODELS_PAGE_1 };
  });
  const models = await discoverModels(engine);
  assert.equal(transport.calls.length, 2);
  assert.deepEqual(models.map(m => m.id), ['gemini-a-flash', 'gemini-b-pro', 'gemini-c-tts', 'text-embedding-x']);
  const a = models[0];
  assert.equal(a.supportsGenerateContent, true);
  assert.equal(a.outputTokenLimit, 500);
  assert.equal(models[3].supportsGenerateContent, false);
});

test('alternatives come from the live list, exclude non-text models and the current model', () => {
  const models = [...MODELS_PAGE_1.models, ...MODELS_PAGE_2.models].map(normalizeModel);
  assert.deepEqual(suggestAlternatives(models, 'gemini-a-flash'), ['gemini-b-pro']);
});

test('probe performs a real generateContent call and reports success', async () => {
  const { engine, transport } = engineWith(() => ({ body: F.docSuccess('OK') }));
  const r = await probeModel(engine, 'gemini-a-flash');
  assert.equal(r.ok, true);
  assert.equal(r.sample, 'OK');
  assert.match(transport.calls[0].path, /gemini-a-flash:generateContent$/);
});

test('diagnose: model listed in ListModels but generation fails → probe reports the real error', async () => {
  const { engine } = engineWith((req) => {
    if (req.method === 'GET') return { body: MODELS_PAGE_2 };
    return { status: 429, body: F.DOC_ZERO_LIMIT_429 };
  });
  engine.apiKey = 'x'.repeat(39);
  const report = await diagnose(engine, { model: 'gemini-b-pro' });
  assert.equal(report.configuration.ok, true);
  assert.equal(report.listModels.ok, true);
  assert.equal(report.modelListed, true);
  assert.equal(report.modelSupportsGenerateContent, true);
  assert.equal(report.probe.ok, false, 'listed ≠ usable: the probe must expose the failure');
  assert.equal(report.probe.error.kind, ErrorKind.BILLING_REQUIRED);
});

test('diagnose stops at configuration problems without sending requests', async () => {
  const { engine, transport } = engineWith(() => ({ body: F.docSuccess('OK') }));
  engine.apiKey = '';
  const report = await diagnose(engine);
  assert.equal(report.configuration.ok, false);
  assert.equal(transport.calls.length, 0);
});
