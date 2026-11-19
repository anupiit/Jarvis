#!/usr/bin/env node
// PHYSICAL voice test for Windows (microphone + speakers). Run it yourself:  npm run voice:check
// It records what YOU observed (heard the speech? transcription correct?) — nothing is assumed.
const readline = require('readline');
const { VoiceService } = require('../services/voiceService');
const { writeResult } = require('./lib/benchUtil');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((resolve) => rl.question(q, (a) => resolve(a.trim().toLowerCase())));

(async () => {
  if (process.platform !== 'win32') {
    console.log(`This check needs Windows (current platform: ${process.platform}).`);
    rl.close();
    process.exit(2);
  }
  const voice = new VoiceService();
  const results = { trials: [] };
  let t = Date.now();
  results.availability = await voice.checkAvailability();
  results.availabilityProbeMs = Date.now() - t;
  console.log('Availability:', results.availability, `(${results.availabilityProbeMs} ms)`);

  t = Date.now();
  const spoken = await voice.speak('This is the Jarvis speaker test.');
  results.tts = { result: spoken, ms: Date.now() - t, heard: (await ask('Did you hear "This is the Jarvis speaker test"? (y/n): ')) === 'y' };

  const phrases = ['create a to do list app', 'help', 'exit voice'];
  for (const phrase of phrases) {
    await ask(`\nPress Enter, then say: "${phrase}" `);
    t = Date.now();
    const r = await voice.listen({ onListening: () => console.log('Listening...') });
    const ms = Date.now() - t;
    console.log('Result:', r, `(${ms} ms)`);
    const correct = r.ok ? (await ask('Was the transcription correct? (y/n): ')) === 'y' : false;
    results.trials.push({ expected: phrase, result: r, ms, judgedCorrect: correct });
  }
  results.summary = {
    speakerHeard: results.tts.heard,
    recognitionCorrect: `${results.trials.filter(x => x.judgedCorrect).length}/${results.trials.length}`
  };
  console.log('\nSummary:', results.summary);
  console.log('Saved:', writeResult('voice-physical-windows', results));
  voice.dispose();
  rl.close();
})();
