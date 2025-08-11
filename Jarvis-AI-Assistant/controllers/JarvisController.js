const readline = require('readline');
const fs = require('fs');
const path = require('path');
const ProjectPlanner = require('../models/ProjectPlanner');
const FileGenerator = require('../models/FileGenerator');
const { callGeminiAPI } = require('../services/geminiService');
const { speakText, startVoiceInput, checkVoiceAvailability } = require('../services/voiceService');
const { log, delay } = require('../utils/logger');
const { geminiApiKey, PROJECTS_DIR } = require('../config/config');

class JarvisController {
  constructor() {
    this.planner = new ProjectPlanner();
    this.generator = new FileGenerator();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    this.voiceAvailable = false;
  }

  async createProject(description) {
    try {
      log('\n🎯 JARVIS ACTIVATED', 'bright');
      log(`🎨 Creating: ${description}`, 'cyan');
      
      // Step 1: Plan the project
      const plan = await this.planner.createProjectPlan(description);
      
      // Step 2: Confirm with user
      const confirmed = await this.confirmPlan();
      if (!confirmed) {
        log('❌ Project creation cancelled', 'red');
        return;
      }

      // Step 3: Generate files
      await this.generator.generateProjectFiles(plan);
      
    } catch (error) {
      log(`❌ Project creation failed: ${error.message}`, 'red');
    }
  }

  async confirmPlan() {
    return new Promise((resolve) => {
      this.rl.question('\n❓ Do you want to proceed with this plan? (y/n): ', (answer) => {
        resolve(answer.toLowerCase().startsWith('y'));
      });
    });
  }

  displayHelp() {
    log('\n📖 JARVIS - COMMANDS', 'bright');
    log('━'.repeat(50), 'dim');
    log('🎨 create <description>  - Create a new project', 'cyan');
    log('📁 list                  - List current directory files', 'cyan');
    log('🔍 open <filename>       - Open and display a file', 'cyan');
    log('🎤 voice                 - Start voice input mode', 'cyan');
    log('❓ help                  - Show this help message', 'cyan');
    log('🚪 exit                  - Exit the application', 'cyan');
    log('━'.repeat(50), 'dim');
    log('\nExample: create fullstack expense tracker with React', 'yellow');
    log('Example: create weather dashboard with charts', 'yellow');
    log('Example: create todo app with drag and drop', 'yellow');
    log('\n💡 Voice Commands:', 'magenta');
    log('  • Say "hello" or "hi" for greetings', 'white');
    log('  • Ask any question for AI response', 'white');
    log('  • Say "create project" followed by description', 'white');
    
    if (!this.voiceAvailable) {
      log('\n⚠️ Voice features may not work properly.', 'yellow');
      log('💡 To enable voice: Enable Windows Speech Recognition in Settings > Privacy > Speech', 'cyan');
    }
  }

  async start() {
    log('🚀 JARVIS STARTED', 'green');
    log('Type "help" for commands or "create <description>" to start building!', 'cyan');
    
    // Check voice availability
    this.voiceAvailable = await checkVoiceAvailability();
    
    // Validate API key
    if (!geminiApiKey || geminiApiKey === 'YOUR_API_KEY_HERE' || geminiApiKey.length < 30) {
      log('⚠️ Please set your GEMINI_API_KEY environment variable!', 'yellow');
      log('   export GEMINI_API_KEY="your-api-key-here"', 'dim');
    }

    this.askQuestion();
  }

