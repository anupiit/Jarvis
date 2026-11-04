# Jarvis — Current Architecture

Describes the code as of this branch. CommonJS, Node.js ≥ 18, one runtime dependency (`dotenv`).

## 1. Component overview

```
index.js ── processSafety net
   │
   ▼
JarvisController ────────────── InputManager (the ONLY stdin reader; buffers lines; null on EOF)
   │  processInput(text, source)      ▲
   │  ◄── commandRouter.parseCommand  │ typed lines / push-to-talk Enter
   │                                  │
   ├── VoiceService ── spawn(powershell.exe -Command <constant script>), text via env vars
   │       listen() → System.Speech dictation + command grammar → JSON line → transcription
   │       speak()  → System.Speech synthesizer
   │
   ├── ProjectPlanner ── RequirementParser (deterministic hard requirements)
   │       │            projectNaming / safePath
   │       └── GeminiEngine.generate(planning prompt, JSON mode) → normalizeBlueprint()
   │
   ├── FileGenerator ── SelfCorrector ── codeValidator
   │       │                 └── GeminiEngine.generate (generation / correction prompts)
   │       └── atomicWrite (temp file → fsync → rename)   safePath.resolveInside / realpath check
   │
   └── modelDiscovery (models / diagnose)
            │
            ▼
GeminiEngine (services/geminiService.js) — process-local reliability layer
   LRU+TTL cache → in-flight coalescing → bounded FIFO queue → concurrency slots
   → sliding-window rate limiter (+ global pause on 429) → circuit breaker
   → geminiClient (one HTTP attempt) → geminiErrors classification → retry scheduler
   → telemetry (counters/latencies only)
```

## 2. Gemini integration

**API surface.** `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`,
authenticated with the `x-goog-api-key` header (the key is never placed in a URL). Request body:
`contents: [{ role: 'user', parts: [{ text }] }]`, optional `systemInstruction: { parts: [{ text }] }`,
`generationConfig: { maxOutputTokens, responseMimeType?, temperature?, thinkingConfig? }`.
Response parsing joins every non-thought text part of `candidates[0].content.parts`, reads
`finishReason` (`MAX_TOKENS` → truncated; `CONTINUATION` + `continuationToken` → follow-up request with
identical `contents` and increased `maxOutputTokens`, max 2 hops), `promptFeedback.blockReason`,
`usageMetadata`, `modelVersion` and `modelStatus`.

**Why generateContent and not the Interactions API.** Jarvis makes stateless single-turn requests;
`generateContent` is the stable method listed for text models in the official Discovery document
(revision 20261103) and is what the existing code already used. The Interactions API is a separate
endpoint with its own request body; sending a `contents` body to it produces the previously observed
"Unknown parameter 'contents'" error. Mixing the two formats is avoided by having a single client
module (`services/geminiClient.js`) that every caller goes through.

**Model selection.** `GEMINI_MODEL` (default `gemini-flash-latest`, a maintained alias). `models`
lists the live ListModels result (paginated) with `supportedGenerationMethods`; `diagnose` additionally
sends a real tiny generation request because being listed does not guarantee generation works
(tier, quota, region, preview access).

## 3. Reliability engine (process-local)

| Mechanism | Implementation | Behaviour |
|---|---|---|
| Cache | `utils/lruCache.js` | 100 entries, 10 min TTL, key = SHA-256(model, system instruction, prompt, generation config). Truncated results are not cached. Corrections bypass it (`noCache`). |
| Coalescing | `inflight` map in the engine | Identical concurrent calls share one promise until it settles (success or failure). |
| Queue | `utils/boundedQueue.js` | FIFO, max 50 pending (queued + waiting to retry). Overflow → `QUEUE_FULL`. Retries re-enter at the front. |
| Concurrency | engine `active` counter | 2 concurrent HTTP attempts. A job waiting for its retry delay holds **no** slot. |
| Rate limit | `utils/slidingWindowRateLimiter.js` | 10 requests / 60 s sliding window; a 429 with a server delay pauses all dispatch. |
| Retry | `utils/retry.js` | Only retryable kinds (TIMEOUT, RATE_LIMITED, SERVER_UNAVAILABLE, DNS, NETWORK). Max 3 retries. Equal-jitter exponential backoff (1 s base, 30 s cap). Server delay from `RetryInfo.retryDelay`, `Retry-After` (seconds **or** HTTP-date) or the message wins. Delays > 60 s are not waited for: the error carries the estimate and control returns to the user. |
| Circuit breaker | `utils/circuitBreaker.js` | Opens after 5 consecutive transient failures (30 s cooldown, half-open single probe, doubling on probe failure). AUTH/PERMISSION/QUOTA_EXHAUSTED/BILLING_REQUIRED trip it immediately (15 min, or the quota reset delay) so failing requests are not resent. |
| Timeouts | `geminiClient` | 120 s per attempt (whole files can be large); the socket is destroyed on timeout. |
| Telemetry | `services/telemetry.js` | Counters, error kinds and the last 500 latencies. No prompts, outputs or keys. |
| Cancellation | `shutdown()`, `AbortSignal` | Rejects queued work, clears retry timers, aborts in-flight requests. |

## 4. Error classification (`services/geminiErrors.js`)

