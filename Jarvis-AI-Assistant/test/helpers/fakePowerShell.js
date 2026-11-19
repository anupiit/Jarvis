// Fake child process for the PowerShell runner. NOT a speech engine: it only replays scripted
// stdout so the Node side of the voice pipeline can be tested without Windows or a microphone.
const { EventEmitter } = require('events');

function createFakeSpawn(behaviour) {
  const calls = [];
  function spawnPowerShell(script, { env } = {}) {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      if (child.killed) return true;
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    const call = { script, env: { ...env }, child };
    calls.push(call);
    setImmediate(() => behaviour(call, {
      out: (line) => child.stdout.emit('data', Buffer.from(`${line}\n`)),
      err: (text) => child.stderr.emit('data', Buffer.from(text)),
      exit: (code = 0) => { if (!child.killed) child.emit('close', code, null); },
      fail: (error) => child.emit('error', error)
    }));
    return child;
  }
  return { spawnPowerShell, calls };
}

module.exports = { createFakeSpawn };
