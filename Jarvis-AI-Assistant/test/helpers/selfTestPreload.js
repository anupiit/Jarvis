// Preloaded (node --require) ONLY by `scripts/e2e-todo.js --self-test`.
// Starts a local HTTP server that imitates the Gemini generateContent endpoint and points the
// real Jarvis HTTP client at it. Responses are the hand-written reference app — NOT Gemini output.
// This validates the benchmark harness and the real CLI/HTTP path; it is not a generation test.
const http = require('http');
const config = require('../../config/config');
const APP = require('../fixtures/todoApp');
const F = require('../fixtures/geminiResponses');

const port = 40000 + (process.pid % 20000);
const files = { 'index.html': APP.INDEX_HTML, 'style.css': APP.STYLE_CSS, 'script.js': APP.SCRIPT_JS };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.headers['x-goog-api-key'] !== 'selftest-key') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(F.CAPTURED_INVALID_KEY_400));
      return;
    }
    const prompt = JSON.parse(body || '{}').contents?.[0]?.parts?.[0]?.text || '';
    let text = 'OK';
    if (/Create a project blueprint/.test(prompt)) text = JSON.stringify(APP.TODO_BLUEPRINT);
    else {
      const m = /contents of the file "([^"]+)"|The file "([^"]+)" you generated/.exec(prompt);
      const f = m && (m[1] || m[2]);
      if (f && files[f]) text = files[f];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(F.docSuccess(text)));
  });
});
server.on('error', (e) => { console.error(`self-test server failed: ${e.message}`); process.exit(3); });
server.listen(port, '127.0.0.1');
server.unref();

config.GEMINI.baseUrl = `http://127.0.0.1:${port}`;
config.geminiApiKey = 'selftest-key';
config.geminiModel = 'selftest-model';
config.envFileLoaded = true;
if (process.env.JARVIS_SELFTEST_PROJECTS_ROOT) config.PROJECTS_ROOT = process.env.JARVIS_SELFTEST_PROJECTS_ROOT;
