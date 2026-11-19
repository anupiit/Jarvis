#!/usr/bin/env node
// Voice benchmark.
//  1. In-process dispatch latency with a MOCK recognizer: time from "transcription available"
//     to the command being routed and answered. Measures Jarvis's own code path only.
//  2. Windows only: cold start time of powershell.exe (the process every TTS/STT call spawns),
//     and of the SAPI availability probe. Not measurable on other platforms.
// Physical microphone/speaker behaviour is NOT measured by this script.
const { spawnSync } = require('child_process');
const JarvisController = require('../controllers/JarvisController');
const { VoiceService } = require('../services/voiceService');
const { setLogSink, resetLogSink } = require('../utils/logger');
const config = require('../config/config');
const { stats, writeResult } = require('./lib/benchUtil');

async function dispatchLatency(iterations = 500) {
  let resolveHeard = null;
  const voice = {
    listenTimeoutSec: 8,
    async listen() { return { ok: true, text: 'hello', confidence: 0.95, _t: (resolveHeard = process.hrtime.bigint()) }; },
    async checkAvailability() { return { supported: true, tts: false, stt: true }; },
    speak: async () => ({ ok: true }), stopSpeaking() {}, cancelListening() { return false; }, dispose() {}
  };
  const io = { ask: async () => null, close() {}, onSigint() {} };
  const engine = { model: 'none', generate: async () => { throw new Error('not used'); }, stats: () => null };
  const controller = new JarvisController({ io, voice, engine, config: { ...config, VOICE_ENABLED: false } });
  controller.voiceInfo = { supported: true, stt: true, tts: false };
  const samples = [];
  let answeredAt = null;
  setLogSink((line) => { if (line.includes("Hello! I'm Jarvis")) answeredAt = process.hrtime.bigint(); }, { color: false });
  try {
    for (let i = 0; i < iterations; i++) {
      answeredAt = null;
      await controller.listenOnce();
      samples.push(Number(answeredAt - resolveHeard) / 1e6);
    }
  } finally {
    resetLogSink();
  }
  return stats(samples.slice(50));
}

function powershellStartup(iterations = 10) {
  if (process.platform !== 'win32') return { measured: false, reason: `not Windows (${process.platform})` };
  const cold = [];
  for (let i = 0; i < iterations; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { windowsHide: true });
    if (r.error) return { measured: false, reason: r.error.message };
    cold.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return { measured: true, emptyCommandMs: stats(cold) };
}

async function sapiProbe() {
  if (process.platform !== 'win32') return { measured: false, reason: `not Windows (${process.platform})` };
  const v = new VoiceService();
  const t = process.hrtime.bigint();
  const a = await v.checkAvailability();
  return { measured: true, ms: Math.round(Number(process.hrtime.bigint() - t) / 1e6), availability: a };
}

(async () => {
  const out = {
    benchmark: 'voice',
    dispatchLatencyMs: { recognizer: 'MOCK (in-memory, returns "hello")', ...(await dispatchLatency()) },
    powershellStartup: powershellStartup(),
    sapiProbe: await sapiProbe(),
    physicalMicrophoneSpeakerTest: 'NOT PERFORMED by this script'
  };
  console.log(JSON.stringify(out, null, 2));
  console.log('Saved:', writeResult(`voice-${process.platform}`, out));
})();
