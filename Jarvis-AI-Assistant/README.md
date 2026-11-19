# Jarvis AI Assistant

A Node.js command-line assistant that turns a natural-language request into a small software project
using Google Gemini. Jarvis plans the project, shows you exactly which files it will write, waits for
your approval, generates each file, validates it, asks Gemini to fix files that fail validation
(bounded), and writes only validated files. On Windows it can also listen and speak through the
built-in Windows speech APIs.

> **Status (2026-11-04).** 229 automated tests (mocked Gemini) pass. Against the live Gemini API,
> the benchmark To-Do request produced a working 3-file app in both live runs (23/23 browser checks
> each, `gemini-3.5-flash`). Physical microphone/speaker tests have **not** been performed (no
> Windows hardware was available). See
> [`docs/JARVIS_IMPLEMENTATION_STATUS.md`](docs/JARVIS_IMPLEMENTATION_STATUS.md).

## What it does

| Step | What happens |
|---|---|
| 1. Understand | Extracts explicit file names, "exactly N files", requested and forbidden technologies, features |
| 2. Plan | Gemini proposes a JSON blueprint; Jarvis enforces your hard requirements and lists every adjustment |
| 3. Approve | Shows name, folder, files, stack and architecture. Only `y`/`yes` continues; `n`/`no` cancels; anything else is asked again |
| 4. Generate | Files are generated in order (HTML → CSS → JS) so later files see the earlier ones |
| 5. Validate | JS (classic script, CommonJS, ES module), JSON, HTML, CSS, Markdown; truncation, stray fences, prose, placeholders, broken file links, forbidden technologies |
| 6. Self-correct | Invalid output is sent back with the errors, up to 3 times |
| 7. Write | Validated files only, atomically; an existing valid file is never replaced by an invalid one |
| 8. Verify & report | Re-validates what is on disk and prints an honest per-file summary |

Static validation checks syntax, structure and file links. It does **not** prove that the generated
application behaves correctly — open it and try it (or use `npm run verify:web` for to-do apps).

## Requirements

* Node.js 18 or newer (tested on Node.js 22)
* A Gemini API key — <https://aistudio.google.com/app/apikey>
* Optional, Windows 10/11 only: microphone, speakers and a Windows speech recognition language

## Install and configure

```bash
git clone https://github.com/anupiit/Jarvis.git
```

```bash
cd Jarvis/Jarvis-AI-Assistant
```

```bash
npm install
```

Copy `.env.example` to `.env` (same folder as `package.json`) and set your key. On Windows:

```bash
copy .env.example .env
```

```env
GEMINI_API_KEY=your-gemini-api-key-here
GEMINI_MODEL=gemini-flash-latest
```

`.env` is git-ignored. Jarvis never prints the key; it only reports whether one is configured.
`GEMINI_MODEL` is optional. Run `models` inside Jarvis to see what your key can use, and `diagnose`
to test one: during testing on 2026-11-04, `gemini-flash-latest` and `gemini-3.8-flash` were returning
503 "high demand" while `gemini-3.5-flash` worked. Free-tier keys are limited to about 20 generation
requests per model per day; one project costs at least 4 (plan + one per file).

## Run

```bash
npm start
```

Example session:

```
💡 Jarvis > create a simple responsive to-do list app using HTML, CSS and vanilla JavaScript. Generate exactly three files: index.html, style.css, and script.js.
📋 PROJECT PLAN
📁 Project:   To-Do List (todo-list-app)
📂 Files to write (3) — nothing else will be created:
  todo-list-app/
  ├── index.html — ...
  ├── style.css — ...
  └── script.js — ...
❓ Write these files? (y/n): y
✅ index.html — valid on first attempt
...
🎉 PROJECT GENERATED — 3/3 files validated and written
```

Projects are written to `projectsByJarvis/<short-name>/` inside the Jarvis folder.

## Commands

| Command | Description |
|---|---|
| `create <description>` | Plan, approve and generate a project (`build` / `generate` also work) |
| `voice` | Voice mode: press Enter to speak, or type; `exit voice` leaves |
| `listen` | Speak a single command (push-to-talk) |
| `voice on` / `voice off` | Spoken replies on/off |
| `projects` | List generated projects |
| `list` | List files in the current directory |
| `open <file>` | Show a file inside the current directory or the Jarvis folder |
| `models` | List Gemini models available to your key (live) |
| `diagnose [model]` | Configuration → ListModels → a real generation probe |
| `stats` | Gemini request statistics for this session |
| `help`, `exit` | |

Greetings get a local reply. Any other text is sent to Gemini as a general question (or, without a
key, Jarvis explains what is missing).

## Voice (Windows)

