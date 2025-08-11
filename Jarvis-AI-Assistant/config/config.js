require('dotenv').config();

module.exports = {
  // API Configuration
  geminiApiKey: process.env.GEMINI_API_KEY,
  API_DELAY: 3000, // 3 second delay between API calls for free tier
  MAX_RETRIES: 5,
  GEMINI_DEBOUNCE_MS: 1000, // 1 second debounce window

  // Project Configuration
  PROJECTS_DIR: 'projectsByJarvis',
  
  // Voice Configuration
  VOICE_ENABLED: true,
  VOICE_RATE: 1.0,
  VOICE_VOLUME: 100,

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