const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('stream');
const { InputManager } = require('../utils/inputManager');

function make() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c) => { written += c; });
  const io = new InputManager({ input, output, terminal: false });
  return { io, input, output: () => written };
}

test('lines typed before a prompt are buffered, not lost (old bug: piped "y" was dropped)', async () => {
  const { io, input } = make();
  input.write('create x\ny\n');
  await new Promise(r => setImmediate(r));
  assert.equal(await io.ask('> '), 'create x');
  assert.equal(await io.ask('? '), 'y');
  io.close();
});

test('ask waits for the next line when none is buffered', async () => {
  const { io, input } = make();
  const p = io.ask('> ');
  setTimeout(() => input.write('later\n'), 5);
  assert.equal(await p, 'later');
  io.close();
});

test('end of input resolves pending and future prompts with null (no ERR_USE_AFTER_CLOSE)', async () => {
  const { io, input } = make();
  const p = io.ask('> ');
  input.end();
  assert.equal(await p, null);
  assert.equal(await io.ask('> '), null);
  assert.equal(await io.ask('> '), null);
});

test('buffered lines are still delivered after input ends', async () => {
  const { io, input } = make();
  input.end('a\nb\n');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(await io.ask('> '), 'a');
  assert.equal(await io.ask('> '), 'b');
  assert.equal(await io.ask('> '), null);
});

test('concurrent asks are rejected instead of creating competing readers', async () => {
  const { io, input } = make();
  const first = io.ask('1 ');
  await assert.rejects(io.ask('2 '), /another prompt is pending/);
  input.write('x\n');
  assert.equal(await first, 'x');
  io.close();
});

test('exactly one stdin reader exists for the lifetime of the manager', async () => {
  const { io, input } = make();
  const dataListeners = input.listenerCount('data');
  for (let i = 0; i < 5; i++) {
    const p = io.ask('> ');
    input.write(`line ${i}\n`);
    await p;
  }
  assert.equal(input.listenerCount('data'), dataListeners);
  io.close();
});

test('SIGINT is routed to the handler', () => {
  const { io } = make();
  let called = 0;
  io.onSigint(() => { called++; });
  io.rl.emit('SIGINT');
  assert.equal(called, 1);
  io.close();
});

test('prompts and piped input are echoed for readable transcripts', async () => {
  const { io, input, output } = make();
  input.write('hello\n');
  await new Promise(r => setImmediate(r));
  await io.ask('PROMPT> ');
  assert.match(output(), /PROMPT> hello\n/);
  io.close();
});
