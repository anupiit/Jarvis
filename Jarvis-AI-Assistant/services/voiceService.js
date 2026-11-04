// Windows voice I/O through the built-in System.Speech (SAPI) APIs of Windows PowerShell 5.1.
//
// Security: the PowerShell scripts below are CONSTANTS. User/model text is passed only through
// environment variables (JARVIS_TTS_TEXT etc.) and processes are started with spawn() without a
// shell, so no text can ever be interpreted as a command.
const { spawn } = require('child_process');
const config = require('../config/config');

const VOICE_COMMANDS = ['exit voice', 'help', 'list files', 'voice off', 'voice on', 'yes', 'no', 'listen', 'stats', 'models'];

// Statements joined with "; " into a single -Command argument (single quotes only, no double quotes).
const PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$r = @{ tts = $false; voices = 0; stt = $false; recognizers = 0; culture = [System.Globalization.CultureInfo]::CurrentUICulture.Name; error = $null }',
  'try { Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $r.voices = @($s.GetInstalledVoices() | Where-Object { $_.Enabled }).Count; $r.tts = $r.voices -gt 0; $s.Dispose(); $r.recognizers = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()).Count; $r.stt = $r.recognizers -gt 0 } catch { $r.error = $_.Exception.Message }',
  '[Console]::Out.WriteLine(($r | ConvertTo-Json -Compress))'
].join('; ');

const TTS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try { Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = [int]$env:JARVIS_TTS_RATE; $s.Volume = [int]$env:JARVIS_TTS_VOLUME; $s.Speak([string]$env:JARVIS_TTS_TEXT); $s.Dispose(); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }'
].join('; ');

const STT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  'function Out-Json($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)) }',
  'try { ' + [
    'Add-Type -AssemblyName System.Speech',
    '$timeout = [int]$env:JARVIS_STT_TIMEOUT',
    '$recs = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())',
    "if ($recs.Count -eq 0) { Out-Json @{ ok = $false; code = 'NO_RECOGNIZER'; message = 'No speech recognizer is installed.' }; exit 0 }",
    '$culture = [System.Globalization.CultureInfo]::CurrentUICulture.Name',
    '$info = $recs | Where-Object { $_.Culture.Name -eq $culture } | Select-Object -First 1',
    'if (-not $info) { $info = $recs[0] }',
    '$engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)',
    '$engine.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))',
    "try { $choices = New-Object System.Speech.Recognition.Choices; foreach ($c in ($env:JARVIS_STT_COMMANDS -split '\\|')) { if ($c) { $choices.Add($c) } }; $gb = New-Object System.Speech.Recognition.GrammarBuilder($choices); $gb.Culture = $info.Culture; $engine.LoadGrammar((New-Object System.Speech.Recognition.Grammar($gb))) } catch { }",
    "try { $engine.SetInputToDefaultAudioDevice() } catch { Out-Json @{ ok = $false; code = 'NO_MICROPHONE'; message = $_.Exception.Message }; exit 0 }",
    '$engine.InitialSilenceTimeout = [TimeSpan]::FromSeconds($timeout)',
    '$engine.BabbleTimeout = [TimeSpan]::FromSeconds($timeout)',
    '$engine.EndSilenceTimeout = [TimeSpan]::FromMilliseconds(800)',
    "Out-Json @{ event = 'listening' }",
    '$result = $engine.Recognize([TimeSpan]::FromSeconds($timeout))',
    "if ($null -eq $result) { Out-Json @{ ok = $false; code = 'NO_SPEECH'; message = 'No speech was recognized before the timeout.' } } else { Out-Json @{ ok = $true; text = $result.Text; confidence = $result.Confidence } }",
    '$engine.Dispose()'
  ].join('; ') + " } catch { Out-Json @{ ok = $false; code = 'RECOGNITION_ERROR'; message = $_.Exception.Message } }"
].join('; ');

const HINTS = {
  UNSUPPORTED_PLATFORM: 'Voice input/output uses Windows speech APIs; on this OS please type instead.',
  POWERSHELL_UNAVAILABLE: 'Windows PowerShell (powershell.exe) could not be started; voice features are unavailable.',
  NO_RECOGNIZER: 'Install a speech recognition language: Settings > Time & language > Speech (and Language > add a speech pack).',
  NO_MICROPHONE: 'No default recording device. Connect a microphone, select it as default in Sound settings, and allow desktop apps to use it (Settings > Privacy & security > Microphone).',
  NO_SPEECH: 'Nothing was recognized. Speak right after "Listening...", check the microphone level, and make sure "Let desktop apps access your microphone" is on.',
  TIMEOUT: 'Speech recognition did not finish in time and was stopped.',
  BUSY: 'Already listening.',
  CANCELLED: 'Listening was cancelled.',
  RECOGNITION_ERROR: 'Windows speech recognition reported an error.'
};

