// Provider routing tests. Everything here uses scripted fake clients: these tests prove the routing
// LOGIC only. They say nothing about whether the real Claude/Gemini APIs behave this way — see
// docs/JARVIS_PROVIDER_ROUTING.md ("Real API verification") and `npm run verify:providers`.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { GeminiEngine } = require('../services/geminiService');
const { ProviderRouter } = require('../services/providerRouter');
const { UsageTracker, normalizeUsage } = require('../services/usageTracker');
const { GeminiError, ErrorKind } = require('../services/geminiErrors');
const FileGenerator = require('../models/FileGenerator');
const { normalizeBlueprint } = require('../models/ProjectPlanner');
const { parseRequirements } = require('../models/RequirementParser');
const { requestedFile } = require('./helpers/scriptedEngine');
const { setLogSink, resetLogSink } = require('../utils/logger');
const APP = require('./fixtures/todoApp');

const KEY = 'k'.repeat(40);

/** A client whose behaviour is a queue/function of scripted outcomes. */
function fakeClient(provider, behave) {
  const calls = [];
  return {
    calls,
    provider,
    buildBody: ({ prompt }) => ({ prompt }),
    async generateContent({ model, body }) {
      const n = calls.length;
      calls.push({ model, body });
      const out = await behave(n, body);
      if (out instanceof Error) throw out;
      const usage = provider === 'claude'
        ? { input_tokens: 1000, output_tokens: 500 }
        : { promptTokenCount: 800, candidatesTokenCount: 400 };
      return { text: out, finishReason: 'STOP', truncated: false, continuationToken: null, usage, modelVersion: model, modelStatus: null };
    },
    async listModels() { return { models: [] }; }
  };
}

const credits = () => new GeminiError(ErrorKind.BILLING_REQUIRED, 'Your credit balance is too low', { httpStatus: 400, retryable: false });
const auth = () => new GeminiError(ErrorKind.AUTH, 'invalid x-api-key', { httpStatus: 401 });
const overloaded = () => new GeminiError(ErrorKind.SERVER_UNAVAILABLE, 'Overloaded', { httpStatus: 529 });
const rateLimited = (ms) => new GeminiError(ErrorKind.RATE_LIMITED, 'rate limited', { httpStatus: 429, retryAfterMs: ms });

function setup({ claude = () => 'from claude', gemini = () => 'from gemini', settings = {}, only } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const claudeClient = fakeClient('claude', claude);
  const geminiClient = fakeClient('gemini', gemini);
  const engSettings = { rateLimitMaxRequests: 10000, maxRetries: 1, baseBackoffMs: 1, maxBackoffMs: 2, maxRetryWaitMs: 15000 };
  const engines = {};
  if (only !== 'gemini') engines.claude = new GeminiEngine({ provider: 'claude', apiKey: KEY, model: 'claude-opus-5-5', client: claudeClient, settings: engSettings });
  if (only !== 'claude') engines.gemini = new GeminiEngine({ provider: 'gemini', apiKey: KEY, model: 'gemini-3.5-flash', client: geminiClient, settings: engSettings });
  const events = [];
  const router = new ProviderRouter({
    mode: 'auto', engines, now,
    settings: { fallbackEnabled: true, cooldownMs: 900_000, transientCooldownMs: 60_000, spendLimitUsd: {}, priceOverride: {}, ...settings },
    onEvent: (e) => events.push(e)
  });
  return { router, claudeClient, geminiClient, events, clock, engines };
}

let n = 0;
const prompt = () => `prompt ${++n}`; // unique each time: never served from the cache

test('Claude success: Claude answers, Gemini untouched, usage and cost recorded for Claude only', async () => {
  const { router, claudeClient, geminiClient, events } = setup();
  const res = await router.generate(prompt());
  assert.equal(res.text, 'from claude');
  assert.equal(res.provider, 'claude');
  assert.deepEqual(res.fellBackFrom, []);
  assert.equal(claudeClient.calls.length, 1);
  assert.equal(geminiClient.calls.length, 0);
  const s = router.stats();
  assert.equal(s.providers.claude.usage.requests, 1);
  assert.equal(s.providers.claude.usage.inputTokens, 1000);
  // claude-opus-5-5: $4/MTok in, $20/MTok out -> 1000*4/1e6 + 500*20/1e6 = $0.014
  assert.ok(Math.abs(s.providers.claude.usage.estimatedCostUsd - 0.014) < 1e-9);
  assert.equal(s.providers.gemini.usage.requests, 0);
  assert.equal(s.providers.claude.status, 'healthy');
  const used = events.find(e => e.type === 'provider-used');
  assert.equal(used.providerName, 'Claude');
});

