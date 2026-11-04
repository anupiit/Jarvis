# Jarvis — Final Benchmark Report

All numbers below were measured on **2026-11-04** in this branch's environment (Linux container,
Node.js v22.23.4, 4 × Intel Xeon @ 2.10 GHz) unless stated otherwise. Raw output:
[`docs/benchmark-results/`](benchmark-results/). No figure from earlier reports is reused.

**Label legend:** `MOCKED` = no network/Gemini involved · `LOCAL` = real processes/sockets on this
machine, no Google · `LIVE` = real request to Google's API · `BLOCKED` = could not run here.

## 1. Summary

| # | Benchmark | Type | Result |
|---|---|---|---|
| 1 | Automated test suite | MOCKED/LOCAL | **229 / 229 passed**, 0 failed, 0 skipped, 21 files |
| 2 | Coverage (modules loaded by tests) | MOCKED/LOCAL | **94.91 % lines, 80.74 % branches, 90.05 % functions** |
| 3 | Outbound requests, 20 identical prompts | MOCKED | 1 request (**95 % fewer** than one per call) |
| 4 | Outbound requests, 200 calls / 25 prompts (skewed) | MOCKED | 25 requests (**87.5 % fewer**) |
| 5 | Outbound requests, 20 distinct prompts (control) | MOCKED | 20 requests (0 %) |
| 6 | Engine overhead per call | MOCKED | p50 **0.021 ms**, p95 0.045 ms |
| 7 | Defect detection (15 seeded defects) | LOCAL | **15 / 15 detected**, 15 / 15 fixes accepted |
| 8 | False positives on known-good files | LOCAL | **0 / 7** flagged |
| 9 | Self-correction loop, scripted corrector | MOCKED | 15 / 15 (plumbing only — not an AI repair rate) |
| 10 | Self-correction, real Gemini repairs | LIVE | **BLOCKED** (no API key) |
| 11 | Invalid key against the live endpoint | LIVE | **1 request, 0 retries, whole CLI session 491 ms** (baseline: 6 requests over ~31 s, then crash) |
| 12 | Live To-Do generation benchmark (Part 11) | LIVE | **BLOCKED** (no API key) |
| 13 | E2E harness self-test (real CLI + real HTTP socket + Chromium) | LOCAL, mock Gemini | GENERATED, **18 / 18** browser/static checks |
| 14 | Browser verifier controls | LOCAL | reference app 18/18; persistence-removed variant fails exactly 3/18 |
| 15 | Voice dispatch latency (mock recognizer) | MOCKED | p50 **0.003 ms**, p95 0.007 ms |
| 16 | PowerShell start-up / SAPI probe | LOCAL (Windows) | **Not measurable** (Linux) |
| 17 | Physical microphone/speaker | hardware | **NOT TESTED** |

## 2. Automated tests

Command: `npm test` (built-in `node:test`; no nested suites — every count is a leaf test).

| Area | Files | Tests |
|---|---|---|
| Configuration, redaction | config | 7 |
| Gemini errors (incl. 3 payloads captured live) | geminiErrors | 17 |
| Gemini HTTP client (real local HTTP server) | geminiClient | 11 |
| Reliability engine (mocked transport) | geminiService | 29 |
| Reliability primitives | reliabilityPrimitives | 11 |
| Retry/Retry-After | retry | 8 |
| Model discovery / diagnose | modelDiscovery | 5 |
| Requirement parsing / naming / paths / approval | requirementParser, projectNaming, safePath, confirm | 7 + 8 + 5 + 3 |
| Planner | projectPlanner | 9 |
| Validator + extraction (15 generated from the defect corpus) | codeValidator | 33 |
| Atomic writes | atomicWrite | 5 |
| Self-correction | selfCorrector | 7 |
| File generation | fileGenerator | 9 |
| Voice (fake PowerShell process) | voiceService | 16 |
| Command routing / input lifecycle | commandRouter, inputManager | 7 + 8 |
| Process safety net (child processes) | processSafety | 3 |
| End-to-end CLI workflows | e2e.controller | 21 |
| **Total** | **21** | **229** |

* **Real API tests in the suite:** 0 (the suite is deterministic and offline by design).
* **Live API checks outside the suite:** `npm run live:errors` — invalid key on `generateContent`
  (→ AUTH, HTTP 400 `API_KEY_INVALID`), invalid key on ListModels (→ AUTH), no key (→ PERMISSION,
  HTTP 403). The DNS check cannot be reproduced live here: the sandbox proxy turns an unknown host into
  a tunnel error (classified NETWORK). ENOTFOUND classification is covered by a deterministic test.
* **Physical hardware tests:** 0.
* **Skipped:** 0 on Linux. One test (symlink escape) is skipped on Windows, where creating symlinks
  needs elevated rights.

Coverage (`npm run test:coverage`, raw: `benchmark-results/coverage.txt`) only includes modules that
the tests load in-process; `index.js`, `agent.js` and `utils/processSafety.js` (exercised in child
processes) do not appear in it. **This is not 100 % coverage.**

## 3. Reliability engine — MOCKED transport

Script: `npm run bench:reliability`. In-memory transport with fixed latency (50 ms; 20 ms for the
mixed workload); concurrency 4; rate limiter disabled for the measurement.

