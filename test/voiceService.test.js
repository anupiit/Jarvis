// Voice pipeline tests with a FAKE PowerShell process (mocked speech engine).
// These do not exercise Windows SAPI, a microphone or speakers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { VoiceService, prepareSpokenText, scripts } = require('../services/voiceService');
const { createFakeSpawn } = require('./helpers/fakePowerShell');

const win = (behaviour, opts = {}) => {
  const fake = createFakeSpawn(behaviour);
  const voice = new VoiceService({ platform: 'win32', spawnPowerShell: fake.spawnPowerShell, ...opts });
  return { voice, fake };
};

test('TTS passes text only via environment variable — never in the command line (no injection)', async () => {
  const { voice, fake } = win((call, io) => io.exit(0));
  const hostile = `"; Remove-Item -Recurse C:\\ ; " $(Start-Process calc) & del /q * | whoami`;
  const r = await voice.speak(hostile);
  assert.equal(r.ok, true);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].script, scripts.TTS_SCRIPT, 'the script is the fixed constant');
  assert.ok(!fake.calls[0].script.includes('Remove-Item'));
  assert.ok(fake.calls[0].env.JARVIS_TTS_TEXT.includes('Remove-Item'), 'text travels as data');
  assert.equal(fake.calls[0].env.JARVIS_TTS_RATE, '0');
  assert.equal(fake.calls[0].env.JARVIS_TTS_VOLUME, '100');
});

test('PowerShell scripts are constants without double quotes (safe as one spawn argument)', () => {
  for (const s of Object.values(scripts)) {
    assert.ok(!s.includes('"'));
    assert.ok(!s.includes('${'));
  }
});

test('a new utterance cancels speech already in progress', async () => {
  const { voice, fake } = win((call, io) => { if (fake.calls.length > 1) io.exit(0); /* first never ends */ });
  const first = voice.speak('first sentence');
  await new Promise(r => setImmediate(r));
  const second = await voice.speak('second sentence');
  assert.equal(second.ok, true);
  assert.equal(fake.calls[0].child.killed, true);
  assert.equal((await first).code, 'CANCELLED');
});

test('spoken text drops markdown/code/emoji and is length-capped', () => {
  assert.equal(prepareSpokenText('**Hello** `x` 🚀 [link](http://a)'), 'Hello x link');
  assert.match(prepareSpokenText('Run:\n```js\nconsole.log(1)\n```\nDone'), /code omitted/);
  const long = prepareSpokenText('This is a sentence. '.repeat(100), 100);
  assert.ok(long.length < 140);
  assert.match(long, /rest is on screen/);
});

test('speech recognition success returns the transcription and signals "listening"', async () => {
  const { voice, fake } = win((call, io) => {
    io.out('{"event":"listening"}');
    io.out('{"ok":true,"text":"create a todo list app","confidence":0.91}');
    io.exit(0);
  });
  let listening = false;
  const r = await voice.listen({ timeoutSec: 5, onListening: () => { listening = true; } });
  assert.deepEqual(r, { ok: true, text: 'create a todo list app', confidence: 0.91 });
  assert.equal(listening, true);
  assert.equal(fake.calls[0].script, scripts.STT_SCRIPT);
  assert.equal(fake.calls[0].env.JARVIS_STT_TIMEOUT, '5');
  assert.match(fake.calls[0].env.JARVIS_STT_COMMANDS, /exit voice/);
});

test('recognition failures are reported with codes: no microphone, no speech, no recognizer', async () => {
  for (const [code, out] of [
    ['NO_MICROPHONE', '{"ok":false,"code":"NO_MICROPHONE","message":"No audio input is supplied to this recognizer."}'],
    ['NO_SPEECH', '{"ok":false,"code":"NO_SPEECH","message":"No speech was recognized before the timeout."}'],
    ['NO_RECOGNIZER', '{"ok":false,"code":"NO_RECOGNIZER","message":"No speech recognizer is installed."}']
  ]) {
    const { voice } = win((call, io) => { io.out(out); io.exit(0); });
    const r = await voice.listen();
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.ok(VoiceService.hint(code));
  }
});

