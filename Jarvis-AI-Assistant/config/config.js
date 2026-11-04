const path = require('path');

// Resolve everything relative to the application directory, not process.cwd(),
// so Jarvis behaves the same no matter which directory it is started from.
const ROOT_DIR = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT_DIR, '.env');

// Load .env before any service reads configuration. Existing environment
// variables win over .env values (dotenv default), which is what users expect.
const dotenvResult = require('dotenv').config({ path: ENV_PATH });

const PLACEHOLDER_KEYS = new Set(['', 'YOUR_API_KEY_HERE', 'your-api-key-here', 'your-gemini-api-key-here']);

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

const config = {
  ROOT_DIR,
  ENV_PATH,
  envFileLoaded: !dotenvResult.error,

  // API Configuration (only these two values come from the environment)
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
  const problems = [];
  const warnings = [];
  const key = cfg.geminiApiKey;
  if (!key || PLACEHOLDER_KEYS.has(key)) {
    problems.push(`GEMINI_API_KEY is not set. Add it to ${cfg.ENV_PATH} (see .env.example).`);
  } else {
    if (/\s/.test(key)) problems.push('GEMINI_API_KEY contains whitespace. Remove spaces/line breaks around the value.');
    if (/^["'].*["']$/.test(key)) warnings.push('GEMINI_API_KEY appears to be wrapped in quotes; remove them if requests fail with API_KEY_INVALID.');
    if (key.length < 30) warnings.push('GEMINI_API_KEY looks shorter than a typical Gemini API key.');
  }
  if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(cfg.geminiModel)) {
    problems.push(`GEMINI_MODEL "${cfg.geminiModel}" is not a valid model identifier.`);
  }
  return { ok: problems.length === 0, problems, warnings };
}

// Make sure the key value can never be printed by the logger or error messages.
require('../utils/redact').registerSecret(config.geminiApiKey);

config.validateConfig = validateConfig;
config.normalizeModelName = normalizeModelName;

module.exports = config;
