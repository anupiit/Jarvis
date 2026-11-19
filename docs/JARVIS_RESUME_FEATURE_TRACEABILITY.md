# Jarvis — Resume Claim / Requirement → Code Traceability Matrix

**Source of claims.** No resume and no resume documentation (`docs/JARVIS_RESUME_BULLETS.md`,
`docs/JARVIS_RESUME_METRICS.md`) existed in the repository at audit time. Claims below therefore come from
(a) the task brief's requirements and its list of previously reported figures, and (b) the committed
`README.MD`. No additional claims were invented.

**Status legend (audit time, revision `a64a3fc`)**
1 = FULLY IMPLEMENTED AND VERIFIED · 2 = IMPLEMENTED BUT NOT FULLY VERIFIED · 3 = PARTIALLY IMPLEMENTED ·
4 = IMPLEMENTED BUT CURRENTLY BROKEN · 5 = NOT IMPLEMENTED · 6 = NOT TESTED

> "Final status" / "Final evidence" were filled in at Phase 12 (2026-11-04) from test runs and benchmark
> output. "(mocked)" = verified only with Gemini or the speech engine replaced by a mock.

## A. Project generation engine

| ID | Claim / requirement | Audit files | Audit status | What actually happened (traced) | Final status | Final evidence |
|---|---|---|---|---|---|---|
| A1 | NL request → structured blueprint | `models/ProjectPlanner.js` | 3, 6 | Single Gemini prompt; greedy `{…}` regex; no schema validation; any failure → template plan | IMPLEMENTED AND VERIFIED | Mocked tests + 2 live runs (`live-runs/run*/transcript.txt`) |
| A2 | Extract name, purpose, features, stack, file requirements | `ProjectPlanner.js` | 3 | Only via AI; explicit files / forbidden tech / "exactly N" never parsed | IMPLEMENTED AND VERIFIED | `models/RequirementParser.js`, `test/requirementParser.test.js` (7) |
| A3 | Show full plan before writing | `ProjectPlanner.displayPlan` | 3 | Plan shown, but metadata files written later were never shown | IMPLEMENTED AND VERIFIED | Plan lists every file; `verifyProject()` checks written set; e2e |
| A4 | Explicit approval, never bypassed | `JarvisController.confirmPlan` | 4 | `startsWith('y')`; `" y"` cancels, `"yellow"` approves, no re-ask; piped `y` lost → crash | IMPLEMENTED AND VERIFIED | `utils/confirm.js`, `test/confirm.test.js`, e2e approval matrix, real CLI run |
| A5 | Cancellation writes no files | controller | 2 | True by code path, untested | IMPLEMENTED AND VERIFIED | e2e: n/no/N/NO leave the projects folder empty |
| A6 | Short, sanitized, ≤50-char, Windows-safe names | `ProjectPlanner.createFallbackPlan` | 4 | Fallback = slug of the entire prompt (`a-project-that-manage-my-day-`); AI name unsanitized | IMPLEMENTED AND VERIFIED | `utils/projectNaming.js`, `test/projectNaming.test.js` (8) |
| A7 | Path traversal protection; outputs stay in projects dir | `FileGenerator` | 5 | `path.join(projectPath, aiName)` — traversal possible | IMPLEMENTED AND VERIFIED | `utils/safePath.js`, safePath + fileGenerator traversal tests |
| A8 | Exact requested files only (index.html/style.css/script.js) | `FileGenerator`, `ProjectPlanner` | 4 | `styles.css` hard-coded; `package.json`/README/.gitignore always added | IMPLEMENTED AND VERIFIED | e2e "exactly three files"; 2 live runs wrote exactly the 3 files |
| A9 | HTML references the exact CSS/JS names | `FileGenerator.getSpecificRequirements` | 4 | Prompt hard-codes `styles.css` | IMPLEMENTED AND VERIFIED (mocked AI) | validator `broken-reference`/`missing-reference`; styles.css→style.css correction test |
| A10 | Static validation of generated code | — | 5 | None | IMPLEMENTED AND VERIFIED | `services/codeValidator.js`; 33 tests; 15/15 defects; 0/7 false positives |
| A11 | Bounded AI self-correction (≤3) | — | 5 | None | IMPLEMENTED AND VERIFIED (mocked); live 2/2 repairs, rate not established | `models/SelfCorrector.js`, `test/selfCorrector.test.js` (7), `validation-live.json` |
| A12 | Preserve valid existing files when candidate invalid | — | 5 | `writeFileSync` overwrites directly | IMPLEMENTED AND VERIFIED | `utils/atomicWrite.js`; preservation + rename-failure tests |
| A13 | Clear generation summary | `FileGenerator` | 4 | Prints "COMPLETED" even when every file fell back to a template | IMPLEMENTED AND VERIFIED | `FileGenerator.printSummary`; "PROJECT INCOMPLETE" tests |

