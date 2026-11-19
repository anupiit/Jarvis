const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ProjectPlanner = require('../models/ProjectPlanner');
const { normalizeBlueprint, parseBlueprintJson } = ProjectPlanner;
const { parseRequirements } = require('../models/RequirementParser');
const { GeminiError, ErrorKind } = require('../services/geminiErrors');
const { setLogSink, resetLogSink } = require('../utils/logger');

const TODO_REQUEST = 'Create a simple modern responsive To-Do List web application using HTML, CSS, and vanilla JavaScript. It must allow users to add tasks, display tasks, mark tasks as completed, delete tasks, and persist tasks in localStorage. Generate exactly three files: index.html, style.css, and script.js. Do not use React, Node.js, external libraries, databases, APIs, or additional folders.';

// An AI answer that ignores the user's constraints (the failure mode seen before).
const DISOBEDIENT_AI = {
  projectName: 'simple-modern-responsive-to-do-list-web-application-using-html',
  title: 'To-Do List',
  description: 'A todo app',
  features: ['Add tasks', 'Delete tasks'],
  techStack: ['HTML', 'CSS', 'JavaScript', 'React', 'Node.js'],
  files: [
    { path: 'index.html', description: 'Markup' },
    { path: 'styles.css', description: 'Styles' },
    { path: 'script.js', description: 'Logic' },
    { path: 'package.json', description: 'npm' },
    { path: 'assets/logo.png', description: 'logo' },
    { path: '../../evil.js', description: 'escape' }
  ],
  directories: ['assets', 'components'],
  dependencies: ['lodash'],
  architecture: 'SPA'
};

function fakeEngine(responder) {
  const calls = [];
  return {
    calls,
    async generate(prompt, opts) {
      calls.push({ prompt, opts });
      return responder(prompt, opts);
    }
  };
}

function quiet(fn) {
  return async (...args) => {
    const lines = [];
    setLogSink((l) => lines.push(l), { color: false });
    try { return await fn(lines, ...args); } finally { resetLogSink(); }
  };
}

test('exact-file request overrides a disobedient AI plan and records every adjustment', () => {
  const plan = normalizeBlueprint(DISOBEDIENT_AI, parseRequirements(TODO_REQUEST), TODO_REQUEST);
  assert.deepEqual(plan.files.map(f => f.path), ['index.html', 'style.css', 'script.js']);
  assert.deepEqual(plan.directories, []);
  assert.deepEqual(plan.dependencies, []);
  assert.equal(plan.projectName, 'todo-list-app');
  assert.ok(!plan.techStack.some(t => /react|node/i.test(t)));
  const notes = plan.adjustments.join('\n');
  assert.match(notes, /unsafe path "\.\.\/\.\.\/evil\.js"/);
  assert.match(notes, /assets\/logo\.png.*binary/);
  assert.match(notes, /"styles\.css".*exactly 3/);
  assert.match(notes, /lodash/);
});

test('files are ordered HTML → CSS → JS so later files receive earlier ones as context', () => {
  const plan = normalizeBlueprint({ files: [{ path: 'app.js' }, { path: 'main.css' }, { path: 'index.html' }, { path: 'README.md' }] }, parseRequirements('make a site'), 'make a site');
  assert.deepEqual(plan.files.map(f => f.path), ['index.html', 'main.css', 'app.js', 'README.md']);
});

test('named files are added when the AI forgets them (non-exact request)', () => {
  const plan = normalizeBlueprint({ files: [{ path: 'index.html' }] }, parseRequirements('a game with index.html and game.js'), 'a game with index.html and game.js');
  assert.deepEqual(plan.files.map(f => f.path), ['index.html', 'game.js']);
  assert.match(plan.adjustments.join(' '), /Added "game\.js"/);
});

test('legacy fileStructure format from older prompts is accepted', () => {
  const plan = normalizeBlueprint({ fileStructure: [{ name: 'index.html', type: 'file' }, { name: 'assets', type: 'directory' }] }, parseRequirements('a page'), 'a page');
  assert.deepEqual(plan.files.map(f => f.path), ['index.html']);
  assert.deepEqual(plan.directories, ['assets']);
});

test('parseBlueprintJson handles fenced JSON and rejects non-JSON', () => {
  assert.equal(parseBlueprintJson('```json\n{"projectName":"x"}\n```').projectName, 'x');
  assert.equal(parseBlueprintJson('Here you go: {"a":1} thanks').a, 1);
  assert.throws(() => parseBlueprintJson('no json here'));
  assert.throws(() => parseBlueprintJson('[1,2]'));
});

test('createProjectPlan uses JSON mode, includes constraints in the prompt, and resolves the path inside projects root', quiet(async (lines) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
  const engine = fakeEngine(() => ({ text: JSON.stringify(DISOBEDIENT_AI) }));
  const planner = new ProjectPlanner({ engine, projectsRoot: root });
  const plan = await planner.createProjectPlan(TODO_REQUEST);
  assert.equal(engine.calls[0].opts.responseMimeType, 'application/json');
  assert.match(engine.calls[0].prompt, /EXACTLY these files/);
  assert.match(engine.calls[0].prompt, /index\.html, style\.css, script\.js/);
  assert.doesNotMatch(engine.calls[0].prompt, /styles\.css/, 'no hard-coded styles.css steering');
  assert.equal(plan.projectPath, path.join(root, 'todo-list-app'));
  assert.equal(plan.source, 'ai');
  assert.ok(lines.some(l => /Files to write \(3\)/.test(l)));
  assert.ok(lines.some(l => /Adjusted to match your request/.test(l)));
  assert.ok(!fs.existsSync(plan.projectPath), 'planning never writes files');
  fs.rmSync(root, { recursive: true, force: true });
}));

test('unparseable AI answer → clearly labelled deterministic fallback plan', quiet(async (lines) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
  const planner = new ProjectPlanner({ engine: fakeEngine(() => ({ text: 'Sorry, I cannot do JSON today.' })), projectsRoot: root });
  const plan = await planner.createProjectPlan(TODO_REQUEST);
  assert.equal(plan.source, 'fallback');
  assert.deepEqual(plan.files.map(f => f.path), ['index.html', 'style.css', 'script.js']);
  assert.ok(lines.some(l => /deterministic fallback plan/.test(l)));
  fs.rmSync(root, { recursive: true, force: true });
}));

test('Gemini failure during planning is re-thrown (no silent template plan)', quiet(async () => {
  const planner = new ProjectPlanner({
    engine: fakeEngine(() => { throw new GeminiError(ErrorKind.MODEL_NOT_FOUND, 'models/x is not found', { httpStatus: 404 }); }),
    projectsRoot: os.tmpdir()
  });
  await assert.rejects(planner.createProjectPlan('make a todo app'), (e) => e.kind === ErrorKind.MODEL_NOT_FOUND);
}));

test('plan marks files that already exist and will be replaced', quiet(async (lines) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-plan-'));
  fs.mkdirSync(path.join(root, 'todo-list-app'));
  fs.writeFileSync(path.join(root, 'todo-list-app', 'index.html'), '<!DOCTYPE html><html></html>');
  const planner = new ProjectPlanner({ engine: fakeEngine(() => ({ text: '{}' })), projectsRoot: root });
  const plan = await planner.createProjectPlan(TODO_REQUEST);
  assert.deepEqual(plan.existingFiles, ['index.html']);
  assert.ok(lines.some(l => /index\.html  \[replace\]/.test(l)));
  fs.rmSync(root, { recursive: true, force: true });
}));
