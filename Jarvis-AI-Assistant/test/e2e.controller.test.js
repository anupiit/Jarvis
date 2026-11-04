// End-to-end CLI workflows through the REAL stack:
// InputManager → JarvisController → ProjectPlanner → FileGenerator → SelfCorrector → codeValidator
// → GeminiEngine (cache/queue/limiter/breaker/retry) → Gemini response parsing → atomic writes.
// Only the HTTP transport (Gemini) and the voice service are mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PassThrough } = require('stream');
const config = require('../config/config');
const JarvisController = require('../controllers/JarvisController');
const { GeminiEngine } = require('../services/geminiService');
const { InputManager } = require('../utils/inputManager');
const { setLogSink, resetLogSink } = require('../utils/logger');
const { createMockTransport } = require('./helpers/mockTransport');
const { requestedFile } = require('./helpers/scriptedEngine');
const F = require('./fixtures/geminiResponses');
const APP = require('./fixtures/todoApp');

const FILES = { 'index.html': APP.INDEX_HTML, 'style.css': APP.STYLE_CSS, 'script.js': APP.SCRIPT_JS };
const ok = (text) => ({ body: F.docSuccess(text) });
const promptOf = (req) => req.body.contents[0].parts[0].text;

/** Gemini stand-in: blueprint for planning prompts, file bodies for generation prompts. */
function geminiHandler({ files = FILES, override } = {}) {
  return (req, i) => {
    const prompt = promptOf(req);
    if (override) {
      const o = override(prompt, i);
      if (o) return o;
    }
    if (/Create a project blueprint/.test(prompt)) return ok(JSON.stringify(APP.TODO_BLUEPRINT));
    const corrected = /The file "([^"]+)" you generated failed/.exec(prompt);
    const file = corrected ? corrected[1] : requestedFile(prompt);
    if (file && files[file]) return ok(files[file]);
    return ok('Four.');
  };
}

function mockVoice({ stt = true, tts = false, transcripts = [] } = {}) {
  const queue = [...transcripts];
  const v = {
    listenTimeoutSec: 8,
    listens: 0,
    spoken: [],
    pendingResolve: null,
    async checkAvailability() { return { supported: true, tts, stt, voices: tts ? 1 : 0, culture: 'en-US', reason: null }; },
    async listen({ onListening } = {}) {
      v.listens++;
      if (onListening) onListening();
      const next = queue.shift();
      if (next === 'HANG') return new Promise((resolve) => { v.pendingResolve = resolve; });
      if (typeof next === 'object') return next;
      return { ok: true, text: next, confidence: 0.9 };
    },
    cancelListening() {
      if (v.pendingResolve) { v.pendingResolve({ ok: false, code: 'CANCELLED' }); v.pendingResolve = null; return true; }
      return false;
    },
    async speak(text) { v.spoken.push(text); return { ok: true }; },
    stopSpeaking() {},
    dispose() {}
  };
  return v;
}

async function runSession(lines, { handler = geminiHandler(), voice = mockVoice(), engineSettings = {}, cfg = {}, keepRoot, beforeStart } = {}) {
  const root = keepRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-e2e-'));
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const io = new InputManager({ input, output, terminal: false });
  const transport = createMockTransport(handler);
  const engine = new GeminiEngine({
    apiKey: 'k'.repeat(39), model: 'gemini-test', transport,
    settings: { baseBackoffMs: 1, maxBackoffMs: 5, rateLimitMaxRequests: 1000, ...engineSettings }
  });
  const controller = new JarvisController({
    io, engine, voice, projectsRoot: root,
    config: { ...config, geminiApiKey: 'k'.repeat(39), geminiModel: 'gemini-test', envFileLoaded: true, ...cfg }
  });
  const logs = [];
  setLogSink((l) => logs.push(l), { color: false });
  try {
    if (beforeStart) beforeStart({ controller, input, voice });
    input.end(lines.map(l => `${l}\n`).join(''));
    await controller.start();
  } finally {
    resetLogSink();
  }
  const projectDir = path.join(root, 'todo-list-app');
  const tree = fs.existsSync(projectDir) ? fs.readdirSync(projectDir).sort() : null;
  return { root, logs, text: logs.join('\n'), transport, engine, controller, projectDir, tree, input };
}