| Scenario | Logical calls | Outbound requests | vs. one request per call |
|---|---|---|---|
| 20 concurrent identical prompts (coalescing) | 20 | 1 | 95 % fewer |
| 20 sequential identical prompts (cache) | 20 | 1 | 95 % fewer |
| 20 distinct prompts (control) | 20 | 20 | 0 % |
| 200 calls over 25 prompts, skewed, waves of 10 (seed 42) | 200 | 25 | 87.5 % fewer |
| 20 distinct prompts, first attempt of each returns 503 | 20 | 40 | 100 % **more**; 20/20 succeeded after 1 retry each |

Interpretation: the reduction equals the duplication rate of the workload (it is 1 − distinct/total
by construction). It shows that the cache and coalescing work as designed; it is **not** a
prediction of savings for real usage, where Jarvis prompts are mostly unique.

Engine overhead per call with a 0 ms transport (1 800 measured calls): mean 0.028 ms, p50 0.021 ms,
p95 0.045 ms, max 1.346 ms.

## 4. Validation and self-correction

Script: `npm run bench:validation` (corpus: `test/fixtures/defectCorpus.js`).

| Category | Defects |
|---|---|
| JavaScript (classic script) | missing brace, unterminated string, extra parenthesis, `import` in classic script, `require()` in browser |
| ES module / CommonJS | invalid `export`, broken arrow function |
| JSON | trailing comma, single quotes |
| CSS | unclosed block, stray brace, missing colon |
| HTML | unclosed `<div>`, truncated document, Markdown fence around the document |

* Detected: **15 / 15**, each with the expected rule. Hand-written fixes accepted: **15 / 15**.
* Validation time per file: p50 0.21 ms; the ES-module case spawns `node --check` (≈ 53 ms).
* False positives: **0 / 7** known-good files (3-file reference app + 4 files from a project committed
  by the old pipeline).
* Real-world catch: the validator rejects `projectsByJarvis/anup-calculator-app/components/Button.js`,
  committed earlier by the old pipeline — a stray ```` ```javascript ```` fence and output cut off
  mid-tag at ~7.5 KB.
* Self-correction with a **scripted** corrector (returns the known fix on the first correction):
  15 / 15 accepted after 1 correction. This proves the loop and the validator agree; it says nothing
  about Gemini's ability to repair code. `npm run bench:validation:live` measures that — **BLOCKED**
  here (no key).

## 5. Gemini error handling — LIVE

| Measurement | Old code (`a64a3fc`) | This branch |
|---|---|---|
| Requests sent for an invalid/missing key | 6 (1 + 5 retries; with no key at all it sent `key=undefined`) | 1 with an invalid key; **0** with no key (CONFIG error) |
| Time until control returns | ~31 s of retries, then an uncaught `ERR_USE_AFTER_CLOSE` crash | whole scripted session (plan attempt, stray `y`, a question, `stats`, `exit`) in **491 ms**; the one HTTP request took 379 ms |
| Later requests in the same session | retried again | fail fast via the circuit latch (0 requests) |
| Message | `API key not valid` repeated | `Gemini rejected the API key (HTTP 400 INVALID_ARGUMENT)` + how to fix it |

Transcripts: `benchmark-results/live-invalid-key-session.txt` (final code) and
`benchmark-results/live-error-paths.txt`. Both used a deliberately invalid key; no real credential was
used or exists in this environment.

## 6. Project generation

### 6.1 Live benchmark (Part 11) — BLOCKED
`npm run e2e:todo` sends the exact benchmark request to the real CLI, answers the approval prompt
with `y`, then runs `verify-web-project.js`. It requires `GEMINI_API_KEY`; none is available in this
environment and none was requested. Recorded result: `benchmark-results/e2e-todo.json` → `BLOCKED`.
**No claim is made that Gemini generates a working To-Do app.**

### 6.2 Harness self-test — LOCAL, mock Gemini
`npm run e2e:selftest` runs the same harness, with the real CLI process and the real HTTP client over
a real local socket, against a local server that returns the hand-written reference app.

* 4 requests (1 plan + 3 files), 3/3 files validated on first attempt, 109 ms.
* Folder `todo-list-app/` with exactly `index.html`, `style.css`, `script.js`.
* Browser verification **18 / 18**. Static checks: exactly 3 files, no folders, HTML references
  `style.css` and `script.js`, all files valid. Chromium checks: add two tasks, display, complete,
  delete, localStorage write, after reload the task persists, the deleted task stays deleted, the
  completion persists, no console errors.

### 6.3 Verifier controls
* Reference app: 18 / 18.
* Same app with the `localStorage.setItem` call removed: fails exactly the three persistence checks
  (15 / 18). The verifier can fail, so its pass results are meaningful.

## 7. Voice

| Measurement | Result |
|---|---|
| In-process dispatch latency (transcription available → command answered), mock recognizer, 450 samples | mean 0.006 ms, p50 0.003 ms, p95 0.007 ms |
| `powershell.exe` cold start (`npm run bench:voice` on Windows) | not measurable on Linux |
| SAPI availability probe | not measurable on Linux |
| Physical microphone and speaker | **NOT TESTED** — use `npm run voice:check` on Windows |

## 8. Not re-measured

* **KLM-GOMS setup-time baseline (~600 s).** This was an analytical estimate, not a human experiment.
  No user study was run; it remains an estimate and should not be presented as measured.
