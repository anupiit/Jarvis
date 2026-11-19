// Process-level safety net for the interactive CLI.
// Late socket errors (e.g. ECONNRESET on a pooled or proxied socket after its request has
// already settled) are emitted on objects Jarvis never sees. They are harmless for the
// request that already failed/succeeded, so they are logged instead of crashing the CLI.
// Anything else is reported and the process exits with a non-zero code.
const { redactSecrets } = require('./redact');

const BENIGN_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ETIMEDOUT', 'ERR_PROXY_TUNNEL']);

function installProcessSafetyNet({ log = (m) => console.error(m), exit = (code) => process.exit(code) } = {}) {
  process.on('unhandledRejection', (reason) => {
    const msg = reason && reason.message ? reason.message : String(reason);
    log(`⚠️ Internal error (unhandled promise rejection): ${redactSecrets(msg)}`);
  });
  process.on('uncaughtException', (error) => {
    if (error && BENIGN_SOCKET_CODES.has(error.code) && error.syscall !== undefined) {
      log(`⚠️ Ignored late network socket error (${error.code}).`);
      return;
    }
    log(`❌ Fatal internal error: ${redactSecrets(error && error.stack ? error.stack : String(error))}`);
    exit(1);
  });
}

module.exports = { installProcessSafetyNet, BENIGN_SOCKET_CODES };
