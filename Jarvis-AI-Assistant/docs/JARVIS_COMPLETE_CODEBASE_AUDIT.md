# Jarvis AI Assistant — Complete Codebase Audit (Phase 0)

**Audit date:** 2026-11-04
**Audited revision:** `a64a3fc` (`main`, "new changes") — the only branch on `github.com/anupiit/Jarvis`
**Auditor scope:** every file tracked in the repository (no files were modified before this audit was written)

---

## 1. Critical scope finding — the repository is much smaller than the task brief assumes

The task brief describes "existing" functionality: an LRU cache, request coalescing, a sliding-window rate
limiter, a bounded FIFO queue, telemetry, a static code validator, an AI self-correction engine, Windows
speech recognition, 147 passing tests, benchmark scripts, and resume documentation
(`docs/JARVIS_RESUME_BULLETS.md`, `docs/JARVIS_RESUME_METRICS.md`).

**None of these exist in the repository.** Verification performed:

| Check | Result |
|---|---|
| `git ls-remote origin` / GitHub branch list | Only `main` (`a64a3fc`) |
| GitHub pull requests (open + closed) | None |
| Other repositories accessible to this session matching "jarvis" | None (only `anupiit/Jarvis`) |
| `docs/` directory | Does not exist |
| Test files (`*.test.js`, `test/`, `__tests__/`) | None; `npm test` is the npm placeholder that exits 1 |
| Benchmark scripts | None |
| Resume file or resume docs | None |
| `.env.example` | Does not exist |

The most likely explanation is that the work described in the brief exists only in an unpushed local working
copy, or was described by an earlier tool session but never committed. **If you have unpushed local changes,
they are not reflected anywhere in this audit or in the implementation that follows** — reconcile before
merging.

Consequences for this engagement:

* Every "existing" reliability/validation/voice/test feature is treated as **NOT IMPLEMENTED** and is built
  from the specification in the brief, on top of the committed architecture.
* All previously reported metrics (147 tests, 15/15 fixtures, 95 % fewer requests, 15.34 ms, 158.6 ms,
  KLM-GOMS 600 s) are **unverifiable from the repository** — there is no code that could have produced them.
  They are not reused; see `JARVIS_FINAL_RESUME_VALIDATION.md` for re-measurements.

---

## 2. Repository inventory (as committed)

```
Jarvis-AI-Assistant/
├── .gitignore                      41 lines   (.env is ignored ✔)
├── README.MD                      188 lines
├── agent.js                         5 lines   duplicate of index.js ("legacy entry point")
├── index.js                         5 lines   new JarvisController().start()
├── package.json                    29 lines   deps: dotenv ^16; devDeps: nodemon; test script = placeholder
├── package-lock.json
├── config/config.js                31 lines
├── controllers/JarvisController.js 276 lines
├── models/ProjectPlanner.js       110 lines
├── models/FileGenerator.js        480 lines
├── services/geminiService.js      120 lines
├── services/voiceService.js        81 lines
├── utils/logger.js                 21 lines
└── projectsByJarvis/               two previously generated sample projects (committed output)
    ├── a-project-that-manage-my-day-/   ← evidence of the "whole prompt as folder name" bug
    └── anup-calculator-app/
```

Total application source: **~1,130 lines**, CommonJS, one runtime dependency (`dotenv`).

---

## 3. Architecture as committed

```
index.js ─► JarvisController ──► ProjectPlanner ──► geminiService.callGeminiAPI ──► https (generateContent)
                │                     │
                │                     └─ fallback plan (slug of full prompt)
                ├──► FileGenerator ───► geminiService (one call per file, independent prompts)
                │         └─ template fallback files + package.json + README.md + .gitignore (always)
                ├──► voiceService.speakText  (exec "powershell -Command ...")
                └──► voiceService.startVoiceInput (a SECOND readline on stdin — typed text, no STT)
```

---

## 4. File-by-file findings

### 4.1 `config/config.js`
| # | Finding | Severity |
|---|---|---|
| C1 | `require('dotenv').config()` loads `.env` from `process.cwd()`, not the application directory. Starting Jarvis from any other directory silently loses the API key. | High |
| C2 | No model variable. The model is hard-coded in `geminiService.js`. | High |
| C3 | No validation of configuration; missing key is only warned about (and the request is still sent — see G1). | Medium |
| C4 | `VOICE_RATE` defined but never used; `GEMINI_DEBOUNCE_MS` drives a buggy debounce (G6). | Low |
| C5 | `.env` is git-ignored ✔. No `.env.example` exists. | Low |

