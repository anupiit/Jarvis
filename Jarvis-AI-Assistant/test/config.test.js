const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const fs = require('fs');

const config = require('../config/config');

test('config resolves .env and projects dir relative to the app directory, not cwd', () => {
  const appRoot = path.resolve(__dirname, '..');
  assert.equal(config.ROOT_DIR, appRoot);
  assert.equal(config.ENV_PATH, path.join(appRoot, '.env'));
  assert.equal(config.PROJECTS_ROOT, path.join(appRoot, 'projectsByJarvis'));
});

test('config loads GEMINI_API_KEY / GEMINI_MODEL from the environment and normalizes "models/" prefix', () => {
  const script = "const c=require('./config/config');console.log(JSON.stringify({m:c.geminiModel,hasKey:!!c.geminiApiKey}))";
  const res = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, GEMINI_API_KEY: 'test-key-value-that-is-long-enough-1234', GEMINI_MODEL: 'models/gemini-test-model' },
    encoding: 'utf8'
  });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(JSON.parse(res.stdout.trim()), { m: 'gemini-test-model', hasKey: true });
});

test('config is loaded identically when Jarvis is started from another directory', () => {
  const os = require('os');
  const script = `const c=require(${JSON.stringify(path.resolve(__dirname, '..', 'config', 'config.js'))});console.log(c.ENV_PATH)`;
  const res = spawnSync(process.execPath, ['-e', script], { cwd: os.tmpdir(), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), path.join(path.resolve(__dirname, '..'), '.env'));
});

test('validateConfig reports a missing key without revealing values', () => {
  const r = config.validateConfig({ ...config, geminiApiKey: '' });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /GEMINI_API_KEY is not set/);
});

test('validateConfig rejects placeholders, whitespace and bad model names', () => {
  assert.equal(config.validateConfig({ ...config, geminiApiKey: 'your-gemini-api-key-here' }).ok, false);
  assert.equal(config.validateConfig({ ...config, geminiApiKey: 'abc def ghi jkl mno pqr stu vwx yz12' }).ok, false);
  const bad = config.validateConfig({ ...config, geminiApiKey: 'x'.repeat(39), geminiModel: 'bad model/name' });
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(' '), /GEMINI_MODEL/);
  const good = config.validateConfig({ ...config, geminiApiKey: 'x'.repeat(39), geminiModel: 'gemini-flash-latest' });
  assert.equal(good.ok, true);
});

test('.env is git-ignored and .env.example contains placeholders only', () => {
  const root = path.resolve(__dirname, '..');
  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /^\.env$/m);
  const example = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.match(example, /GEMINI_API_KEY=your-gemini-api-key-here/);
  assert.doesNotMatch(example, /AIza[0-9A-Za-z_-]{20,}/);
});

test('logger redacts the configured key and key-shaped strings', () => {
  const { registerSecret, redactSecrets } = require('../utils/redact');
  registerSecret('super-secret-test-key-123456');
  assert.equal(redactSecrets('value super-secret-test-key-123456 here'), 'value [REDACTED] here');
  assert.equal(redactSecrets('https://x/y?key=abc123&b=1'), 'https://x/y?key=[REDACTED]&b=1');
  assert.equal(redactSecrets('AIzaSyA1234567890abcdefghijklmnopqrstu'), '[REDACTED]');
  assert.equal(redactSecrets('{"x-goog-api-key": "zzz-secret"}'), '{"x-goog-api-key": "[REDACTED]"}');

  const lines = [];
  const logger = require('../utils/logger');
  logger.setLogSink((l) => lines.push(l), { color: false });
  logger.log('key=AIzaSyA1234567890abcdefghijklmnopqrstu');
  logger.resetLogSink();
  assert.deepEqual(lines, ['key=[REDACTED]']);
});
