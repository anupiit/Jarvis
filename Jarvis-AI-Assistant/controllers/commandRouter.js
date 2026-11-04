// Pure command parsing shared by typed and spoken input.

const GREETING = /^(?:hi|hello|hey|hola|namaste|yo|sup|greetings|good (?:morning|afternoon|evening))(?:[\s,]+(?:there|jarvis))?$/;

const EXACT = new Map([
  ['help', 'help'], ['?', 'help'], ['commands', 'help'], ['show help', 'help'],
  ['exit', 'exit'], ['quit', 'exit'], ['bye', 'exit'], ['goodbye', 'exit'],
  ['exit voice', 'exitVoice'], ['stop voice', 'exitVoice'], ['leave voice', 'exitVoice'], ['quit voice', 'exitVoice'], ['exit voice mode', 'exitVoice'],
  ['voice', 'voiceMode'], ['voice mode', 'voiceMode'], ['start voice', 'voiceMode'], ['enter voice mode', 'voiceMode'],
  ['voice on', 'ttsOn'], ['speech on', 'ttsOn'],
  ['voice off', 'ttsOff'], ['speech off', 'ttsOff'], ['mute', 'ttsOff'],
  ['listen', 'listen'],
  ['list', 'list'], ['ls', 'list'], ['list files', 'list'], ['show files', 'list'],
  ['projects', 'projects'], ['list projects', 'projects'],
  ['models', 'models'], ['list models', 'models'],
  ['stats', 'stats'], ['status', 'stats'], ['telemetry', 'stats']
]);

/**
 * @param {string} raw user input (typed or transcribed)
 * @returns {{ type: string, args?: string, raw: string }}
 */
function parseCommand(raw) {
  const text = String(raw === null || raw === undefined ? '' : raw).trim();
  const lower = text.toLowerCase().replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  if (!lower) return { type: 'empty', raw: text };

  if (EXACT.has(lower)) return { type: EXACT.get(lower), raw: text };
  // A bare yes/no with no question pending (e.g. approval typed after planning failed).
  if (['y', 'yes', 'n', 'no'].includes(lower)) return { type: 'strayAnswer', raw: text };

  const diag = /^(?:diagnose|doctor)(?:\s+(\S+))?$/.exec(lower);
  if (diag) return { type: 'diagnose', args: diag[1] ? text.split(/\s+/)[1] : undefined, raw: text };

  if (/^open\s+/i.test(text)) return { type: 'open', args: text.replace(/^open\s+/i, '').trim(), raw: text };

  const create = /^(?:jarvis[,\s]+)?(?:create|build|generate)\b[\s:,-]*([\s\S]*)$/i.exec(text);
  if (create) {
    let description = create[1].trim();
    // Spoken form: "create project todo list" → "todo list"
    const spoken = /^project\s+(?!that\b|which\b|to\b|for\b)([\s\S]+)$/i.exec(description);
    if (spoken) description = spoken[1].trim();
    if (!description) return { type: 'createUsage', raw: text };
    return { type: 'create', args: description, raw: text };
  }

  if (GREETING.test(lower)) return { type: 'greeting', raw: text };
  return { type: 'chat', args: text, raw: text };
}

module.exports = { parseCommand };
