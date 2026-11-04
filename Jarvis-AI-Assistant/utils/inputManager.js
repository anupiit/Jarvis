// The ONLY reader of stdin. Every prompt (commands, approvals, voice push-to-talk) goes
// through ask(), so there is never a second readline interface competing for input.
// Lines that arrive while nobody is asking (piped input, type-ahead) are buffered instead
// of being lost; end of input resolves pending and future asks with null.
const readline = require('readline');

class InputManager {
  constructor({ input = process.stdin, output = process.stdout, terminal } = {}) {
    this.input = input;
    this.output = output;
    this.isTTY = terminal !== undefined ? terminal : Boolean(input.isTTY && output.isTTY);
    this.rl = readline.createInterface({ input, output, terminal: this.isTTY, historySize: 100 });
    this.buffer = [];
    this.waiting = null;
    this.closed = false;
    this.sigintHandler = null;
    this.closeHandlers = [];

    this.rl.on('line', (line) => {
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        if (!this.isTTY) this.output.write(`${line}\n`); // echo piped input so transcripts read naturally
        resolve(line);
      } else {
        this.buffer.push(line);
      }
    });
    this.rl.on('close', () => {
      this.closed = true;
      if (this.waiting) {
        const resolve = this.waiting;
        this.waiting = null;
        resolve(null);
      }
      for (const fn of this.closeHandlers) {
        try { fn(); } catch (_) { /* ignore */ }
      }
    });
    this.rl.on('SIGINT', () => {
      if (this.sigintHandler) this.sigintHandler();
      else this.rl.close();
    });
  }

  onSigint(fn) {
    this.sigintHandler = fn;
  }

  onClose(fn) {
    this.closeHandlers.push(fn);
  }

  /**
   * Show a prompt and wait for one line.
   * @param {string} promptText
   * @param {{ discardTypeahead?: boolean }} [opts] discard keys typed earlier (TTY only) — used for approvals
   * @returns {Promise<string|null>} the line, or null when input has ended
   */
  ask(promptText, { discardTypeahead = false } = {}) {
    if (this.waiting) return Promise.reject(new Error('InputManager.ask() called while another prompt is pending'));
    if (discardTypeahead && this.isTTY) this.buffer.length = 0;
    if (this.buffer.length) {
      const line = this.buffer.shift();
      this.output.write(promptText);
      if (!this.isTTY) this.output.write(`${line}\n`); // echo piped input so transcripts read naturally
      return Promise.resolve(line);
    }
    if (this.closed) return Promise.resolve(null);
    this.rl.setPrompt(promptText);
    this.rl.prompt();
    return new Promise((resolve) => { this.waiting = resolve; });
  }

  close() {
    if (!this.closed) this.rl.close();
  }
}

module.exports = { InputManager };
