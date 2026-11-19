const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeFileAtomic, cleanupStaleTempFiles, TEMP_SUFFIX } = require('../utils/atomicWrite');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-atomic-'));
}

test('writes content and creates missing parent directories', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'a', 'b', 'c.txt');
  writeFileAtomic(target, 'hello');
  assert.equal(fs.readFileSync(target, 'utf8'), 'hello');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'a', 'b')), ['c.txt'], 'no temp files left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('replaces an existing file atomically', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'x.txt');
  fs.writeFileSync(target, 'old');
  writeFileAtomic(target, 'new');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failed rename leaves the original file intact and removes the temp file', () => {
  const dir = tmpdir();
  const target = path.join(dir, 'keep.txt');
  fs.writeFileSync(target, 'valid original');
  assert.throws(() => writeFileAtomic(target, 'replacement', {
    rename: () => { throw Object.assign(new Error('simulated lock'), { code: 'EPERM' }); }
  }), /simulated lock/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'valid original');
  assert.deepEqual(fs.readdirSync(dir), ['keep.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('temporary file names are unique per write', () => {
  const { tempPathFor } = require('../utils/atomicWrite');
  const a = tempPathFor('/x/y.txt');
  const b = tempPathFor('/x/y.txt');
  assert.notEqual(a, b);
  assert.ok(a.endsWith(TEMP_SUFFIX));
});

test('stale temp files from a crashed run are cleaned up (only ours)', () => {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, `.index.html.123.abc${TEMP_SUFFIX}`), 'partial');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'keep');
  assert.equal(cleanupStaleTempFiles(dir), 1);
  assert.deepEqual(fs.readdirSync(dir), ['.gitignore']);
  fs.rmSync(dir, { recursive: true, force: true });
});
