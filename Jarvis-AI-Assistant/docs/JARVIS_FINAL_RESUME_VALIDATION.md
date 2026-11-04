# Jarvis — Final Resume Claim Validation

**Inputs.** No resume and no resume documentation existed in the repository. The claims checked here
are the eight previously reported figures listed in the task brief plus the committed README's
feature claims. Evidence comes from `JARVIS_FINAL_BENCHMARK_REPORT.md` and `docs/benchmark-results/`.

**Verdicts:** ✅ KEEP (as worded) · ✏️ REWORD (keep only the defensible part) · ❌ DROP.

## 1. Previously reported figures

| # | Previous claim | Supported by repo at audit time? | Re-measured now | Verdict | Defensible wording |
|---|---|---|---|---|---|
| E1 | "15/15 syntax-defect fixtures repaired" | No — no validator, corrector or fixtures existed | 15/15 seeded defects **detected**; 15/15 fixes accepted. Repair with a *scripted* corrector 15/15 (plumbing only). Live Gemini: **2/2 attempted defects repaired** (1 correction each), 13 not measured (free-tier daily limit) | ✏️ REWORD | "Static validator detected 15/15 seeded syntax/structure defects with 0 false positives on 7 known-good files." Do **not** claim a repair rate: 2 samples are not enough. |
| E2 | "Up to 95 % fewer outbound requests (mocked transport, repeated/concurrent identical prompts)" | No benchmark existed | 95 % fewer for 20 identical prompts (concurrent or sequential); 87.5 % for a skewed 200-call/25-prompt mix; 0 % for distinct prompts; retries add requests | ✏️ REWORD | "In mocked benchmark workloads, caching and in-flight coalescing reduced outbound requests by 87.5–95 % (0 % for non-repeating prompts)." Must keep the word *mocked*. |
| E3 | "147 passing tests" | No — zero test files | **229 / 229** passing leaf tests in 21 files (no nested suites); 94.91 % line / 80.74 % branch coverage of loaded modules | ✏️ REWORD | "229 automated tests (node:test), 94.9 % line coverage." Never claim 100 %. |
| E4 | "15.34 ms mock/in-memory voice dispatch latency" | No | p50 **0.003 ms**, p95 0.007 ms with a mock recognizer — measures Jarvis's routing only | ❌ DROP | Not meaningful as a résumé metric; a mock dispatch time says nothing about voice responsiveness. |
| E5 | "158.6 ms PowerShell process startup" | No | Not measurable (no Windows here). `npm run bench:voice` measures it on Windows | ❌ DROP (until re-measured) | If re-measured on your PC, state it as "measured on <CPU>, Windows <ver>"; it is a platform property, not an achievement. |
| E6 | "KLM-GOMS setup-time baseline ≈ 600 s" | Analytical estimate only | Not re-measured (requires a user study) | ❌ DROP as a metric | May be described in an interview as a back-of-the-envelope estimate, never as a measured time saving. |
| E7 | "Earlier benchmark tested 3-file HTML/CSS/JS apps, not full-stack" | Consistent | Still true: the live benchmark is a 3-file static web app (2/2 runs passed 23/23 checks); nothing full-stack was generated or verified | ✅ KEEP (as a scope statement) | Describe Jarvis as generating "multi-file web projects", not "full-stack applications". |
| E8 | "No physical mic/speaker testing" | Confirmed | Still not performed | ✅ KEEP (as a limitation) | Do not claim voice reliability. Mention Windows speech integration only after `npm run voice:check` passes on your machine. |

## 2. README / feature claims

| Claim (old README) | Finding | Verdict |
|---|---|---|
| "AI-Powered Project Generation … complete projects" | Pipeline tested with mocks and in 2 live Gemini runs (both produced a working To-Do app) | ✏️ REWORD — "generates and validates multi-file web projects from natural-language requests" |
| "Voice Interaction: Speak to Jarvis" | Previously typed-only; now implemented but hardware-unverified | ✏️ REWORD — conditional on `voice:check` |
| "Caching: API response caching" | Old: unbounded dict; new: bounded LRU + TTL + coalescing | ✅ KEEP (new implementation) |
| "Rate Limiting: Built-in rate limiting" | Old: false (fixed sleep); new: sliding-window limiter | ✅ KEEP (new implementation) |
| "Production-ready code" for generated projects | Not provable; static validation only | ❌ DROP |
| "create fullstack expense tracker with React" example | Not demonstrated | ❌ DROP |

## 3. Claims that must not be made

* 100 % generation reliability, or "error-free" / "guaranteed working" generated code.
* "Enterprise-grade" security — the work is input/path hardening and injection removal, not an audit.
* Full-stack generation.
* Voice accuracy or reliability figures.
* Real-world request/cost savings — the request-reduction numbers come from mocked workloads.
* Any of the old figures E3–E6 as stated.

## 4. What would unlock stronger claims

| Run this (on your machine, with your key) | Unlocks |
|---|---|
| `npm run diagnose` | Done 2026-11-04: `gemini-3.5-flash` works; `gemini-flash-latest`/`gemini-3.8-flash` were overloaded (503) at the time |
| `npm run e2e:todo` (repeat e.g. 10× on more days) | Currently 2/2 runs; more runs are needed before stating a success rate (23 checks per run) |
| `npm run bench:validation:live` (after the daily quota resets) | a real AI repair rate for the 15 seeded defects (so far 2/2 measured) |
| `npm run voice:check` | a hardware-verified statement about Windows speech input/output |