Voice uses `System.Speech` (SAPI) through Windows PowerShell 5.1: dictation plus a small command
grammar for recognition, and the installed SAPI voices for speech. Typed and spoken input go through
the same command pipeline. Plan approval is always typed (a misrecognized "yes" must not write files).

Before relying on it, run the interactive hardware check, which records what you actually heard and
whether transcriptions were correct:

```bash
npm run voice:check
```

On other operating systems Jarvis reports voice as unavailable and works with typed input.

## Troubleshooting

| Symptom | What Jarvis tells you / what to do |
|---|---|
| `HTTP 404 model not found` | The model is not available to your key. Run `models`, set `GEMINI_MODEL`, then `diagnose` |
| `HTTP 400 ... API_KEY_INVALID` | Fix `GEMINI_API_KEY` in `.env` (no quotes/spaces) and restart. Requests are paused instead of retried |
| `HTTP 429 rate limit` | Retried after Google's suggested delay. Waits longer than 60 s are not blocked on — Jarvis reports the estimate and returns to the prompt |
| `HTTP 429 quota exhausted` / `requires billing` | Daily quota used up, or the model has no free-tier quota (limit 0). Not retried |
| `HTTP 503 temporarily unavailable` | Bounded retries with backoff; repeated failures pause requests briefly (circuit breaker) |
| `ENOTFOUND generativelanguage.googleapis.com` | DNS/internet/VPN/firewall problem on your machine |
| Behind a corporate proxy | On recent Node.js versions (verified with v22.23) set `NODE_USE_ENV_PROXY=1` together with `HTTPS_PROXY`; add the proxy's CA via `NODE_EXTRA_CA_CERTS` |

## Tests and benchmarks

```bash
npm test
```

| Script | Purpose | Network |
|---|---|---|
| `npm test` / `npm run test:coverage` | 229 deterministic tests (mocked Gemini and voice) | none |
| `npm run live:errors` | Live endpoint checks using deliberately invalid credentials | Google |
| `npm run diagnose` | Live ListModels + generation probe with your key | Google |
| `npm run bench:reliability` | Cache/coalescing/queue benchmark, **mocked transport** | none |
| `npm run bench:validation` | Defect-corpus detection; `:live` measures real Gemini repairs | none / Google |
| `npm run bench:voice` | Dispatch latency (mock recognizer); PowerShell start-up on Windows | none |
| `npm run e2e:todo` | Live end-to-end To-Do benchmark + browser verification | Google |
| `npm run e2e:selftest` | Same harness against a local mock Gemini server | none |
| `npm run verify:web -- <dir>` | Browser add/complete/delete/reload checks (needs Playwright) | none |

Results: [`docs/JARVIS_FINAL_BENCHMARK_REPORT.md`](docs/JARVIS_FINAL_BENCHMARK_REPORT.md).

## Project structure

```
config/config.js            .env loading (app folder), GEMINI_MODEL, tunables, config validation
controllers/                JarvisController (CLI), commandRouter (shared typed/voice parsing)
models/                     RequirementParser, ProjectPlanner, FileGenerator, SelfCorrector
services/                   geminiClient (HTTP), geminiErrors, geminiService (reliability engine),
                            modelDiscovery, codeValidator, voiceService, telemetry
utils/                      inputManager, safePath, projectNaming, atomicWrite, codeExtraction,
                            lruCache, slidingWindowRateLimiter, boundedQueue, circuitBreaker,
                            retry, redact, confirm, logger, processSafety
scripts/                    test runner, diagnostics, benchmarks, E2E, browser verifier, voice check
test/                       node:test suites, fixtures, mocks
docs/                       audit, architecture, status, benchmarks, resume validation
```

## Limitations

* All caching, rate limiting and circuit-breaker state is per process (not distributed).
* Generated code is validated statically; runtime behaviour is only checked by the optional browser
  verifier for static to-do style apps. Node.js projects are syntax-checked but not installed or run.
* Voice features were implemented against Microsoft's documented `System.Speech` API but have not yet
  been run on Windows hardware by the maintainers of this branch.
* The folders in `projectsByJarvis/` that predate this version were produced by the old pipeline;
  `anup-calculator-app/components/Button.js` is truncated and does not parse.

## Documentation

* [Architecture](docs/JARVIS_CURRENT_ARCHITECTURE.md) · [Implementation status](docs/JARVIS_IMPLEMENTATION_STATUS.md)
* [Codebase audit](docs/JARVIS_COMPLETE_CODEBASE_AUDIT.md) · [Completion report](docs/JARVIS_IMPLEMENTATION_COMPLETION_REPORT.md)
* [Benchmarks](docs/JARVIS_FINAL_BENCHMARK_REPORT.md) · [Resume validation](docs/JARVIS_FINAL_RESUME_VALIDATION.md)

License: MIT
