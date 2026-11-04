const test = require('node:test');
const assert = require('node:assert/strict');
const { validateFile } = require('../services/codeValidator');
const { extractCode } = require('../utils/codeExtraction');
const { DEFECTS } = require('./fixtures/defectCorpus');
const APP = require('./fixtures/todoApp');

const v = (path, content, context = {}) => validateFile({ path, content, context });
const rules = (r) => r.errors.map(e => e.rule);

test('reference To-Do app (3 files) validates cleanly with references checked', async () => {
  const planned = ['index.html', 'style.css', 'script.js'];
  const html = await v('index.html', APP.INDEX_HTML, { plannedFiles: planned, expectedReferences: ['style.css', 'script.js'], forbiddenCategories: ['external-libraries'] });
  assert.equal(html.valid, true, JSON.stringify(html.errors));
  assert.deepEqual(html.meta.ids.sort(), ['add-button', 'empty-state', 'task-form', 'task-input', 'task-list']);
  const css = await v('style.css', APP.STYLE_CSS);
  assert.equal(css.valid, true, JSON.stringify(css.errors));
  const js = await v('script.js', APP.SCRIPT_JS, { environment: 'browser', moduleType: 'script', htmlIds: html.meta.ids, forbiddenCategories: ['react', 'node', 'external-libraries', 'network-apis'] });
  assert.equal(js.valid, true, JSON.stringify(js.errors));
  assert.deepEqual(js.warnings, []);
});

for (const d of DEFECTS) {
  test(`defect corpus: detects ${d.id} and accepts its fix`, async () => {
    const broken = await v(d.path, d.broken, d.context || {});
    assert.equal(broken.valid, false, `${d.id} should be invalid`);
    assert.ok(rules(broken).includes(d.expectRule), `${d.id}: expected rule ${d.expectRule}, got ${rules(broken)}`);
    const fixed = await v(d.path, d.fixed, d.context || {});
    assert.equal(fixed.valid, true, `${d.id} fix should be valid: ${JSON.stringify(fixed.errors)}`);
  });
}

test('JavaScript: CommonJS allows require/module.exports and top-level return', async () => {
  assert.equal((await v('server.js', "const http = require('http');\nif (!http) return;\nmodule.exports = http;", { environment: 'node' })).valid, true);
});

test('JavaScript: ES module syntax is checked with node --check', async () => {
  assert.equal((await v('app.mjs', 'import fs from "fs";\nexport default fs;\n')).valid, true);
  const bad = await v('app.mjs', 'import from "fs";\n');
  assert.equal(bad.valid, false);
  assert.match(bad.errors[0].message, /module/);
});

test('JavaScript: syntax errors report a line number and truncation hint', async () => {
  const r = await v('script.js', 'const a = 1;\nconst b = 2;\nfunction f() {\n  return a +\n');
  assert.equal(r.valid, false);
  assert.match(r.errors[0].message, /may be truncated/);
});

test('JavaScript: forbidden technologies are flagged from the request constraints', async () => {
  const ctx = { environment: 'browser', moduleType: 'module', forbiddenCategories: ['react', 'external-libraries', 'network-apis'] };
  const r = await v('app.js', "import React from 'react';\nfetch('https://api.example.com/x');\nexport default React;", ctx);
  assert.ok(rules(r).includes('forbidden-technology'));
  assert.ok(rules(r).includes('forbidden-external-resource'));
});

