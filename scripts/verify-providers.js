#!/usr/bin/env node
// REAL-API verification of provider routing. This sends a handful of tiny requests (a few
// hundred tokens in total) to the live Claude and Gemini APIs using the keys in .env, and prints
// a PASS / FAIL / SKIP line per check. It never prints keys. Mocked unit tests cannot prove any
// of this — run it yourself:   npm run verify:providers
//
// Checks
//   1. Claude alone         real request with ANTHROPIC_API_KEY
//   2. Gemini alone         real request with GEMINI_API_KEY
//   3. auto routing         a request through the router reports which provider answered
//   4. forced fallback      Claude is given a deliberately INVALID key -> real 401 -> the router must
//                           answer the same request with the real Gemini API
//   5. circuit/health       after (4) Claude must be paused and the next request must not call it
//
// Credit exhaustion cannot be provoked safely against the real API; (4) exercises the same
// fallback path with a real authentication failure. See docs/JARVIS_PROVIDER_ROUTING.md.
const config = require('../config/config');
const { GeminiEngine } = require('../services/geminiService');
const { ProviderRouter } = require('../services/providerRouter');

const PROMPT = 'Reply with exactly the single word: OK';
const results = [];

function report(name, status, detail = '') {
  results.push(status);
  const tag = { PASS: '✔ PASS', FAIL: '✖ FAIL', SKIP: '– SKIP' }[status];
  console.log(`${tag}  ${name}${detail ? `  — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    report(name, 'PASS', detail);
  } catch (e) {
    report(name, 'FAIL', e && e.toUserMessage ? e.toUserMessage().replace(/\n/g, ' ') : (e && e.message) || String(e));
  }
}

function describe(res) {
  return `answered by ${res.providerName || res.provider || 'engine'} (${res.model}), reply "${String(res.text).trim().slice(0, 20)}"`;
}

async function main() {
  const hasClaude = config.isProviderConfigured('claude');
  const hasGemini = config.isProviderConfigured('gemini');
  console.log(`Providers configured: Claude ${hasClaude ? 'yes' : 'no'}, Gemini ${hasGemini ? 'yes' : 'no'}`);
  console.log('Sending a few tiny real requests...\n');

  if (hasClaude) {
    await check('1. Claude alone (real API)', async () => {
      const e = new GeminiEngine({ provider: 'claude', settings: { maxRetries: 0 } });
      const res = await e.generate(PROMPT, { noCache: true, maxOutputTokens: 1024, timeoutMs: 60000 });
      e.shutdown();
      return describe({ ...res, providerName: 'Claude' });
    });
  } else report('1. Claude alone (real API)', 'SKIP', 'ANTHROPIC_API_KEY not configured');

  if (hasGemini) {
    await check('2. Gemini alone (real API)', async () => {
      const e = new GeminiEngine({ provider: 'gemini', settings: { maxRetries: 0 } });
      const res = await e.generate(PROMPT, { noCache: true, maxOutputTokens: 1024, timeoutMs: 60000 });
      e.shutdown();
      return describe({ ...res, providerName: 'Gemini' });
    });
  } else report('2. Gemini alone (real API)', 'SKIP', 'GEMINI_API_KEY not configured');

  if (hasClaude || hasGemini) {
    await check('3. auto routing picks the expected provider', async () => {
      const router = new ProviderRouter({ mode: 'auto' });
      const res = await router.generate(PROMPT, { noCache: true, maxOutputTokens: 1024, timeoutMs: 60000 });
      router.shutdown();
      const expected = hasClaude ? 'claude' : 'gemini';
      if (res.provider !== expected) throw new Error(`expected ${expected} but ${res.provider} answered (${res.fellBackFrom.join(',') || 'no fallback'})`);
      return describe(res);
    });
  } else report('3. auto routing', 'SKIP', 'no provider configured');

  if (hasGemini) {
    await check('4. forced fallback: invalid Claude key -> real Gemini answers', async () => {
      const bad = new GeminiEngine({ provider: 'claude', apiKey: 'sk-ant-invalid-verification-key-0000000000000000', settings: { maxRetries: 0 } });
      const good = new GeminiEngine({ provider: 'gemini', settings: { maxRetries: 0 } });
      const events = [];
      const router = new ProviderRouter({ mode: 'auto', engines: { claude: bad, gemini: good }, onEvent: (e) => events.push(e) });
      const res = await router.generate(PROMPT, { noCache: true, maxOutputTokens: 1024, timeoutMs: 60000 });
      if (res.provider !== 'gemini') throw new Error(`expected Gemini to answer, got ${res.provider}`);
      if (!res.fellBackFrom.includes('claude')) throw new Error('fallback was not recorded');
      const fb = events.find(e => e.type === 'provider-fallback');
      if (!fb) throw new Error('no provider-fallback event');
      // 5. health: Claude must now be paused and not called again
      const before = bad.stats().counters.outboundRequests;
      await router.generate(`${PROMPT} (second)`, { noCache: true, maxOutputTokens: 1024, timeoutMs: 60000 });
      const after = bad.stats().counters.outboundRequests;
      const st = router.stats().providers.claude.status;
      router.shutdown();
      if (st !== 'paused') throw new Error(`Claude status is "${st}", expected "paused"`);
      if (after !== before) throw new Error('Claude was called again while paused');
      report('5. circuit/health: paused provider is not called again', 'PASS', `Claude ${st}, no further requests sent`);
      return `${describe(res)}; Claude failed with ${fb.kind}`;
    });
  } else {
    report('4. forced fallback (real)', 'SKIP', 'GEMINI_API_KEY not configured');
    report('5. circuit/health (real)', 'SKIP', 'needs check 4');
  }

  const failed = results.filter(r => r === 'FAIL').length;
  const passed = results.filter(r => r === 'PASS').length;
  console.log(`\n${passed} passed, ${failed} failed, ${results.filter(r => r === 'SKIP').length} skipped.`);
  if (!failed && results.includes('SKIP')) console.log('Skipped checks were NOT verified — add the missing key(s) and re-run.');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
