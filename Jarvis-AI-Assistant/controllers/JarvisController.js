const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const ProjectPlanner = require('../models/ProjectPlanner');
const FileGenerator = require('../models/FileGenerator');
const { getDefaultEngine } = require('../services/geminiService');
const { GeminiError } = require('../services/geminiErrors');
const { discoverModels, diagnose } = require('../services/modelDiscovery');
const { VoiceService } = require('../services/voiceService');
const { InputManager } = require('../utils/inputManager');
const { parseConfirmation } = require('../utils/confirm');
const { isInside, PathSecurityError } = require('../utils/safePath');
const { formatDuration } = require('../utils/retry');
const { redactSecrets } = require('../utils/redact');
const { parseCommand } = require('./commandRouter');
const { log } = require('../utils/logger');

const CHAT_SYSTEM_INSTRUCTION = 'You are Jarvis, a concise, friendly assistant inside a command-line project generator. Answer briefly (at most about 120 words) in plain text. If the user seems to want software built, remind them they can type "create <description>".';
const MAX_CONFIRM_ATTEMPTS = 5;
const MAX_OPEN_BYTES = 200 * 1024;

class JarvisController {
  /**
   * All collaborators are injectable for tests; defaults are the real implementations.
   */
  constructor(options = {}) {
    this.config = options.config || config;
    this.io = options.io || new InputManager({ input: options.input, output: options.output });
    this.engine = options.engine || getDefaultEngine();
    this.voice = options.voice || new VoiceService();
    this.projectsRoot = options.projectsRoot || this.config.PROJECTS_ROOT;
    this.planner = options.planner || new ProjectPlanner({ engine: this.engine, projectsRoot: this.projectsRoot });
    this.generator = options.generator || new FileGenerator({ engine: this.engine, projectsRoot: this.projectsRoot, onEvent: (e) => this.onGenerationEvent(e) });
    this.voiceInfo = null;
    this.ttsEnabled = false;
    this.inVoiceMode = false;
    this.busy = null;
    this.stopped = false;
    if (this.engine && 'onEvent' in this.engine && !this.engine.onEvent) {
      this.engine.onEvent = (e) => this.onEngineEvent(e);
    }
    this.io.onSigint(() => this.handleInterrupt());
  }

  // ---------------------------------------------------------------- lifecycle
  async start({ checkVoice = true } = {}) {
    await this.printStartupDiagnostics({ checkVoice });
    await this.loop();
  }

