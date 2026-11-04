# Jarvis — Resume Metrics (with provenance)

Only metrics with reproducible evidence are listed. "Mocked" metrics must be labelled as such
wherever they are used. Measured 2026-11-04 on Node.js v22.23.4, Linux, 4 × Xeon 2.10 GHz.

| Metric | Value | Type | Reproduce | Raw data |
|---|---|---|---|---|
| Automated tests | 229 passing / 0 failing (21 files, leaf tests only) | deterministic | `npm test` | `benchmark-results/coverage.txt` |
| Line / branch / function coverage | 94.91 % / 80.74 % / 90.05 % (modules loaded by tests) | deterministic | `npm run test:coverage` | `benchmark-results/coverage.txt` |
| Seeded defect detection | 15 / 15 | local | `npm run bench:validation` | `benchmark-results/validation.json` |
| False positives on known-good files | 0 / 7 | local | `npm run bench:validation` | `benchmark-results/validation.json` |
| Outbound-request reduction, 20 identical prompts | 95 % (20 → 1) | **mocked transport** | `npm run bench:reliability` | `benchmark-results/reliability.json` |
| Outbound-request reduction, 200 calls / 25 prompts | 87.5 % (200 → 25) | **mocked transport** | `npm run bench:reliability` | `benchmark-results/reliability.json` |
| Engine overhead per call | p50 0.021 ms | **mocked transport** | `npm run bench:reliability` | `benchmark-results/reliability.json` |
| Invalid-key failure, live endpoint | 1 request, 0 retries, 491 ms whole session (old: 6 requests, ~31 s, then crash) | **live** | `npm run live:errors`; see transcript | `benchmark-results/live-invalid-key-session.txt` |
| E2E harness self-test | 3/3 files, 23/23 browser checks | local, **mock Gemini** | `npm run e2e:selftest` | `benchmark-results/e2e-todo-selftest*.json` |
| Live To-Do generation (exact benchmark prompt) | 2/2 runs generated; 3/3 files valid on first attempt; 23/23 browser/static checks each; 143–222 s | **live** (`gemini-3.5-flash`, free tier) | `npm run e2e:todo` | `benchmark-results/live-runs/` |
| Transient 503s during live generation | 5/5 recovered by bounded retry (no failed file) | **live** | `npm run e2e:todo` | `live-runs/*/transcript.txt` |
| Live AI repairs of seeded defects | 2/2 attempted repaired (1 correction each); 13 not measured (daily quota) | **live** | `npm run bench:validation:live` | `benchmark-results/validation-live.json` |

## Pending (run locally to obtain)

| Metric | Command | Why pending |
|---|---|---|
| Live To-Do success **rate** (more runs, several days) | `npm run e2e:todo` | 2 runs so far; free tier = 20 requests/model/day |
| Real Gemini repair **rate** on 15 defects | `npm run bench:validation:live` | 2/15 measured before the daily limit |
| PowerShell start-up time, SAPI probe time | `npm run bench:voice` (Windows) | needs Windows |
| Speech recognition correctness / speaker output | `npm run voice:check` (Windows) | needs microphone + speakers |

## Retired metrics

147 tests, 15.34 ms voice dispatch, 158.6 ms PowerShell start-up, "15/15 repaired" and the KLM-GOMS
600 s estimate are retired — see `JARVIS_FINAL_RESUME_VALIDATION.md`.
