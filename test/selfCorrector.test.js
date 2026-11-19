const test = require('node:test');
const assert = require('node:assert/strict');
const { SelfCorrector, buildCorrectionPrompt } = require('../models/SelfCorrector');
const { GeminiError, ErrorKind } = require('../services/geminiErrors');
const { createScriptedEngine } = require('./helpers/scriptedEngine');

const GOOD_JS = "const total = [1, 2, 3].reduce((a, b) => a + b, 0);\nconsole.log(total);\n";
const BAD_JS = 'const total = [1, 2, 3].reduce((a, b) => a + b, 0;\n';

test('first-attempt success: one call, no corrections', async () => {
  const engine = createScriptedEngine(() => GOOD_JS);
  const r = await new SelfCorrector({ engine }).generateValidFile({ filePath: 'script.js', prompt: 'p' });
  assert.equal(r.ok, true);
  assert.equal(r.corrections, 0);
  assert.equal(engine.calls.length, 1);
  assert.equal(r.content, GOOD_JS.trim());
});

test('correction success: invalid → errors sent back → valid', async () => {
  const engine = createScriptedEngine((prompt, opts, i) => (i === 0 ? BAD_JS : GOOD_JS));
  const events = [];
  const r = await new SelfCorrector({ engine, onEvent: e => events.push(e) }).generateValidFile({ filePath: 'script.js', prompt: 'ORIGINAL TASK TEXT' });
  assert.equal(r.ok, true);
  assert.equal(r.corrections, 1);
  const correction = engine.calls[1];
  assert.match(correction.prompt, /failed automatic validation \(correction attempt 1 of 3\)/);
  assert.match(correction.prompt, /\[syntax\]/);
  assert.match(correction.prompt, /PREVIOUS OUTPUT/);
  assert.match(correction.prompt, /ORIGINAL TASK TEXT/);
  assert.equal(correction.opts.noCache, true, 'corrections must bypass the cache');
  assert.equal(events[0].type, 'correcting');
  assert.equal(r.attempts.length, 2);
});

test('maximum corrections reached: stops after 3 and reports the last errors', async () => {
  const engine = createScriptedEngine(() => BAD_JS);
  const r = await new SelfCorrector({ engine }).generateValidFile({ filePath: 'script.js', prompt: 'p' });
  assert.equal(r.ok, false);
  assert.equal(r.corrections, 3);
  assert.equal(engine.calls.length, 4, '1 generation + 3 corrections, never more');
  assert.equal(r.finalErrors[0].rule, 'syntax');
  assert.equal(r.content, undefined, 'invalid output is never returned as content');
});

test('maxCorrections is configurable (0 = validate only)', async () => {
  const engine = createScriptedEngine(() => BAD_JS);
  const r = await new SelfCorrector({ engine, maxCorrections: 0 }).generateValidFile({ filePath: 'script.js', prompt: 'p' });
  assert.equal(r.ok, false);
  assert.equal(engine.calls.length, 1);
});

test('truncated output → correction asks for the complete file without echoing the partial output', async () => {
  const engine = createScriptedEngine((p, o, i) => (i === 0 ? { text: 'const a = [1, 2,', truncated: true } : GOOD_JS));
  const r = await new SelfCorrector({ engine }).generateValidFile({ filePath: 'script.js', prompt: 'p' });
  assert.equal(r.ok, true);
  assert.match(engine.calls[1].prompt, /cut off before the end/);
  assert.doesNotMatch(engine.calls[1].prompt, /PREVIOUS OUTPUT/);
});

test('Gemini failure during generation or correction is returned, not thrown', async () => {
  const fail = new GeminiError(ErrorKind.SERVER_UNAVAILABLE, 'overloaded', { httpStatus: 503 });
  const first = await new SelfCorrector({ engine: createScriptedEngine(() => { throw fail; }) }).generateValidFile({ filePath: 'script.js', prompt: 'p' });
  assert.equal(first.ok, false);
  assert.equal(first.error.kind, ErrorKind.SERVER_UNAVAILABLE);
  const mid = await new SelfCorrector({ engine: createScriptedEngine((p, o, i) => { if (i === 0) return BAD_JS; throw fail; }) }).generateValidFile({ filePath: 'script.js', prompt: 'p' });
  assert.equal(mid.ok, false);
  assert.equal(mid.error.kind, ErrorKind.SERVER_UNAVAILABLE);
  assert.equal(mid.finalErrors[0].rule, 'syntax');
});

test('correction prompt shortens very large previous output', () => {
  const p = buildCorrectionPrompt({ filePath: 'a.js', code: 'x'.repeat(50000), errors: [{ rule: 'syntax', message: 'bad', line: 1 }], truncated: false, attempt: 1, maxAttempts: 3, originalPrompt: 'o' });
  assert.ok(p.length < 40000);
  assert.match(p, /previous output shortened/);
});
