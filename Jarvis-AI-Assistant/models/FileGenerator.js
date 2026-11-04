const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { getDefaultEngine } = require('../services/geminiService');
const { GeminiError, ErrorKind } = require('../services/geminiErrors');
const { validateFile, formatIssues } = require('../services/codeValidator');
const { SelfCorrector } = require('./SelfCorrector');
const { resolveInside, assertRealPathInside } = require('../utils/safePath');
const { writeFileAtomic, cleanupStaleTempFiles } = require('../utils/atomicWrite');
const { log, displayProgress } = require('../utils/logger');

const CODEGEN_SYSTEM_INSTRUCTION = 'You are an expert software engineer. You write complete, working, production-quality source files that fit together with the other files of the project. You output only the raw file content: no explanations and no Markdown code fences.';
const MAX_CONTEXT_CHARS_PER_FILE = 15000;

// Gemini failures that are about this specific content; every other failure that survived
// the engine's retries will affect the next file too, so generation stops.
const CONTENT_SPECIFIC = new Set([ErrorKind.BLOCKED, ErrorKind.EMPTY_RESPONSE, ErrorKind.INVALID_RESPONSE]);

function isWebProject(plan) {
  const stack = (plan.techStack || []).join(' ').toLowerCase();
  const hasHtml = plan.files.some(f => f.fileType === 'html');
  const nodeish = /\bnode|express|electron|deno\b/.test(stack) || plan.files.some(f => f.path === 'package.json');
  return hasHtml && !nodeish;
}

function relativeFrom(fromFile, toFile) {
  const rel = path.posix.relative(path.posix.dirname(fromFile), toFile);
  return rel || path.posix.basename(toFile);
}

function formatBytes(n) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

class FileGenerator {
  constructor({ engine, projectsRoot, maxCorrections = config.MAX_CORRECTION_ATTEMPTS, validator = validateFile, onEvent = null } = {}) {
    this.engine = engine || null;
    this.projectsRoot = projectsRoot || config.PROJECTS_ROOT;
    this.maxCorrections = maxCorrections;
    this.validator = validator;
    this.onEvent = onEvent;
  }

  getEngine() {
    return this.engine || getDefaultEngine();
  }

  primaryHtml(plan) {
    const html = plan.files.filter(f => f.fileType === 'html');
    return html.find(f => f.path === 'index.html') || (html.length === 1 ? html[0] : null);
  }