| Input | Kind | Retried |
|---|---|---|
| 400 `API_KEY_INVALID` | AUTH | no (latches) |
| 400 `FAILED_PRECONDITION` (location / free tier unavailable) | PRECONDITION / BILLING_REQUIRED | no |
| 400 other (`INVALID_ARGUMENT`, unknown field) | INVALID_REQUEST | no |
| 401 | AUTH | no |
| 403 | PERMISSION (or AUTH for key reasons) | no |
| 404 | MODEL_NOT_FOUND | no |
| 408, 504, socket timeout, ETIMEDOUT | TIMEOUT | yes |
| 429 per-minute quota / no details | RATE_LIMITED | yes (server delay) |
| 429 per-day quota id | QUOTA_EXHAUSTED | no |
| 429 `limit: 0`, depleted prepayment credits, billing required | BILLING_REQUIRED | no |
| 500 / 502 / 503 | SERVER_UNAVAILABLE | yes |
| ENOTFOUND / EAI_AGAIN | DNS | yes (bounded) |
| ECONNRESET / ECONNREFUSED / EPIPE / unreachable | NETWORK | yes |
| TLS certificate errors | NETWORK | no (hint about proxy CA) |
| 200 without usable text / blocked | EMPTY_RESPONSE / BLOCKED | no |

Every error renders as `Gemini <what> (HTTP <code> <status>): <message>` plus a `→ hint` line.

## 5. Project generation pipeline

1. **RequirementParser** — explicit file names (ignores technology names like `Node.js`), exactness
   ("exactly N files", "only these files", "no other files"), requested stack (outside negated
   clauses), forbidden items/categories, features ("allow users to …").
2. **ProjectPlanner** — planning prompt lists the hard constraints (no hard-coded example file
   names); JSON response mode; `normalizeBlueprint()` validates paths, removes unsafe/binary paths,
   enforces exact files / no folders / no dependencies, orders HTML → CSS → JS, chooses the folder
   name, and records each change in `plan.adjustments`. Unparseable AI output → labelled fallback
   plan; Gemini errors are re-thrown (nothing is written).
3. **Approval** — `JarvisController.confirmPlan()`: `y|yes` / `n|no` (any case, trimmed); otherwise
   asked again (max 5); end of input = cancel. In a terminal, keys typed before the question are
   discarded so type-ahead cannot approve.
4. **FileGenerator** — per file: prompt with the exact file list, link instructions
   (`<link rel="stylesheet" href="style.css">`, `<script src="script.js" defer>`), constraints and
   previously written files → **SelfCorrector** → validated content → `resolveInside` + realpath
   check → `writeFileAtomic`. A failed file never overwrites an existing one. A Gemini failure that
   survived the engine's retries stops the run (remaining files are skipped). Final verification
   re-reads and re-validates everything on disk and reports unexpected files (never deletes them).
5. **SelfCorrector** — generate → validate → (≤3×) correction prompt with numbered errors, the
   previous output (or, if truncated, a request to regenerate concisely) and the original task.

## 6. Static validator (`services/codeValidator.js`)

| Type | Checks |
|---|---|
| JavaScript | `new vm.Script` (classic browser script — compiles, never runs), `vm.compileFunction` (CommonJS), `node --check` on a unique temp `.mjs` via `execFile` (ES modules). Module type comes from the HTML `<script type>`, extension, or syntax. Forbidden React/Node/external imports/network APIs; `require()` in a browser script; unknown element ids (warning). |
| JSON | `JSON.parse` with line numbers |
| HTML | Tokenizer: comments, doctype, attributes and quotes, raw-text elements, void and optional-end-tag elements, implicit `<p>` closing, mismatched/unclosed tags, document truncation, inline `<script>`/`<style>` validation, duplicate ids, references to planned files (with "did you mean" suggestions), required links to planned CSS/JS, external CDN resources when forbidden |
| CSS | Scanner: comments, strings, parentheses (`url(data:…;…)`), nested blocks/at-rules, declarations (`prop: value`), stray/unclosed braces, trailing content |
| All | Empty file, model stopped at output limit, unclosed/stray Markdown fences, explanatory prose, placeholder comments |

## 7. Input and voice

* `InputManager` owns the single `readline` interface; voice mode's push-to-talk is "press Enter on an
  empty line". This removes the second interface the old voice code created on `process.stdin`.
* `VoiceService` spawns `powershell.exe -NoProfile -NonInteractive -Command <constant>` (no shell).
  Scripts contain no user data and no double quotes; text, rate, volume and timeouts are passed as
  `JARVIS_*` environment variables. Recognition prints `{"event":"listening"}` then one JSON result
  (`ok/text/confidence` or `code/message`: NO_RECOGNIZER, NO_MICROPHONE, NO_SPEECH, RECOGNITION_ERROR).
  A Node-side guard kills hung processes; Ctrl+C cancels listening; speech is stopped before listening.

## 8. Security model

* No shell execution anywhere (`spawn`/`execFile` with fixed executables only).
* Every write path: `validateRelativePath` (no absolute/drive/UNC paths, `..`, Windows-invalid
  characters, reserved device names, trailing dots/spaces) → `resolveInside` → realpath check.
* Writes happen only after approval, only for files in the approved plan, only after validation.
* Secrets: key read once, registered with the redactor; the logger, error messages and the process
  safety net redact it and any `AIza…` / `key=` / `x-goog-api-key` patterns. Telemetry stores no text.
* `open` is limited to the current directory and the Jarvis folder (≤ 200 KB).

## 9. Configuration

Environment (`.env` next to `package.json`, loaded before any service): `GEMINI_API_KEY` (required),
`GEMINI_MODEL` (optional). All other settings are constants in `config/config.js`
(`GEMINI.*`, `MAX_CORRECTION_ATTEMPTS`, `MAX_PROJECT_NAME_LENGTH`, voice settings).