test('JavaScript: element ids missing from the HTML produce a warning (not an error)', async () => {
  const r = await v('script.js', "document.getElementById('missing-id'); document.querySelector('#task-list');", { environment: 'browser', moduleType: 'script', htmlIds: ['task-list'] });
  assert.equal(r.valid, true);
  assert.equal(r.warnings[0].rule, 'unknown-element-id');
  assert.match(r.warnings[0].message, /#missing-id/);
});

test('JSON: valid and invalid', async () => {
  assert.equal((await v('package.json', '{"name":"x","version":"1.0.0"}')).valid, true);
  const r = await v('package.json', '{"name": "x",\n "version": }');
  assert.equal(r.valid, false);
  assert.ok(r.errors[0].line >= 1);
});

test('CSS: nested at-rules, custom properties, url(data:...;) and strings are handled', async () => {
  const css = `@import url("a.css");\n@media (max-width: 600px) { .a { color: var(--x, red); } }\n.b { background: url(data:image/png;base64,AAAA); content: "a;b{}"; }\n.c { &:hover { color: blue } }\n@font-face { font-family: "X"; src: url(x.woff2) format("woff2"); }`;
  const r = await v('style.css', css);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('CSS: unclosed comment and trailing content (truncation) are errors', async () => {
  assert.ok(rules(await v('style.css', 'body { color: red; }\n/* unfinished')).includes('unclosed-comment'));
  assert.ok(rules(await v('style.css', 'body { color: red; }\n.card { padd')).includes('unclosed-block'));
  assert.ok(rules(await v('style.css', 'body { color: red; }\n.card')).includes('unexpected-trailing-content'));
});

test('HTML: optional end tags (p, li, td) are not false positives', async () => {
  const html = '<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>t</title></head><body><p>one<p>two<ul><li>a<li>b</ul><table><tr><td>1<td>2</table><img src="x.png" alt=""><br></body></html>';
  const r = await v('index.html', html);
  assert.equal(r.valid, true, JSON.stringify(r.errors));
});

test('HTML: mismatched closing tag and unterminated attribute are errors', async () => {
  assert.ok(rules(await v('index.html', '<!DOCTYPE html><html><body><div><span></div></span></body></html>')).includes('unclosed-tag'));
  assert.ok(rules(await v('index.html', '<!DOCTYPE html><html><body><div class="x>hi</div></body></html>')).includes('unterminated-attribute'));
  assert.ok(rules(await v('index.html', '<!DOCTYPE html><html><body></section></body></html>')).includes('unexpected-closing-tag'));
});

test('HTML: wrong stylesheet name (styles.css vs style.css) is a broken reference with a suggestion', async () => {
  const html = APP.INDEX_HTML.replace('href="style.css"', 'href="styles.css"');
  const r = await v('index.html', html, { plannedFiles: ['index.html', 'style.css', 'script.js'], expectedReferences: ['style.css', 'script.js'] });
  assert.ok(rules(r).includes('broken-reference'));
  assert.ok(rules(r).includes('missing-reference'));
  assert.match(r.errors.find(e => e.rule === 'broken-reference').message, /did you mean "style\.css"/);
});

test('HTML: CDN script is rejected when external libraries are forbidden', async () => {
  const html = APP.INDEX_HTML.replace('</head>', '<script src="https://cdn.jsdelivr.net/npm/lodash@4/lodash.min.js"></script></head>');
  const r = await v('index.html', html, { forbiddenCategories: ['external-libraries'] });
  assert.ok(rules(r).includes('forbidden-external-resource'));
});

test('HTML: inline <script> and <style> are validated too', async () => {
  const html = '<!DOCTYPE html><html><head><title>t</title><style>body { color red; }</style></head><body><script>let x = ;</script></body></html>';
  const r = await v('index.html', html);
  assert.ok(rules(r).includes('invalid-declaration'));
  assert.ok(rules(r).includes('syntax'));
});

test('generic: empty, prose prefix, placeholder and truncation flags', async () => {
  assert.deepEqual(rules(await v('script.js', '   \n')), ['empty']);
  assert.ok(rules(await v('script.js', "Here is the code:\nconsole.log('x');")).includes('unexpected-prose'));
  assert.ok(rules(await v('script.js', "console.log('a');\n// ... rest of the code\n")).includes('incomplete'));
  assert.ok(rules(await v('script.js', "console.log('a');", { truncated: true })).includes('truncated'));
  assert.ok(rules(await v('script.js', "console.log('a');", { unclosedFence: true })).includes('truncated'));
});

test('markdown: unclosed fence is detected, balanced fences are fine', async () => {
  assert.equal((await v('README.md', '# Title\n```js\ncode\n```\n')).valid, true);
  assert.ok(rules(await v('README.md', '# Title\n```js\ncode\n')).includes('unclosed-fence'));
});

test('regression: committed sample components/Button.js (truncated, stray fence) is rejected', async () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'projectsByJarvis', 'anup-calculator-app', 'components', 'Button.js');
  if (!fs.existsSync(file)) return;
  const r = await v('components/Button.js', fs.readFileSync(file, 'utf8'), { environment: 'browser', moduleType: 'script' });
  assert.equal(r.valid, false);
  assert.ok(rules(r).includes('markdown-fence'));
});

test('extraction: fenced blocks, language preference, unclosed fence, prose around HTML', () => {
  assert.deepEqual(extractCode('Sure!\n```css\nbody{}\n```\nDone.', 'style.css'), { code: 'body{}', unclosedFence: false, hadFence: true });
  assert.equal(extractCode('```html\n<p>x</p>\n```\n```js\nconsole.log(1)\n```', 'script.js').code, 'console.log(1)');
  assert.equal(extractCode('```javascript\nconst a = 1;\n', 'script.js').unclosedFence, true);
  assert.equal(extractCode('Here:\n<!DOCTYPE html><html></html>\nHope it helps', 'index.html').code, '<!DOCTYPE html><html></html>');
  assert.equal(extractCode('```markdown\n# T\n```js\nx\n```\n```', 'README.md').code, '# T\n```js\nx\n```');
  assert.equal(extractCode('json: {"a":1} ok', 'x.json').code, '{"a":1}');
});