test('Claude credit exhaustion: the same request is retried on Gemini, once, and Claude is then skipped', async () => {
  const { router, claudeClient, geminiClient, events } = setup({ claude: () => credits() });
  const res = await router.generate(prompt());
  assert.equal(res.text, 'from gemini');
  assert.equal(res.provider, 'gemini');
  assert.deepEqual(res.fellBackFrom, ['claude']);
  assert.equal(claudeClient.calls.length, 1, 'billing errors are not retried');
  assert.equal(geminiClient.calls.length, 1, 'exactly one fallback request');
  assert.ok(events.some(e => e.type === 'provider-fallback' && e.from === 'claude' && e.to === 'gemini' && e.kind === ErrorKind.BILLING_REQUIRED));
  // Next requests do not touch Claude while it is paused (circuit/cooldown).
  const res2 = await router.generate(prompt());
  assert.equal(res2.provider, 'gemini');
  assert.equal(claudeClient.calls.length, 1);
  assert.equal(geminiClient.calls.length, 2);
  const s = router.stats();
  assert.equal(s.providers.claude.status, 'paused');
  assert.match(s.providers.claude.reason, /BILLING_REQUIRED/);
  assert.equal(s.providers.claude.usage.requests, 0, 'a failed request costs nothing in the estimate');
  assert.equal(s.providers.gemini.usage.requests, 2);
  assert.equal(s.providers.gemini.usage.estimatedCostUsd, 0, 'Gemini free tier is estimated at $0');
  assert.equal(s.fallbacks, 1);
});

test('authentication / configuration failures also fall back', async () => {
  const { router, geminiClient } = setup({ claude: () => auth() });
  const res = await router.generate(prompt());
  assert.equal(res.provider, 'gemini');
  assert.equal(geminiClient.calls.length, 1);
});

test('Claude rate limiting: brief limits are retried on Claude; long ones fall back to Gemini', async () => {
  // brief: one 429 then success -> stays on Claude
  const brief = setup({ claude: (i) => (i === 0 ? rateLimited(1) : 'from claude') });
  const r1 = await brief.router.generate(prompt());
  assert.equal(r1.provider, 'claude');
  assert.equal(brief.claudeClient.calls.length, 2);
  assert.equal(brief.geminiClient.calls.length, 0);

  // long: provider asks for 120 s (> maxRetryWait) -> immediate fallback, Claude paused
  const long = setup({ claude: () => rateLimited(120_000) });
  const r2 = await long.router.generate(prompt());
  assert.equal(r2.provider, 'gemini');
  assert.equal(long.claudeClient.calls.length, 1);
  const status = long.router.stats().providers.claude;
  assert.equal(status.status, 'paused');
  assert.ok(status.retryInMs >= 60_000);

  // persistent 429 that survives the retry budget -> fallback as well
  const persistent = setup({ claude: () => rateLimited(1) });
  const r3 = await persistent.router.generate(prompt());
  assert.equal(r3.provider, 'gemini');
  assert.equal(persistent.claudeClient.calls.length, 2, '1 attempt + 1 retry, then give up');
});

test('transient Claude outage after retries falls back; request-level errors do NOT fall back', async () => {
  const outage = setup({ claude: () => overloaded() });
  assert.equal((await outage.router.generate(prompt())).provider, 'gemini');

  for (const kind of [ErrorKind.INVALID_REQUEST, ErrorKind.BLOCKED, ErrorKind.EMPTY_RESPONSE]) {
    const t = setup({ claude: () => new GeminiError(kind, 'bad request / model output problem', { retryable: false }) });
    await assert.rejects(t.router.generate(prompt()), (e) => e.kind === kind);
    assert.equal(t.geminiClient.calls.length, 0, `${kind} must not trigger a provider switch`);
    assert.equal(t.router.stats().providers.claude.status, 'healthy');
  }
});

test('Gemini failure: ignored while Claude works; surfaced (with Claude context) when it is the fallback', async () => {
  const fine = setup({ gemini: () => overloaded() });
  assert.equal((await fine.router.generate(prompt())).provider, 'claude');
  assert.equal(fine.geminiClient.calls.length, 0);

  // Gemini rejecting the request itself is not a provider problem: surface Gemini's error
  const bad = setup({ claude: () => credits(), gemini: () => new GeminiError(ErrorKind.INVALID_REQUEST, 'bad prompt', { retryable: false }) });
  await assert.rejects(bad.router.generate(prompt()), (e) => e.kind === ErrorKind.INVALID_REQUEST);
});

