# Jarvis — Resume Claim / Requirement → Code Traceability Matrix

**Source of claims.** No resume and no resume documentation (`docs/JARVIS_RESUME_BULLETS.md`,
`docs/JARVIS_RESUME_METRICS.md`) existed in the repository at audit time. Claims below therefore come from
(a) the task brief's requirements and its list of previously reported figures, and (b) the committed
`README.MD`. No additional claims were invented.

**Status legend (audit time, revision `a64a3fc`)**
1 = FULLY IMPLEMENTED AND VERIFIED · 2 = IMPLEMENTED BUT NOT FULLY VERIFIED · 3 = PARTIALLY IMPLEMENTED ·
4 = IMPLEMENTED BUT CURRENTLY BROKEN · 5 = NOT IMPLEMENTED · 6 = NOT TESTED

> The "Final status" and "Final evidence" columns are filled in after implementation (Phase 12). Statuses are
> based on traced execution paths, not on the existence of functions or documentation.

## A. Project generation engine

| ID | Claim / requirement | Audit files | Audit status | What actually happened (traced) | Final status | Final evidence |
|---|---|---|---|---|---|---|
| A1 | NL request → structured blueprint | `models/ProjectPlanner.js` | 3, 6 | Single Gemini prompt; greedy `{…}` regex; no schema validation; any failure → template plan | _pending_ | _pending_ |
| A2 | Extract name, purpose, features, stack, file requirements | `ProjectPlanner.js` | 3 | Only via AI; explicit files / forbidden tech / "exactly N" never parsed | _pending_ | _pending_ |
| A3 | Show full plan before writing | `ProjectPlanner.displayPlan` | 3 | Plan shown, but metadata files written later were never shown | _pending_ | _pending_ |
| A4 | Explicit approval, never bypassed | `JarvisController.confirmPlan` | 4 | `startsWith('y')`; `" y"` cancels, `"yellow"` approves, no re-ask; piped `y` lost → crash | _pending_ | _pending_ |
| A5 | Cancellation writes no files | controller | 2 | True by code path, untested | _pending_ | _pending_ |
| A6 | Short, sanitized, ≤50-char, Windows-safe names | `ProjectPlanner.createFallbackPlan` | 4 | Fallback = slug of the entire prompt (`a-project-that-manage-my-day-`); AI name unsanitized | _pending_ | _pending_ |
| A7 | Path traversal protection; outputs stay in projects dir | `FileGenerator` | 5 | `path.join(projectPath, aiName)` — traversal possible | _pending_ | _pending_ |
| A8 | Exact requested files only (index.html/style.css/script.js) | `FileGenerator`, `ProjectPlanner` | 4 | `styles.css` hard-coded; `package.json`/README/.gitignore always added | _pending_ | _pending_ |
| A9 | HTML references the exact CSS/JS names | `FileGenerator.getSpecificRequirements` | 4 | Prompt hard-codes `styles.css` | _pending_ | _pending_ |
| A10 | Static validation of generated code | — | 5 | None | _pending_ | _pending_ |
| A11 | Bounded AI self-correction (≤3) | — | 5 | None | _pending_ | _pending_ |
| A12 | Preserve valid existing files when candidate invalid | — | 5 | `writeFileSync` overwrites directly | _pending_ | _pending_ |
| A13 | Clear generation summary | `FileGenerator` | 4 | Prints "COMPLETED" even when every file fell back to a template | _pending_ | _pending_ |

## B. Gemini integration & reliability

| ID | Claim / requirement | Audit files | Audit status | Traced behaviour | Final status | Final evidence |
|---|---|---|---|---|---|---|
| B1 | `.env` loaded before services; correct key var | `config/config.js` | 4 | Loads from `cwd`, not app dir | _pending_ | _pending_ |
| B2 | Configurable model | — | 5 | Hard-coded retired `gemini-2.0-flash-exp` → 404 | _pending_ | _pending_ |
| B3 | Correct endpoint / request / response schema | `geminiService.js` | 3 | Shape OK; key in URL; `parts[0]` only; finishReason ignored; 2048 tokens | _pending_ | _pending_ |
| B4 | Model discovery (ListModels + generation probe) | — | 5 | None | _pending_ | _pending_ |
| B5 | Error classification (400/401/403/404/408/429/5xx/DNS/reset/timeout) | — | 5 | All errors treated identically | _pending_ | _pending_ |
| B6 | Retry: exponential, bounded, jitter, Retry-After (s / HTTP-date / RetryInfo) | `geminiService.js` | 4 | 5 blind retries, no jitter, Retry-After ignored, permanent errors retried | _pending_ | _pending_ |
| B7 | Long retry delay returns control instead of freezing | — | 5 | — | _pending_ | _pending_ |
| B8 | Bounded LRU cache + TTL | `geminiService.js` | 3 | Unbounded object, no TTL | _pending_ | _pending_ |
| B9 | Request coalescing | `geminiService.js` | 4 | 1 s "debounce" window, deleted while in flight | _pending_ | _pending_ |
| B10 | Sliding-window rate limiter | — | 5 | README claims it; only fixed 3 s sleep | _pending_ | _pending_ |
| B11 | Bounded FIFO queue + concurrency | — | 5 | — | _pending_ | _pending_ |
| B12 | Worker slot released during backoff | — | 5 | — | _pending_ | _pending_ |
| B13 | Timeouts | `geminiService.js` | 4 | `setTimeout` without abort handler | _pending_ | _pending_ |
| B14 | Telemetry without prompts/secrets | — | 5 | — | _pending_ | _pending_ |
| B15 | Circuit breaker + recovery | — | 5 | — | _pending_ | _pending_ |

## C. Voice

| ID | Claim / requirement | Audit files | Audit status | Traced behaviour | Final status | Final evidence |
|---|---|---|---|---|---|---|
| C1 | Windows speech recognition / STT | `voiceService.js` | 5 | Typed input only | _pending_ | _pending_ |
| C2 | TTS responses | `voiceService.speakText` | 4 | Works on Windows by design, but injection-prone `exec` string | _pending_ | _pending_ |
| C3 | `listen`, `voice`, `voice on/off`, `exit voice` | controller | 3 | Only `voice` | _pending_ | _pending_ |
| C4 | Voice input enters same pipeline as typed | controller | 3 | Separate, duplicated if-chain | _pending_ | _pending_ |
| C5 | Microphone errors, cancellation, cleanup | — | 5 | — | _pending_ | _pending_ |
| C6 | Physical microphone/speaker reliability | — | 6 | Never tested | _pending_ | _pending_ |

## D. CLI, security, testing, documentation

| ID | Claim / requirement | Audit status | Final status | Final evidence |
|---|---|---|---|---|
| D1 | Commands help/create/listen/voice/voice on/voice off/exit | 3 | _pending_ | _pending_ |
| D2 | No unhandled rejections / crashes on bad input | 4 (crash reproduced) | _pending_ | _pending_ |
| D3 | Greeting handled; useful diagnostics instead of generic errors | 3 | _pending_ | _pending_ |
| D4 | No shell injection | 4 | _pending_ | _pending_ |
| D5 | No secret logging | 2 | _pending_ | _pending_ |
| D6 | Automated regression tests | 5 | _pending_ | _pending_ |
| D7 | "AI-powered generation of complete web applications" (README) | 2 | _pending_ | _pending_ |
| D8 | "Fullstack" generation (README examples) | 6 | _pending_ | _pending_ |

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
