const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateRelativePath, resolveInside, assertRealPathInside, PathSecurityError } = require('../utils/safePath');

test('valid relative paths are normalized to forward slashes', () => {
  assert.deepEqual(validateRelativePath('index.html'), { ok: true, normalized: 'index.html' });
  assert.deepEqual(validateRelativePath('src\\components\\Button.js'), { ok: true, normalized: 'src/components/Button.js' });
  assert.deepEqual(validateRelativePath('./css/style.css'), { ok: true, normalized: 'css/style.css' });
});

test('traversal, absolute, drive-letter and UNC paths are rejected', () => {
  for (const bad of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'C:\\Windows\\x.js', 'c:evil.js', '\\\\server\\share\\x', 'a//b.js', './.', '..']) {
    assert.equal(validateRelativePath(bad).ok, false, bad);
  }
});

test('Windows-invalid names are rejected', () => {
  for (const bad of ['con.js', 'NUL', 'aux.html', 'com1.txt', 'lpt9/x.js', 'a<b.js', 'what?.js', 'pipe|.js', 'quote".js', 'trailing.', 'dir /x.js', 'nul\u0000.js']) {
    assert.equal(validateRelativePath(bad).ok, false, bad);
  }
});

test('resolveInside keeps results inside the base and throws PathSecurityError otherwise', () => {
  const base = path.join(os.tmpdir(), 'jarvis-safe-base');
  assert.equal(resolveInside(base, 'a/b.txt'), path.join(base, 'a', 'b.txt'));
  assert.throws(() => resolveInside(base, '../outside.txt'), PathSecurityError);
  assert.throws(() => resolveInside(base, ''), PathSecurityError);
});

test('symlink escaping the base is detected', { skip: process.platform === 'win32' ? 'symlinks need admin on Windows' : false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-symlink-'));
  const base = path.join(root, 'base');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(base);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(base, 'link'));
  try {
    assert.throws(() => assertRealPathInside(base, path.join(base, 'link', 'x.txt')), PathSecurityError);
    assert.doesNotThrow(() => assertRealPathInside(base, path.join(base, 'real', 'x.txt')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