test('both providers unavailable: one clear error, no loops, then fail fast without calling either', async () => {
  const { router, claudeClient, geminiClient } = setup({ claude: () => credits(), gemini: () => new GeminiError(ErrorKind.QUOTA_EXHAUSTED, 'daily quota used up', { httpStatus: 429, retryable: false }) });
  await assert.rejects(router.generate(prompt()), (e) => {
    assert.equal(e.kind, ErrorKind.ALL_PROVIDERS_UNAVAILABLE);
    assert.match(e.message, /Claude failed \(BILLING_REQUIRED/);
    assert.match(e.message, /Gemini failed \(QUOTA_EXHAUSTED/);
    assert.equal(e.causes.length, 2);
    assert.equal(e.retryable, false);
    assert.match(e.toUserMessage(), /^Jarvis has no provider available/);
    return true;
  });
  assert.equal(claudeClient.calls.length, 1);
  assert.equal(geminiClient.calls.length, 1);
  // Both are now paused: the next request fails immediately, with no network calls.
  await assert.rejects(router.generate(prompt()), (e) => e.kind === ErrorKind.ALL_PROVIDERS_UNAVAILABLE && /paused/.test(e.message) && e.retryAfterMs > 0);
  assert.equal(claudeClient.calls.length, 1);
  assert.equal(geminiClient.calls.length, 1);
});

test('recovery: after the cooldown Claude is probed once, becomes primary again, even if its engine breaker was latched', async () => {
  let claudeBroken = true;
  const { router, claudeClient, geminiClient, clock, events, engines } = setup({ claude: () => (claudeBroken ? credits() : 'from claude') });
  assert.equal((await router.generate(prompt())).provider, 'gemini');
  assert.equal(engines.claude.breaker.peek().open, true, 'the engine latched its own breaker on the billing error');

  clock.t += 899_000; // still inside the 15-minute cooldown
  assert.equal((await router.generate(prompt())).provider, 'gemini');
  assert.equal(claudeClient.calls.length, 1, 'no probe before the cooldown ends');

  claudeBroken = false; // credits topped up by the user
  clock.t += 2_000;     // cooldown over
  const res = await router.generate(prompt());
  assert.equal(res.provider, 'claude');
  assert.equal(claudeClient.calls.length, 2);
  assert.ok(events.some(e => e.type === 'provider-probe' && e.provider === 'claude'));
  assert.ok(events.some(e => e.type === 'provider-recovered' && e.provider === 'claude'));
  assert.equal(router.stats().providers.claude.status, 'healthy');
  assert.equal((await router.generate(prompt())).provider, 'claude');
  assert.equal(geminiClient.calls.length, 2, 'Gemini only handled the requests made while Claude was down');
});

test('a failed recovery probe re-pauses Claude and still answers via Gemini', async () => {
  const { router, claudeClient, clock } = setup({ claude: () => credits() });
  await router.generate(prompt());
  clock.t += 900_001;
  const res = await router.generate(prompt()); // probe fails again
  assert.equal(res.provider, 'gemini');
  assert.equal(claudeClient.calls.length, 2);
  assert.equal(router.stats().providers.claude.status, 'paused');
  clock.t += 1_000;
  await router.generate(prompt());
  assert.equal(claudeClient.calls.length, 2, 'paused again for a full cooldown');
});

test('AI_FALLBACK_ENABLED=false: Claude errors surface and Gemini is never called', async () => {
  const { router, geminiClient } = setup({ claude: () => credits(), settings: { fallbackEnabled: false } });
  await assert.rejects(router.generate(prompt()), (e) => e.kind === ErrorKind.BILLING_REQUIRED);
  assert.equal(geminiClient.calls.length, 0);
  assert.deepEqual(router.candidates(), ['claude']);
});

test('only Gemini configured: auto mode uses Gemini; nothing configured: clear CONFIG error', async () => {
  const g = setup({ only: 'gemini' });
  assert.equal((await g.router.generate(prompt())).provider, 'gemini');
  const none = new ProviderRouter({ mode: 'auto', engines: {} });
  await assert.rejects(none.generate('x'), (e) => e.kind === ErrorKind.CONFIG && /ANTHROPIC_API_KEY/.test(e.message));
});

test('spend limit: once Claude\'s estimated spend reaches the limit, requests go to Gemini (no purchases, no overrun)', async () => {
  const { router, claudeClient, geminiClient } = setup({ settings: { spendLimitUsd: { claude: 0.02, gemini: null } } });
  assert.equal((await router.generate(prompt())).provider, 'claude'); // $0.014
  assert.equal((await router.generate(prompt())).provider, 'claude'); // $0.028 >= $0.02 afterwards
  const r = await router.generate(prompt());
  assert.equal(r.provider, 'gemini');
  assert.equal(claudeClient.calls.length, 2);
  assert.equal(geminiClient.calls.length, 1);
  const s = router.stats().providers.claude;
  assert.equal(s.usage.limitReached, true);
  assert.match(s.reason, /spend limit/);
});

test('cache hits are free: not counted as usage and not sent twice', async () => {
  const { router, claudeClient } = setup();
  const p = prompt();
  await router.generate(p);
  const again = await router.generate(p);
  assert.equal(again.cached, true);
  assert.equal(claudeClient.calls.length, 1);
  assert.equal(router.stats().providers.claude.usage.requests, 1);
});

test('requests asking for a model of the other provider do not leak the model name across providers', async () => {
  const { router, claudeClient } = setup({ claude: () => credits() });
  await router.generate(prompt(), { model: 'claude-sonnet-5-5' });
  // Claude failed -> Gemini engine must have used ITS own model, not "claude-sonnet-5-5"
  assert.equal(claudeClient.calls[0].model, 'claude-sonnet-5-5');
  const geminiModel = router.engines.gemini.client.calls[0].model;
  assert.equal(geminiModel, 'gemini-3.5-flash');
});

test('usage normalisation and pricing', () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 }), { inputTokens: 100, outputTokens: 5 });
  assert.deepEqual(normalizeUsage({ promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2 }), { inputTokens: 7, outputTokens: 5 });
  assert.deepEqual(normalizeUsage(null), { inputTokens: 0, outputTokens: 0 });
  const t = new UsageTracker();
  assert.equal(t.price('claude', 'claude-sonnet-5-5').out, 10);
  assert.equal(t.price('claude', 'claude-unknown-9'), null);
  t.record('claude', 'claude-unknown-9', { input_tokens: 1, output_tokens: 1 });
  assert.equal(t.snapshot().claude.unpricedRequests, 1);
  const paid = new UsageTracker({ override: { gemini: { in: 0.3, out: 2.5 } } });
  const r = paid.record('gemini', 'gemini-x', { promptTokenCount: 1_000_000, candidatesTokenCount: 1_000_000 });
  assert.ok(Math.abs(r.costUsd - 2.8) < 1e-9);
});

