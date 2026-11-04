// Bounded generate → validate → correct loop.
// Never writes files: it returns either validated content or a failure description.
const config = require('../config/config');
const { validateFile, formatIssues } = require('../services/codeValidator');
const { extractCode } = require('../utils/codeExtraction');

const MAX_PREVIOUS_OUTPUT_CHARS = 30000;

function fenceLanguage(filePath) {
  const ext = String(filePath).split('.').pop().toLowerCase();
  return ({ js: 'javascript', mjs: 'javascript', cjs: 'javascript', htm: 'html', md: 'markdown' })[ext] || ext;
}

function buildCorrectionPrompt({ filePath, code, errors, truncated, attempt, maxAttempts, originalPrompt }) {
  const parts = [
    `The file "${filePath}" you generated failed automatic validation (correction attempt ${attempt} of ${maxAttempts}).`,
    '',
    'VALIDATION ERRORS:',
    formatIssues(errors, 12),
    ''
  ];
  if (truncated) {
    parts.push('Your previous output was cut off before the end. Regenerate the COMPLETE file from the beginning. Keep it concise enough to finish (fewer comments, no redundant code).', '');
  } else {
    const shown = code.length > MAX_PREVIOUS_OUTPUT_CHARS ? `${code.slice(0, MAX_PREVIOUS_OUTPUT_CHARS)}\n/* …previous output shortened… */` : code;
    parts.push('PREVIOUS OUTPUT:', '```' + fenceLanguage(filePath), shown, '```', '');
  }
  parts.push('ORIGINAL TASK (all requirements still apply):', originalPrompt, '');
  parts.push(`Return ONLY the complete, corrected contents of "${filePath}". Fix every error listed above. No explanations and no Markdown code fences.`);
  return parts.join('\n');
}

class SelfCorrector {
  constructor({ engine, validator = validateFile, maxCorrections = config.MAX_CORRECTION_ATTEMPTS, onEvent = null } = {}) {
    if (!engine) throw new Error('SelfCorrector requires an engine');
    this.engine = engine;
    this.validator = validator;
    this.maxCorrections = Math.max(0, maxCorrections);
    this.onEvent = onEvent;
  }

  emit(event) {
    if (typeof this.onEvent === 'function') {
      try { this.onEvent(event); } catch (_) { /* ignore listener errors */ }
    }
  }

  /**
   * @returns {Promise<{ ok, content?, corrections, attempts: Array, warnings?, finalErrors?, error?, lastContent? }>}
   */
  async generateValidFile({ filePath, prompt, systemInstruction, context = {}, maxOutputTokens }) {
    const attempts = [];
    let corrections = 0;
    const genOpts = { systemInstruction, maxOutputTokens };

    let res;
    try {
      res = await this.engine.generate(prompt, genOpts);
    } catch (error) {
      return { ok: false, error, corrections, attempts };
    }
    let extracted = extractCode(res.text, filePath);
    let truncated = Boolean(res.truncated) || extracted.unclosedFence;
    let verdict = await this.validator({ path: filePath, content: extracted.code, context: { ...context, truncated: res.truncated, unclosedFence: extracted.unclosedFence } });
    attempts.push({ attempt: 0, kind: 'generate', valid: verdict.valid, errors: verdict.errors, truncated });

    while (!verdict.valid && corrections < this.maxCorrections) {
      corrections++;
      this.emit({ type: 'correcting', filePath, attempt: corrections, max: this.maxCorrections, errors: verdict.errors });
      const correctionPrompt = buildCorrectionPrompt({
        filePath, code: extracted.code, errors: verdict.errors, truncated,
        attempt: corrections, maxAttempts: this.maxCorrections, originalPrompt: prompt
      });
      try {
        // noCache: an identical correction prompt must not return the same cached bad answer.
        res = await this.engine.generate(correctionPrompt, { ...genOpts, noCache: true });
      } catch (error) {
        return { ok: false, error, corrections, attempts, finalErrors: verdict.errors, lastContent: extracted.code };
      }
      extracted = extractCode(res.text, filePath);
      truncated = Boolean(res.truncated) || extracted.unclosedFence;
      verdict = await this.validator({ path: filePath, content: extracted.code, context: { ...context, truncated: res.truncated, unclosedFence: extracted.unclosedFence } });
      attempts.push({ attempt: corrections, kind: 'correct', valid: verdict.valid, errors: verdict.errors, truncated });
    }

    if (verdict.valid) {
      return { ok: true, content: extracted.code, corrections, attempts, warnings: verdict.warnings, meta: verdict.meta };
    }
    return { ok: false, corrections, attempts, finalErrors: verdict.errors, lastContent: extracted.code };
  }
}

module.exports = { SelfCorrector, buildCorrectionPrompt };
