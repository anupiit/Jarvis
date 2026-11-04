// The safety net runs in a child process so it never touches the test runner's own handlers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const preamble = `require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'processSafety.js'))}).installProcessSafetyNet();`;
const run = (code) => spawnSync(process.execPath, ['-e', preamble + code], { encoding: 'utf8', timeout: 10000 });

test('a late socket ECONNRESET is logged and the process keeps running', () => {
  const r = run(`setImmediate(() => { const e = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET', syscall: 'read' }); throw e; }); setTimeout(() => { console.log('still alive'); }, 50);`);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /still alive/);
  assert.match(r.stderr, /Ignored late network socket error \(ECONNRESET\)/);
});

test('any other uncaught exception exits non-zero with a redacted report', () => {
  const r = run(`setImmediate(() => { throw new Error('boom key=AIzaSyA1234567890abcdefghijklmnopqrstu'); });`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Fatal internal error/);
  assert.doesNotMatch(r.stderr, /AIzaSyA1234567890/);
});

test('unhandled promise rejections are reported instead of crashing silently', () => {
  const r = run(`Promise.reject(new Error('lost promise')); setTimeout(() => console.log('alive'), 50);`);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /unhandled promise rejection\): lost promise/);
});
