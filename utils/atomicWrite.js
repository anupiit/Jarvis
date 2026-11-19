// Atomic file replacement: write a uniquely named temp file in the same directory,
// flush it, then rename over the target. A crash or failure never leaves a half-written
// target, and an existing valid file is only replaced by a complete new one.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMP_SUFFIX = '.jarvis-tmp';
const RETRYABLE_RENAME = new Set(['EPERM', 'EBUSY', 'EACCES']); // Windows: antivirus / indexer locks

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function tempPathFor(target) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  return path.join(dir, `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}${TEMP_SUFFIX}`);
}

function renameWithRetry(from, to, attempts = 6) {
  for (let i = 1; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (!RETRYABLE_RENAME.has(e.code) || i >= attempts) throw e;
      sleepSync(25 * i);
    }
  }
}

/**
 * @param {string} target absolute path
 * @param {string} content
 * @param {{ rename?: Function }} [hooks] test hook to simulate rename failures
 */
function writeFileAtomic(target, content, hooks = {}) {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = tempPathFor(target);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx'); // exclusive: never clobbers an existing file
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    (hooks.rename || renameWithRetry)(tmp, target);
  } catch (error) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    }
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    throw error;
  }
}

/** Remove temp files left behind by a crashed earlier run (only our own naming pattern). */
function cleanupStaleTempFiles(dir) {
  let removed = 0;
  if (!fs.existsSync(dir)) return removed;
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith('.') && entry.endsWith(TEMP_SUFFIX)) {
      try { fs.rmSync(path.join(dir, entry), { force: true }); removed++; } catch (_) { /* ignore */ }
    }
  }
  return removed;
}

module.exports = { writeFileAtomic, cleanupStaleTempFiles, tempPathFor, TEMP_SUFFIX };