### 4.2 `services/geminiService.js`
| # | Finding | Severity |
|---|---|---|
| G1 | With no key configured the request is still sent as `?key=undefined` (reproduced — see §6). | High |
| G2 | Model hard-coded to `gemini-2.0-flash-exp`, an experimental model that is no longer served → **HTTP 404 "model not found"** (root cause of the reported 404). | Critical |
| G3 | API key placed in the URL query string. Any logged URL/error leaks it. The documented header `x-goog-api-key` is not used. | Medium |
| G4 | `maxOutputTokens: 2048` for whole source files. Files are truncated, and for thinking models the thinking budget counts against the limit, producing a candidate with no text → "Unexpected response format". | High |
| G5 | **Every** error is retried 5 times with 1/2/4/8/16 s backoff — including permanent 400/401/403/404. Retry-After / `RetryInfo` is ignored (wrong delays for 429), there is no jitter, no classification, no circuit breaker. Reproduced: an invalid key wastes 31 s. | High |
| G6 | "Debounce" map entry is deleted after 1 s even though the request may still be in flight, so coalescing only works for 1 s. Correctness depends on the backoff (≥1 s) never being shorter than the debounce window. | Medium |
| G7 | Cache is an unbounded plain object with no TTL (memory grows for the process lifetime). | Medium |
| G8 | Only `parts[0].text` is read; multi-part responses and thought parts are not handled; `finishReason`, `promptFeedback.blockReason` and usage metadata are ignored. | Medium |
| G9 | No queue, no concurrency limit, no rate limiter (README claims "Built-in rate limiting" — false; only a fixed 3 s sleep between files exists). | Medium |
| G10 | No model discovery / ListModels / diagnostics. | Medium |
| G11 | Network errors (ENOTFOUND, ECONNRESET, ETIMEDOUT) are retried blindly and reported with raw messages. | Medium |
| G12 | `req.setTimeout(30000)` sets a timeout but no `timeout` handler destroys the request, so a stalled socket is never aborted by this code. | Medium |

**API surface decision.** The official Discovery document for `generativelanguage.googleapis.com` (revision
`20261103`, fetched live during this audit) defines `POST v1beta/models/{model}:generateContent` with
`contents`, `systemInstruction`, `generationConfig` (incl. `responseMimeType`, `thinkingConfig`) and the
response fields `candidates[].content.parts[]`, `finishReason` (now including `CONTINUATION` +
`continuationToken`), `promptFeedback`, `usageMetadata`, `modelVersion` and `modelStatus`. The Interactions
API is a separate surface with a different request body; sending a `contents` body to it is what produces
"Unknown parameter 'contents'". The committed code uses `generateContent` correctly in shape; the defects
are the model, the auth transport, the limits and the error handling — **not** the choice of API.
Keep `generateContent`; do not mix in Interactions API formats.

### 4.3 `models/ProjectPlanner.js`
| # | Finding | Severity |
|---|---|---|
| P1 | The prompt's example file structure hard-codes `styles.css`, `assets/`, `components/`, steering every plan toward those names regardless of the user's request. | High |
| P2 | No extraction of explicit file requirements, forbidden technologies or "exactly N files". | High |
| P3 | AI `projectName` is used unsanitized → path traversal (`../../x`) and Windows-invalid names possible. | High |
| P4 | Fallback plan name = slug of the **entire prompt**, no length cap, trailing `-` kept (the committed folder `a-project-that-manage-my-day-` is this bug). | High |
| P5 | Fallback plan silently adds `styles.css` and `assets/`. | Medium |
| P6 | Any planning failure (including auth/quota) falls back to a template plan, which then leads to template files being written — the real error is hidden. | High |
| P7 | No schema validation of the AI JSON (missing `features` → crash in `displayPlan`). | Medium |

### 4.4 `models/FileGenerator.js`
| # | Finding | Severity |
|---|---|---|
| F1 | `path.join(projectPath, item.name)` with AI-supplied names → **path traversal** outside `projectsByJarvis`. | Critical |
| F2 | Always writes `package.json`, `README.md`, `.gitignore` (not in the plan the user approved). `package.json` lists AI "dependencies" as `"latest"`. | High |
| F3 | HTML prompt says "Link to styles.css and script.js" regardless of planned names → broken references when the user asks for `style.css`. | High |
| F4 | Each file is generated in isolation — the JS never sees the HTML IDs it must use. | High |
| F5 | **No validation** of generated code at all. | Critical |
| F6 | **No self-correction.** | Critical |
| F7 | On failure, placeholder template files are written silently and "🎉 PROJECT CREATION COMPLETED!" is printed even if every file failed (fake success). | High |
| F8 | Direct `writeFileSync` (non-atomic) over existing files; a bad candidate destroys a valid existing file. | High |
| F9 | `extractCodeFromResponse` regex with `type` = `javascript` fails on ```` ```js ```` fences; unclosed fences (truncation) are not detected. | Medium |
| F10 | Fixed `API_DELAY` 3 s sleep between files instead of rate limiting. | Low |

### 4.5 `services/voiceService.js`
| # | Finding | Severity |
|---|---|---|
| V1 | **There is no speech recognition.** `startVoiceInput` reads typed text ("Voice input uses text input for reliability"). | Critical (vs. claims) |
| V2 | `speakText` builds a shell string for `exec()` with AI-generated text; escaping only `'`/`"`/newline. cmd.exe metacharacters after a `""` sequence can break out → **command injection** driven by model output. | Critical |
| V3 | Creates a **second `readline` interface on `process.stdin`** while the controller's interface is active → duplicate keypress handling/echo, terminal raw-mode toggling on close, and lost lines. Root cause of "pressing Enter did not reliably activate" voice input. | High |
| V4 | `checkVoiceAvailability()` always returns `true` (comment: "let's assume it's available"); on non-Windows every response triggers 3 failing PowerShell spawns and a warning. | Medium |
| V5 | No cancellation / child-process tracking; overlapping speech processes. | Medium |
| V6 | `listen`, `voice on`, `voice off` commands do not exist. | Medium |

