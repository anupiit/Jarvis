const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const { getDefaultEngine } = require('../services/geminiService');
const { GeminiError } = require('../services/geminiErrors');
const { parseRequirements } = require('./RequirementParser');
const { chooseProjectName } = require('../utils/projectNaming');
const { validateRelativePath, resolveInside } = require('../utils/safePath');
const { log } = require('../utils/logger');

const TEXT_FILE_TYPES = {
  html: 'html', htm: 'html', css: 'css', scss: 'css', less: 'css',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown', txt: 'text',
  svg: 'svg', xml: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'toml', py: 'python',
  sh: 'shell', java: 'java', go: 'go', rb: 'ruby', php: 'php', gitignore: 'text', env: 'text'
};

function fileTypeFor(filePath) {
  const base = filePath.split('/').pop().toLowerCase();
  if (base === '.gitignore') return 'text';
  const ext = base.includes('.') ? base.split('.').pop() : '';
  return TEXT_FILE_TYPES[ext] || null;
}

const PLANNER_SYSTEM_INSTRUCTION = 'You are a senior software architect. You produce minimal, correct project blueprints as strict JSON. You never add files, folders, dependencies or technologies the user did not ask for or that are not strictly necessary.';

function buildPlanningPrompt(description, reqs) {
  const constraints = [];
  if (reqs.explicitFiles.length) {
    constraints.push(`- Files named by the user (use these exact names and paths): ${reqs.explicitFiles.join(', ')}`);
    if (reqs.exactFiles) constraints.push('- The user requires EXACTLY these files and no others.');
  }
  if (reqs.techStack.length) constraints.push(`- Requested technologies: ${reqs.techStack.join(', ')}${reqs.vanilla ? ' (vanilla, no frameworks)' : ''}`);
  if (reqs.forbiddenTerms.length) constraints.push(`- Forbidden (do not use): ${reqs.forbiddenTerms.join(', ')}`);
  if (reqs.noAdditionalFolders) constraints.push('- Do not create folders.');
  if (reqs.noExternalLibraries) constraints.push('- No external libraries, CDNs or packages.');

  return `Create a project blueprint for this request.

USER REQUEST:
"""
${description}
"""

HARD CONSTRAINTS (must be respected):
${constraints.length ? constraints.join('\n') : '- none detected'}

Return ONLY a JSON object with exactly this shape:
{
  "projectName": "short-kebab-case-name (2-4 words, at most 40 characters)",
  "title": "Human readable title",
  "description": "One or two sentences describing the project",
  "features": ["feature", "..."],
  "techStack": ["technology", "..."],
  "files": [{ "path": "relative/path/with.extension", "description": "what this file contains" }],
  "directories": ["relative/dir"],
  "dependencies": [],
  "architecture": "How the files work together"
}

Rules:
- Paths are relative, use forward slashes, never absolute, never "..".
- Only list text source files that you can write in full (no images, fonts or other binaries).
- Keep the project minimal. Do not add package.json, README.md, configuration files, build tools, folders or dependencies unless the request needs them.
- "directories" lists only folders that must exist; folders implied by file paths are created automatically.`;
}

/** Extract and parse the JSON object from a model response. */
function parseBlueprintJson(text) {
  let s = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('No JSON object found in the planning response');
  const obj = JSON.parse(s.slice(start, end + 1));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('Planning response is not a JSON object');
  return obj;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map(v => (typeof v === 'string' ? v : (v && (v.name || v.title || v.feature)) || ''))
    .map(v => String(v).trim())
    .filter(Boolean)
    .slice(0, 30);
}

/**
 * Turn an AI blueprint (or null) into a validated plan that respects the user's hard requirements.
 * Every change made to the AI proposal is recorded in plan.adjustments and shown before approval.
 */
