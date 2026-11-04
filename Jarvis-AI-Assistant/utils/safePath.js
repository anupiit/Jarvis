// Path validation for every file Jarvis writes. Rejects absolute paths, traversal,
// Windows-invalid characters and reserved device names, and verifies the resolved
// path (including symlinks) stays inside the permitted base directory.
const fs = require('fs');
const path = require('path');

class PathSecurityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathSecurityError';
    this.code = 'EPATHSECURITY';
  }
}

const INVALID_WIN_CHARS = /[<>:"|?*\u0000-\u001f]/;
const RESERVED_BASENAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_RELATIVE_PATH = 200;

/**
 * Validate a user/AI-supplied relative path.
 * @returns {{ ok: true, normalized: string } | { ok: false, reason: string }}
 */
function validateRelativePath(input) {
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: 'empty path' };
  let p = input.trim().replace(/\\/g, '/');
  if (p.length > MAX_RELATIVE_PATH) return { ok: false, reason: 'path too long' };
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p) || p.startsWith('//')) return { ok: false, reason: 'absolute paths are not allowed' };
  p = p.replace(/^\.\/+/, '').replace(/\/+$/, '');
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' ) return { ok: false, reason: 'empty path segment' };
    if (seg === '.' || seg === '..') return { ok: false, reason: 'path traversal ("." or "..") is not allowed' };
    if (INVALID_WIN_CHARS.test(seg)) return { ok: false, reason: `invalid character in "${seg}"` };
    if (/[. ]$/.test(seg)) return { ok: false, reason: `"${seg}" ends with a dot or space (invalid on Windows)` };
    if (RESERVED_BASENAME.test(seg.split('.')[0])) return { ok: false, reason: `"${seg}" is a reserved Windows device name` };
  }
  return { ok: true, normalized: segments.join('/') };
}

function isInside(baseDir, target) {
  const rel = path.relative(baseDir, target);
  return rel === '' ? false : !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Resolve `relative` under `baseDir` or throw PathSecurityError. */
function resolveInside(baseDir, relative) {
  const check = validateRelativePath(relative);
  if (!check.ok) throw new PathSecurityError(`Refusing path "${relative}": ${check.reason}`);
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...check.normalized.split('/'));
  if (!isInside(base, target)) throw new PathSecurityError(`Refusing path "${relative}": resolves outside ${base}`);
  return target;
}

/** After directories exist, make sure symlinks/junctions do not lead outside the base. */
function assertRealPathInside(baseDir, target) {
  const realBase = fs.realpathSync(baseDir);
  let probe = target;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== realBase && !isInside(realBase, realProbe)) {
    throw new PathSecurityError(`Refusing to write through "${probe}": it resolves outside ${realBase}`);
  }
}

module.exports = { PathSecurityError, validateRelativePath, resolveInside, assertRealPathInside, isInside };