### 4.6 `controllers/JarvisController.js`
| # | Finding | Severity |
|---|---|---|
| J1 | Confirmation: `answer.toLowerCase().startsWith('y')` — `" y"` cancels, `"yellow"` approves, invalid input cancels without re-asking. | High |
| J2 | Type-ahead/piped lines that arrive while no `rl.question` is pending are dropped; the subsequent `rl.question` after stdin end throws **uncaught `ERR_USE_AFTER_CLOSE`** (reproduced). | High |
| J3 | General-question errors are reported as "Unknown command" — the real diagnostic is discarded. | Medium |
| J4 | `exit` calls `process.exit(0)` immediately (in-flight speech/children not cleaned up). | Low |
| J5 | `open <file>` reads any path on disk; `open` lower-cases the filename (breaks case-sensitive paths). | Medium |
| J6 | No `unhandledRejection` / `uncaughtException` safety net. | Medium |
| J7 | Startup hint is `export GEMINI_API_KEY=...` (POSIX) on a Windows-targeted tool. | Low |

### 4.7 Other files
* `utils/logger.js` — no secret redaction.
* `agent.js` — duplicate of `index.js`; harmless, kept.
* `README.MD` — documents caching and "Built-in rate limiting" (the latter is not implemented), lists
  `list`/`open`/`voice` only.
* `package.json` — `"test"` is the npm placeholder; `engines: node >= 14` although nothing was ever tested.

---

## 5. Security audit summary (as committed)

| Area | Status |
|---|---|
| Shell injection | **Vulnerable** (V2: `exec` with interpolated model output) |
| Path traversal on write | **Vulnerable** (F1, P3) |
| Path traversal on read (`open`) | Unrestricted (J5) |
| Secret in URL | Yes (G3) |
| Secret logging | Not directly logged, but no redaction layer |
| `.env` git-ignored | ✔ |
| User approval before writes | Present, but weak parsing (J1) and extra unapproved files are written (F2) |
| Temporary files | None used (and no atomic writes — F8) |

---

## 6. Baseline execution evidence (committed code, run in a scratch copy)

Command: `printf 'hi\ncreate a project that manage my day\ny\n' | node index.js` with no API key.

Observed:
1. Greeting answered ✔.
2. `⚠️ Voice output not available` printed on Linux even though `checkVoiceAvailability()` returned `true` (V4).
3. Request sent with an undefined key; Google returned `400 API_KEY_INVALID`; **retried 5×** over ~31 s (G1, G5).
4. Fallback plan: project name `a-project-that-manage-my-day`, files `styles.css` + `assets/` (P4, P5).
5. The piped `y` was lost; `readline was closed` → **uncaught `ERR_USE_AFTER_CLOSE` stack trace** (J2).
6. No files were written in this run only because readline crashed first.

Evidence in previously committed Jarvis output (found later with the new validator):
* `projectsByJarvis/anup-calculator-app/components/Button.js` starts with a stray ```` ```javascript ```` fence,
  has no closing fence and ends mid-tag (`</calculator-`) at ~7.5 KB — consistent with the old 2048-token output
  limit (G4) and the fence-extraction bug (F9). The old pipeline wrote it without validation (F5) and it does not
  parse. `index.html` of that project never loads `components/Button.js` or `components/Display.js` (F4).
* `projectsByJarvis/a-project-that-manage-my-day-/` contains `package.json`, `README.md`, `.gitignore` and
  `styles.css` that were added automatically (F2, P1).

Live Gemini endpoint checks performed during the audit (no valid key is available in this environment):
* `GET /v1beta/models` without key → `403 PERMISSION_DENIED` ("unregistered callers").
* `POST …:generateContent` with an invalid key → `400 INVALID_ARGUMENT`, `ErrorInfo.reason = API_KEY_INVALID`.
* `POST …:generateContent` with an unknown body field → `400 INVALID_ARGUMENT`, `BadRequest.fieldViolations`
  ("Invalid JSON payload received. Unknown name …").
These real payloads are used verbatim as test fixtures.

---

## 7. Environment constraints for this engagement

| Dependency | Availability here | Impact |
|---|---|---|
| Gemini API key | **Not available** (and will not be requested) | Live generation, live 404/429/503 and live E2E generation cannot be executed here |
| `generativelanguage.googleapis.com` | Reachable | Live auth-failure paths and Discovery document verified |
| `ai.google.dev` documentation | **Blocked** by session network policy | Used the official machine-readable Discovery document instead |
| Windows / PowerShell / SAPI | **Not available** (Linux container) | Real STT/TTS and PowerShell timing cannot be measured here |
| Microphone / speakers | **Not available** | Physical voice tests: NOT TESTED |
| Chromium + Playwright | Available | Browser functional testing of web output is possible |
| Node.js | v22.23.4 | |
