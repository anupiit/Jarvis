#!/usr/bin/env node
// Static validation + self-correction benchmark over the 15-item defect corpus.
//
//   node scripts/benchmark-validation.js          → detection + loop plumbing (scripted corrector, no network)
//   node scripts/benchmark-validation.js --live   → real Gemini repairs each defect (needs GEMINI_API_KEY)
//
// The scripted mode proves the validator catches each defect and that the loop accepts a
// correct fix. It says NOTHING about how well Gemini repairs code; only --live measures that.
const fs = require('fs');
const path = require('path');
const { validateFile } = require('../services/codeValidator');
const { SelfCorrector } = require('../models/SelfCorrector');
const { GeminiEngine } = require('../services/geminiService');
const { DEFECTS } = require('../test/fixtures/defectCorpus');
const APP = require('../test/fixtures/todoApp');
const { stats, writeResult } = require('./lib/benchUtil');

const live = process.argv.includes('--live');

async function timeIt(fn) {
  const t = process.hrtime.bigint();
  const value = await fn();
  return { value, ms: Number(process.hrtime.bigint() - t) / 1e6 };
}

(async () => {
  // 1. Detection
  const detection = [];
  for (const d of DEFECTS) {
    const broken = await timeIt(() => validateFile({ path: d.path, content: d.broken, context: d.context || {} }));
    const fixed = await validateFile({ path: d.path, content: d.fixed, context: d.context || {} });
    detection.push({
      id: d.id, file: d.path,
      detected: !broken.value.valid && broken.value.errors.some(e => e.rule === d.expectRule),
      rules: [...new Set(broken.value.errors.map(e => e.rule))].join(','),
      fixAccepted: fixed.valid,
      ms: Math.round(broken.ms * 100) / 100
    });
  }

  // 2. False positives on known-good files
  const goodSet = [
    { path: 'index.html', content: APP.INDEX_HTML, context: { plannedFiles: ['index.html', 'style.css', 'script.js'], expectedReferences: ['style.css', 'script.js'] } },
    { path: 'style.css', content: APP.STYLE_CSS },
    { path: 'script.js', content: APP.SCRIPT_JS, context: { environment: 'browser', moduleType: 'script' } }
  ];
  const sampleRoot = path.join(__dirname, '..', 'projectsByJarvis', 'a-project-that-manage-my-day-');
  if (fs.existsSync(sampleRoot)) {
    for (const f of ['index.html', 'styles.css', 'script.js', 'package.json']) {
      goodSet.push({ path: f, content: fs.readFileSync(path.join(sampleRoot, f), 'utf8'), context: { environment: 'browser' }, origin: 'committed sample' });
    }
  }
  const falsePositives = [];
  for (const g of goodSet) {
    const r = await validateFile(g);
    if (!r.valid) falsePositives.push({ file: g.path, origin: g.origin || 'reference app', errors: r.errors });
  }

  // 3. Correction loop
  let engineFor;
  let mode;
  if (live) {
    const engine = new GeminiEngine();
    if (!engine.apiKey) {
      console.error('LIVE MODE BLOCKED: GEMINI_API_KEY is not set. No results recorded.');
      process.exit(2);
    }
    engineFor = () => engine;
    mode = `LIVE Gemini (${engine.model})`;
  } else {
    // Scripted corrector: first answer = the defect, correction answer = the known fix.
    engineFor = (d) => {
      let call = 0;
      return { generate: async () => ({ text: call++ === 0 ? d.broken : d.fixed, truncated: false, finishReason: 'STOP' }) };
    };
    mode = 'SCRIPTED corrector (mock returns the known fix) — loop plumbing only';
  }
  const correction = [];
  for (const d of DEFECTS) {
    const corrector = new SelfCorrector({ engine: engineFor(d), maxCorrections: 3 });
    const prompt = live
      ? `Write the complete contents of the file "${d.path}". Use exactly this content and return it unchanged:\n${d.broken}`
      : 'scripted';
    const t = await timeIt(() => corrector.generateValidFile({ filePath: d.path, prompt, context: d.context || {} }));
    correction.push({ id: d.id, repaired: t.value.ok, corrections: t.value.corrections, error: t.value.error ? t.value.error.kind : null, ms: Math.round(t.ms) });
  }

  const out = {
    benchmark: 'validation-and-self-correction',
    corpusSize: DEFECTS.length,
    detection: { detected: detection.filter(d => d.detected).length, fixAccepted: detection.filter(d => d.fixAccepted).length, perDefect: detection, validationMs: stats(detection.map(d => d.ms)) },
    falsePositives: { filesChecked: goodSet.length, flagged: falsePositives.length, details: falsePositives },
    correction: { mode, repaired: correction.filter(c => c.repaired).length, perDefect: correction }
  };
  console.table(detection.map(d => ({ id: d.id, detected: d.detected, rules: d.rules, fixAccepted: d.fixAccepted })));
  console.log(`Detection: ${out.detection.detected}/${DEFECTS.length} | fixes accepted: ${out.detection.fixAccepted}/${DEFECTS.length} | false positives: ${falsePositives.length}/${goodSet.length}`);
  console.log(`Correction (${mode}): ${out.correction.repaired}/${DEFECTS.length}`);
  console.log('Saved:', writeResult(live ? 'validation-live' : 'validation', out));
})();
