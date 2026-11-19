const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const FileGenerator = require('../models/FileGenerator');
const { normalizeBlueprint } = require('../models/ProjectPlanner');
const { parseRequirements } = require('../models/RequirementParser');
const { GeminiError, ErrorKind } = require('../services/geminiErrors');
const { createScriptedEngine, requestedFile } = require('./helpers/scriptedEngine');
const { setLogSink, resetLogSink } = require('../utils/logger');
const APP = require('./fixtures/todoApp');

function makePlan(root, request = APP.TODO_REQUEST, blueprint = APP.TODO_BLUEPRINT) {
  const plan = normalizeBlueprint(blueprint, parseRequirements(request), request);
  plan.projectsRoot = root;
  return plan;
}

function goodFiles(prompt) {
  const file = requestedFile(prompt);
  return { 'index.html': APP.INDEX_HTML, 'style.css': APP.STYLE_CSS, 'script.js': APP.SCRIPT_JS }[file];
}

async function run(plan, responder, opts = {}) {
  const lines = [];
  setLogSink((l) => lines.push(l), { color: false });
  try {
    const engine = createScriptedEngine(responder);
    const gen = new FileGenerator({ engine, projectsRoot: plan.projectsRoot, ...opts });
    const summary = await gen.generateProjectFiles(plan);
    return { summary, engine, lines };
  } finally {
    resetLogSink();
  }
}

function listTree(dir) {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push(`${r}/`); walk(path.join(d, e.name), r); } else out.push(r);
    }
  })(dir, '');
  return out.sort();
}

test('three-file HTML/CSS/JS app: exactly the requested files, correct names and connections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  const { summary, engine, lines } = await run(makePlan(root), (p) => goodFiles(p));
  assert.equal(summary.ok, true);
  assert.deepEqual(listTree(path.join(root, 'todo-list-app')), ['index.html', 'script.js', 'style.css']);
  const html = fs.readFileSync(path.join(root, 'todo-list-app', 'index.html'), 'utf8');
  assert.match(html, /href="style\.css"/);
  assert.match(html, /src="script\.js"/);
  // generation order and context passing
  assert.deepEqual(engine.calls.map(c => requestedFile(c.prompt)), ['index.html', 'style.css', 'script.js']);
  assert.match(engine.calls[0].prompt, /<link rel="stylesheet" href="style\.css">/);
  assert.match(engine.calls[2].prompt, /--- index\.html ---/, 'JS prompt receives the generated HTML');
  assert.ok(lines.some(l => /PROJECT GENERATED — 3\/3/.test(l)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing parent directories (projects root and nested paths) are created', async () => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-')), 'does', 'not', 'exist');
  const req = 'make a site with index.html and js/app.js';
  const plan = makePlan(root, req, { files: [{ path: 'index.html' }, { path: 'js/app.js' }] });
  const html = '<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>x</title></head><body><script src="js/app.js" defer></script></body></html>';
  const { summary } = await run(plan, (p) => (requestedFile(p) === 'index.html' ? html : 'console.log("ok");'));
  assert.equal(summary.ok, true, JSON.stringify(summary.results));
  assert.ok(fs.existsSync(path.join(root, plan.projectName, 'js', 'app.js')));
});

test('long descriptions still produce a short project folder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  const longReq = `Create a ${'really '.repeat(40)}great habit tracker app using index.html, style.css and script.js only`;
  const plan = makePlan(root, longReq, { files: [] });
  assert.ok(plan.projectName.length <= 50);
  assert.equal(plan.projectName, 'habit-tracker-app'); // 'great' and 'really' are filler words
});

test('path traversal attempts never write outside the projects directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  const plan = makePlan(root, 'make a page', { files: [{ path: 'index.html' }] });
  plan.files.push({ path: '../../escape.js', fileType: 'javascript', description: 'evil' });
  plan.projectName = 'safe-name';
  const { summary } = await run(plan, (p) => (requestedFile(p) === 'index.html' ? APP.INDEX_HTML : 'console.log(1);'));
  const evil = summary.results.find(r => r.path === '../../escape.js');
  assert.equal(evil.status, 'failed');
  assert.match(evil.reason, /traversal/);
  assert.ok(!fs.existsSync(path.join(root, '..', 'escape.js')));
  // An invalid project name is refused outright
  const bad = makePlan(root);
  bad.projectName = '../outside';
  await assert.rejects(run(bad, goodFiles), /Refusing path/);
});

