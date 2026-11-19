#!/usr/bin/env node
// Standalone Gemini diagnostic: configuration → ListModels → live generation probe.
// Usage: npm run diagnose [-- <model>]
require('../utils/processSafety').installProcessSafetyNet();
const JarvisController = require('../controllers/JarvisController');
const { GeminiEngine } = require('../services/geminiService');

(async () => {
  const engine = new GeminiEngine();
  const io = { ask: async () => null, close() {}, onSigint() {} };
  const voice = { checkAvailability: async () => ({ supported: false }), dispose() {}, stopSpeaking() {} };
  const jarvis = new JarvisController({ engine, io, voice });
  const report = await jarvis.runDiagnostics(process.argv[2]);
  if (report.configuration.ok && report.listModels && report.listModels.ok) await jarvis.showModels();
  engine.shutdown();
  process.exit(report.probe && report.probe.ok ? 0 : 1);
})();