function defaultSpawnPowerShell(script, { env } = {}) {
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** Make model output pleasant to listen to and bounded in length. */
function prepareSpokenText(text, maxChars = config.VOICE_MAX_SPOKEN_CHARS) {
  let s = String(text || '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/[`*_#>|~]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const sentenceEnd = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    s = (sentenceEnd > maxChars / 2 ? cut.slice(0, sentenceEnd + 1) : cut) + ' … The rest is on screen.';
  }
  return s;
}

/**
 * Start a PowerShell process. Returns the child (or null) and a promise for its outcome.
 * @returns {{ child: object|null, done: Promise<{ code, signal, stdout, stderr, timedOut, spawnError }> }}
 */
function runProcess(spawnFn, script, { env, timeoutMs, onLine } = {}) {
  let child;
  try {
    child = spawnFn(script, { env });
  } catch (error) {
    return { child: null, done: Promise.resolve({ spawnError: error, stdout: '', stderr: '' }) };
  }
  const done = new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let buffered = '';
    let timedOut = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const timer = timeoutMs ? setTimeout(() => { timedOut = true; try { child.kill(); } catch (_) { /* gone */ } }, timeoutMs) : null;
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      buffered += text;
      let idx;
      while ((idx = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, idx).trim();
        buffered = buffered.slice(idx + 1);
        if (line && onLine) onLine(line);
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ spawnError: error, stdout, stderr, timedOut }));
    child.on('close', (code, signal) => {
      if (buffered.trim() && onLine) onLine(buffered.trim());
      finish({ code, signal, stdout, stderr, timedOut });
    });
  });
  return { child, done };
}

class VoiceService {
  constructor(options = {}) {
    this.platform = options.platform || process.platform;
    this.spawnPowerShell = options.spawnPowerShell || defaultSpawnPowerShell;
    this.rate = options.rate ?? config.VOICE_RATE;
    this.volume = options.volume ?? config.VOICE_VOLUME;
    this.listenTimeoutSec = options.listenTimeoutSec ?? config.VOICE_LISTEN_TIMEOUT_SEC;
    this.maxSpokenChars = options.maxSpokenChars ?? config.VOICE_MAX_SPOKEN_CHARS;
    // Extra time allowed on top of the recognizer's own timeout before Node kills the process.
    this.listenGuardExtraMs = options.listenGuardExtraMs ?? 20000;
    this.availability = null;
    this.speechChild = null;
    this.listenChild = null;
    this.listenCancelled = false;
  }

  get supported() {
    return this.platform === 'win32';
  }

  static hint(code) {
    return HINTS[code] || null;
  }

  /** Probe SAPI voices and recognizers (Windows only). Never throws. */
  async checkAvailability({ timeoutMs = 10000 } = {}) {
    if (!this.supported) {
      this.availability = { platform: this.platform, supported: false, tts: false, stt: false, voices: 0, recognizers: 0, reason: HINTS.UNSUPPORTED_PLATFORM };
      return this.availability;
    }
    let parsed = null;
    const res = await runProcess(this.spawnPowerShell, PROBE_SCRIPT, {
      timeoutMs,
      onLine: (line) => { try { parsed = JSON.parse(line); } catch (_) { /* ignore */ } }
    }).done;
    if (res.spawnError) {
      this.availability = { platform: this.platform, supported: false, tts: false, stt: false, voices: 0, recognizers: 0, reason: HINTS.POWERSHELL_UNAVAILABLE };
    } else if (!parsed) {
      this.availability = { platform: this.platform, supported: true, tts: false, stt: false, voices: 0, recognizers: 0, reason: res.timedOut ? 'Voice check timed out.' : `Voice check failed: ${(res.stderr || '').trim().slice(0, 200)}` };
    } else {
      this.availability = {
        platform: this.platform, supported: true, tts: Boolean(parsed.tts), stt: Boolean(parsed.stt),
        voices: parsed.voices || 0, recognizers: parsed.recognizers || 0, culture: parsed.culture || null,
        reason: parsed.error || (!parsed.stt ? HINTS.NO_RECOGNIZER : null)
      };
    }
    return this.availability;
  }

