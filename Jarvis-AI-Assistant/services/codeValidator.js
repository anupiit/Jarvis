// Static validation of generated files before they are accepted.
//
// What this proves: the file parses (JS/JSON), is structurally well-formed (HTML/CSS),
// is not truncated/empty/wrapped in prose, and references the planned sibling files.
// What it does NOT prove: that the program behaves correctly at runtime.
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { execFile } = require('child_process');

function issue(rule, message, line = null, column = null) {
  return { rule, message, line, column };
}

function extOf(filePath) {
  const base = String(filePath).split('/').pop().toLowerCase();
  return base.includes('.') ? base.split('.').pop() : '';
}

function languageFor(filePath) {
  const ext = extOf(filePath);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'css') return 'css';
  if (ext === 'js' || ext === 'mjs' || ext === 'cjs' || ext === 'jsx') return 'javascript';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  return 'text';
}

function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

// ---------------------------------------------------------------------------
// Generic checks (all file types)
// ---------------------------------------------------------------------------
const PROSE_PREFIX = /^(?:here(?:'s| is| are)\b|sure[,!.]|certainly[,!.]|of course[,!.]|below is\b|this (?:file|code) (?:is|contains|implements)\b|i(?:'ve| have) (?:created|written|generated)\b|okay[,!.]|absolutely[,!.])/i;
const PLACEHOLDER = /(?:\/\/|\/\*|<!--|#)\s*(?:\.\.\.\s*)?(?:rest of (?:the )?(?:code|file|styles|implementation)|remaining (?:code|styles|implementation)|add (?:your|more) (?:code|styles|logic) here|implementation goes here|same as (?:above|before))|^\s*\.\.\.\s*$/im;

function genericChecks(filePath, content, context, errors, warnings) {
  if (!content || !content.trim()) {
    errors.push(issue('empty', 'File is empty'));
    return false;
  }
  if (context.truncated) {
    errors.push(issue('truncated', 'The model stopped at its output limit (finishReason MAX_TOKENS); the file is incomplete'));
  }
  if (context.unclosedFence) {
    errors.push(issue('truncated', 'A Markdown code fence was opened but never closed; the output looks cut off'));
  }
  const language = languageFor(filePath);
  if (language !== 'markdown') {
    const fenceMatch = /^\s*```/m.exec(content);
    if (fenceMatch) errors.push(issue('markdown-fence', 'Contains a Markdown code fence (```), which is not valid in this file type', lineOfIndex(content, fenceMatch.index)));
  }
  const firstLine = content.trim().split('\n')[0].trim();
  if (PROSE_PREFIX.test(firstLine)) {
    errors.push(issue('unexpected-prose', `Starts with explanatory prose instead of file content: "${firstLine.slice(0, 60)}"`, 1));
  }
  const ph = PLACEHOLDER.exec(content);
  if (ph) {
    errors.push(issue('incomplete', `Contains placeholder text instead of complete code: "${ph[0].trim().slice(0, 60)}"`, lineOfIndex(content, ph.index)));
  }
  return true;
}

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------
function locationFromSyntaxError(err, filename) {
  const stack = String(err && err.stack || '');
  const re = new RegExp(`${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+)`);
  const m = re.exec(stack) || /:(\d+)\n/.exec(stack);
  return m ? parseInt(m[1], 10) : null;
}