const cleanup = (r) => fs.rmSync(r.root, { recursive: true, force: true });

test('E2E 1+6: request → plan → approval → generation → validation, exactly three files', async () => {
  const r = await runSession(['create ' + APP.TODO_REQUEST, 'y', 'exit']);
  assert.deepEqual(r.tree, ['index.html', 'script.js', 'style.css']);
  const html = fs.readFileSync(path.join(r.projectDir, 'index.html'), 'utf8');
  assert.match(html, /<link rel="stylesheet" href="style\.css">/);
  assert.match(html, /<script src="script\.js" defer><\/script>/);
  assert.match(r.text, /PROJECT PLAN/);
  assert.match(r.text, /Files to write \(3\)/);
  assert.match(r.text, /PROJECT GENERATED — 3\/3 files validated and written/);
  // Planning + 3 files = 4 outbound requests, in that order
  assert.equal(r.transport.calls.length, 4);
  assert.match(promptOf(r.transport.calls[0]), /Create a project blueprint/);
  assert.equal(r.transport.calls[0].body.generationConfig.responseMimeType, 'application/json');
  cleanup(r);
});

test('approval matrix: y / yes / Y / YES approve and actually generate', async () => {
  for (const answer of ['y', 'yes', 'Y', 'YES', '  yes  ']) {
    const r = await runSession(['create ' + APP.TODO_REQUEST, answer, 'exit']);
    assert.deepEqual(r.tree, ['index.html', 'script.js', 'style.css'], `answer ${JSON.stringify(answer)}`);
    cleanup(r);
  }
});

test('E2E 4: n / no / N / NO cancel and write nothing (no project folder, no generation calls)', async () => {
  for (const answer of ['n', 'no', 'N', 'NO']) {
    const r = await runSession(['create ' + APP.TODO_REQUEST, answer, 'exit']);
    assert.equal(r.tree, null, `answer ${answer}`);
    assert.deepEqual(fs.readdirSync(r.root), []);
    assert.equal(r.transport.calls.length, 1, 'only the planning request was sent');
    assert.match(r.text, /cancelled — no files were written/);
    cleanup(r);
  }
});

test('invalid answers ask again, then the valid answer is honoured', async () => {
  const r = await runSession(['create ' + APP.TODO_REQUEST, 'maybe', '', 'yellow', 'y', 'exit']);
  assert.equal((r.text.match(/Please answer "y" \(yes\) or "n" \(no\)/g) || []).length, 3);
  assert.deepEqual(r.tree, ['index.html', 'script.js', 'style.css']);
  cleanup(r);
});

test('input ending at the approval prompt cancels safely (no files, no crash)', async () => {
  const r = await runSession(['create ' + APP.TODO_REQUEST]);
  assert.equal(r.tree, null);
  assert.match(r.text, /Input ended before an answer/);
  assert.match(r.text, /Goodbye/);
  cleanup(r);
});

test('E2E 2: Gemini failure → useful diagnostic → back at the prompt → recovery on the next request', async () => {
  let healthy = false;
  const handler = (req, i) => (healthy ? geminiHandler()(req, i) : { status: 503, body: F.DOC_OVERLOADED_503 });
  const r = await runSession(['create ' + APP.TODO_REQUEST, 'stats', 'create ' + APP.TODO_REQUEST, 'y', 'exit'], {
    handler,
    engineSettings: { maxRetries: 1, circuitFailureThreshold: 100 },
    beforeStart: ({ controller }) => {
      const original = controller.showStats.bind(controller);
      controller.showStats = () => { original(); healthy = true; }; // service recovers after the first failure
    }
  });
  assert.match(r.text, /Planning failed: Gemini is temporarily unavailable \(HTTP 503 UNAVAILABLE\): The model is overloaded/);
  assert.match(r.text, /retry 1\/1/);
  assert.match(r.text, /No files were written/);
  assert.match(r.text, /PROJECT GENERATED — 3\/3/);
  assert.deepEqual(r.tree, ['index.html', 'script.js', 'style.css']);
  cleanup(r);
});