  buildContext(file, plan, generated, htmlMeta) {
    const web = isWebProject(plan);
    const planned = plan.files.map(f => f.path);
    const ctx = {
      plannedFiles: planned,
      forbiddenCategories: (plan.requirements && plan.requirements.forbiddenCategories) || [],
      environment: web ? 'browser' : 'node'
    };
    const primary = this.primaryHtml(plan);
    if (web && primary && file.path === primary.path) {
      ctx.expectedReferences = plan.files
        .filter(f => f.fileType === 'css' || (f.fileType === 'javascript' && /\.(m?js)$/.test(f.path)))
        .map(f => f.path);
    }
    if (file.fileType === 'javascript' && web) {
      const loaded = htmlMeta && htmlMeta.scripts ? htmlMeta.scripts.find(s => s.src && s.src.replace(/^\.\//, '') === relativeFrom(primary ? primary.path : 'index.html', file.path)) : null;
      ctx.moduleType = loaded && loaded.type === 'module' ? 'module' : (file.path.endsWith('.mjs') ? 'module' : 'script');
      if (htmlMeta && htmlMeta.ids) ctx.htmlIds = htmlMeta.ids;
    }
    return ctx;
  }

  buildFilePrompt(file, plan, generated) {
    const reqs = plan.requirements || {};
    const fileList = plan.files.map(f => `- ${f.path} — ${f.description}`).join('\n');
    const constraints = [];
    if (reqs.forbiddenTerms && reqs.forbiddenTerms.length) constraints.push(`- Do NOT use: ${reqs.forbiddenTerms.join(', ')}.`);
    if (reqs.noExternalLibraries) constraints.push('- No external libraries, frameworks, CDNs or network resources.');
    if (reqs.noAdditionalFolders || reqs.exactFiles) constraints.push('- The project consists of exactly the files listed above. Do not reference any other file.');

    const specific = [];
    const primary = this.primaryHtml(plan);
    if (file.fileType === 'html') {
      const css = plan.files.filter(f => f.fileType === 'css').map(f => relativeFrom(file.path, f.path));
      const js = plan.files.filter(f => f.fileType === 'javascript').map(f => relativeFrom(file.path, f.path));
      specific.push('- A complete HTML5 document: <!DOCTYPE html>, <html lang="en">, <head> with charset, viewport meta and <title>, and a <body>. It must end with </html>.');
      if (primary && primary.path === file.path) {
        css.forEach(c => specific.push(`- Load the stylesheet exactly as: <link rel="stylesheet" href="${c}">`));
        js.forEach(j => specific.push(`- Load the script exactly as: <script src="${j}" defer></script>`));
      }
      specific.push('- Semantic, accessible markup (labels for inputs, aria attributes where useful). Give every element the JavaScript needs a stable id.');
    } else if (file.fileType === 'css') {
      specific.push('- Style the ids and classes used in the HTML shown below (and classes the JavaScript adds).');
      specific.push('- Responsive, mobile-first layout using Flexbox/Grid and CSS custom properties. Plain CSS only.');
    } else if (file.fileType === 'javascript' && isWebProject(plan)) {
      specific.push('- Browser JavaScript loaded with a classic <script defer> tag: no import/export, no require().');
      specific.push('- Use exactly the element ids and classes from the HTML shown below.');
      specific.push('- Guard against missing elements and against unavailable or corrupted localStorage data (try/catch around JSON.parse).');
    } else if (file.fileType === 'json') {
      specific.push('- Strictly valid JSON (no comments, no trailing commas).');
    }

    const contextBlocks = Object.entries(generated).map(([p, content]) => {
      const shown = content.length > MAX_CONTEXT_CHARS_PER_FILE ? `${content.slice(0, MAX_CONTEXT_CHARS_PER_FILE)}\n…(shortened)…` : content;
      return `--- ${p} ---\n${shown}`;
    });

    return [
      `Write the complete contents of the file "${file.path}" (${file.description}).`,
      '',
      `PROJECT: ${plan.title} — ${plan.description}`,
      'USER REQUEST (verbatim):',
      '"""', plan.request || plan.description, '"""',
      '',
      'FEATURES TO IMPLEMENT:',
      ...plan.features.map(f => `- ${f}`),
      `TECH STACK: ${plan.techStack.join(', ')}`,
      '',
      'ALL PROJECT FILES (use these exact names; they are the only files):',
      fileList,
      ...(constraints.length ? ['', 'CONSTRAINTS:', ...constraints] : []),
      ...(specific.length ? ['', `REQUIREMENTS FOR ${file.path}:`, ...specific] : []),
      ...(contextBlocks.length ? ['', 'FILES ALREADY WRITTEN (stay consistent with them):', ...contextBlocks] : []),
      '',
      `Return ONLY the raw contents of ${file.path}.`
    ].join('\n');
  }

  /**
   * Generate, validate, correct and write every planned file.
   * Only files listed in the approved plan are ever written, and only after validation.
   * @returns {Promise<object>} summary
   */
  async generateProjectFiles(plan) {
    const started = Date.now();
    const root = path.resolve(plan.projectsRoot || this.projectsRoot);
    fs.mkdirSync(root, { recursive: true });
    const projectPath = resolveInside(root, plan.projectName);
    const projectExisted = fs.existsSync(projectPath);
    if (projectExisted) cleanupStaleTempFiles(projectPath);

    const corrector = new SelfCorrector({ engine: this.getEngine(), validator: this.validator, maxCorrections: this.maxCorrections, onEvent: this.onEvent });
    const results = [];
    const generated = {};
    let htmlMeta = null;
    let fatal = null;

    log('\n🚀 Generating files...', 'green');
    for (let i = 0; i < plan.files.length; i++) {
      const file = plan.files[i];
      if (fatal) {
        results.push({ path: file.path, status: 'skipped', reason: `stopped after ${fatal.kind}` });
        continue;
      }
      displayProgress(i, plan.files.length, `Generating ${file.path}`);
      let target;
      try {
        target = resolveInside(projectPath, file.path);
      } catch (e) {
        results.push({ path: file.path, status: 'failed', reason: e.message });
        continue;
      }
      const existed = fs.existsSync(target);
      const outcome = await corrector.generateValidFile({
        filePath: file.path,
        prompt: this.buildFilePrompt(file, plan, generated),
        systemInstruction: CODEGEN_SYSTEM_INSTRUCTION,
        context: this.buildContext(file, plan, generated, htmlMeta)
      });

      if (outcome.ok) {
        const content = outcome.content.endsWith('\n') ? outcome.content : `${outcome.content}\n`;
        try {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          assertRealPathInside(root, target);
          writeFileAtomic(target, content);
        } catch (e) {
          results.push({ path: file.path, status: 'failed', reason: `write failed: ${e.message}`, preservedExisting: existed });
          continue;
        }
        generated[file.path] = content;
        if (file.fileType === 'html' && outcome.meta) {
          const primary = this.primaryHtml(plan);
          if (!htmlMeta || (primary && primary.path === file.path)) htmlMeta = outcome.meta;
        }
        results.push({ path: file.path, status: 'written', bytes: Buffer.byteLength(content), corrections: outcome.corrections, warnings: outcome.warnings || [], replaced: existed });
        log(`✅ ${file.path} — valid${outcome.corrections ? ` after ${outcome.corrections} correction(s)` : ' on first attempt'}`, 'green');
      } else if (outcome.error) {
        const err = outcome.error instanceof GeminiError ? outcome.error : new GeminiError(ErrorKind.UNKNOWN, outcome.error.message);
        results.push({ path: file.path, status: 'failed', reason: err.toUserMessage(), error: err, corrections: outcome.corrections, preservedExisting: existed });
        log(`❌ ${file.path} — ${err.toUserMessage()}`, 'red');
        if (!CONTENT_SPECIFIC.has(err.kind)) fatal = err;
      } else {
        results.push({ path: file.path, status: 'failed', reason: `still invalid after ${outcome.corrections} correction(s)`, finalErrors: outcome.finalErrors, corrections: outcome.corrections, preservedExisting: existed });
        log(`❌ ${file.path} — still invalid after ${outcome.corrections} correction(s):\n${formatIssues(outcome.finalErrors).replace(/^/gm, '     ')}`, 'red');
        if (existed) log(`   The existing ${file.path} was left unchanged.`, 'yellow');
      }
    }
    displayProgress(plan.files.length, plan.files.length, 'Done');

    const written = results.filter(r => r.status === 'written');
    if (written.length) {
      for (const dir of plan.directories || []) {
        try { fs.mkdirSync(resolveInside(projectPath, dir), { recursive: true }); } catch (_) { /* invalid dirs were filtered at planning */ }
      }
    } else if (!projectExisted && fs.existsSync(projectPath) && fs.readdirSync(projectPath).length === 0) {
      fs.rmdirSync(projectPath);
    }

    const verification = await this.verifyProject(plan, projectPath, written.map(r => r.path));
    const summary = {
      projectName: plan.projectName,
      projectPath,
      results,
      written: written.length,
      failed: results.filter(r => r.status === 'failed').length,
      skipped: results.filter(r => r.status === 'skipped').length,
      totalCorrections: results.reduce((n, r) => n + (r.corrections || 0), 0),
      verification,
      fatalError: fatal,
      durationMs: Date.now() - started
    };
    summary.ok = summary.written === plan.files.length && verification.ok;
    this.printSummary(summary, plan);
    return summary;
  }

  /** Final verification: re-read what is on disk, re-validate it, and check the file set. */
  async verifyProject(plan, projectPath, writtenPaths) {
    const problems = [];
    const warnings = [];
    if (!fs.existsSync(projectPath)) return { ok: false, problems: ['project directory does not exist'], warnings, unexpected: [] };
    const onDisk = [];
    (function walk(dir, rel) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { onDisk.push(`${r}/`); walk(path.join(dir, entry.name), r); } else onDisk.push(r);
      }
    })(projectPath, '');
    const plannedDirs = new Set((plan.directories || []).map(d => `${d}/`));
    for (const f of plan.files) {
      const parts = f.path.split('/');
      for (let k = 1; k < parts.length; k++) plannedDirs.add(`${parts.slice(0, k).join('/')}/`);
    }
    const planned = new Set(plan.files.map(f => f.path));
    const unexpected = onDisk.filter(p => !planned.has(p) && !plannedDirs.has(p));

    let htmlMeta = null;
    for (const rel of writtenPaths) {
      const content = fs.readFileSync(path.join(projectPath, ...rel.split('/')), 'utf8');
      const file = plan.files.find(f => f.path === rel);
      const ctx = this.buildContext(file, plan, {}, htmlMeta);
      const v = await this.validator({ path: rel, content, context: ctx });
      if (file.fileType === 'html' && v.meta && !htmlMeta) htmlMeta = v.meta;
      if (!v.valid) problems.push(`${rel}: ${formatIssues(v.errors, 3)}`);
      for (const w of v.warnings) warnings.push(`${rel}: ${w.message}`);
    }
    return { ok: problems.length === 0, problems, warnings, unexpected };
  }

