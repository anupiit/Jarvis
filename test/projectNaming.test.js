const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeProjectName, chooseProjectName, deriveNameFromDescription, extractExplicitName } = require('../utils/projectNaming');

const TODO_REQUEST = 'Create a simple modern responsive To-Do List web application using HTML, CSS, and vanilla JavaScript. It must allow users to add tasks, display tasks, mark tasks as completed, delete tasks, and persist tasks in localStorage. Generate exactly three files: index.html, style.css, and script.js. Do not use React, Node.js, external libraries, databases, APIs, or additional folders.';

test('benchmark request → todo-list-app (never the whole prompt)', () => {
  assert.equal(chooseProjectName(TODO_REQUEST, null), 'todo-list-app');
  assert.equal(chooseProjectName(TODO_REQUEST, 'simple-modern-todo-list-web-application-using-html'), 'todo-list-app');
});

test('brief example: "Create a modern responsive To-Do List application." → todo-list-app', () => {
  assert.equal(chooseProjectName('Create a modern responsive To-Do List application.', null), 'todo-list-app');
});

test('regression: "a project that manage my day" no longer becomes the full prompt slug', () => {
  const name = chooseProjectName('a project that manage my day', null);
  assert.equal(name, 'manage-my-day');
  assert.notEqual(name, 'a-project-that-manage-my-day-');
  assert.equal(chooseProjectName('a project that manage my day', 'day-planner'), 'day-planner', 'AI name is used when there is no clear noun phrase');
});

test('typical requests produce short meaningful names', () => {
  assert.equal(chooseProjectName('fullstack expense tracker with React', null), 'fullstack-expense-tracker');
  assert.equal(chooseProjectName('weather dashboard with charts', null), 'weather-dashboard');
  assert.equal(chooseProjectName('todo app with drag and drop', null), 'todo-app');
  assert.equal(chooseProjectName('anup calculator app', null), 'anup-calculator-app');
});

test('explicit "called X" wins', () => {
  assert.equal(extractExplicitName('build me a game called Space Blaster with canvas'), 'Space Blaster');
  assert.equal(chooseProjectName('build me a game called Space Blaster with canvas', 'other'), 'space-blaster');
});

test('names are at most 50 characters and cut at a word boundary', () => {
  const long = sanitizeProjectName('extremely-long-name-'.repeat(10));
  assert.ok(long.length <= 50, long);
  assert.doesNotMatch(long, /-$/);
  const desc = 'Create ' + 'supercalifragilistic '.repeat(10) + 'dashboard';
  assert.ok(chooseProjectName(desc, null).length <= 50);
});

test('sanitization: Windows-invalid characters, traversal, unicode, reserved names', () => {
  assert.equal(sanitizeProjectName('My:App<>|?*"/\\'), 'my-app');
  assert.equal(sanitizeProjectName('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitizeProjectName('Café Résumé'), 'cafe-resume');
  assert.equal(sanitizeProjectName('CON'), 'con-project');
  assert.equal(sanitizeProjectName('lpt1'), 'lpt1-project');
  assert.equal(sanitizeProjectName('   '), 'jarvis-project');
  assert.equal(sanitizeProjectName('नमस्ते'), 'jarvis-project');
  assert.equal(sanitizeProjectName('trailing dots...'), 'trailing-dots');
});

test('derivation falls back to the first meaningful words when there is no anchor', () => {
  const d = deriveNameFromDescription('something to organise recipes and shopping');
  assert.equal(d.anchored, false);
  assert.equal(d.name, 'organise-recipes-shopping');
});
