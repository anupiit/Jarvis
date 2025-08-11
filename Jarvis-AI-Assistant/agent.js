// Legacy entry point - redirects to new modular structure
const JarvisController = require('./controllers/JarvisController');

// Start Jarvis
const jarvis = new JarvisController();
jarvis.start();