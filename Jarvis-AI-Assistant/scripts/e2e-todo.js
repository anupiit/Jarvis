#!/usr/bin/env node
// LIVE end-to-end benchmark (Part 11): runs the real Jarvis CLI with the real Gemini API,
// answers the approval prompt with "y" through stdin (the same prompt a user sees — it is not
// bypassed), then verifies the generated project statically and in a headless browser.
//
//   npm run e2e:todo                      (requires GEMINI_API_KEY in .env; uses real API quota)
//   node scripts/e2e-todo.js --self-test  (harness check: local MOCK Gemini server, temp folder)
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config/config');
const { writeResult } = require('./lib/benchUtil');

const selfTest = process.argv.includes('--self-test');
const resultName = selfTest ? 'e2e-todo-selftest' : 'e2e-todo';
const projectsRoot = selfTest ? fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-selftest-')) : config.PROJECTS_ROOT;

const REQUEST = 'Create a simple modern responsive To-Do List web application using HTML, CSS, and vanilla JavaScript. It must allow users to add tasks, display tasks, mark tasks as completed, delete tasks, and persist tasks in localStorage. Generate exactly three files: index.html, style.css, and script.js. Do not use React, Node.js, external libraries, databases, APIs, or additional folders.';
const projectDir = path.join(projectsRoot, 'todo-list-app');

const v = config.validateConfig();
if (!selfTest && !v.ok) {
  console.error('BLOCKED: the live E2E benchmark needs a configured Gemini API key.');
  v.problems.forEach(p => console.error(`  → ${p}`));
  writeResult(resultName, { status: 'BLOCKED', reason: v.problems.join(' ') });
  process.exit(2);
}
if (fs.existsSync(projectDir)) {
  console.log(`Note: ${projectDir} already exists; files are replaced only by validated output.`);
}

const started = Date.now();
const nodeArgs = selfTest ? ['--require', path.join(__dirname, '..', 'test', 'helpers', 'selfTestPreload.js')] : [];
const child = spawn(process.execPath, [...nodeArgs, path.join(__dirname, '..', 'index.js')], {
  cwd: path.join(__dirname, '..'),
  stdio: ['pipe', 'pipe', 'inherit'],
  env: selfTest ? { ...process.env, JARVIS_SELFTEST_PROJECTS_ROOT: projectsRoot } : process.env
});
let transcript = '';
let answered = false;
child.stdout.on('data', (chunk) => {
  const text = chunk.toString();
  transcript += text;
  process.stdout.write(text);
  if (!answered && /Write these files\? \(y\/n\):/.test(transcript)) {
    answered = true;
    child.stdin.write('y\n');
  }
  if (/PROJECT (GENERATED|INCOMPLETE)|Planning failed|cancelled — no files/.test(text)) {
    child.stdin.write('stats\nexit\n');
  }
});
child.stdin.write(`create ${REQUEST}\n`);

child.on('close', (code) => {
  const durationMs = Date.now() - started;
  const clean = transcript.replace(/\x1b\[[0-9;]*m/g, '');
  const generated = /PROJECT GENERATED — 3\/3/.test(clean);
  const corrections = (clean.match(/AI correction \d+\/\d+/g) || []).length;
  const statsLine = (clean.match(/Calls: .*/) || [''])[0];
  let verification = null;
  if (fs.existsSync(projectDir)) {
    const jsonOut = path.join(__dirname, '..', 'docs', 'benchmark-results', `${resultName}-verification.json`);
    spawnSync(process.execPath, [path.join(__dirname, 'verify-web-project.js'), projectDir, '--json', jsonOut], { stdio: 'inherit' });
    try { verification = JSON.parse(fs.readFileSync(jsonOut, 'utf8')); } catch (_) { /* verifier failed */ }
  }
  const result = {
    mode: selfTest ? 'SELF-TEST: local mock Gemini serving the hand-written reference app (validates the harness, NOT generation quality)' : 'LIVE Gemini',
    status: generated ? 'GENERATED' : 'NOT GENERATED',
    model: selfTest ? 'selftest-model (mock)' : config.geminiModel,
    cliExitCode: code,
    durationMs,
    aiCorrections: corrections,
    requestStats: statsLine,
    verification: verification ? { passed: verification.passed, total: verification.total, browserSkipped: verification.browserSkipped } : null
  };
  console.log('\nRESULT', JSON.stringify(result, null, 2));
  writeResult(resultName, result);
  if (selfTest) fs.rmSync(projectsRoot, { recursive: true, force: true });
  process.exit(generated && verification && verification.passed === verification.total ? 0 : 1);
});
