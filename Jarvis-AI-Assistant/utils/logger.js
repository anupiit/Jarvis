const { colors } = require('../config/config');
const { redactSecrets } = require('./redact');

// Output sink can be swapped (tests capture output; the CLI writes to stdout).
let sink = (line) => process.stdout.write(line + '\n');
let useColor = true;

function setLogSink(fn, { color = true } = {}) {
  sink = fn;
  useColor = color;
}

function resetLogSink() {
  sink = (line) => process.stdout.write(line + '\n');
  useColor = true;
}

function log(message, color = 'white') {
  const text = redactSecrets(message === undefined ? '' : String(message));
  if (useColor && colors[color]) {
    sink(`${colors[color]}${text}${colors.reset}`);
  } else {
    sink(text);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function displayProgress(step, total, message) {
  const safeTotal = Math.max(1, total);
  const percentage = Math.min(100, Math.round((step / safeTotal) * 100));
  const filled = Math.floor(percentage / 5);
  const progressBar = '█'.repeat(filled) + '░'.repeat(20 - filled);
  log(`[${progressBar}] ${percentage}% - ${message}`, 'cyan');
}

module.exports = {
  log,
  delay,
  displayProgress,
  setLogSink,
  resetLogSink
};
