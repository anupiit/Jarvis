// A stand-in for GeminiEngine.generate() that returns scripted model output.
// responder(prompt, opts, index) → string | { text, truncated, finishReason } | throws

function createScriptedEngine(responder) {
  const calls = [];
  return {
    calls,
    model: 'scripted-model',
    async generate(prompt, opts = {}) {
      const index = calls.length;
      calls.push({ prompt, opts });
      const out = await responder(prompt, opts, index);
      if (typeof out === 'string') return { text: out, finishReason: 'STOP', truncated: false, attempts: 1 };
      return { finishReason: out.truncated ? 'MAX_TOKENS' : 'STOP', truncated: false, attempts: 1, ...out };
    }
  };
}

/** Pick the file a code-generation prompt is asking for. */
function requestedFile(prompt) {
  const m = /(?:contents of the file|contents of) "([^"]+)"|The file "([^"]+)" you generated/.exec(prompt);
  return m ? (m[1] || m[2]) : null;
}

module.exports = { createScriptedEngine, requestedFile };
