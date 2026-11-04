const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRequirements, extractFiles } = require('../models/RequirementParser');

const TODO_REQUEST = 'Create a simple modern responsive To-Do List web application using HTML, CSS, and vanilla JavaScript. It must allow users to add tasks, display tasks, mark tasks as completed, delete tasks, and persist tasks in localStorage. Generate exactly three files: index.html, style.css, and script.js. Do not use React, Node.js, external libraries, databases, APIs, or additional folders.';

test('benchmark request: exact files, count, stack, forbidden items, features', () => {
  const r = parseRequirements(TODO_REQUEST);
  assert.deepEqual(r.explicitFiles, ['index.html', 'style.css', 'script.js']);
  assert.equal(r.exactFiles, true);
  assert.equal(r.expectedFileCount, 3);
  assert.equal(r.vanilla, true);
  assert.ok(r.techStack.includes('html') && r.techStack.includes('css') && r.techStack.includes('javascript'));
  assert.ok(!r.techStack.includes('react'), 'React appears only in a negated clause');
  assert.ok(!r.techStack.includes('node'));
  for (const cat of ['react', 'node', 'external-libraries', 'database', 'network-apis', 'folders']) {
    assert.ok(r.forbiddenCategories.includes(cat), cat);
  }
  assert.equal(r.noExternalLibraries, true);
  assert.equal(r.noAdditionalFolders, true);
  assert.deepEqual(r.features, ['Add tasks', 'Display tasks', 'Mark tasks as completed', 'Delete tasks', 'Persist tasks in localStorage']);
  assert.deepEqual(r.warnings, []);
});

test('technology names ending in .js are not mistaken for files', () => {
  assert.deepEqual(extractFiles('Use Node.js, Vue.js and Chart.js with app.js and components/Button.js'), ['app.js', 'components/Button.js']);
});

test('files mentioned without "exactly" are required but not exclusive', () => {
  const r = parseRequirements('build a todo app with index.html and app.js');
  assert.deepEqual(r.explicitFiles, ['index.html', 'app.js']);
  assert.equal(r.exactFiles, false);
});

test('"only these files" and "no other files" also mean exact', () => {
  assert.equal(parseRequirements('Make a page with only these files: a.html, b.css').exactFiles, true);
  assert.equal(parseRequirements('Create main.py. No other files.').exactFiles, true);
});

test('count/name mismatch produces a visible warning', () => {
  const r = parseRequirements('Generate exactly two files: index.html, style.css and script.js');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /2 files but names 3/);
});

test('positive technology requests are detected', () => {
  const r = parseRequirements('Create a REST API using Node.js and Express with server.js');
  assert.ok(r.techStack.includes('node'));
  assert.ok(r.techStack.includes('express'));
  assert.deepEqual(r.forbiddenCategories, []);
});

test('plain requests have no constraints', () => {
  const r = parseRequirements('create a weather dashboard');
  assert.deepEqual(r.explicitFiles, []);
  assert.equal(r.exactFiles, false);
  assert.equal(r.noAdditionalFolders, false);
});
