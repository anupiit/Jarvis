// 15 syntax/structure-defect fixtures with a hand-written correct version of each.
// Used to measure (a) whether the validator DETECTS each defect and accepts the fix,
// and (b) the self-correction loop plumbing with a scripted (mock) corrector.
// A mocked corrector returning the known fix says nothing about Gemini's real repair rate.

const DEFECTS = [
  { id: 'js-missing-brace', path: 'script.js', broken: 'function add(a, b) {\n  return a + b;\n', fixed: 'function add(a, b) {\n  return a + b;\n}\n', expectRule: 'syntax' },
  { id: 'js-unterminated-string', path: 'script.js', broken: "const msg = 'hello;\nconsole.log(msg);\n", fixed: "const msg = 'hello';\nconsole.log(msg);\n", expectRule: 'syntax' },
  { id: 'js-extra-paren', path: 'script.js', broken: 'console.log((1 + 2)));\n', fixed: 'console.log((1 + 2));\n', expectRule: 'syntax' },
  { id: 'js-import-in-classic-script', path: 'script.js', broken: "import { x } from './x.js';\nconsole.log(x);\n", fixed: 'const x = 1;\nconsole.log(x);\n', expectRule: 'syntax', context: { environment: 'browser', moduleType: 'script' } },
  { id: 'js-require-in-browser', path: 'script.js', broken: "const fs = require('fs');\n", fixed: 'const store = window.localStorage;\n', expectRule: 'node-api-in-browser', context: { environment: 'browser', moduleType: 'script' } },
  { id: 'esm-bad-export', path: 'app.mjs', broken: 'export const = 5;\n', fixed: 'export const value = 5;\n', expectRule: 'syntax' },
  { id: 'cjs-bad-arrow', path: 'server.js', broken: "module.exports = (req, res) => {\n  res.end('ok';\n};\n", fixed: "module.exports = (req, res) => {\n  res.end('ok');\n};\n", expectRule: 'syntax' },
  { id: 'json-trailing-comma', path: 'data.json', broken: '{ "a": 1, }', fixed: '{ "a": 1 }', expectRule: 'syntax' },
  { id: 'json-single-quotes', path: 'data.json', broken: "{ 'a': 1 }", fixed: '{ "a": 1 }', expectRule: 'syntax' },
  { id: 'css-unclosed-block', path: 'style.css', broken: 'body {\n  color: red;\n\n.card { padding: 1rem; }\n', fixed: 'body {\n  color: red;\n}\n\n.card { padding: 1rem; }\n', expectRule: 'unclosed-block' },
  { id: 'css-stray-brace', path: 'style.css', broken: 'body { color: red; }\n}\n', fixed: 'body { color: red; }\n', expectRule: 'unexpected-closing-brace' },
  { id: 'css-missing-colon', path: 'style.css', broken: 'body {\n  color red;\n}\n', fixed: 'body {\n  color: red;\n}\n', expectRule: 'invalid-declaration' },
  { id: 'html-unclosed-div', path: 'index.html', broken: '<!DOCTYPE html>\n<html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width"></head>\n<body>\n<div class="card">\n<p>Hi</p>\n</body>\n</html>', fixed: '<!DOCTYPE html>\n<html lang="en"><head><title>x</title><meta name="viewport" content="width=device-width"></head>\n<body>\n<div class="card">\n<p>Hi</p>\n</div>\n</body>\n</html>', expectRule: 'unclosed-tag' },
  { id: 'html-truncated', path: 'index.html', broken: '<!DOCTYPE html>\n<html lang="en"><head><title>x</title></head>\n<body>\n<main>\n<h1>To', fixed: '<!DOCTYPE html>\n<html lang="en"><head><title>x</title></head>\n<body>\n<main>\n<h1>Todo</h1>\n</main>\n</body>\n</html>', expectRule: 'unclosed-tag' },
  { id: 'html-markdown-fence', path: 'index.html', broken: '```html\n<!DOCTYPE html>\n<html lang="en"><head><title>x</title></head><body></body></html>\n```', fixed: '<!DOCTYPE html>\n<html lang="en"><head><title>x</title></head><body></body></html>', expectRule: 'markdown-fence' }
];

module.exports = { DEFECTS };