function normalizeBlueprint(ai, reqs, description, { source = 'ai', fallbackReason = null } = {}) {
  const adjustments = [];
  const raw = ai || {};

  // ---- files -------------------------------------------------------------
  const proposed = [];
  const rawFiles = Array.isArray(raw.files) ? raw.files : [];
  // Legacy shape: fileStructure: [{ name, type: 'file'|'directory', ... }]
  const legacy = Array.isArray(raw.fileStructure) ? raw.fileStructure : [];
  for (const f of [...rawFiles, ...legacy.filter(x => x && x.type !== 'directory')]) {
    const p = typeof f === 'string' ? f : (f && (f.path || f.name));
    if (!p) continue;
    proposed.push({ path: String(p), description: (f && f.description) ? String(f.description) : '' });
  }
  const proposedDirs = [
    ...asStringArray(raw.directories),
    ...legacy.filter(x => x && x.type === 'directory').map(x => String(x.name || ''))
  ].filter(Boolean);

  let files = [];
  const seen = new Set();
  for (const f of proposed) {
    const check = validateRelativePath(f.path);
    if (!check.ok) { adjustments.push(`Removed unsafe path "${f.path}" (${check.reason}).`); continue; }
    const key = check.normalized.toLowerCase();
    if (seen.has(key)) continue;
    if (!fileTypeFor(check.normalized)) { adjustments.push(`Removed "${check.normalized}" (binary or unsupported file type).`); continue; }
    seen.add(key);
    files.push({ path: check.normalized, fileType: fileTypeFor(check.normalized), description: f.description });
  }

  if (reqs.exactFiles) {
    const wanted = reqs.explicitFiles.map(p => validateRelativePath(p)).filter(c => c.ok).map(c => c.normalized);
    const removed = files.filter(f => !wanted.some(w => w.toLowerCase() === f.path.toLowerCase())).map(f => f.path);
    if (removed.length) adjustments.push(`Removed ${removed.map(r => `"${r}"`).join(', ')} — you asked for exactly ${wanted.length} file(s).`);
    files = wanted.map(w => {
      const fromAi = files.find(f => f.path.toLowerCase() === w.toLowerCase());
      return { path: w, fileType: fileTypeFor(w), description: fromAi ? fromAi.description : '' };
    });
  } else {
    for (const w of reqs.explicitFiles) {
      const check = validateRelativePath(w);
      if (check.ok && fileTypeFor(check.normalized) && !files.some(f => f.path.toLowerCase() === check.normalized.toLowerCase())) {
        files.push({ path: check.normalized, fileType: fileTypeFor(check.normalized), description: '' });
        adjustments.push(`Added "${check.normalized}" — you named it in the request.`);
      }
    }
  }

  let directories = [];
  for (const d of proposedDirs) {
    const check = validateRelativePath(d);
    if (check.ok && !directories.includes(check.normalized)) directories.push(check.normalized);
  }

  if (reqs.noAdditionalFolders) {
    const nested = files.filter(f => f.path.includes('/') && !reqs.explicitFiles.includes(f.path));
    if (nested.length) {
      adjustments.push(`Removed ${nested.map(f => `"${f.path}"`).join(', ')} — you asked for no additional folders.`);
      files = files.filter(f => !nested.includes(f));
    }
    if (directories.length) adjustments.push(`Removed folder(s) ${directories.map(d => `"${d}/"`).join(', ')} — you asked for no additional folders.`);
    directories = [];
  } else if (reqs.exactFiles && directories.length) {
    adjustments.push(`Removed folder(s) ${directories.map(d => `"${d}/"`).join(', ')} — not part of the exact file list.`);
    directories = [];
  }

  if (files.length > config.MAX_PLANNED_FILES) {
    adjustments.push(`Limited the plan to the first ${config.MAX_PLANNED_FILES} files.`);
    files = files.slice(0, config.MAX_PLANNED_FILES);
  }

  if (!files.length) {
    const defaults = ['index.html', 'style.css', 'script.js'];
    files = defaults.map(p => ({ path: p, fileType: fileTypeFor(p), description: '' }));
    adjustments.push('No usable files were proposed; using a minimal HTML/CSS/JavaScript structure.');
  }

  // Order: HTML first, then CSS, then JavaScript, then the rest — later files get earlier ones as context.
  const rank = (f) => ({ html: 0, css: 1, javascript: 2 }[f.fileType] ?? 3);
  files.sort((a, b) => rank(a) - rank(b));

  for (const f of files) {
    if (!f.description) {
      f.description = ({ html: 'Page structure and markup', css: 'Styles and responsive layout', javascript: 'Application logic and interactivity', json: 'Configuration / data', markdown: 'Documentation' })[f.fileType] || 'Project file';
    }
  }

  // ---- stack / dependencies ------------------------------------------------
  let techStack = asStringArray(raw.techStack);
  const forbiddenStack = techStack.filter(t => reqs.forbiddenCategories.some(cat => t.toLowerCase().replace(/[.\s]/g, '').includes(cat.replace(/-.*/, ''))));
  if (forbiddenStack.length) {
    adjustments.push(`Removed forbidden technolog${forbiddenStack.length > 1 ? 'ies' : 'y'} from the stack: ${forbiddenStack.join(', ')}.`);
    techStack = techStack.filter(t => !forbiddenStack.includes(t));
  }
  const userStack = reqs.techStack.filter(t => t !== 'localstorage');
  if (userStack.length) {
    const label = { html: 'HTML', css: 'CSS', javascript: reqs.vanilla ? 'Vanilla JavaScript' : 'JavaScript' };
    techStack = userStack.map(t => label[t] || t);
  }
  if (!techStack.length) techStack = [...new Set(files.map(f => f.fileType))];

  let dependencies = asStringArray(raw.dependencies);
  if (dependencies.length && reqs.noExternalLibraries) {
    adjustments.push(`Removed dependencies ${dependencies.join(', ')} — you asked for no external libraries.`);
    dependencies = [];
  }

  // ---- naming --------------------------------------------------------------
  const projectName = chooseProjectName(description, raw.projectName);

  const features = asStringArray(raw.features).length ? asStringArray(raw.features) : (reqs.features.length ? reqs.features : ['Core functionality described in the request']);

  return {
    projectName,
    title: typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : projectName,
    description: typeof raw.description === 'string' && raw.description.trim() ? raw.description.trim() : description,
    request: description,
    features,
    techStack,
    files,
    directories,
    dependencies,
    architecture: typeof raw.architecture === 'string' && raw.architecture.trim() ? raw.architecture.trim() : 'Files are linked by relative paths; no build step is required.',
    requirements: reqs,
    adjustments: [...reqs.warnings, ...adjustments],
    source,
    fallbackReason,
    // Back-compat view used by older callers
    get fileStructure() {
      return [
        ...this.directories.map(d => ({ name: d, type: 'directory', description: 'Folder' })),
        ...this.files.map(f => ({ name: f.path, type: 'file', fileType: f.fileType, description: f.description }))
      ];
    }
  };
}