  async askQuestion() {
    this.rl.question('\n💡 Jarvis > ', async (input) => {
      const command = input.trim().toLowerCase();

      if (!command) {
        this.askQuestion();
        return;
      }

      // Respond to greetings
      if (["hello", "hi", "hey", "hola", "namaste", "yo", "sup", "greetings"].includes(command)) {
        const response = 'Hello! I\'m Jarvis. How can I assist you today?';
        log(`🤖 ${response}`, 'green');
        if (this.voiceAvailable) {
          speakText(response);
        }
        this.askQuestion();
        return;
      }

      if (command === 'exit' || command === 'quit') {
        const response = 'Thanks for using Jarvis!';
        log(`👋 ${response}`, 'green');
        if (this.voiceAvailable) {
          speakText(response);
        }
        process.exit(0);
      }

      if (command === 'help') {
        this.displayHelp();
        this.askQuestion();
        return;
      }

      if (command === 'list') {
        this.listFiles();
        this.askQuestion();
        return;
      }

      if (command === 'voice') {
        await this.startVoiceMode();
        this.askQuestion();
        return;
      }

      if (command.startsWith('open ')) {
        const filename = command.replace('open ', '');
        this.openFile(filename);
        this.askQuestion();
        return;
      }

      if (command.startsWith('create ')) {
        const description = input.replace(/create\s+/i, '');
        await this.createProject(description);
        this.askQuestion();
        return;
      }

      // If not a command or greeting, treat as a general question and use LLM
      try {
        log('🤔 Let me think...', 'cyan');
        const response = await callGeminiAPI(input);
        log(`🤖 ${response}`, 'green');
        if (this.voiceAvailable) {
          // Add a small delay to prevent voice conflicts
          await delay(500);
          speakText(response);
        }
      } catch (err) {
        log('❌ Unknown command. Type "help" for available commands.', 'red');
      }
      this.askQuestion();
    });
  }

  async startVoiceMode() {
    log('🎤 Voice mode activated!', 'magenta');
    log('💡 Say "exit voice" to return to text mode', 'cyan');
    
    if (!this.voiceAvailable) {
      log('⚠️ Voice output not available. Using text-only mode.', 'yellow');
    }
    
    while (true) {
      const voiceInput = await startVoiceInput();
      
      if (!voiceInput) {
        log('⚠️ No input received. Please try again.', 'yellow');
        continue;
      }
      
      const input = voiceInput.toLowerCase();
      
      // Check for voice mode exit
      if (input.includes('exit voice') || input.includes('stop voice') || input === 'exit') {
        log('🎤 Voice mode deactivated', 'cyan');
        if (this.voiceAvailable) {
          speakText('Voice mode deactivated');
        }
        break;
      }
      
      // Handle voice commands
      if (input.includes('create project') || input.includes('create app')) {
        const description = voiceInput.replace(/create\s+(project|app)\s+/i, '');
        log(`🎨 Creating project: ${description}`, 'cyan');
        if (this.voiceAvailable) {
          speakText(`Creating project: ${description}`);
        }
        await this.createProject(description);
        continue;
      }
      
      if (input.includes('list files') || input.includes('show files')) {
        this.listFiles();
        continue;
      }
      
      if (input.includes('help')) {
        this.displayHelp();
        continue;
      }
      
      // Handle greetings
      if (["hello", "hi", "hey", "hola", "namaste", "yo", "sup", "greetings"].includes(input)) {
        const response = 'Hello! I\'m Jarvis. How can I assist you today?';
        log(`🤖 ${response}`, 'green');
        if (this.voiceAvailable) {
          speakText(response);
        }
        continue;
      }
      
      // Treat as general question
      try {
        log('🤔 Let me think...', 'cyan');
        const response = await callGeminiAPI(voiceInput);
        log(`🤖 ${response}`, 'green');
        if (this.voiceAvailable) {
          // Add a small delay to prevent voice conflicts
          await delay(500);
          speakText(response);
        }
      } catch (err) {
        const errorMsg = 'Sorry, I could not process that request. Please try again.';
        log(`❌ ${errorMsg}`, 'red');
        if (this.voiceAvailable) {
          speakText(errorMsg);
        }
      }
    }
  }

  listFiles() {
    try {
      const files = fs.readdirSync(process.cwd());
      log('\n📂 Current Directory:', 'cyan');
      files.forEach(file => {
        const stats = fs.statSync(file);
        const icon = stats.isDirectory() ? '📁' : '📄';
        log(`  ${icon} ${file}`, 'white');
      });
    } catch (error) {
      log(`❌ Error listing files: ${error.message}`, 'red');
    }
  }

  openFile(filename) {
    try {
      const content = fs.readFileSync(filename, 'utf8');
      log(`\n📄 ${filename}:`, 'cyan');
      log('─'.repeat(50), 'dim');
      log(content, 'white');
      log('─'.repeat(50), 'dim');
    } catch (error) {
      log(`❌ Error opening file: ${error.message}`, 'red');
    }
  }
}

module.exports = JarvisController; 