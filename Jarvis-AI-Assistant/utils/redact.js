// Removes secrets from any text before it is printed or stored.

const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{20,}/g;
const KEY_PARAM_PATTERN = /([?&](?:key|api_key|apikey)=)[^&\s"']+/gi;
const KEY_HEADER_PATTERN = /(x-goog-api-key["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

const extraSecrets = new Set();

function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) extraSecrets.add(value);
}

function redactSecrets(input) {
  if (input === null || input === undefined) return input;
  let text = typeof input === 'string' ? input : String(input);
  for (const secret of extraSecrets) {
    if (text.includes(secret)) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(GOOGLE_KEY_PATTERN, '[REDACTED]')
    .replace(KEY_PARAM_PATTERN, '$1[REDACTED]')
    .replace(KEY_HEADER_PATTERN, '$1[REDACTED]');
}

module.exports = { redactSecrets, registerSecret };