test('model not found → diagnostic tells the user to run "models"', async () => {
  const r = await runSession(['create a todo app', 'exit'], { handler: () => ({ status: 404, body: F.DOC_MODEL_NOT_FOUND_404 }) });
  assert.match(r.text, /model not found \(HTTP 404 NOT_FOUND\)/);
  assert.match(r.text, /Run "models"/);
  assert.equal(r.transport.calls.length, 1, '404 is not retried');
  cleanup(r);
});

test('very long Retry-After returns control instead of freezing the CLI', async () => {
  const body = JSON.parse(JSON.stringify(F.DOC_RATE_LIMIT_429));
  body.error.details[1].retryDelay = '14400s';
  const started = Date.now();
  const r = await runSession(['create a todo app', 'help', 'exit'], { handler: () => ({ status: 429, body }) });
  assert.ok(Date.now() - started < 3000);
  assert.match(r.text, /about 4 h/);
  assert.match(r.text, /JARVIS — COMMANDS/, 'the next command ran');
  cleanup(r);
});

test('E2E 3: generated syntax error → AI correction → validated project', async () => {
  let jsAttempts = 0;
  const handler = geminiHandler({
    override: (prompt) => {
      if (requestedFile(prompt) === 'script.js' && !/you generated failed/.test(prompt)) {
        jsAttempts++;
        return ok(APP.SCRIPT_JS.replace('function save() {', 'function save() {{'));
      }
      return null;
    }
  });
  const r = await runSession(['create ' + APP.TODO_REQUEST, 'y', 'exit'], { handler });
  assert.equal(jsAttempts, 1);
  assert.match(r.text, /🔧 script\.js: 1 validation issue\(s\) \(syntax/);
  assert.match(r.text, /AI correction 1\/3/);
  assert.match(r.text, /script\.js — valid after 1 correction/);
  assert.equal(fs.readFileSync(path.join(r.projectDir, 'script.js'), 'utf8').trim(), APP.SCRIPT_JS.trim());
  cleanup(r);
});

test('E2E 5: voice input → transcription → same command pipeline (create, typed approval)', async () => {
  const voice = mockVoice({ transcripts: [APP.TODO_REQUEST, 'exit voice'] }); // the request itself starts with "Create"
  const r = await runSession(['voice', '', 'y', '', 'exit'], { voice });
  assert.equal(voice.listens, 2);
  assert.match(r.text, /🗣️ Heard: "Create a simple modern responsive To-Do List web application/);
  assert.match(r.text, /🗣️ Heard: "exit voice"/);
  assert.match(r.text, /PROJECT GENERATED — 3\/3/);
  assert.match(r.text, /Voice mode off/);
  assert.deepEqual(r.tree, ['index.html', 'script.js', 'style.css']);
  cleanup(r);
});

test('listen: one-shot push-to-talk processes the transcription like typed input', async () => {
  const voice = mockVoice({ transcripts: ['hello'] });
  const r = await runSession(['listen', 'exit'], { voice });
  assert.match(r.text, /Heard: "hello"/);
  assert.match(r.text, /Hello! I'm Jarvis/);
  cleanup(r);
});

test('voice recognition failure → hint, back at the prompt; typed fallback works in voice mode', async () => {
  const voice = mockVoice({ transcripts: [{ ok: false, code: 'NO_MICROPHONE', message: 'No audio input is supplied to this recognizer.' }] });
  const r = await runSession(['voice', '', 'help', 'exit voice', 'exit'], { voice });
  assert.match(r.text, /No audio input is supplied/);
  assert.match(r.text, /Privacy & security > Microphone/);
  assert.match(r.text, /JARVIS — COMMANDS/, 'typed text in voice mode is processed');
  assert.match(r.text, /Voice mode off/);
  cleanup(r);
});

test('Ctrl+C while listening cancels recognition and keeps Jarvis running', async () => {
  const voice = mockVoice({ transcripts: ['HANG'] });
  const r = await runSession(['listen', 'help', 'exit'], {
    voice,
    beforeStart: ({ controller }) => {
      const original = voice.listen;
      voice.listen = (opts) => { const p = original(opts); setTimeout(() => controller.handleInterrupt(), 10); return p; };
    }
  });
  assert.match(r.text, /Listening cancelled/);
  assert.match(r.text, /JARVIS — COMMANDS/);
  cleanup(r);
});

test('speech recognition unavailable → clear explanation, typed input unaffected', async () => {
  const r = await runSession(['listen', 'voice', 'help', 'exit voice', 'exit'], { voice: mockVoice({ stt: false }) });
  assert.match(r.text, /Speech recognition is not available/);
  assert.match(r.text, /typed input still works in voice mode/);
  cleanup(r);
});

test('voice on / voice off toggle spoken replies', async () => {
  const voice = mockVoice({ tts: true });
  const r = await runSession(['voice off', 'hi', 'voice on', 'hi', 'exit'], { voice });
  assert.match(r.text, /Spoken replies off/);
  assert.match(r.text, /Spoken replies on/);
  assert.equal(voice.spoken.filter(s => /Hello! I'm Jarvis/.test(s)).length, 1, 'only the second greeting was spoken');
  cleanup(r);
});

test('"hi" gets a greeting; general questions are answered by Gemini; without a key they get an explanation', async () => {
  const r = await runSession(['hi', 'what is 2+2?', 'exit']);
  assert.match(r.text, /Hello! I'm Jarvis/);
  assert.match(r.text, /🤖 Four\./);
  cleanup(r);
  const noKey = await runSession(['what is 2+2?', 'exit'], { cfg: { geminiApiKey: '' } });
  assert.match(noKey.text, /not a Jarvis command, and general questions need Gemini/);
  assert.equal(noKey.transport.calls.length, 0);
  cleanup(noKey);
});

test('a single stdin reader across commands, approvals and voice mode (no duplicate listeners)', async () => {
  const counts = [];
  const voice = mockVoice({ transcripts: ['help'] });
  const r = await runSession(['voice', '', 'exit voice', 'create ' + APP.TODO_REQUEST, 'n', 'listen', 'exit'], {
    voice: Object.assign(voice, { transcripts: undefined }),
    beforeStart: ({ controller, input }) => {
      counts.push(input.listenerCount('data'));
      const ask = controller.io.ask.bind(controller.io);
      controller.io.ask = (...a) => { counts.push(input.listenerCount('data')); return ask(...a); };
      const listen = voice.listen;
      voice.listen = (...a) => { counts.push(input.listenerCount('data')); return listen(...a); };
    }
  });
  assert.match(r.text, /cancelled/);
  assert.ok(counts.length >= 8, `sampled ${counts.length} times`);
  assert.ok(counts.every(c => c === counts[0]), `stdin 'data' listener count changed during the session: ${counts}`);
  cleanup(r);
});

test('stats show real request counts without prompt contents', async () => {
  const r = await runSession(['create ' + APP.TODO_REQUEST, 'y', 'stats', 'exit']);
  assert.match(r.text, /Calls: 4 \| outbound HTTP: 4/);
  assert.doesNotMatch(r.text.split('📊')[1], /To-Do List web application/);
  cleanup(r);
});

test('models command lists the live model list and flags a missing configured model', async () => {
  const handler = (req) => (req.method === 'GET' ? { body: { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }] } } : ok('x'));
  const r = await runSession(['models', 'exit'], { handler });
  assert.match(r.text, /• gemini-a/);
  assert.match(r.text, /"gemini-test" is not in this list/);
  cleanup(r);
});

test('diagnose: ListModels OK but generation fails → reports the real failure and live alternatives', async () => {
  const handler = (req) => (req.method === 'GET'
    ? { body: { models: [{ name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] }, { name: 'models/gemini-other-flash', supportedGenerationMethods: ['generateContent'] }] } }
    : { status: 429, body: F.DOC_ZERO_LIMIT_429 });
  const r = await runSession(['diagnose', 'exit'], { handler });
  assert.match(r.text, /2\. ListModels: OK/);
  assert.match(r.text, /"gemini-test" listed: yes/);
  assert.match(r.text, /4\. Live generation with "gemini-test": FAILED/);
  assert.match(r.text, /requires billing/);
  assert.match(r.text, /gemini-other-flash/);
  cleanup(r);
});

test('open refuses paths outside the workspace', async () => {
  const r = await runSession(['open ../../../../../../etc/hostname', 'exit']);
  assert.match(r.text, /For safety, open only shows files inside/);
  cleanup(r);
});