  /** Speak text (cancels any speech in progress). Resolves when speech ends. Never throws. */
  async speak(text) {
    if (!this.supported) return { ok: false, code: 'UNSUPPORTED_PLATFORM' };
    if (this.availability && !this.availability.tts) return { ok: false, code: 'UNAVAILABLE' };
    const spoken = prepareSpokenText(text, this.maxSpokenChars);
    if (!spoken) return { ok: true, skipped: true };
    this.stopSpeaking();
    const { child, done } = runProcess(this.spawnPowerShell, TTS_SCRIPT, {
      env: { JARVIS_TTS_TEXT: spoken, JARVIS_TTS_RATE: String(Math.max(-10, Math.min(10, Math.round(this.rate)))), JARVIS_TTS_VOLUME: String(Math.max(0, Math.min(100, Math.round(this.volume)))) },
      timeoutMs: 120000
    });
    this.speechChild = child;
    const res = await done;
    if (this.speechChild === child) this.speechChild = null;
    if (res.spawnError) return { ok: false, code: 'POWERSHELL_UNAVAILABLE', message: res.spawnError.message };
    if (res.signal || (child && child.killedByJarvis)) return { ok: false, code: 'CANCELLED' };
    if (res.code !== 0) return { ok: false, code: 'TTS_ERROR', message: (res.stderr || '').trim().slice(0, 300) };
    return { ok: true };
  }

  stopSpeaking() {
    if (this.speechChild) {
      this.speechChild.killedByJarvis = true;
      try { this.speechChild.kill(); } catch (_) { /* already gone */ }
      this.speechChild = null;
    }
  }

  /**
   * Record one utterance from the default microphone and transcribe it.
   * @returns {Promise<{ ok: boolean, text?: string, confidence?: number, code?: string, message?: string }>}
   */
  async listen({ timeoutSec = this.listenTimeoutSec, onListening } = {}) {
    if (!this.supported) return { ok: false, code: 'UNSUPPORTED_PLATFORM', message: HINTS.UNSUPPORTED_PLATFORM };
    if (this.availability && this.availability.supported && !this.availability.stt) {
      return { ok: false, code: 'NO_RECOGNIZER', message: HINTS.NO_RECOGNIZER };
    }
    if (this.listenChild) return { ok: false, code: 'BUSY', message: HINTS.BUSY };
    this.stopSpeaking(); // never transcribe our own voice
    this.listenCancelled = false;
    let result = null;
    const { child, done } = runProcess(this.spawnPowerShell, STT_SCRIPT, {
      env: { JARVIS_STT_TIMEOUT: String(timeoutSec), JARVIS_STT_COMMANDS: VOICE_COMMANDS.join('|') },
      timeoutMs: timeoutSec * 1000 + this.listenGuardExtraMs,
      onLine: (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch (_) { return; }
        if (msg.event === 'listening') { if (onListening) onListening(); return; }
        if (typeof msg.ok === 'boolean') result = msg;
      }
    });
    this.listenChild = child;
    const res = await done;
    this.listenChild = null;
    if (this.listenCancelled) return { ok: false, code: 'CANCELLED', message: HINTS.CANCELLED };
    if (res.spawnError) return { ok: false, code: 'POWERSHELL_UNAVAILABLE', message: HINTS.POWERSHELL_UNAVAILABLE };
    if (res.timedOut) return { ok: false, code: 'TIMEOUT', message: HINTS.TIMEOUT };
    if (!result) return { ok: false, code: 'RECOGNITION_ERROR', message: (res.stderr || 'No result from the speech recognizer').trim().slice(0, 300) };
    if (result.ok) {
      const text = String(result.text || '').trim();
      if (!text) return { ok: false, code: 'NO_SPEECH', message: HINTS.NO_SPEECH };
      return { ok: true, text, confidence: typeof result.confidence === 'number' ? result.confidence : null };
    }
    return { ok: false, code: result.code || 'RECOGNITION_ERROR', message: result.message || HINTS[result.code] };
  }

  cancelListening() {
    if (this.listenChild) {
      this.listenCancelled = true;
      try { this.listenChild.kill(); } catch (_) { /* already gone */ }
      return true;
    }
    return false;
  }

  dispose() {
    this.stopSpeaking();
    this.cancelListening();
  }
}

module.exports = {
  VoiceService,
  prepareSpokenText,
  VOICE_COMMANDS,
  scripts: { PROBE_SCRIPT, TTS_SCRIPT, STT_SCRIPT }
};
