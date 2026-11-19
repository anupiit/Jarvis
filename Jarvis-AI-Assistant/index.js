#!/usr/bin/env node
// Jarvis entry point. Configuration (.env) is loaded by config/config.js before any service starts.
const { installProcessSafetyNet } = require('./utils/processSafety');
installProcessSafetyNet();

const JarvisController = require('./controllers/JarvisController');

const jarvis = new JarvisController();
jarvis.start().then(
  () => process.exit(0),
  (error) => {
    console.error(`❌ Jarvis stopped unexpectedly: ${require('./utils/redact').redactSecrets(error && error.stack ? error.stack : String(error))}`);
    process.exit(1);
  }
);
