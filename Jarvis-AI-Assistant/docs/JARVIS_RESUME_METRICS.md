# Jarvis — Resume Metrics (with provenance)

Only metrics with reproducible evidence are listed. "Mocked" metrics must be labelled as such
wherever they are used. Measured 2026-11-04 on Node.js v22.23.4, Linux, 4 × Xeon 2.10 GHz.

| Metric | Value | Type | Reproduce | Raw data |
|---|---|---|---|---|
| Automated tests | 229 passing / 0 failing (21 files, leaf tests only) | deterministic | `npm test` | `benchmark-results/coverage.txt` |
| Line / branch / function coverage | 94.91 % / 80.69 % / 90.05 % (modules loaded by tests) | deterministic | `npm run test:coverage` | `benchmark-results/coverage.txt` |
| Seeded defect detection | 15 / 15 | local | `npm run bench:validation` | `benchmark-results/validation.json` |
| False positives on known-good files | 0 / 7 | local | `npm run bench:validation` | `benchmark-results/validation.json` |
| Outbound-request reduction, 20 identical prompts | 95 % (20 → 1) | **mocked transport** | `npm run bench:reliability` | `benchmark-results/reliability.json` |
| Outbound-request reduction, 200 calls / 25 prompts | 87.5 % (200 → 25) | **mocked transport** | `npm run bench:reliability` | `benchmark-results/reliability.json` |
| Engine overhead per call | p50 0.021 ms | **mocked transport** | `npm run bench:reliability` | `benchmark-results/reliability.json` |
| Invalid-key failure, live endpoint | 1 request, 0 retries, 491 ms whole session (old: 6 requests, ~31 s, then crash) | **live** | `npm run live:errors`; see transcript | `benchmark-results/live-invalid-key-session.txt` |
| E2E harness self-test | 3/3 files, 18/18 browser checks | local, **mock Gemini** | `npm run e2e:selftest` | `benchmark-results/e2e-todo-selftest*.json` |

## Pending (blocked here — run locally to obtain)

| Metric | Command | Why pending |
|---|---|---|
| Live To-Do generation success rate + browser verification | `npm run e2e:todo` | needs `GEMINI_API_KEY` |
| Real Gemini repair rate on 15 defects | `npm run bench:validation:live` | needs `GEMINI_API_KEY` |
| PowerShell start-up time, SAPI probe time | `npm run bench:voice` (Windows) | needs Windows |
| Speech recognition correctness / speaker output | `npm run voice:check` (Windows) | needs microphone + speakers |

## Retired metrics

147 tests, 15.34 ms voice dispatch, 158.6 ms PowerShell start-up, "15/15 repaired" and the KLM-GOMS
600 s estimate are retired — see `JARVIS_FINAL_RESUME_VALIDATION.md`.