test('syntax error → AI correction → validated file written', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  let jsCalls = 0;
  const { summary, lines } = await run(makePlan(root), (p) => {
    if (/The file "script\.js" you generated failed/.test(p) || requestedFile(p) === 'script.js') {
      jsCalls++;
      return jsCalls === 1 ? APP.SCRIPT_JS.replace("'use strict';", "'use strict'; const = 1;") : APP.SCRIPT_JS;
    }
    return goodFiles(p);
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.results.find(r => r.path === 'script.js').corrections, 1);
  assert.ok(lines.some(l => /script\.js — valid after 1 correction/.test(l)));
  fs.rmSync(root, { recursive: true, force: true });
});

test('HTML referencing styles.css instead of style.css is corrected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  let htmlCalls = 0;
  const { summary } = await run(makePlan(root), (p) => {
    if (requestedFile(p) === 'index.html') {
      htmlCalls++;
      return htmlCalls === 1 ? APP.INDEX_HTML.replace('style.css', 'styles.css') : APP.INDEX_HTML;
    }
    return goodFiles(p);
  });
  assert.equal(summary.ok, true);
  assert.equal(htmlCalls, 2);
  assert.ok(!fs.existsSync(path.join(root, 'todo-list-app', 'styles.css')));
});

test('unrecoverable invalid output: nothing written for that file, existing valid file preserved', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  const projectDir = path.join(root, 'todo-list-app');
  fs.mkdirSync(projectDir);
  fs.writeFileSync(path.join(projectDir, 'script.js'), APP.SCRIPT_JS);
  const { summary, engine, lines } = await run(makePlan(root), (p) => (requestedFile(p) === 'script.js' ? 'function broken( {' : goodFiles(p)));
  const js = summary.results.find(r => r.path === 'script.js');
  assert.equal(js.status, 'failed');
  assert.equal(js.corrections, 3);
  assert.equal(js.preservedExisting, true);
  assert.equal(fs.readFileSync(path.join(projectDir, 'script.js'), 'utf8'), APP.SCRIPT_JS, 'valid existing file untouched');
  assert.equal(summary.ok, false);
  assert.ok(lines.some(l => /PROJECT INCOMPLETE/.test(l)));
  assert.equal(engine.calls.filter(c => /script\.js/.test(c.prompt.slice(0, 200))).length, 4);
  assert.deepEqual(listTree(projectDir), ['index.html', 'script.js', 'style.css'], 'no temp files left');
  fs.rmSync(root, { recursive: true, force: true });
});

test('fatal Gemini error stops generation; remaining files are skipped and an empty new folder is removed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  const { summary, engine } = await run(makePlan(root), () => {
    throw new GeminiError(ErrorKind.QUOTA_EXHAUSTED, 'Quota exceeded', { httpStatus: 429 });
  });
  assert.equal(engine.calls.length, 1, 'does not keep hammering the API');
  assert.deepEqual(summary.results.map(r => r.status), ['failed', 'skipped', 'skipped']);
  assert.ok(!fs.existsSync(path.join(root, 'todo-list-app')), 'no empty project folder left behind');
  assert.equal(summary.fatalError.kind, ErrorKind.QUOTA_EXHAUSTED);
  fs.rmSync(root, { recursive: true, force: true });
});

test('final verification reports pre-existing extra files without deleting them', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-gen-'));
  fs.mkdirSync(path.join(root, 'todo-list-app'));
  fs.writeFileSync(path.join(root, 'todo-list-app', 'notes.txt'), 'mine');
  const { summary } = await run(makePlan(root), goodFiles);
  assert.deepEqual(summary.verification.unexpected, ['notes.txt']);
  assert.ok(fs.existsSync(path.join(root, 'todo-list-app', 'notes.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});
