// Deterministic extraction of hard requirements from a natural-language request.
// The AI blueprint is later checked against these so explicit user instructions win.

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// "<name>.js" tokens that are technologies, not files.
const TECH_JS_NAMES = new Set([
  'node', 'nodejs', 'vue', 'next', 'nuxt', 'express', 'three', 'chart', 'd3', 'react', 'angular', 'ember',
  'backbone', 'p5', 'anime', 'moment', 'alpine', 'nest', 'electron', 'knockout', 'jquery', 'svelte',
  'socket', 'deno', 'solid', 'preact', 'mithril', 'meteor', 'handlebars', 'mustache', 'tensorflow', 'pixi', 'phaser'
]);

const FILE_PATTERN = /(?<![\w./\\-])((?:[\w-]+\/)*[\w-]+\.(?:html?|css|scss|less|m?js|cjs|jsx|tsx?|json|md|txt|svg|py|java|go|rb|php|sh|ya?ml|toml|xml))(?![\w-])/gi;

const TECH_PATTERNS = [
  ['html', /\bhtml5?\b/i],
  ['css', /\bcss3?\b/i],
  ['javascript', /\b(?:java\s?script|js|es6|ecmascript)\b/i],
  ['typescript', /\btype\s?script\b/i],
  ['react', /\breact(?:\.js|js)?\b/i],
  ['vue', /\bvue(?:\.js|js)?\b/i],
  ['angular', /\bangular\b/i],
  ['svelte', /\bsvelte\b/i],
  ['node', /\bnode(?:\.js|js)?\b/i],
  ['express', /\bexpress(?:\.js|js)?\b/i],
  ['python', /\bpython\b/i],
  ['flask', /\bflask\b/i],
  ['django', /\bdjango\b/i],
  ['tailwind', /\btailwind\b/i],
  ['bootstrap', /\bbootstrap\b/i],
  ['localstorage', /\blocal\s?storage\b/i]
];

// Normalized forbidden categories that the validator can enforce.
const FORBIDDEN_CATEGORIES = [
  ['react', /\breact\b/i],
  ['vue', /\bvue\b/i],
  ['angular', /\bangular\b/i],
  ['node', /\bnode(?:\.js|js)?\b/i],
  ['typescript', /\btypescript\b/i],
  ['jquery', /\bjquery\b/i],
  ['bootstrap', /\bbootstrap\b/i],
  ['tailwind', /\btailwind\b/i],
  ['external-libraries', /\b(?:external|third[- ]party)?\s*(?:libraries|library|frameworks?|cdns?|packages|dependencies)\b/i],
  ['database', /\bdatabases?\b|\bdb\b|\bsql\b|\bmongo/i],
  ['network-apis', /\bapis?\b|\bbackend\b|\bserver\b|\bfetch\b|\bnetwork\b/i],
  ['folders', /\b(?:additional|extra|other|sub)?\s*(?:folders?|directories|subfolders?|subdirectories)\b/i],
  ['build-tools', /\bbuild tools?\b|\bwebpack\b|\bvite\b|\bbundlers?\b|\bnpm\b/i]
];

