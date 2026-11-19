// Extract the file body from a model response (handles fences, prose, truncation).

const LANG_ALIASES = {
  html: ['html', 'htm', 'xhtml'],
  css: ['css', 'scss'],
  js: ['js', 'javascript', 'jsx', 'mjs', 'cjs', 'node'],
  mjs: ['js', 'javascript', 'mjs'],
  cjs: ['js', 'javascript', 'cjs', 'node'],
  json: ['json', 'jsonc'],
  md: ['md', 'markdown'],
  py: ['py', 'python'],
  ts: ['ts', 'typescript'],
  svg: ['svg', 'xml', 'html']
};

function extensionOf(filePath) {
  const base = String(filePath).split('/').pop().toLowerCase();
  return base.includes('.') ? base.split('.').pop() : '';
}

/**
 * @returns {{ code: string, unclosedFence: boolean, hadFence: boolean }}
 */
function extractCode(response, filePath) {
  const text = String(response || '').replace(/\r\n/g, '\n');
  const ext = extensionOf(filePath);

  if (ext === 'md') {
    // Markdown legitimately contains fences; only unwrap a response that is one big fenced block.
    const whole = /^\s*```(?:md|markdown)?[^\n]*\n([\s\S]*?)\n```\s*$/i.exec(text);
    return { code: (whole ? whole[1] : text).trim(), unclosedFence: false, hadFence: Boolean(whole) };
  }

  const blocks = [];
  const re = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) blocks.push({ lang: m[1].toLowerCase(), body: m[2] });

  if (blocks.length) {
    const wanted = LANG_ALIASES[ext] || [ext];
    const matching = blocks.filter(b => wanted.includes(b.lang));
    const pool = matching.length ? matching : blocks;
    const best = pool.reduce((a, b) => (b.body.length > a.body.length ? b : a));
    return { code: best.body.trim(), unclosedFence: false, hadFence: true };
  }

  // An opening fence without a closing one: the output was cut off.
  const open = /^\s*```[\w+#.-]*[^\n]*\n([\s\S]*)$/.exec(text);
  if (open) return { code: open[1].trim(), unclosedFence: true, hadFence: true };

  let code = text.trim();
  if (ext === 'html' || ext === 'htm') {
    const start = code.search(/<!doctype html|<html[\s>]/i);
    if (start > 0) code = code.slice(start);
    const end = code.toLowerCase().lastIndexOf('</html>');
    if (end !== -1) code = code.slice(0, end + '</html>'.length);
  } else if (ext === 'json') {
    const start = code.search(/[{[]/);
    const end = Math.max(code.lastIndexOf('}'), code.lastIndexOf(']'));
    if (start !== -1 && end > start) code = code.slice(start, end + 1);
  }
  return { code, unclosedFence: false, hadFence: false };
}

module.exports = { extractCode };