// ---- no duplicate side effects --------------------------------------------------------------
function makePlan(root) {
  const plan = normalizeBlueprint(APP.TODO_BLUEPRINT, parseRequirements(APP.TODO_REQUEST), APP.TODO_REQUEST);
  plan.projectsRoot = root;
  return plan;
}
const goodFile = (body) => ({ 'index.html': APP.INDEX_HTML, 'style.css': APP.STYLE_CSS, 'script.js': APP.SCRIPT_JS }[requestedFile(body.prompt)]);

test('project generation across a mid-run Claude failure: every file written exactly once, no repeated requests', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-route-'));
  const writes = [];
  const origWrite = fs.writeFileSync;
  // Claude serves the first file, then runs out of credits; Gemini serves the rest.
  const { router, claudeClient, geminiClient } = setup({
    claude: (i, body) => (i === 0 ? goodFile(body) : credits()),
    gemini: (i, body) => goodFile(body)
  });
  const lines = [];
  setLogSink((l) => lines.push(l), { color: false });
  try {
    fs.writeFileSync = function patched(file, ...rest) { writes.push(String(file)); return origWrite.call(this, file, ...rest); };
    const summary = await new FileGenerator({ engine: router, projectsRoot: root }).generateProjectFiles(makePlan(root));
    assert.equal(summary.ok, true);
  } finally {
    fs.writeFileSync = origWrite;
    resetLogSink();
  }
  const requestedByClaude = claudeClient.calls.map(c => requestedFile(c.body.prompt));
  const requestedByGemini = geminiClient.calls.map(c => requestedFile(c.body.prompt));
  assert.deepEqual(requestedByClaude, ['index.html', 'style.css'], 'Claude: one success, then the single failed attempt');
  assert.deepEqual(requestedByGemini, ['style.css', 'script.js'], 'Gemini: the failed request once, then the remaining file');
  const projectDir = path.join(root, 'todo-list-app');
  assert.deepEqual(fs.readdirSync(projectDir).sort(), ['index.html', 'script.js', 'style.css']);
  // each final file written once (atomic temp files are separate paths; count the final destinations)
  const finals = writes.filter(w => w.startsWith(projectDir) && !/\.tmp|\.jarvis|~/.test(w));
  const counts = {};
  finals.forEach(w => { counts[path.basename(w)] = (counts[path.basename(w)] || 0) + 1; });
  Object.values(counts).forEach(c => assert.ok(c <= 1, `a file was written more than once: ${JSON.stringify(counts)}`));
  assert.equal(lines.filter(l => /PROJECT GENERATED/.test(l)).length, 1, 'the project summary is produced once');
  const s = router.stats();
  assert.equal(s.providers.claude.usage.requests, 1);
  assert.equal(s.providers.gemini.usage.requests, 2);
  fs.rmSync(root, { recursive: true, force: true });
});
