#!/usr/bin/env node
// Live checks that need NO valid key: they verify the real endpoint, request schema and
// error classification for failure paths. Uses deliberately invalid credentials.
// Usage: node scripts/live-error-paths.js
const { createGeminiClient, buildGenerateContentBody } = require('../services/geminiClient');
require('../utils/processSafety').installProcessSafetyNet();

async function check(label, fn) {
  const started = Date.now();
  try {
    await fn();
    console.log(`UNEXPECTED SUCCESS  ${label}`);
    return { label, ok: false };
  } catch (e) {
    console.log(`${label}\n  → kind=${e.kind} http=${e.httpStatus} status=${e.apiStatus} reason=${e.reason} retryable=${e.retryable} (${Date.now() - started} ms)\n  → ${e.message}`);
    return { label, kind: e.kind, httpStatus: e.httpStatus };
  }
}

(async () => {
  const body = buildGenerateContentBody({ prompt: 'Reply with OK', generationConfig: { maxOutputTokens: 64 } });
  const results = [];
  results.push(await check('generateContent with an invalid key', () =>
    createGeminiClient({ apiKey: 'jarvis-invalid-test-key' }).generateContent({ model: 'gemini-flash-latest', body, timeoutMs: 30000 })));
  results.push(await check('ListModels with an invalid key', () =>
    createGeminiClient({ apiKey: 'jarvis-invalid-test-key' }).listModels({ timeoutMs: 30000 })));
  results.push(await check('ListModels with no key at all', () =>
    createGeminiClient({ apiKey: '' }).listModels({ timeoutMs: 30000 })));
  results.push(await check('DNS failure (reserved .invalid host)', () =>
    createGeminiClient({ apiKey: 'x', baseUrl: 'https://generativelanguage.invalid' }).generateContent({ model: 'm', body, timeoutMs: 15000 })));
  console.log('\nSUMMARY ' + JSON.stringify(results));
})();
