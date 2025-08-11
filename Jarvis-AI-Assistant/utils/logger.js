const { colors } = require('../config/config');

function log(message, color = 'white') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function displayProgress(step, total, message) {
  const percentage = Math.round((step / total) * 100);
  const progressBar = '█'.repeat(Math.floor(percentage / 5)) + '░'.repeat(20 - Math.floor(percentage / 5));
  log(`[${progressBar}] ${percentage}% - ${message}`, 'cyan');
}

module.exports = {
  log,
  delay,
  displayProgress
}; 