const NEGATION = /\b(?:do not|don't|dont|never|must not|mustn't|should not|shouldn't|without|avoid|no)\b/i;

function splitList(text, { stripVerbs = false } = {}) {
  return text
    .split(/,|;|\bor\b|\band\b|\bnor\b|\//i)
    .map(s => (stripVerbs ? s.trim().replace(/^(?:use|using|include|including|add|adding|any|rely on|need|needing|other)\s+/i, '') : s).trim())
    .filter(s => s && s.length <= 60);
}

function extractFiles(text) {
  const files = [];
  let m;
  FILE_PATTERN.lastIndex = 0;
  while ((m = FILE_PATTERN.exec(text)) !== null) {
    const file = m[1].replace(/\\/g, '/');
    const base = file.split('/').pop();
    const stem = base.replace(/\.[^.]+$/, '').toLowerCase();
    const ext = base.split('.').pop().toLowerCase();
    if (ext === 'js' && TECH_JS_NAMES.has(stem)) continue;
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

function extractForbidden(text) {
  const clauses = [];
  const sentences = text.split(/(?<=[.!?])\s+|\n+/);
  for (const sentence of sentences) {
    const idx = sentence.search(NEGATION);
    if (idx === -1) continue;
    const clause = sentence.slice(idx).replace(NEGATION, '').replace(/[.!?]+$/, '').trim();
    if (clause) clauses.push(clause);
  }
  const terms = [];
  for (const clause of clauses) {
    for (const item of splitList(clause, { stripVerbs: true })) if (!terms.includes(item.toLowerCase())) terms.push(item.toLowerCase());
  }
  const categories = new Set();
  for (const term of terms) {
    for (const [cat, re] of FORBIDDEN_CATEGORIES) if (re.test(term)) categories.add(cat);
  }
  return { clauses, terms, categories: [...categories] };
}

function extractFeatures(text) {
  const m = /(?:allows?|lets?|enables?)\s+(?:users?|the user|people|me|you)\s+to\s+([^.]+)|users?\s+(?:can|should be able to|must be able to)\s+([^.]+)|features?\s*:\s*([^.]+)/i.exec(text);
  if (!m) return [];
  const list = (m[1] || m[2] || m[3] || '');
  return splitList(list)
    .map(s => s.replace(/^(?:also|then)\s+/i, ''))
    .filter(s => s.split(/\s+/).length <= 10)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1));
}

function extractExpectedCount(text) {
  const m = /\bexactly\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+)?files?\b/i.exec(text)
    || /\b(?:only|just)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:\w+\s+)?files?\b/i.exec(text);
  if (!m) return null;
  const v = m[1].toLowerCase();
  return NUMBER_WORDS[v] || parseInt(v, 10) || null;
}

/**
 * @param {string} text natural-language request
 */
function parseRequirements(text) {
  const original = String(text || '').trim();
  const explicitFiles = extractFiles(original);
  const expectedFileCount = extractExpectedCount(original);
  const exactWording = /\bexactly\b[^.]{0,80}\bfiles?\b|\bonly\s+(?:these|the following|those)\b[^.]{0,40}\bfiles?\b|\bno (?:other|additional|extra) files\b|\b(?:do not|don't)\s+(?:create|add|generate|include)\s+(?:any\s+)?(?:other|additional|extra) files\b/i.test(original);
  const exactFiles = explicitFiles.length > 0 && (exactWording || expectedFileCount !== null);
  const forbidden = extractForbidden(original);

  // Detect requested technologies outside negated clauses.
  let positiveText = original;
  for (const clause of forbidden.clauses) positiveText = positiveText.split(clause).join(' ');
  const techStack = TECH_PATTERNS.filter(([, re]) => re.test(positiveText)).map(([name]) => name);
  for (const f of explicitFiles) {
    const ext = f.split('.').pop().toLowerCase();
    if (/^html?$/.test(ext) && !techStack.includes('html')) techStack.push('html');
    if (ext === 'css' && !techStack.includes('css')) techStack.push('css');
    if (/^(m?js|cjs)$/.test(ext) && !techStack.includes('javascript')) techStack.push('javascript');
  }
  const vanilla = /\bvanilla\b|\bplain (?:html|css|java\s?script|js)\b|\bno frameworks?\b/i.test(original);

  const warnings = [];
  if (expectedFileCount !== null && explicitFiles.length && expectedFileCount !== explicitFiles.length) {
    warnings.push(`The request says ${expectedFileCount} files but names ${explicitFiles.length} (${explicitFiles.join(', ')}). The named files are used.`);
  }

  return {
    original,
    explicitFiles,
    exactFiles,
    expectedFileCount,
    techStack,
    vanilla,
    forbiddenTerms: forbidden.terms,
    forbiddenCategories: forbidden.categories,
    noExternalLibraries: forbidden.categories.includes('external-libraries') || vanilla,
    noAdditionalFolders: forbidden.categories.includes('folders'),
    features: extractFeatures(original),
    warnings
  };
}

module.exports = { parseRequirements, extractFiles, extractForbidden, extractFeatures };
