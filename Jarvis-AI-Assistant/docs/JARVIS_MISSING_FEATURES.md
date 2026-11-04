# Jarvis — Missing Features and Bug List (Phase 1, prioritized)

Derived from `JARVIS_COMPLETE_CODEBASE_AUDIT.md` (revision `a64a3fc`). IDs in brackets refer to audit findings.
Priority: **P0** = blocks the core workflow or is a security hole · **P1** = required by the brief/claims ·
**P2** = quality / robustness.

## P0 — Blocks the core workflow or is a security issue

| # | Item | Audit ref | Planned fix |
|---|---|---|---|
| 1 | Hard-coded retired model → HTTP 404 | G2, C2 | `GEMINI_MODEL` env var with a maintained alias default; `models` / `diagnose` commands |
| 2 | Request sent with `key=undefined`; key in URL | G1, G3 | Fail fast with a config diagnostic; send key in `x-goog-api-key` header |
| 3 | `.env` loaded from `cwd` | C1 | Load from the application directory before any service is required |
| 4 | Shell injection in TTS (`exec` + interpolated model output) | V2 | `execFile`/`spawn` of `powershell.exe -EncodedCommand <constant script>`; text passed via environment variable |
| 5 | Path traversal via AI-supplied project/file names | F1, P3 | `safePath.resolveInside()` for every write; reject absolute, `..`, reserved and invalid names; realpath check |
| 6 | No validation of generated code; fake "COMPLETED" with placeholder templates | F5, F7 | Static validator; no silent template fallback; honest per-file summary |
| 7 | Readline lost lines → uncaught `ERR_USE_AFTER_CLOSE` crash | J2 | Single `InputManager` that buffers lines and resolves `null` on EOF |
| 8 | Weak approval parsing; invalid input cancels silently | J1 | `parseConfirmation()` (y/yes/n/no, any case, trimmed) + re-ask loop, EOF = cancel |

## P1 — Required by the brief

| # | Item | Audit ref | Planned fix |
|---|---|---|---|
| 9 | Whole prompt used as directory name | P4 | `projectNaming.deriveProjectName()` — short slug, ≤50 chars, Windows-safe, reserved names handled |
| 10 | Exact file requirements ignored; `styles.css` hard-coded; metadata files always added | P1, P2, F2, F3 | `RequirementParser` + plan enforcement; HTML prompt lists the exact planned names; nothing written outside the approved plan |
| 11 | Files generated in isolation | F4 | Ordered generation (HTML → CSS → JS) with previously generated files as context |
| 12 | No AI self-correction | F6 | `SelfCorrector`: validate → correction prompt with errors → re-validate, max 3 corrections |
| 13 | Non-atomic writes destroy valid files | F8 | `atomicWrite` (unique temp file in same dir → rename, Windows EPERM/EBUSY retry, cleanup) |
| 14 | Blind retries of permanent errors; Retry-After ignored; no jitter | G5 | `retry.js` (exp. backoff + jitter, Retry-After seconds/HTTP-date, `RetryInfo`), classification-driven retry |
| 15 | Long server retry delays freeze the CLI | G5 | `maxRetryWaitMs` cap → fail with estimated wait, return to prompt |
| 16 | No error classification | G11 | `geminiErrors.classify*()` for 400/401/403/404/408/429/5xx/ENOTFOUND/ECONNRESET/ETIMEDOUT; quota vs. rate limit vs. billing |
| 17 | Unbounded cache, broken coalescing | G6, G7 | LRU + TTL; in-flight map cleared on settle |
| 18 | No rate limiter / queue / concurrency control | G9 | Sliding-window limiter, bounded FIFO queue, concurrency slots, global pause on 429 |
| 19 | No circuit breaker | — | Breaker for repeated transient failures; latch for auth/quota/billing so requests are not re-sent |
| 20 | No telemetry | — | Counters + latency summary; no prompts, keys or responses stored |
| 21 | No model discovery | G10 | ListModels (paginated) + live generation probe; ListModels ≠ generation guarantee |
| 22 | Truncation (2048 tokens) and empty thinking-only candidates | G4, G8 | Larger output budget; parse all text parts excluding thoughts; `MAX_TOKENS` → invalid → correction; `CONTINUATION` support |
| 23 | No speech recognition | V1 | `System.Speech.Recognition` via PowerShell (dictation + command grammar), JSON result protocol, timeouts |
| 24 | Second readline on stdin in voice mode | V3 | Voice mode uses the same `InputManager`; push-to-talk = press Enter |
| 25 | `listen`, `voice on`, `voice off` missing; voice path duplicated | V6, C3/C4 | Command router shared by typed and voice input |
| 26 | Voice availability always `true` | V4 | Real probe (Windows: SAPI voices/recognizers; other OS: unsupported) |
| 27 | Generic "Unknown command" hides diagnostics | J3 | Classified, actionable diagnostics everywhere |
| 28 | No automated tests | — | `node:test` suite (no new dependency) + coverage report |
| 29 | No benchmarks / no defensible metrics | — | Reliability, validator, self-correction, voice-dispatch benchmarks; live scripts for the user's machine |

## P2 — Robustness / hygiene

| # | Item | Audit ref | Planned fix |
|---|---|---|---|
| 30 | No secret redaction in logs | 4.7 | `redact.js` applied in the logger and to error messages |
| 31 | `open` reads any file on disk | J5 | Restrict to the Jarvis workspace; size cap |
| 32 | No process-level safety net; `process.exit` without cleanup | J4, J6 | `unhandledRejection` handler; graceful shutdown (kill voice children, cancel queued requests) |
| 33 | Missing `.env.example` | C5 | Placeholders only |
| 34 | README overstates (rate limiting, full-stack) | 4.7 | Rewrite to reflect the final implementation |
| 35 | `npm test` placeholder | 4.7 | Real test runner script (cross-platform) |

## Explicitly out of scope / will not be claimed

* Distributed rate limiting or caching (all reliability state is **process-local**).
* Full-stack generation guarantees (only demonstrated targets will be claimed).
* Running AI-generated code automatically (security); runtime checks are limited to an opt-in browser
  verification script for static web projects.
* Physical voice reliability (no hardware in this environment).

## Resolution (Phase 12, 2026-11-04)

| Items | Resolution |
|---|---|
| 1–8 (P0) | All fixed and covered by tests. #1/#2 additionally checked against the live endpoint. |
| 9–22 (P1, generation + Gemini) | Implemented and tested with mocked Gemini; live success paths blocked (no key). |
| 23–26 (P1, voice) | Implemented; verified only with a fake PowerShell process — not run on Windows hardware. |
| 27–29 (P1, CLI/tests/bench) | Implemented; 229 tests; benchmarks in `JARVIS_FINAL_BENCHMARK_REPORT.md`. |
| 30–35 (P2) | Implemented. |

Details: `JARVIS_IMPLEMENTATION_STATUS.md`.