## B. Gemini integration & reliability

| ID | Claim / requirement | Audit files | Audit status | Traced behaviour | Final status | Final evidence |
|---|---|---|---|---|---|---|
| B1 | `.env` loaded before services; correct key var | `config/config.js` | 4 | Loads from `cwd`, not app dir | IMPLEMENTED AND VERIFIED | `test/config.test.js` (started from another cwd) |
| B2 | Configurable model | — | 5 | Hard-coded retired `gemini-2.0-flash-exp` → 404 | IMPLEMENTED AND VERIFIED | `GEMINI_MODEL` (default `gemini-flash-latest`); config test |
| B3 | Correct endpoint / request / response schema | `geminiService.js` | 3 | Shape OK; key in URL; `parts[0]` only; finishReason ignored; 2048 tokens | IMPLEMENTED AND VERIFIED | `services/geminiClient.js`, `test/geminiClient.test.js` (11); live generation succeeded |
| B4 | Model discovery (ListModels + generation probe) | — | 5 | None | IMPLEMENTED AND VERIFIED | `services/modelDiscovery.js`; live ListModels (60) + probes (`live-diagnose.txt`) |
| B5 | Error classification (400/401/403/404/408/429/5xx/DNS/reset/timeout) | — | 5 | All errors treated identically | IMPLEMENTED AND VERIFIED | `services/geminiErrors.js` (17 tests); live 400 API_KEY_INVALID + 403 |
| B6 | Retry: exponential, bounded, jitter, Retry-After (s / HTTP-date / RetryInfo) | `geminiService.js` | 4 | 5 blind retries, no jitter, Retry-After ignored, permanent errors retried | IMPLEMENTED AND VERIFIED | `utils/retry.js` (8) + engine retry tests |
| B7 | Long retry delay returns control instead of freezing | — | 5 | — | IMPLEMENTED AND VERIFIED | engine + e2e "very long Retry-After" tests |
| B8 | Bounded LRU cache + TTL | `geminiService.js` | 3 | Unbounded object, no TTL | IMPLEMENTED AND VERIFIED | `utils/lruCache.js`; eviction/TTL tests |
| B9 | Request coalescing | `geminiService.js` | 4 | 1 s "debounce" window, deleted while in flight | IMPLEMENTED AND VERIFIED | coalescing tests (whole flight, shared failures) |
| B10 | Sliding-window rate limiter | — | 5 | README claims it; only fixed 3 s sleep | IMPLEMENTED AND VERIFIED | `utils/slidingWindowRateLimiter.js`; window + pause tests |
| B11 | Bounded FIFO queue + concurrency | — | 5 | — | IMPLEMENTED AND VERIFIED | `utils/boundedQueue.js`; FIFO + overflow tests |
| B12 | Worker slot released during backoff | — | 5 | — | IMPLEMENTED AND VERIFIED | "worker slot is released during retry backoff" test |
| B13 | Timeouts | `geminiService.js` | 4 | `setTimeout` without abort handler | IMPLEMENTED AND VERIFIED | client timeout test against a stalled local server |
| B14 | Telemetry without prompts/secrets | — | 5 | — | IMPLEMENTED AND VERIFIED | `services/telemetry.js`; no-prompt/no-key leak test |
| B15 | Circuit breaker + recovery | — | 5 | — | IMPLEMENTED AND VERIFIED | `utils/circuitBreaker.js`; open/half-open/recovery tests |