  async loop() {
    while (!this.stopped) {
      const line = await this.io.ask('\n💡 Jarvis > ');
      if (line === null) {
        await this.shutdown();
        break;
      }
      await this.processInput(line, { source: 'typed' });
    }
  }

  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    this.inVoiceMode = false;
    log('👋 Goodbye — thanks for using Jarvis!', 'green');
    try { this.voice.dispose(); } catch (_) { /* ignore */ }
    try { if (typeof this.engine.shutdown === 'function') this.engine.shutdown(); } catch (_) { /* ignore */ }
    this.io.close();
  }

  handleInterrupt() {
    if (this.busy === 'listening' && this.voice.cancelListening()) {
      log('\n⏹️ Listening cancelled.', 'yellow');
      return;
    }
    log('\n⏹️ Interrupted.', 'yellow');
    this.shutdown();
  }

  // ---------------------------------------------------------------- startup
  async printStartupDiagnostics({ checkVoice }) {
    const cfg = this.config;
    log('🚀 JARVIS — AI project generator', 'green');
    log('━'.repeat(60), 'dim');
    const major = parseInt(process.versions.node.split('.')[0], 10);
    log(`  Node.js ${process.version} on ${process.platform}${major < 18 ? '  ⚠️ Node.js 18 or newer is required' : ''}`, major < 18 ? 'yellow' : 'white');
    log(`  Settings file: ${cfg.envFileLoaded ? cfg.ENV_PATH : `not found (${cfg.ENV_PATH}) — copy .env.example to .env`}`, cfg.envFileLoaded ? 'white' : 'yellow');
    const v = cfg.validateConfig ? cfg.validateConfig(cfg) : { ok: Boolean(cfg.geminiApiKey), problems: [], warnings: [] };
    log(`  Gemini API key: ${v.ok ? 'configured ✔' : 'NOT configured ✖'}   Model: ${cfg.geminiModel}`, v.ok ? 'white' : 'yellow');
    v.problems.forEach(p => log(`    → ${p}`, 'yellow'));
    v.warnings.forEach(w => log(`    → ${w}`, 'yellow'));
    log(`  Projects folder: ${this.projectsRoot}`, 'white');
    if (checkVoice) {
      this.voiceInfo = await this.voice.checkAvailability();
    } else {
      this.voiceInfo = { supported: false, tts: false, stt: false, reason: 'voice check skipped' };
    }
    this.ttsEnabled = Boolean(cfg.VOICE_ENABLED && this.voiceInfo.tts);
    log(`  Voice: ${this.describeVoice()}`, 'white');
    log('━'.repeat(60), 'dim');
    log('Type "help" for commands, or "create <description>" to build a project.', 'cyan');
  }

  describeVoice() {
    const i = this.voiceInfo || {};
    if (!i.supported) return `unavailable — ${i.reason || 'not supported'} (typed input works normally)`;
    const tts = i.tts ? `speech output ✔ (${i.voices} voice${i.voices === 1 ? '' : 's'})` : 'speech output ✖';
    const stt = i.stt ? `speech recognition ✔ (${i.culture || 'default language'})` : 'speech recognition ✖';
    return `${tts}, ${stt}${i.reason ? ` — ${i.reason}` : ''}`;
  }

  // ---------------------------------------------------------------- dispatch
  /**
   * Single entry point for typed and spoken input.
   * @returns {Promise<object>} what happened (used by tests)
   */
  async processInput(text, { source = 'typed' } = {}) {
    const cmd = parseCommand(text);
    let outcome = { type: cmd.type, source };
    try {
      switch (cmd.type) {
        case 'empty': break;
        case 'greeting':
          this.respond('Hello! I\'m Jarvis. Describe a project after "create" (for example: create a to-do list app), or type "help".');
          break;
        case 'help': this.displayHelp(); break;
        case 'exit': await this.shutdown(); break;
        case 'exitVoice':
          if (!this.inVoiceMode) log('ℹ️ Voice mode is not active. Type "voice" to start it.', 'cyan');
          break;
        case 'voiceMode': await this.voiceMode(); break;
        case 'ttsOn': this.setTts(true); break;
        case 'ttsOff': this.setTts(false); break;
        case 'listen': outcome = { ...outcome, ...(await this.listenOnce()) }; break;
        case 'list': this.listFiles(); break;
        case 'projects': this.listProjects(); break;
        case 'open': this.openFile(cmd.args); break;
        case 'models': await this.showModels(); break;
        case 'diagnose': await this.runDiagnostics(cmd.args); break;
        case 'stats': this.showStats(); break;
        case 'strayAnswer':
          log('ℹ️ There is no question waiting for an answer. Type "help" for commands.', 'cyan');
          break;
        case 'createUsage':
          log('ℹ️ Describe what to build, e.g.: create a responsive to-do list app using HTML, CSS and JavaScript', 'cyan');
          break;
        case 'create': outcome = { ...outcome, ...(await this.createProject(cmd.args)) }; break;
        case 'chat': await this.chat(cmd.args); break;
        default: log(`ℹ️ Unrecognized input. Type "help" for commands.`, 'cyan');
      }
    } catch (error) {
      this.reportError(error, 'Command failed');
      outcome.error = error;
    }
    return outcome;
  }

  respond(text) {
    log(`🤖 ${text}`, 'green');
    if (this.ttsEnabled) {
      this.voice.speak(text).catch(() => {});
    }
  }

  reportError(error, prefix = 'Error') {
    if (error instanceof GeminiError) {
      log(`❌ ${prefix}: ${error.toUserMessage()}`, 'red');
    } else if (error instanceof PathSecurityError) {
      log(`❌ ${prefix}: ${error.message}`, 'red');
    } else {
      log(`❌ ${prefix}: ${redactSecrets(error && error.message ? error.message : String(error))}`, 'red');
    }
  }

  onEngineEvent(event) {
    if (event.type === 'retry') {
      const what = event.httpStatus ? `HTTP ${event.httpStatus}` : event.kind;
      log(`⚠️ Gemini ${what}: ${String(event.message).slice(0, 120)} — retry ${event.attempt}/${event.maxRetries} in ${formatDuration(event.delayMs)}`, 'yellow');
    } else if (event.type === 'rate-limit-wait' && event.delayMs >= 2000) {
      log(`⏳ Pacing Gemini requests (local rate limit): next request in ${formatDuration(event.delayMs)}`, 'dim');
    }
  }

  onGenerationEvent(event) {
    if (event.type === 'correcting') {
      const first = event.errors[0];
      log(`🔧 ${event.filePath}: ${event.errors.length} validation issue(s) (${first.rule}${first.line ? ` line ${first.line}` : ''}: ${first.message.slice(0, 90)}) — AI correction ${event.attempt}/${event.max}`, 'yellow');
    }
  }

  displayHelp() {
    log('\n📖 JARVIS — COMMANDS', 'bright');
    log('━'.repeat(60), 'dim');
    log('🎨 create <description>  Plan a project, show it, and generate it after you approve', 'cyan');
    log('🎤 voice                 Voice mode: press Enter to speak, type to send text, "exit voice" to leave', 'cyan');
    log('🎙️ listen                Speak one command (push-to-talk)', 'cyan');
    log('🔊 voice on / voice off  Turn spoken replies on or off', 'cyan');
    log('📂 projects              List projects generated by Jarvis', 'cyan');
    log('📁 list                  List files in the current directory', 'cyan');
    log('🔍 open <file>           Show a file inside the Jarvis folder or current directory', 'cyan');
    log('🧪 models                List Gemini models available to your API key', 'cyan');
    log('🩺 diagnose [model]      Check configuration, model availability and a live generation', 'cyan');
    log('📊 stats                 Gemini request statistics for this session', 'cyan');
    log('❓ help                  Show this help', 'cyan');
    log('🚪 exit                  Quit Jarvis', 'cyan');
    log('━'.repeat(60), 'dim');
    log('Anything else is sent to Gemini as a general question.', 'dim');
    log('Example: create a responsive to-do list app using HTML, CSS and vanilla JavaScript', 'yellow');
  }

  // ---------------------------------------------------------------- projects
  async createProject(description) {
    log(`\n🎯 New project request: ${description}`, 'bright');
    let plan;
    try {
      plan = await this.planner.createProjectPlan(description);
    } catch (error) {
      this.reportError(error, 'Planning failed');
      log('No files were written.', 'yellow');
      return { status: 'plan-failed', error };
    }

    const decision = await this.confirmPlan();
    if (decision !== 'yes') {
      log('❌ Project creation cancelled — no files were written.', 'red');
      return { status: 'cancelled', plan };
    }
    log('✅ Plan approved.', 'green');
    this.busy = 'generating';
    let summary;
    try {
      summary = await this.generator.generateProjectFiles(plan);
    } finally {
      this.busy = null;
    }
    if (this.ttsEnabled) {
      this.voice.speak(summary.ok ? `Project ${plan.projectName} is ready.` : `Project ${plan.projectName} is incomplete. See the summary on screen.`).catch(() => {});
    }
    return { status: summary.ok ? 'generated' : 'incomplete', plan, summary };
  }

  /** @returns {Promise<'yes'|'no'>} */
  async confirmPlan() {
    for (let attempt = 1; attempt <= MAX_CONFIRM_ATTEMPTS; attempt++) {
      const answer = await this.io.ask('\n❓ Write these files? (y/n): ', { discardTypeahead: true });
      if (answer === null) {
        log('\n⚠️ Input ended before an answer was given.', 'yellow');
        return 'no';
      }
      const decision = parseConfirmation(answer);
      if (decision !== 'invalid') return decision;
      log('⚠️ Please answer "y" (yes) or "n" (no).', 'yellow');
    }
    log(`⚠️ No valid answer after ${MAX_CONFIRM_ATTEMPTS} attempts — treating it as "no".`, 'yellow');
    return 'no';
  }

  listFiles() {
    const dir = process.cwd();
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      log(`\n📂 ${dir}`, 'cyan');
      entries.forEach(e => log(`  ${e.isDirectory() ? '📁' : '📄'} ${e.name}`, 'white'));
    } catch (error) {
      log(`❌ Could not list ${dir}: ${error.message}`, 'red');
    }
  }

  listProjects() {
    if (!fs.existsSync(this.projectsRoot)) {
      log(`📂 No projects yet (${this.projectsRoot} does not exist).`, 'cyan');
      return;
    }
    const dirs = fs.readdirSync(this.projectsRoot, { withFileTypes: true }).filter(e => e.isDirectory());
    log(`\n📂 Projects in ${this.projectsRoot}:`, 'cyan');
    if (!dirs.length) log('  (none)', 'white');
    dirs.forEach(d => {
      const count = fs.readdirSync(path.join(this.projectsRoot, d.name)).length;
      log(`  📁 ${d.name} (${count} item${count === 1 ? '' : 's'})`, 'white');
    });
  }

  openFile(name) {
    if (!name) { log('ℹ️ Usage: open <file>', 'cyan'); return; }
    const target = path.resolve(process.cwd(), name);
    const allowed = [process.cwd(), this.config.ROOT_DIR, this.projectsRoot].map(p => path.resolve(p));
    if (!allowed.some(base => isInside(base, target))) {
      log('❌ For safety, open only shows files inside the current directory or the Jarvis folder.', 'red');
      return;
    }
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) { log(`❌ ${name} is not a file.`, 'red'); return; }
      if (stat.size > MAX_OPEN_BYTES) { log(`❌ ${name} is larger than ${MAX_OPEN_BYTES / 1024} KB; open it in an editor instead.`, 'red'); return; }
      log(`\n📄 ${name}:`, 'cyan');
      log('─'.repeat(60), 'dim');
      log(fs.readFileSync(target, 'utf8'), 'white');
      log('─'.repeat(60), 'dim');
    } catch (error) {
      log(`❌ Could not open ${name}: ${error.code === 'ENOENT' ? 'file not found' : error.message}`, 'red');
    }
  }

  // ---------------------------------------------------------------- Gemini tools
  async chat(text) {
    const v = this.config.validateConfig ? this.config.validateConfig(this.config) : { ok: true, problems: [] };
    if (!v.ok) {
      log('ℹ️ That is not a Jarvis command, and general questions need Gemini, which is not configured:', 'cyan');
      v.problems.forEach(p => log(`   → ${p}`, 'yellow'));
      log('   Type "help" for commands, or "create <description>" to plan a project.', 'cyan');
      return;
    }
    log('🤔 Thinking...', 'cyan');
    try {
      const res = await this.engine.generate(text, { systemInstruction: CHAT_SYSTEM_INSTRUCTION, maxOutputTokens: 8192 });
      this.respond(res.text.trim());
    } catch (error) {
      this.reportError(error, 'Could not answer');
      log('Tip: to build something, start with "create ...". Type "help" for all commands.', 'dim');
    }
  }

  async showModels() {
    log('🔎 Asking Gemini which models this API key can use...', 'cyan');
    try {
      const models = await discoverModels(this.engine);
      const usable = models.filter(m => m.supportsGenerateContent);
      log(`\n🧪 ${models.length} models listed, ${usable.length} support generateContent:`, 'bright');
      usable.forEach(m => {
        const mark = m.id === this.engine.model ? ' ← configured' : '';
        const limits = m.inputTokenLimit ? ` (in ${m.inputTokenLimit.toLocaleString()} / out ${m.outputTokenLimit ? m.outputTokenLimit.toLocaleString() : '?'} tokens)` : '';
        log(`  • ${m.id}${limits}${mark}`, m.id === this.engine.model ? 'green' : 'white');
      });
      if (!usable.some(m => m.id === this.engine.model)) {
        log(`⚠️ The configured model "${this.engine.model}" is not in this list. Set GEMINI_MODEL in .env to one of the models above.`, 'yellow');
      }
      log('ℹ️ Being listed does not guarantee generation works (quota, tier, region). Run "diagnose <model>" to test one.', 'dim');
    } catch (error) {
      this.reportError(error, 'Model discovery failed');
    }
  }

  async runDiagnostics(model) {
    log('🩺 Running Gemini diagnostics...', 'cyan');
    const report = await diagnose(this.engine, { model: model || this.engine.model });
    log(`  1. Configuration: ${report.configuration.ok ? 'OK' : 'problems found'}`, report.configuration.ok ? 'green' : 'red');
    report.configuration.problems.forEach(p => log(`     → ${p}`, 'yellow'));
    if (!report.configuration.ok) return report;
    if (report.listModels && report.listModels.ok) {
      log(`  2. ListModels: OK (${report.listModels.count} models, ${report.listModels.generateContentCount} with generateContent)`, 'green');
      log(`  3. "${report.model}" listed: ${report.modelListed ? 'yes' : 'NO'}${report.modelListed ? `, supports generateContent: ${report.modelSupportsGenerateContent ? 'yes' : 'NO'}` : ''}`, report.modelListed && report.modelSupportsGenerateContent ? 'green' : 'yellow');
    } else if (report.listModels) {
      log(`  2. ListModels: FAILED — ${report.listModels.error.toUserMessage ? report.listModels.error.toUserMessage() : report.listModels.error.message}`, 'red');
    }
    if (report.probe.ok) {
      log(`  4. Live generation with "${report.model}": OK in ${report.probe.latencyMs} ms (reply: "${report.probe.sample}")`, 'green');
    } else {
      log(`  4. Live generation with "${report.model}": FAILED`, 'red');
      log(`     ${report.probe.error.toUserMessage().replace(/\n/g, '\n     ')}`, 'red');
      if (report.alternatives.length) log(`     Models listed for your key that you could try: ${report.alternatives.join(', ')}`, 'yellow');
    }
    return report;
  }

  showStats() {
    const s = this.engine.stats ? this.engine.stats() : null;
    if (!s) { log('ℹ️ No statistics available.', 'cyan'); return; }
    const c = s.counters;
    log('\n📊 Gemini requests this session (process-local)', 'bright');
    log(`  Calls: ${c.requests} | outbound HTTP: ${c.outboundRequests} | cache hits: ${c.cacheHits} | coalesced: ${c.coalesced}`, 'white');
    log(`  Successes: ${c.successes} | failures: ${c.failures} | retries: ${c.retries} | rate-limit delays: ${c.rateLimitDelays}`, 'white');
    log(`  Latency (ms): p50 ${s.latencyMs.p50 ?? '-'} | p95 ${s.latencyMs.p95 ?? '-'} | max ${s.latencyMs.max ?? '-'}`, 'white');
    log(`  Circuit: ${s.circuit.state}${s.circuit.openForMs ? ` (resumes in ${formatDuration(s.circuit.openForMs)})` : ''} | queue: ${s.queued} | cache entries: ${s.cacheEntries}`, 'white');
    if (Object.keys(s.errorsByKind).length) log(`  Errors: ${Object.entries(s.errorsByKind).map(([k, n]) => `${k}×${n}`).join(', ')}`, 'yellow');
  }

  // ---------------------------------------------------------------- voice
  setTts(on) {
    if (on && !(this.voiceInfo && this.voiceInfo.tts)) {
      log(`⚠️ Spoken replies are not available: ${(this.voiceInfo && this.voiceInfo.reason) || 'no speech voices found'}`, 'yellow');
      this.ttsEnabled = false;
      return;
    }
    this.ttsEnabled = on;
    if (!on) this.voice.stopSpeaking();
    log(on ? '🔊 Spoken replies on.' : '🔇 Spoken replies off.', 'cyan');
  }

  /** Record and transcribe one utterance. @returns {Promise<string|null>} */
  async captureSpeech() {
    const info = this.voiceInfo || {};
    if (!info.stt) {
      log(`⚠️ Speech recognition is not available: ${String(info.reason || 'unknown reason').replace(/\.$/, '')}. Type your message instead.`, 'yellow');
      return null;
    }
    this.busy = 'listening';
    log(`🎙️ Starting microphone... (Ctrl+C cancels)`, 'magenta');
    let res;
    try {
      res = await this.voice.listen({ onListening: () => log(`🎙️ Listening — speak now (up to ${this.voice.listenTimeoutSec} s of silence)...`, 'magenta') });
    } finally {
      this.busy = null;
    }
    if (res.ok) {
      const conf = typeof res.confidence === 'number' ? ` (confidence ${Math.round(res.confidence * 100)}%)` : '';
      log(`🗣️ Heard: "${res.text}"${conf}`, 'green');
      return res.text;
    }
    if (res.code !== 'CANCELLED') {
      log(`⚠️ ${res.message || res.code}`, 'yellow');
      const hint = VoiceService.hint(res.code);
      if (hint && hint !== res.message) log(`   → ${hint}`, 'cyan');
    }
    return null;
  }

  async listenOnce() {
    const text = await this.captureSpeech();
    if (!text) return { heard: null };
    const inner = await this.processInput(text, { source: 'voice' });
    return { heard: text, inner };
  }

  async voiceMode() {
    if (this.inVoiceMode) { log('ℹ️ Already in voice mode.', 'cyan'); return; }
    this.inVoiceMode = true;
    log('🎤 Voice mode on. Press Enter to speak, or type a message. Say or type "exit voice" to leave.', 'magenta');
    if (!(this.voiceInfo && this.voiceInfo.stt)) {
      log(`⚠️ Speech recognition is unavailable (${(this.voiceInfo && this.voiceInfo.reason) || 'unknown'}); typed input still works in voice mode.`, 'yellow');
    }
    while (this.inVoiceMode && !this.stopped) {
      const line = await this.io.ask('\n🎤 [Enter = speak] > ');
      if (line === null) { await this.shutdown(); break; }
      let text = line.trim();
      let source = 'typed';
      if (!text) {
        const heard = await this.captureSpeech();
        if (!heard) continue;
        text = heard;
        source = 'voice';
      }
      const cmd = parseCommand(text);
      if (cmd.type === 'exitVoice' || cmd.type === 'exit') {
        this.inVoiceMode = false;
        this.respond('Voice mode off.');
        break;
      }
      if (cmd.type === 'voiceMode') { log('ℹ️ Already in voice mode.', 'cyan'); continue; }
      await this.processInput(text, { source });
    }
    this.inVoiceMode = false;
  }
}

module.exports = JarvisController;
