const path = require('path');

// Resolve everything relative to the application directory, not process.cwd(),
// so Jarvis behaves the same no matter which directory it is started from.
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

// Load .env before any service reads configuration. Existing environment
// variables win over .env values (dotenv default), which is what users expect.
const dotenvResult = require('dotenv').config({ path: ENV_PATH });

const PLACEHOLDER_KEYS = new Set(['', 'your-anthropic-api-key-here','YOUR_API_KEY_HERE', 'your-api-key-here', 'your-gemini-api-key-here']);

// A maintained alias, so the default does not go stale the way the previously
// hard-coded "gemini-2.0-flash-exp" did. Override with GEMINI_MODEL in .env and
// use the `models` / `diagnose` commands to see what your key can actually use.
const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest';

function normalizeModelName(model) {
  if (!model) return '';
  return String(model).trim().replace(/^models\//, '');
}

function readApiKey() {
  const raw = process.env.GEMINI_API_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

function readAnthropicKey() {
  const raw = process.env.ANTHROPIC_API_KEY;
  return typeof raw === 'string' ? raw.trim() : '';
}

// AI_PROVIDER=auto (default) | claude | gemini. auto = Claude first, Gemini as fallback.
function pickProvider() {
  const explicit = String(process.env.AI_PROVIDER || '').trim().toLowerCase();
  if (explicit === 'claude' || explicit === 'anthropic') return 'claude';
  if (explicit === 'gemini') return 'gemini';
  return 'auto'; // Claude first, Gemini as fallback
}

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

// Optional non-negative number (USD limit / price); null = not set.
function envLimit(name) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const config = {
  ROOT_DIR,
  ENV_PATH,
  envFileLoaded: !dotenvResult.error,

  provider: pickProvider(),
  anthropicApiKey: readAnthropicKey(),
  claudeModel: normalizeModelName(process.env.CLAUDE_MODEL) || DEFAULT_CLAUDE_MODEL,
  DEFAULT_CLAUDE_MODEL,
  CLAUDE: {
    effort: (process.env.CLAUDE_EFFORT === undefined ? 'high' : process.env.CLAUDE_EFFORT).trim().toLowerCase(), // '' disables (older models)
    fallback: String(process.env.CLAUDE_FALLBACK || 'true').toLowerCase() !== 'false'
  },

  // Smart provider routing (AI_PROVIDER=auto). Jarvis NEVER buys credits or enables paid
  // top-ups; the spend limits below are local, per-process safety nets.
  ROUTER: {
    fallbackEnabled: String(process.env.AI_FALLBACK_ENABLED === undefined ? 'true' : process.env.AI_FALLBACK_ENABLED).trim().toLowerCase() !== 'false',
    // How long a provider is skipped after a billing/quota/auth/config failure.
    cooldownMs: envNumber('AI_PROVIDER_COOLDOWN_SEC', 900) * 1000,
    // How long after a transient failure (overload, network, rate limit) that survived retries.
    transientCooldownMs: envNumber('AI_PROVIDER_TRANSIENT_COOLDOWN_SEC', 60) * 1000,
    // With a fallback available, give up on Claude sooner instead of retrying for a long time.
    retriesWithFallback: envNumber('AI_RETRIES_WITH_FALLBACK', 1),
    maxRetryWaitWithFallbackMs: envNumber('AI_RETRY_WAIT_WITH_FALLBACK_SEC', 15) * 1000,
    spendLimitUsd: { claude: envLimit('AI_CLAUDE_SPEND_LIMIT_USD'), gemini: envLimit('AI_GEMINI_SPEND_LIMIT_USD') },
    // USD per million tokens, used only for ESTIMATES. Override with AI_PRICE_<PROVIDER>_<IN|OUT>_PER_MTOK.
    // Gemini defaults to 0 (free tier); set real prices if you are on a paid Gemini plan.
    priceOverride: {
      claude: { in: envLimit('AI_PRICE_CLAUDE_IN_PER_MTOK'), out: envLimit('AI_PRICE_CLAUDE_OUT_PER_MTOK') },
      gemini: { in: envLimit('AI_PRICE_GEMINI_IN_PER_MTOK'), out: envLimit('AI_PRICE_GEMINI_OUT_PER_MTOK') }
    }
  },

  // Gemini configuration (from the environment)
  geminiApiKey: readApiKey(),
  geminiModel: normalizeModelName(process.env.GEMINI_MODEL) || DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_MODEL,

  GEMINI: {
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiVersion: 'v1beta',
    requestTimeoutMs: 120000,     // per HTTP attempt; whole source files can take a while
    maxOutputTokens: 32768,       // the old 2048 truncated files (thinking tokens count too)
    maxContinuations: 2,          // follow finishReason=CONTINUATION at most this many times
    // Retry policy
    maxRetries: 3,                // retries after the first attempt (bounded)
    baseBackoffMs: 1000,
    maxBackoffMs: 30000,
    maxRetryWaitMs: 60000,        // never block longer than this for one retry; report instead
    // Cache
    cacheMaxEntries: 100,
    cacheTtlMs: 10 * 60 * 1000,
    // Rate limiting (process-local sliding window)
    rateLimitMaxRequests: 10,
    rateLimitWindowMs: 60000,
    // Queue / concurrency
    concurrency: 2,
    maxQueueSize: 50,
    // Circuit breaker
    circuitFailureThreshold: 5,
    circuitCooldownMs: 30000,
    circuitLatchMs: 15 * 60 * 1000 // auth/quota/billing failures stop requests for this long
  },

  // Kept for backward compatibility with older callers.
  MAX_RETRIES: 3,

  // Project generation
  PROJECTS_DIR: 'projectsByJarvis',
  PROJECTS_ROOT: path.join(ROOT_DIR, 'projectsByJarvis'),
  MAX_PROJECT_NAME_LENGTH: 50,
  MAX_PLANNED_FILES: 25,
  MAX_CORRECTION_ATTEMPTS: 3,

  // Voice (Windows SAPI). VOICE_RATE is the SAPI rate (-10..10), VOICE_VOLUME 0..100.
  VOICE_ENABLED: true,
  VOICE_RATE: 0,
  VOICE_VOLUME: 100,
  VOICE_LISTEN_TIMEOUT_SEC: 8,
  VOICE_MAX_SPOKEN_CHARS: 600,

  // Console Colors
  colors: {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m'
  }
};

/**
 * Validate configuration without ever revealing secret values.
 * @returns {{ ok: boolean, problems: string[], warnings: string[] }}
 */
function validateConfig(cfg = config) {
  if (cfg.provider === 'auto') {
    const c = validateProvider({ ...cfg, provider: 'claude' });
    const g = validateProvider({ ...cfg, provider: 'gemini' });
    const ok = c.ok || g.ok;
    const problems = ok ? [] : [...c.problems, ...g.problems];
    const warnings = [...c.warnings, ...g.warnings];
    if (ok && !c.ok) warnings.push(`Claude is not usable (${c.problems[0]}); Gemini will be used.`);
    if (ok && !g.ok) warnings.push(`No Gemini fallback (${g.problems[0]}).`);
    return { ok, problems, warnings, claude: c, gemini: g };
  }
  return validateProvider(cfg);
}

function validateProvider(cfg) {
  const problems = [];
  const warnings = [];
  const claude = cfg.provider === 'claude';
  const keyVar = claude ? 'ANTHROPIC_API_KEY' : 'GEMINI_API_KEY';
  const modelVar = claude ? 'CLAUDE_MODEL' : 'GEMINI_MODEL';
  const key = claude ? cfg.anthropicApiKey : cfg.geminiApiKey;
  const model = claude ? cfg.claudeModel : cfg.geminiModel;
  if (!key || PLACEHOLDER_KEYS.has(key)) {
    problems.push(`${keyVar} is not set. Add it to ${cfg.ENV_PATH} (see .env.example).`);
  } else {
    if (/\s/.test(key)) problems.push(`${keyVar} contains whitespace. Remove spaces/line breaks around the value.`);
    if (/^["'].*["']$/.test(key)) warnings.push(`${keyVar} appears to be wrapped in quotes; remove them if requests fail with an authentication error.`);
    if (key.length < 30) warnings.push(`${keyVar} looks shorter than a typical API key.`);
  }
  if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(model)) {
    problems.push(`${modelVar} "${model}" is not a valid model identifier.`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

// Make sure the key value can never be printed by the logger or error messages.
require('../utils/redact').registerSecret(config.geminiApiKey);
require('../utils/redact').registerSecret(config.anthropicApiKey);

config.validateConfig = validateConfig;
config.isProviderConfigured = (provider, cfg = config) => validateProvider({ ...cfg, provider }).ok;
config.normalizeModelName = normalizeModelName;

module.exports = config;