  printSummary(summary, plan) {
    log('', 'white');
    log('━'.repeat(60), 'dim');
    if (summary.ok) {
      log(`🎉 PROJECT GENERATED — ${summary.written}/${plan.files.length} files validated and written`, 'green');
    } else {
      log(`⚠️ PROJECT INCOMPLETE — ${summary.written} of ${plan.files.length} files written, ${summary.failed} failed, ${summary.skipped} skipped`, 'yellow');
    }
    log(`📁 Location: ${summary.projectPath}`, 'cyan');
    for (const r of summary.results) {
      if (r.status === 'written') {
        log(`  ✅ ${r.path} (${formatBytes(r.bytes)}${r.corrections ? `, ${r.corrections} AI correction(s)` : ''}${r.replaced ? ', replaced previous file' : ''})`, 'white');
      } else if (r.status === 'failed') {
        log(`  ❌ ${r.path} — ${r.reason.split('\n')[0]}${r.preservedExisting ? ' (existing file preserved)' : ''}`, 'white');
      } else {
        log(`  ⏭️ ${r.path} — skipped (${r.reason})`, 'white');
      }
    }
    if (summary.fatalError) log(`\n${summary.fatalError.toUserMessage()}`, 'yellow');
    if (summary.verification.unexpected.length) log(`ℹ️ Other files already in the folder (not created by this run): ${summary.verification.unexpected.join(', ')}`, 'dim');
    if (summary.verification.problems.length) summary.verification.problems.forEach(p => log(`❌ Verification: ${p}`, 'red'));
    const warnings = summary.verification.warnings;
    if (warnings.length) {
      log('⚠️ Warnings (not blocking):', 'yellow');
      warnings.slice(0, 8).forEach(w => log(`  • ${w}`, 'white'));
    }
    const primary = this.primaryHtml(plan);
    if (summary.written && primary && summary.results.some(r => r.path === primary.path && r.status === 'written')) {
      log(`🌐 Open in a browser: ${path.join(summary.projectPath, ...primary.path.split('/'))}`, 'cyan');
    }
    log('ℹ️ Validation checks syntax, structure and file links; it does not prove the app behaves correctly — try it out.', 'dim');
    log('━'.repeat(60), 'dim');
  }
}

module.exports = FileGenerator;
module.exports.FileGenerator = FileGenerator;
module.exports.isWebProject = isWebProject;
module.exports.CODEGEN_SYSTEM_INSTRUCTION = CODEGEN_SYSTEM_INSTRUCTION;
