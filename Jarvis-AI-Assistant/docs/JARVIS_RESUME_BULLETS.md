# Jarvis — Resume Bullets (evidence-backed)

Each bullet lists the evidence it rests on. Use the "ready" bullets as they are. Use a "conditional"
bullet only after you have run the listed command yourself and it succeeded.

## Ready to use

1. **Built Jarvis, a Node.js CLI that turns natural-language requests into multi-file web projects**
   through a plan → explicit approval → Gemini generation → static validation → bounded AI
   self-correction → atomic-write pipeline, with exact-file and forbidden-technology constraints
   parsed from the request.
   *Evidence:* `models/`, `services/`, 21 end-to-end CLI tests (`test/e2e.controller.test.js`).

2. **Engineered a process-local reliability layer for the Gemini API** — bounded LRU/TTL cache,
   in-flight request coalescing, bounded FIFO queue with concurrency slots released during backoff,
   sliding-window rate limiting, Retry-After-aware exponential backoff with jitter and a circuit
   breaker — **cutting outbound requests by 87.5–95 % in mocked repeated-prompt benchmarks**.
   *Evidence:* `services/geminiService.js`, 40 engine/primitive tests, `benchmark-results/reliability.json`.

3. **Wrote a dependency-free static code validator** (V8 and `node --check` for JavaScript, JSON, custom
   HTML and CSS tokenizers, truncation, fence and cross-file reference checks) that **detected 15/15
   seeded defects with 0 false positives on 7 known-good files** and exposed a truncated, unparseable
   file in previously committed output.
   *Evidence:* `services/codeValidator.js`, `benchmark-results/validation.json`.

4. **Classified Gemini API failures into actionable diagnostics** (rate limit vs. daily quota vs.
   billing, auth, model-not-found, 5xx, DNS, resets, timeouts) and stopped resending requests that
   cannot succeed. **Against the live API, an invalid key now costs 1 request and ~0.5 s instead of 6
   requests over ~31 s followed by a crash.**
   *Evidence:* `services/geminiErrors.js`, `benchmark-results/live-invalid-key-session.txt`.

5. **Hardened the CLI and file system access**: a single stdin reader (fixed lost input and an uncaught
   readline crash), strict approval parsing, path-traversal and Windows reserved-name protection,
   shell-free PowerShell integration and secret redaction. **Covered by 229 automated tests (94.9 %
   line coverage).**
   *Evidence:* `utils/inputManager.js`, `utils/safePath.js`, `services/voiceService.js`, `coverage.txt`.

6. **Verified end to end against the live Gemini API:** from a single natural-language prompt, Jarvis
   generated a 3-file To-Do web app that passed **23/23 automated headless-browser and static checks**
   (add, complete, delete, persistence across reload) in **both live runs**, recovering from transient
   HTTP 503s without failing a file.
   *Evidence:* `benchmark-results/live-runs/run1`, `run2` (transcripts, apps, verification JSON).
   *Wording rule:* say "both live runs" / "2 of 2", never a percentage, until you have more runs.

## Conditional (run first, then fill in your numbers)

7. *After a full `npm run bench:validation:live` run:* "The AI self-correction loop repaired **N/15**
   seeded defects within 3 attempts." (So far 2/2 attempted were repaired; the free tier's daily limit
   stopped the run, so no rate can be claimed yet.)

8. *After `npm run voice:check` passes on your PC:* "Added Windows speech input/output (System.Speech)
   with push-to-talk, spoken replies and cancellation, sharing the typed command pipeline."

## Do not use

* "100 % reliable", "error-free code", "production-ready output", "enterprise-grade security".
* "Full-stack application generation".
* "147 tests", "15.34 ms voice latency", "158.6 ms PowerShell start-up", "15/15 repaired",
  "saves ~600 s per setup".
* Any request-reduction figure without the word "mocked".
