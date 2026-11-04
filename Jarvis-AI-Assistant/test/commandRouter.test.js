const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand } = require('../controllers/commandRouter');

const type = (s) => parseCommand(s).type;

test('required CLI commands', () => {
  assert.equal(type('help'), 'help');
  assert.equal(type('listen'), 'listen');
  assert.equal(type('voice'), 'voiceMode');
  assert.equal(type('voice on'), 'ttsOn');
  assert.equal(type('voice off'), 'ttsOff');
  assert.equal(type('exit voice'), 'exitVoice');
  assert.equal(type('exit'), 'exit');
  assert.equal(type('quit'), 'exit');
  assert.equal(type('models'), 'models');
  assert.equal(type('stats'), 'stats');
  assert.equal(type('projects'), 'projects');
  assert.equal(type('list'), 'list');
});

test('commands are case/punctuation-insensitive (speech transcripts)', () => {
  assert.equal(type('Exit voice.'), 'exitVoice');
  assert.equal(type('HELP!'), 'help');
  assert.equal(type('  Voice   Off  '), 'ttsOff');
});

test('create keeps the original description text', () => {
  assert.deepEqual(parseCommand('create A To-Do List app'), { type: 'create', args: 'A To-Do List app', raw: 'create A To-Do List app' });
  assert.equal(parseCommand('Build a weather dashboard').args, 'a weather dashboard');
  assert.equal(parseCommand('Create project todo list.').args, 'todo list.');
  assert.equal(parseCommand('create a project that manages my day').args, 'a project that manages my day');
  assert.equal(type('create'), 'createUsage');
  assert.equal(type('create   '), 'createUsage');
});

test('greetings are recognized; other text is a general question', () => {
  for (const g of ['hi', 'Hi!', 'hello', 'hey jarvis', 'Good morning', 'namaste']) assert.equal(type(g), 'greeting', g);
  assert.equal(type('hi, can you explain closures?'), 'chat');
  assert.deepEqual(parseCommand('what is a closure?'), { type: 'chat', args: 'what is a closure?', raw: 'what is a closure?' });
});

test('open and diagnose take arguments (case preserved)', () => {
  assert.deepEqual(parseCommand('open README.md'), { type: 'open', args: 'README.md', raw: 'open README.md' });
  assert.equal(parseCommand('diagnose gemini-X-Flash').args, 'gemini-X-Flash');
  assert.equal(parseCommand('diagnose').args, undefined);
});

test('a bare y/n with no pending question is not sent to Gemini', () => {
  for (const a of ['y', 'Yes', 'n', 'NO']) assert.equal(type(a), 'strayAnswer', a);
});

test('empty and null input', () => {
  assert.equal(type(''), 'empty');
  assert.equal(type('   '), 'empty');
  assert.equal(type(null), 'empty');
});