function detectModuleType(code, context) {
  if (context.moduleType) return context.moduleType;
  const hasEsm = /^\s*(?:import\s+(?:[\w*{]|['"])|export\s+(?:default|const|let|var|function|class|async|\{|\*))/m.test(code);
  if (hasEsm) return 'module';
  const hasCjs = /\brequire\s*\(\s*['"]|module\.exports\b|\bexports\.\w+\s*=/.test(code);
  if (hasCjs || context.environment === 'node') return 'commonjs';
  return 'script';
}

function checkEsmWithNode(code) {
  return new Promise((resolve) => {
    const tmp = path.join(os.tmpdir(), `jarvis-check-${process.pid}-${crypto.randomBytes(6).toString('hex')}.mjs`);
    try {
      fs.writeFileSync(tmp, code, { encoding: 'utf8', flag: 'wx' });
    } catch (e) {
      resolve({ ok: false, message: `Could not create temp file for module check: ${e.message}`, line: null, internal: true });
      return;
    }
    execFile(process.execPath, ['--check', tmp], { timeout: 15000, windowsHide: true }, (error, stdout, stderr) => {
      fs.rm(tmp, { force: true }, () => {});
      if (!error) { resolve({ ok: true }); return; }
      const text = String(stderr || error.message);
      const lineMatch = /\.mjs:(\d+)/.exec(text);
      const msgMatch = /(SyntaxError: [^\n]+)/.exec(text);
      resolve({ ok: false, message: msgMatch ? msgMatch[1].replace(/^SyntaxError: /, '') : text.split('\n')[0], line: lineMatch ? parseInt(lineMatch[1], 10) : null });
    });
  });
}

async function checkJsSyntax(code, filename, mode) {
  if (mode === 'module') return checkEsmWithNode(code);
  try {
    if (mode === 'commonjs') {
      vm.compileFunction(code, ['exports', 'require', 'module', '__filename', '__dirname'], { filename });
    } else {
      // Compiles without executing.
      new vm.Script(code, { filename });
    }
    return { ok: true };
  } catch (err) {
    if (err && err.name === 'SyntaxError') {
      return { ok: false, message: err.message, line: locationFromSyntaxError(err, filename) };
    }
    return { ok: false, message: String(err && err.message || err), line: null };
  }
}

function jsConstraintChecks(code, context, errors, warnings, moduleType) {
  const forbidden = new Set(context.forbiddenCategories || []);
  const browser = context.environment === 'browser';
  if (forbidden.has('react') && /\bfrom\s+['"]react(?:-dom)?['"]|require\(\s*['"]react['"]\s*\)|\bReactDOM\b|\bReact\.createElement\b/.test(code)) {
    errors.push(issue('forbidden-technology', 'Uses React, which the request forbids'));
  }
  if (browser && moduleType === 'script' && /\brequire\s*\(\s*['"]/.test(code)) {
    errors.push(issue('node-api-in-browser', 'Uses require(), which does not exist in the browser'));
  }
  if (forbidden.has('node') && browser && /\bprocess\.(?:env|argv)|\b__dirname\b|require\(\s*['"](?:fs|path|http)['"]\s*\)/.test(code)) {
    errors.push(issue('forbidden-technology', 'Uses Node.js APIs, which the request forbids'));
  }
  if (forbidden.has('external-libraries') && /\bfrom\s+['"](?:https?:)?\/\/|import\s*\(\s*['"]https?:|\bfrom\s+['"](?![./])[\w@][\w@/.-]*['"]/.test(code)) {
    errors.push(issue('forbidden-external-resource', 'Imports an external library, which the request forbids'));
  }
  if (forbidden.has('network-apis') && /\bfetch\s*\(\s*['"`]https?:|new\s+XMLHttpRequest|\baxios\b/.test(code)) {
    errors.push(issue('forbidden-technology', 'Calls a network API, which the request forbids'));
  }
  if (forbidden.has('database') && /\bindexedDB\b|\bopenDatabase\b|\bfirebase\b|\bsupabase\b/.test(code)) {
    warnings.push(issue('possible-forbidden-technology', 'Uses a browser database/backend service; the request forbids databases'));
  }
  if (context.htmlIds && browser) {
    const used = new Set();
    const re = /getElementById\(\s*['"]([\w-]+)['"]\s*\)|querySelector(?:All)?\(\s*['"]#([\w-]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(code)) !== null) used.add(m[1] || m[2]);
    const missing = [...used].filter(id => !context.htmlIds.includes(id) && !new RegExp(`(?:\\.id\\s*=\\s*['"\`]${id}['"\`]|id=["'\\\\]*${id})`).test(code));
    if (missing.length) {
      warnings.push(issue('unknown-element-id', `Looks up element id(s) not present in the HTML: ${missing.map(i => '#' + i).join(', ')}`));
    }
  }
}

async function validateJavaScript(filePath, content, context, errors, warnings) {
  const ext = extOf(filePath);
  const mode = ext === 'mjs' ? 'module' : ext === 'cjs' ? 'commonjs' : detectModuleType(content, context);
  const result = await checkJsSyntax(content, filePath, mode);
  if (!result.ok && !result.internal) {
    const truncatedHint = /end of input|missing \}|Unterminated/i.test(result.message) ? ' (the output may be truncated)' : '';
    errors.push(issue('syntax', `JavaScript (${mode}) syntax error: ${result.message}${truncatedHint}`, result.line));
  } else if (result.internal) {
    warnings.push(issue('validator-unavailable', result.message));
  }
  jsConstraintChecks(content, context, errors, warnings, mode);
  return { moduleType: mode };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------
function validateJson(content, errors) {
  try {
    JSON.parse(content);
  } catch (e) {
    const pos = /position (\d+)/.exec(e.message);
    const lc = /line (\d+) column (\d+)/.exec(e.message);
    let line = lc ? parseInt(lc[1], 10) : (pos ? lineOfIndex(content, parseInt(pos[1], 10)) : null);
    if (line === null) {
      // V8: `Unexpected token '}', ..."version": }" is not valid JSON` — locate the quoted snippet.
      const snip = /Unexpected token '([\s\S])', (?:\.\.\.)?"([\s\S]*?)"(?:\.\.\.)? is not valid JSON/.exec(e.message);
      const idx = snip ? content.indexOf(snip[2]) : -1;
      if (idx !== -1) line = lineOfIndex(content, idx + snip[2].lastIndexOf(snip[1]));
    }
    errors.push(issue('syntax', `Invalid JSON: ${e.message}`, line));
  }
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------
function validateCss(content, errors, lineOffset = 0) {
  let line = 1;
  let inComment = false;
  let commentLine = 0;
  let inString = null;
  let stringLine = 0;
  let paren = 0;
  let segment = '';
  let segmentLine = 1;
  const stack = [];
  const err = (rule, msg, l) => errors.push(issue(rule, msg, l + lineOffset));

  const checkDeclaration = (seg, l) => {
    const s = seg.trim();
    if (!s || s.startsWith('@')) return;
    if (!/^(?:--[\w-]+|[-\w]+|\*[-\w]+)\s*:/.test(s)) {
      err('invalid-declaration', `Invalid declaration "${s.slice(0, 50)}" (expected "property: value")`, l);
    } else if (/^[-\w]+\s*:\s*(?:!important)?$/.test(s)) {
      err('empty-value', `Declaration "${s.slice(0, 50)}" has no value`, l);
    }
  };

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i + 1];
    if (c === '\n') line++;
    if (inComment) {
      if (c === '*' && next === '/') { inComment = false; i++; }
      continue;
    }
    if (inString) {
      if (c === '\\') { segment += c + (next || ''); i++; if (next === '\n') line++; continue; }
      if (c === inString) inString = null;
      else if (c === '\n') { err('unterminated-string', 'Unterminated string', stringLine); inString = null; }
      segment += c;
      continue;
    }
    if (c === '/' && next === '*') { inComment = true; commentLine = line; i++; continue; }
    if (!segment.trim() && !/\s/.test(c)) segmentLine = line;
    if (c === '"' || c === "'") { inString = c; stringLine = line; segment += c; continue; }
    if (c === '(') paren++;
    if (c === ')') {
      paren--;
      if (paren < 0) { err('unbalanced-parenthesis', 'Unexpected ")"', line); paren = 0; }
    }
    if (paren > 0) { segment += c; continue; }
    if (c === '{') {
      const prelude = segment.trim();
      if (!prelude) err('empty-selector', 'Rule block "{" has no selector', line);
      stack.push({ prelude, line });
      segment = '';
      continue;
    }
    if (c === '}') {
      if (!stack.length) {
        err('unexpected-closing-brace', 'Unexpected "}" with no matching "{"', line);
      } else {
        checkDeclaration(segment, segmentLine);
        stack.pop();
      }
      segment = '';
      continue;
    }
    if (c === ';') {
      if (!stack.length) {
        const stmt = segment.trim();
        if (stmt && !stmt.startsWith('@')) err('declaration-outside-rule', `"${stmt.slice(0, 50)}" is outside of any rule`, segmentLine);
      } else {
        checkDeclaration(segment, segmentLine);
      }
      segment = '';
      continue;
    }
    segment += c;
  }
  if (inComment) err('unclosed-comment', 'Comment "/*" is never closed (the output may be truncated)', commentLine);
  if (inString) err('unterminated-string', 'Unterminated string at end of file', stringLine);
  if (paren > 0) err('unbalanced-parenthesis', 'Unclosed "(" at end of file (the output may be truncated)', line);
  if (stack.length) {
    const open = stack[stack.length - 1];
    err('unclosed-block', `Block "${open.prelude.slice(0, 40)} {" opened on line ${open.line + lineOffset} is never closed (the output may be truncated)`, open.line);
  } else if (segment.trim()) {
    err('unexpected-trailing-content', `Unexpected content at end of file: "${segment.trim().slice(0, 50)}" (the output may be truncated)`, segmentLine);
  }
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const OPTIONAL_END = new Set(['html', 'head', 'body', 'p', 'li', 'dt', 'dd', 'option', 'optgroup', 'tr', 'td', 'th', 'thead', 'tbody', 'tfoot', 'colgroup', 'caption', 'rb', 'rt', 'rtc', 'rp']);
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul']);
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript']);

function implicitlyCloses(open, incoming) {
  if (open === incoming && ['p', 'li', 'dt', 'dd', 'option', 'tr', 'td', 'th'].includes(open)) return true;
  if (open === 'p' && CLOSES_P.has(incoming)) return true;
  if ((open === 'dt' || open === 'dd') && (incoming === 'dt' || incoming === 'dd')) return true;
  if ((open === 'td' || open === 'th') && (incoming === 'td' || incoming === 'th' || incoming === 'tr')) return true;
  return false;
}

function isLocalReference(ref) {
  return ref && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

function isExternalReference(ref) {
  return /^(?:https?:)?\/\//i.test(ref || '');
}

function normalizeRef(htmlPath, ref) {
  const clean = decodeURIComponent(ref.split('#')[0].split('?')[0]);
  if (!clean) return null;
  const dir = path.posix.dirname(htmlPath);
  const joined = clean.startsWith('/') ? clean.slice(1) : path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, clean));
  return joined.replace(/^\.\//, '');
}

function parseAttributes(src, start, errors, tagLine) {
  // Returns { attrs, end, selfClosing } where end is the index of '>' or -1.
  const attrs = {};
  let j = start;
  while (j < src.length) {
    while (j < src.length && /\s/.test(src[j])) j++;
    if (j >= src.length) return { attrs, end: -1 };
    if (src[j] === '>') return { attrs, end: j, selfClosing: false };
    if (src[j] === '/' && src[j + 1] === '>') return { attrs, end: j + 1, selfClosing: true };
    if (src[j] === '/') { j++; continue; }
    const nameMatch = /^[^\s"'>\/=]+/.exec(src.slice(j, j + 200));
    if (!nameMatch) { j++; continue; }
    const name = nameMatch[0].toLowerCase();
    j += nameMatch[0].length;
    while (j < src.length && /\s/.test(src[j])) j++;
    let value = '';
    if (src[j] === '=') {
      j++;
      while (j < src.length && /\s/.test(src[j])) j++;
      const q = src[j];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, j + 1);
        if (close === -1) {
          errors.push(issue('unterminated-attribute', `Attribute ${name} has an unterminated ${q === '"' ? 'double' : 'single'} quote`, tagLine));
          return { attrs, end: -1, fatal: true };
        }
        value = src.slice(j + 1, close);
        j = close + 1;
      } else {
        const m = /^[^\s>]+/.exec(src.slice(j, j + 2000));
        value = m ? m[0] : '';
        j += value.length;
      }
    }
    attrs[name] = value;
  }
  return { attrs, end: -1 };
}

async function validateHtml(filePath, content, context, errors, warnings) {
  const meta = { ids: [], references: [], stylesheets: [], scripts: [], hasDoctype: false };
  const stack = [];
  const idSeen = new Set();
  const inline = [];
  let i = 0;
  let stoppedEarly = false;

  while (i < content.length) {
    const lt = content.indexOf('<', i);
    if (lt === -1) break;
    const line = lineOfIndex(content, lt);
    if (content.startsWith('<!--', lt)) {
      const end = content.indexOf('-->', lt + 4);
      if (end === -1) { errors.push(issue('unclosed-comment', 'HTML comment "<!--" is never closed (the output may be truncated)', line)); stoppedEarly = true; break; }
      i = end + 3;
      continue;
    }
    if (content[lt + 1] === '!' || content[lt + 1] === '?') {
      const end = content.indexOf('>', lt);
      if (end === -1) { errors.push(issue('truncated', 'Declaration "<!" is never closed', line)); stoppedEarly = true; break; }
      if (/^<!doctype\s+html/i.test(content.slice(lt, end + 1))) meta.hasDoctype = true;
      i = end + 1;
      continue;
    }
    if (content[lt + 1] === '/') {
      const m = /^<\/([a-zA-Z][\w:-]*)\s*>/.exec(content.slice(lt, lt + 120));
      if (!m) {
        if (/[a-zA-Z]/.test(content[lt + 2] || '')) {
          errors.push(issue('malformed-tag', 'Malformed closing tag', line));
          if (content.indexOf('>', lt) === -1) { stoppedEarly = true; break; }
        }
        i = lt + 1;
        continue;
      }
      const name = m[1].toLowerCase();
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== name) k--;
      if (k < 0) {
        if (!VOID.has(name)) errors.push(issue('unexpected-closing-tag', `Closing tag </${name}> has no matching opening tag`, line));
      } else {
        for (let x = stack.length - 1; x > k; x--) {
          if (!OPTIONAL_END.has(stack[x].name)) {
            errors.push(issue('unclosed-tag', `<${stack[x].name}> opened on line ${stack[x].line} is not closed before </${name}>`, stack[x].line));
          }
        }
        stack.length = k;
      }
      i = lt + m[0].length;
      continue;
    }
    if (!/[a-zA-Z]/.test(content[lt + 1] || '')) { i = lt + 1; continue; }

    const nameMatch = /^<([a-zA-Z][\w:-]*)/.exec(content.slice(lt, lt + 100));
    const name = nameMatch[1].toLowerCase();
    const parsed = parseAttributes(content, lt + nameMatch[0].length, errors, line);
    if (parsed.end === -1) {
      if (!parsed.fatal) errors.push(issue('truncated', `Tag <${name}> is never closed with ">" (the output may be truncated)`, line));
      stoppedEarly = true;
      break;
    }
    const { attrs, selfClosing } = parsed;

    while (stack.length && OPTIONAL_END.has(stack[stack.length - 1].name) && implicitlyCloses(stack[stack.length - 1].name, name)) stack.pop();

    if (attrs.id) {
      if (idSeen.has(attrs.id)) warnings.push(issue('duplicate-id', `Duplicate id "${attrs.id}"`, line));
      idSeen.add(attrs.id);
      meta.ids.push(attrs.id);
    }
    if (name === 'link' && /\bstylesheet\b/i.test(attrs.rel || '') && attrs.href) {
      meta.stylesheets.push(attrs.href);
      meta.references.push({ kind: 'stylesheet', ref: attrs.href, line });
    } else if (name === 'script' && attrs.src) {
      meta.scripts.push({ src: attrs.src, type: (attrs.type || '').toLowerCase() });
      meta.references.push({ kind: 'script', ref: attrs.src, line });
    } else if (['img', 'source', 'audio', 'video', 'iframe', 'embed'].includes(name) && attrs.src) {
      meta.references.push({ kind: 'asset', ref: attrs.src, line });
    } else if (name === 'link' && attrs.href && /icon|manifest/i.test(attrs.rel || '')) {
      meta.references.push({ kind: 'asset', ref: attrs.href, line });
    }

    const tagEnd = parsed.end;
    if (RAW_TEXT.has(name) && !selfClosing) {
      const closeRe = new RegExp(`</${name}\\s*>`, 'ig');
      closeRe.lastIndex = tagEnd + 1;
      const close = closeRe.exec(content);
      if (!close) {
        errors.push(issue('unclosed-tag', `<${name}> opened on line ${line} is never closed (the output may be truncated)`, line));
        stoppedEarly = true;
        break;
      }
      const body = content.slice(tagEnd + 1, close.index);
      const type = (attrs.type || '').toLowerCase();
      if (name === 'script' && !attrs.src && JS_TYPES.has(type) && body.trim()) inline.push({ kind: 'script', body, line, type });
      if (name === 'style' && body.trim()) inline.push({ kind: 'style', body, line });
      i = close.index + close[0].length;
      continue;
    }
    if (!VOID.has(name)) {
      if (selfClosing) warnings.push(issue('self-closing-non-void', `<${name} /> is not a void element; it is not closed by "/>"`, line));
      else stack.push({ name, line });
    }
    i = tagEnd + 1;
  }

  if (!stoppedEarly) {
    const unclosed = stack.filter(s => !OPTIONAL_END.has(s.name));
    for (const s of unclosed.slice(-5)) {
      errors.push(issue('unclosed-tag', `<${s.name}> opened on line ${s.line} is never closed (the output may be truncated)`, s.line));
    }
  }

  const trimmed = content.trim();
  if (/<html[\s>]/i.test(content) && !/<\/html>\s*$/i.test(trimmed) && !stoppedEarly) {
    errors.push(issue('truncated', 'Document does not end with </html> (the output may be truncated)', lineOfIndex(content, content.length)));
  }
  if (!/<[a-zA-Z]/.test(content)) errors.push(issue('not-html', 'File does not contain any HTML elements'));
  if (!meta.hasDoctype) warnings.push(issue('missing-doctype', 'Missing <!DOCTYPE html> (browsers will use quirks mode)'));
  if (!/<title[\s>]/i.test(content)) warnings.push(issue('missing-title', 'Missing <title>'));
  if (!/<meta[^>]+name=["']?viewport/i.test(content)) warnings.push(issue('missing-viewport', 'Missing <meta name="viewport"> (needed for responsive layouts)'));

  for (const block of inline) {
    const blockLine = lineOfIndex(content, content.indexOf(block.body));
    if (block.kind === 'script') {
      const res = await checkJsSyntax(block.body, `${filePath}#inline-script`, block.type === 'module' ? 'module' : 'script');
      if (!res.ok && !res.internal) errors.push(issue('syntax', `Inline <script> syntax error: ${res.message}`, res.line ? blockLine + res.line - 1 : block.line));
    } else {
      validateCss(block.body, errors, blockLine - 1);
    }
  }

  // References to sibling files
  const forbidden = new Set(context.forbiddenCategories || []);
  const planned = context.plannedFiles || null;
  const referenced = new Set();
  for (const r of meta.references) {
    if (isExternalReference(r.ref)) {
      if (forbidden.has('external-libraries') && r.kind !== 'asset') {
        const fontOnly = /fonts\.(?:googleapis|gstatic)\.com/i.test(r.ref);
        (fontOnly ? warnings : errors).push(issue(fontOnly ? 'external-font' : 'forbidden-external-resource', `Loads an external ${r.kind} (${r.ref}); the request forbids external libraries`, r.line));
      }
      continue;
    }
    if (!isLocalReference(r.ref)) continue;
    const target = normalizeRef(filePath, r.ref);
    if (!target) continue;
    referenced.add(target);
    if (planned && !planned.includes(target)) {
      const ext = target.split('.').pop();
      const suggestion = planned.find(p => p.split('.').pop() === ext);
      const msg = `References "${r.ref}" but the project has no such file${suggestion ? ` (did you mean "${suggestion}"?)` : ''}`;
      if (r.kind === 'asset') warnings.push(issue('missing-asset', msg, r.line));
      else errors.push(issue('broken-reference', msg, r.line));
    }
  }
  for (const expected of context.expectedReferences || []) {
    if (!referenced.has(expected)) {
      const how = expected.endsWith('.css') ? `<link rel="stylesheet" href="${expected}">` : `<script src="${expected}" defer></script>`;
      errors.push(issue('missing-reference', `Does not load the planned file "${expected}" (expected ${how})`));
    }
  }
  return meta;
}

// ---------------------------------------------------------------------------
// Markdown / text
// ---------------------------------------------------------------------------
function validateMarkdown(content, errors) {
  const fences = content.split('\n').filter(l => /^\s*```/.test(l)).length;
  if (fences % 2 === 1) errors.push(issue('unclosed-fence', 'Unclosed Markdown code fence (the output may be truncated)'));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
/**
 * @param {{ path: string, content: string, context?: object }} input
 * context: { truncated, unclosedFence, moduleType, environment ('browser'|'node'),
 *            plannedFiles, expectedReferences, forbiddenCategories, htmlIds }
 * @returns {Promise<{ valid, language, errors, warnings, meta }>}
 */
async function validateFile({ path: filePath, content, context = {} }) {
  const errors = [];
  const warnings = [];
  const language = languageFor(filePath);
  let meta = {};
  const text = typeof content === 'string' ? content.replace(/^\uFEFF/, '') : '';
  const nonEmpty = genericChecks(filePath, text, context, errors, warnings);
  if (nonEmpty) {
    if (language === 'javascript') meta = await validateJavaScript(filePath, text, context, errors, warnings);
    else if (language === 'json') validateJson(text, errors);
    else if (language === 'css') validateCss(text, errors);
    else if (language === 'html') meta = await validateHtml(filePath, text, context, errors, warnings);
    else if (language === 'markdown') validateMarkdown(text, errors);
  }
  return { valid: errors.length === 0, language, errors, warnings, meta };
}

function formatIssues(issues, limit = 8) {
  return issues.slice(0, limit).map((e, n) => `${n + 1}. [${e.rule}]${e.line ? ` line ${e.line}` : ''}: ${e.message}`).join('\n')
    + (issues.length > limit ? `\n…and ${issues.length - limit} more` : '');
}

module.exports = { validateFile, validateCss, languageFor, formatIssues, checkJsSyntax };
