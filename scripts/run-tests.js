#!/usr/bin/env node
// Cross-platform test runner (Windows cmd, PowerShell, bash): runs every test/*.test.js
// with the built-in node:test runner. Pass --coverage for a coverage report.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const testDir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(testDir)
  .filter(f => f.endsWith('.test.js'))
  .sort()
  .map(f => path.join(testDir, f));

const args = ['--test'];
if (process.argv.includes('--coverage')) {
  args.push('--experimental-test-coverage', '--test-coverage-exclude=test/**', '--test-coverage-exclude=scripts/**');
}
const reporter = process.argv.find(a => a.startsWith('--test-reporter='));
if (reporter) args.push(reporter);
args.push(...files);

// Hermetic: never let a developer's real .env (providers, keys) leak into the tests, and never let a
// test reach a real AI API. dotenv does not override variables that are already set.
const env = { ...process.env, AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: '', AI_FALLBACK_ENABLED: 'true' };
for (const k of Object.keys(env)) if (/^AI_(?:CLAUDE|GEMINI|PRICE|PROVIDER_)/.test(k)) delete env[k];
const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..'), env });
process.exit(result.status === null ? 1 : result.status);