test('an empty transcription is treated as no speech', async () => {
  const { voice } = win((call, io) => { io.out('{"ok":true,"text":"  ","confidence":0.2}'); io.exit(0); });
  assert.equal((await voice.listen()).code, 'NO_SPEECH');
});

test('cancelListening kills the recognizer process and resolves CANCELLED', async () => {
  const { voice, fake } = win((call, io) => io.out('{"event":"listening"}')); // never finishes
  const pending = voice.listen();
  await new Promise(r => setTimeout(r, 10));
  assert.equal(voice.cancelListening(), true);
  const r = await pending;
  assert.equal(r.code, 'CANCELLED');
  assert.equal(fake.calls[0].child.killed, true);
  assert.equal(voice.listenChild, null, 'process reference released');
});

test('a hung recognizer is killed by the guard timeout', async () => {
  const { voice, fake } = win(() => {}, { listenGuardExtraMs: 30 });
  const r = await voice.listen({ timeoutSec: 0 });
  assert.equal(r.code, 'TIMEOUT');
  assert.equal(fake.calls[0].child.killed, true);
});

test('only one recognition at a time', async () => {
  const { voice } = win(() => {});
  const first = voice.listen();
  await new Promise(r => setImmediate(r));
  assert.equal((await voice.listen()).code, 'BUSY');
  voice.cancelListening();
  await first;
});

test('listening stops any speech first (never transcribe our own voice)', async () => {
  const { voice, fake } = win((call, io) => { if (call.script === scripts.STT_SCRIPT) { io.out('{"ok":true,"text":"help"}'); io.exit(0); } });
  voice.speak('long answer');
  await new Promise(r => setImmediate(r));
  await voice.listen();
  assert.equal(fake.calls[0].child.killed, true);
});

test('PowerShell missing → POWERSHELL_UNAVAILABLE (no crash)', async () => {
  const { voice } = win((call, io) => io.fail(Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })));
  assert.equal((await voice.listen()).code, 'POWERSHELL_UNAVAILABLE');
  assert.equal((await voice.speak('hi')).code, 'POWERSHELL_UNAVAILABLE');
});

test('availability probe parses SAPI voices and recognizers', async () => {
  const { voice } = win((call, io) => { io.out('{"tts":true,"voices":2,"stt":true,"recognizers":1,"culture":"en-US","error":null}'); io.exit(0); });
  const a = await voice.checkAvailability();
  assert.deepEqual({ tts: a.tts, stt: a.stt, voices: a.voices, culture: a.culture }, { tts: true, stt: true, voices: 2, culture: 'en-US' });
});

test('no recognizer installed → listen refuses without spawning', async () => {
  const { voice, fake } = win((call, io) => { io.out('{"tts":true,"voices":1,"stt":false,"recognizers":0,"culture":"de-DE","error":null}'); io.exit(0); });
  await voice.checkAvailability();
  assert.equal((await voice.listen()).code, 'NO_RECOGNIZER');
  assert.equal(fake.calls.length, 1);
});

test('non-Windows platforms report unsupported and never spawn processes', async () => {
  const fake = createFakeSpawn(() => { throw new Error('must not spawn'); });
  const voice = new VoiceService({ platform: 'linux', spawnPowerShell: fake.spawnPowerShell });
  assert.equal((await voice.checkAvailability()).supported, false);
  assert.equal((await voice.listen()).code, 'UNSUPPORTED_PLATFORM');
  assert.equal((await voice.speak('hello')).code, 'UNSUPPORTED_PLATFORM');
  assert.equal(fake.calls.length, 0);
});

test('dispose stops speech and listening processes', async () => {
  const { voice, fake } = win(() => {});
  voice.speak('a');
  const l = voice.listen();
  await new Promise(r => setImmediate(r));
  voice.dispose();
  await l;
  assert.ok(fake.calls.every(c => c.child.killed));
});