class ProjectPlanner {
  constructor({ engine, projectsRoot } = {}) {
    this.engine = engine || null;
    this.projectsRoot = projectsRoot || config.PROJECTS_ROOT;
    this.currentProject = null;
  }

  getEngine() {
    return this.engine || getDefaultEngine();
  }

  /**
   * Build a plan. Gemini failures are re-thrown (the caller shows the diagnostic; nothing is written).
   * An unparseable AI answer falls back to a deterministic plan that is clearly labelled.
   */
  async createProjectPlan(description) {
    log('\n🧠 Planning: understanding the request...', 'magenta');
    const reqs = parseRequirements(description);
    let ai = null;
    let source = 'ai';
    let fallbackReason = null;
    try {
      const res = await this.getEngine().generate(buildPlanningPrompt(description, reqs), {
        systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        maxOutputTokens: 8192
      });
      ai = parseBlueprintJson(res.text);
    } catch (error) {
      if (error instanceof GeminiError) throw error;
      source = 'fallback';
      fallbackReason = `the AI blueprint could not be parsed (${error.message})`;
    }
    const plan = normalizeBlueprint(ai, reqs, description, { source, fallbackReason });
    plan.projectPath = resolveInside(this.projectsRoot, plan.projectName);
    plan.projectsRoot = this.projectsRoot;
    plan.existingFiles = plan.files.filter(f => fs.existsSync(path.join(plan.projectPath, ...f.path.split('/')))).map(f => f.path);
    plan.directoryExists = fs.existsSync(plan.projectPath);
    this.currentProject = plan;
    this.displayPlan(plan);
    return plan;
  }

  displayPlan(plan = this.currentProject) {
    log('\n📋 PROJECT PLAN', 'green');
    log('━'.repeat(60), 'dim');
    if (plan.source === 'fallback') log(`⚠️ Using a deterministic fallback plan: ${plan.fallbackReason}`, 'yellow');
    log(`📁 Project:   ${plan.title} (${plan.projectName})`, 'bright');
    log(`📍 Location:  ${plan.projectPath}`, 'white');
    if (plan.directoryExists) log('   (folder already exists — files listed below as "replace" are overwritten only by validated output)', 'yellow');
    log(`📝 Purpose:   ${plan.description}`, 'white');

    log('\n✨ Features:', 'cyan');
    plan.features.forEach(feature => log(`  • ${feature}`, 'white'));

    log('\n🛠️ Tech stack:', 'yellow');
    plan.techStack.forEach(tech => log(`  • ${tech}`, 'white'));

    log(`\n📂 Files to write (${plan.files.length}) — nothing else will be created:`, 'blue');
    log(`  ${plan.projectName}/`, 'white');
    plan.directories.forEach(d => log(`  ├── ${d}/`, 'white'));
    plan.files.forEach((f, i) => {
      const branch = i === plan.files.length - 1 ? '└──' : '├──';
      const mark = plan.existingFiles && plan.existingFiles.includes(f.path) ? '  [replace]' : '';
      log(`  ${branch} ${f.path}${mark} — ${f.description}`, 'white');
    });

    if (plan.dependencies.length) {
      log('\n📦 Dependencies (not installed automatically):', 'magenta');
      plan.dependencies.forEach(dep => log(`  • ${dep}`, 'white'));
    }
    if (plan.adjustments.length) {
      log('\n🔧 Adjusted to match your request:', 'yellow');
      plan.adjustments.forEach(a => log(`  • ${a}`, 'white'));
    }
    log(`\n🏗️ Architecture: ${plan.architecture}`, 'green');
    log(`🔍 Each file is validated before it is written; invalid output gets up to ${config.MAX_CORRECTION_ATTEMPTS} AI correction attempts.`, 'dim');
    log('━'.repeat(60), 'dim');
  }
}

module.exports = ProjectPlanner;
module.exports.ProjectPlanner = ProjectPlanner;
module.exports.normalizeBlueprint = normalizeBlueprint;
module.exports.parseBlueprintJson = parseBlueprintJson;
module.exports.buildPlanningPrompt = buildPlanningPrompt;
module.exports.fileTypeFor = fileTypeFor;
