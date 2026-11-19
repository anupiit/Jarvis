# Smart provider routing (Claude → Gemini)

Status: implemented; **routing logic verified with scripted fake clients only**. Nothing in this document
has been verified against the live Claude or Gemini APIs by the automated tests — use
[Real API verification](#real-api-verification) before relying on it.

## Behaviour

`AI_PROVIDER=auto` (the default) uses **Claude first** and **Gemini as the fallback**.

| Situation | What happens |
|---|---|
| Claude answers | Claude handles the request. Gemini is never called. |
| Claude: no credit / billing / quota exhausted / auth or key problem / model not found / region-precondition / key missing | The **same single request** is re-sent to Gemini. Claude is paused for `AI_PROVIDER_COOLDOWN_SEC` (default 900 s). |
| Claude: rate limited | Retried on Claude only if the wait is short (≤ 15 s, 1 retry while a fallback exists). Otherwise → Gemini, Claude paused for the suggested wait (min 60 s). |
| Claude: overloaded / timeout / network after retries | → Gemini, Claude paused for `AI_PROVIDER_TRANSIENT_COOLDOWN_SEC` (default 60 s). |
| Request-level problems (invalid request, content blocked, empty/odd model output, cancel) | **No switch.** The error is shown as is. |
| Cooldown over | The next request probes Claude once (its circuit breaker is reset). Success → Claude is primary again (`✅ Claude is available again`). Failure → paused again for a full cooldown. |
| Both providers fail or are paused | One `ALL_PROVIDERS_UNAVAILABLE` error naming each provider's reason and time to retry. While both are paused, requests fail instantly without network calls. |
| Estimated spend limit reached for a provider | That provider is skipped like an unavailable one. |
| `AI_FALLBACK_ENABLED=false` | Only the primary provider is used; its errors surface. |
| `AI_PROVIDER=claude` or `gemini` | That provider only (no router, no fallback) — the pre-existing single-provider behaviour. |

**No duplicate side effects.** A fallback only re-issues one text-generation call. Files are written by the
generator *after* a call returns, so a failed attempt has produced nothing to repeat; a successful fallback
result is used once. A test generates a project while Claude runs out of credits mid-run and asserts each file
was requested and written once.

**Jarvis never buys credits and never enables paid top-ups or auto-reload.** Spend limits only stop sending
requests to a provider.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AI_PROVIDER` | `auto` | `auto`, `claude` or `gemini` |
| `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` | – / `claude-opus-5-5` | Claude. `CLAUDE_EFFORT` (default `high`), `CLAUDE_FALLBACK` (Anthropic's server-side refusal fallback, default on) |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | – / `gemini-flash-latest` | Gemini |
| `AI_FALLBACK_ENABLED` | `true` | Allow automatic fallback in `auto` mode |
| `AI_PROVIDER_COOLDOWN_SEC` | `900` | Pause after billing/quota/auth/config failures |
| `AI_PROVIDER_TRANSIENT_COOLDOWN_SEC` | `60` | Pause after outage/rate-limit failures that survived retries |
| `AI_RETRIES_WITH_FALLBACK`, `AI_RETRY_WAIT_WITH_FALLBACK_SEC` | `1`, `15` | Claude retry budget while a fallback exists (fail over quickly) |
| `AI_CLAUDE_SPEND_LIMIT_USD`, `AI_GEMINI_SPEND_LIMIT_USD` | none | Per-run limit on **estimated** spend |
| `AI_PRICE_{CLAUDE,GEMINI}_{IN,OUT}_PER_MTOK` | list price / Gemini `$0` | Override price estimates (USD per million tokens) |

If only one provider's key is set, `auto` simply uses that provider.

## What you see

* Startup lists both providers and their roles (`primary` / `fallback`).
* Every request prints a dim line: `via Claude · claude-opus-5-5 · 1200 in / 480 out tokens · ~$0.0144`
  (or `(fallback)`, `(cached)`). Fallbacks print `🔀 Claude unavailable (...) — retrying this request with Gemini`.
* `stats` shows, per provider: status (`healthy` / `paused — reason, retry in …` / `recovering`), requests,
  tokens, **estimated** cost and limit; plus aggregate request counters.
* `models` lists models for every configured provider; `diagnose [model]` diagnoses each provider (a model name
  starting with `claude` selects Claude).

Costs are estimates from list prices (Claude table in `services/usageTracker.js`; Gemini assumed free tier,
`$0`). They are not invoices. Unknown Claude model ids are counted as tokens but "unpriced" (a spend limit
cannot apply to them).

## Audit of the existing code, and what was reused

| Existing | Used as-is |
|---|---|
| `GeminiEngine` (cache, coalescing, FIFO queue, rate limiter, circuit breaker, retry, telemetry) | One engine **per provider**, unchanged apart from a pluggable client and provider name |
| `geminiClient`, `claudeClient` | Unchanged; same `generateContent` / `listModels` interface |
| `geminiErrors` (classification, retryable/latching kinds) | Drives the switch decision; one kind added (`ALL_PROVIDERS_UNAVAILABLE`) |
| Planner, FileGenerator, SelfCorrector, validators | **Untouched** – they only call `engine.generate()` |
| `modelDiscovery` | Untouched except passing the provider to config validation |

## Changes

New: `services/providerRouter.js` (router, health, fallback), `services/usageTracker.js` (tokens, cost, limits),
`scripts/verify-providers.js` (`npm run verify:providers`), `test/providerRouter.test.js` (16 tests).
Modified: `config/config.js` (`auto`, `ROUTER` settings, per-provider validation), `services/geminiService.js`
(`getDefaultEngine()` returns the router in `auto`), `services/geminiErrors.js` (new kind, provider name),
`controllers/JarvisController.js` (startup, events, `models`, `diagnose`, `stats`), `scripts/run-tests.js`
(tests are hermetic: the developer's `.env` can no longer leak providers/keys into tests), `.env.example`,
`README.md`, `test/config.test.js`.

## Tests (mocked — logic only)

Claude success · credit exhaustion → Gemini (once) and Claude skipped afterwards · auth failure → Gemini ·
rate limiting (brief retried on Claude, long and persistent → Gemini) · outage → Gemini · request-level errors do
**not** switch · Gemini failing while unused / failing as fallback · both unavailable (clear error, then no
network calls) · recovery after cooldown incl. latched engine breaker · failed recovery probe · fallback
disabled · single/no provider configured · spend limits · cache hits not billed · no model-name leakage between
providers · usage/pricing maths · full project generation with a mid-run Claude failure (no repeated requests,
each file once).

## Real API verification

Mocks cannot prove that the real services return the errors the router expects. Run:

```bash
npm run verify:providers
```

It uses the keys in `.env`, sends ~5 tiny requests (a few hundred tokens), never prints keys, and exits non-zero on
failure. Checks: (1) Claude alone, (2) Gemini alone, (3) `auto` routing picks Claude, (4) **forced fallback** —
Claude gets a deliberately invalid key, the real 401 must make the router answer with the real Gemini API,
(5) the paused Claude is not called again. Missing keys give `SKIP` (not verified).

Manual checks the script cannot do safely:

1. **Real credit exhaustion:** with a Claude account at $0 balance (or a workspace with a spend limit already hit),
   run `create ...`. Expect `🔀 Claude unavailable (BILLING_REQUIRED ...)`, Gemini finishing the project, and
   `stats` showing Claude `paused`. If Claude's real error text is **not** recognised as billing (the router only
   sees `400 invalid_request_error` with "credit balance"), the request fails with `INVALID_REQUEST` and does
   **not** fall back — report the exact message so the pattern in `services/claudeClient.js` can be extended.
2. **Recovery:** add credit, wait for the cooldown (or restart), run a request; expect `✅ Claude is available again`.
3. **Both down:** use invalid keys for both; expect a single `no provider available` error.
4. Compare `stats` token counts with the Anthropic Console usage page for the same period.

Known limits: state (health, usage, spend) is per process; costs are estimates; the Anthropic credit-exhaustion
wording and Gemini free-tier behaviour were not observed live in this work.
