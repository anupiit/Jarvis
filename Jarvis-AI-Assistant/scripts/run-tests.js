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

const result = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
process.exit(result.status === null ? 1 : result.status);
