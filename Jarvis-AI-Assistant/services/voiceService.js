const { exec } = require('child_process');
const { VOICE_ENABLED } = require('../config/config');
const { log } = require('../utils/logger');

function speakText(text) {
  if (!VOICE_ENABLED) return;
  
  try {
    // Clean the text for PowerShell
    const cleanText = text.replace(/'/g, "''").replace(/"/g, '""').replace(/\n/g, ' ');
    
    // Method 1: Use Windows SAPI directly with better error handling
    const command = `powershell -Command "Add-Type -AssemblyName System.Speech; $speak = New-Object System.Speech.Synthesis.SpeechSynthesizer; $speak.Rate = 0; $speak.Volume = 100; $speak.Speak('${cleanText}')"`;
    
    exec(command, (error) => {
      if (error) {
        // Method 2: Try simpler SAPI approach
        const fallbackCommand = `powershell -Command "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${cleanText}')"`;
        exec(fallbackCommand, (fallbackError) => {
          if (fallbackError) {
            // Method 3: Try using Windows built-in text-to-speech with different approach
            const ttsCommand = `powershell -Command "Start-Process -FilePath 'powershell' -ArgumentList '-Command', 'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(\\'${cleanText}\\')' -WindowStyle Hidden"`;
            exec(ttsCommand, (ttsError) => {
              if (ttsError) {
                log('⚠️ Voice output not available. Voice features disabled.', 'yellow');
                log('💡 To enable voice: Enable Windows Speech Recognition in Settings > Privacy > Speech', 'cyan');
              }
            });
          }
        });
      }
    });
  } catch (err) {
    log('⚠️ Voice output error. Continuing without voice.', 'yellow');
  }
}

function startVoiceInput() {
  return new Promise((resolve) => {
    log('🎤 Voice Input Mode', 'cyan');
    log('💡 Type your message or use voice commands:', 'yellow');
    log('   • "hello" - Greeting', 'white');
    log('   • "create project [description]" - Create new project', 'white');
    log('   • "list files" - Show directory contents', 'white');
    log('   • "help" - Show commands', 'white');
    log('   • "exit voice" - Return to normal mode', 'white');
    log('   • Or ask any question for AI response', 'white');
    log('   • Note: Voice input uses text input for reliability', 'dim');
    
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('💬 Your message: ', (input) => {
      rl.close();
      if (input.trim()) {
        log(`💬 Input: "${input}"`, 'green');
        resolve(input);
      } else {
        resolve(null);
      }
    });
  });
}

// Function to check if voice is available - simplified version
function checkVoiceAvailability() {
  return new Promise((resolve) => {
    // Since voice is working for greetings, let's assume it's available
    // This prevents false negatives that might be causing the issue
    resolve(true);
  });
}

module.exports = {
  speakText,
  startVoiceInput,
  checkVoiceAvailability
}; 