## C. Voice

| ID | Claim / requirement | Audit files | Audit status | Traced behaviour | Final status | Final evidence |
|---|---|---|---|---|---|---|
| C1 | Windows speech recognition / STT | `voiceService.js` | 5 | Typed input only | IMPLEMENTED BUT NOT FULLY VERIFIED | Fake PowerShell only; never executed on Windows |
| C2 | TTS responses | `voiceService.speakText` | 4 | Works on Windows by design, but injection-prone `exec` string | IMPLEMENTED BUT NOT FULLY VERIFIED | Constant script + env-var text; injection test; not run on Windows |
| C3 | `listen`, `voice`, `voice on/off`, `exit voice` | controller | 3 | Only `voice` | IMPLEMENTED AND VERIFIED (mocked voice) | `test/commandRouter.test.js`, e2e voice tests |
| C4 | Voice input enters same pipeline as typed | controller | 3 | Separate, duplicated if-chain | IMPLEMENTED AND VERIFIED (mocked voice) | shared `processInput()`; e2e "voice input → create" |
| C5 | Microphone errors, cancellation, cleanup | — | 5 | — | IMPLEMENTED BUT NOT FULLY VERIFIED | NO_MICROPHONE/NO_SPEECH/cancel/timeout tests with fake process |
| C6 | Physical microphone/speaker reliability | — | 6 | Never tested | BLOCKED BY EXTERNAL DEPENDENCY (NOT TESTED) | Run `npm run voice:check` on Windows |

## D. CLI, security, testing, documentation

| ID | Claim / requirement | Audit status | Final status | Final evidence |
|---|---|---|---|---|
| D1 | Commands help/create/listen/voice/voice on/voice off/exit | 3 | IMPLEMENTED AND VERIFIED | commandRouter + e2e tests |
| D2 | No unhandled rejections / crashes on bad input | 4 (crash reproduced) | IMPLEMENTED AND VERIFIED | `utils/inputManager.js`; EOF tests; process safety net |
| D3 | Greeting handled; useful diagnostics instead of generic errors | 3 | IMPLEMENTED AND VERIFIED | e2e greeting/diagnostic tests |
| D4 | No shell injection | 4 | IMPLEMENTED AND VERIFIED | no `exec`/shell anywhere; voice injection test |
| D5 | No secret logging | 2 | IMPLEMENTED AND VERIFIED | `utils/redact.js`; config/errors/processSafety tests |
| D6 | Automated regression tests | 5 | IMPLEMENTED AND VERIFIED | 229 tests, 21 files, 94.91 % line coverage |
| D7 | "AI-powered generation of complete web applications" (README) | 2 | IMPLEMENTED AND VERIFIED (web apps) | 2/2 live To-Do runs, 23/23 checks each |
| D8 | "Fullstack" generation (README examples) | 6 | PARTIALLY IMPLEMENTED | Not demonstrated and not claimed |

## E. Previously reported figures (from the brief)

| # | Figure | Code that could have produced it at audit time | Audit status |
|---|---|---|---|
| E1 | 15/15 syntax-defect fixtures repaired | None (no validator, no corrector, no fixtures) | Unverifiable |
| E2 | Up to 95 % fewer outbound requests (mocked transport) | None (no benchmark, no mock transport) | Unverifiable |
| E3 | 147 passing tests | None (zero test files) | Unverifiable |
| E4 | 15.34 ms mock voice dispatch latency | None | Unverifiable |
| E5 | 158.6 ms PowerShell startup | None | Unverifiable |
| E6 | KLM-GOMS ≈ 600 s setup baseline | Analytical estimate, not code | Estimate only |
| E7 | Earlier benchmark = 3-file frontend apps only | — | Consistent with code capability |
| E8 | No physical mic/speaker testing | — | Confirmed |

Re-measured values, where possible, are in `JARVIS_FINAL_BENCHMARK_REPORT.md`.
