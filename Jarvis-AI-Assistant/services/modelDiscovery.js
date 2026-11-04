// Model discovery and live diagnostics.
// A model appearing in ListModels does NOT prove generation works (quota, tier, region,
// preview access). diagnose() therefore always performs a real generateContent probe.
const config = require('../config/config');
const { GeminiError, ErrorKind } = require('./geminiErrors');

const NON_TEXT_HINTS = /(embedding|embed|aqa|imagen|veo|tts|native-audio|live|image-generation|-image\b|lyria|robotics|computer-use)/i;

function normalizeModel(raw) {
  const name = raw.name || '';
  const id = name.replace(/^models\//, '');
  const methods = Array.isArray(raw.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  return {
    id,
    name,
    displayName: raw.displayName || id,
    description: raw.description || '',
    methods,
    supportsGenerateContent: methods.includes('generateContent'),
    inputTokenLimit: raw.inputTokenLimit || null,
    outputTokenLimit: raw.outputTokenLimit || null,
    thinking: raw.thinking === true,
    likelyTextModel: !NON_TEXT_HINTS.test(id)
  };
}

async function discoverModels(engine) {
  const raw = await engine.listModels();
  return raw.map(normalizeModel).sort((a, b) => a.id.localeCompare(b.id));
}

/** Text-capable candidates from the LIVE list (no hard-coded recommendations). */
function suggestAlternatives(models, currentModel, limit = 6) {
  return models
    .filter(m => m.supportsGenerateContent && m.likelyTextModel && m.id !== currentModel)
    .sort((a, b) => {
      const aFlash = /flash/i.test(a.id) ? 0 : 1;
      const bFlash = /flash/i.test(b.id) ? 0 : 1;
      return aFlash - bFlash || a.id.localeCompare(b.id);
    })
    .slice(0, limit)
    .map(m => m.id);
}

/** Send a tiny real generateContent request to the given model. */
async function probeModel(engine, model) {
  const started = Date.now();
  try {
    const res = await engine.generate('Reply with exactly the word OK.', {
      model, noCache: true, maxOutputTokens: 2048, timeoutMs: 60000
    });
    return {
      ok: true, model, latencyMs: Date.now() - started, finishReason: res.finishReason,
      modelVersion: res.modelVersion, modelStatus: res.modelStatus, sample: String(res.text).trim().slice(0, 40)
    };
  } catch (error) {
    const err = error instanceof GeminiError ? error : new GeminiError(ErrorKind.UNKNOWN, error.message);
    return { ok: false, model, latencyMs: Date.now() - started, error: err };
  }
}

/**
 * Full diagnostic: configuration → ListModels → model listed? → live generation probe.
 * @returns {Promise<object>} structured report (no secrets)
 */
async function diagnose(engine, { model = engine.model } = {}) {
  const report = {
    configuration: config.validateConfig({ ...config, geminiApiKey: engine.apiKey, geminiModel: model }),
    model,
    listModels: null,
    modelListed: null,
    modelSupportsGenerateContent: null,
    alternatives: [],
    probe: null
  };
  if (!report.configuration.ok) return report;

  engine.resetCircuit(); // a diagnostic should see the real current state
  try {
    const models = await discoverModels(engine);
    const match = models.find(m => m.id === model);
    report.listModels = { ok: true, count: models.length, generateContentCount: models.filter(m => m.supportsGenerateContent).length };
    report.modelListed = Boolean(match);
    report.modelSupportsGenerateContent = match ? match.supportsGenerateContent : null;
    report.alternatives = suggestAlternatives(models, model);
  } catch (error) {
    report.listModels = { ok: false, error };
  }
  report.probe = await probeModel(engine, model);
  return report;
}

module.exports = { normalizeModel, discoverModels, suggestAlternatives, probeModel, diagnose };
