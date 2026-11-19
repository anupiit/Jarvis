// Short, meaningful, Windows-safe project directory names.
// The previous implementation used a slug of the entire prompt (e.g. "a-project-that-manage-my-day-").

const MAX_NAME_LENGTH = 50;
const DEFAULT_NAME = 'jarvis-project';
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const FILLER = new Set([
  'create', 'build', 'make', 'generate', 'develop', 'write', 'code', 'design', 'implement', 'produce',
  'please', 'can', 'could', 'you', 'me', 'i', 'want', 'need', 'would', 'like', 'to', 'a', 'an', 'the',
  'simple', 'basic', 'modern', 'responsive', 'beautiful', 'nice', 'cool', 'small', 'new', 'interactive',
  'minimal', 'minimalist', 'clean', 'fully', 'functional', 'complete', 'professional', 'sleek', 'elegant',
  'awesome', 'great', 'good', 'quick', 'tiny', 'fancy', 'stylish', 'lightweight', 'single', 'one',
  'project', 'that', 'which', 'will', 'should', 'is', 'some', 'kind', 'of', 'very', 'really', 'super',
  'and', 'or', 'it', 'this', 'something'
]);

// Words that typically end the "what is it" noun phrase.
const ANCHORS = new Set([
  'app', 'website', 'site', 'webpage', 'page', 'game', 'dashboard', 'tracker', 'calculator', 'timer',
  'stopwatch', 'clock', 'planner', 'manager', 'editor', 'player', 'portfolio', 'blog', 'store', 'shop',
  'quiz', 'chatbot', 'server', 'api', 'cli', 'tool', 'generator', 'converter', 'viewer', 'gallery',
  'form', 'board', 'list', 'notes', 'journal', 'organizer', 'scheduler', 'counter', 'recorder',
  'translator', 'scraper', 'bot', 'extension', 'widget', 'library', 'landing', 'wiki', 'forum', 'shell'
]);

const CLAUSE_BREAK = /\s(?:using|with|that|which|where|so that|to help|in|on|for|including|featuring|built|written|powered|based|where)\s|[,;:(]/i;

function sanitizeProjectName(raw, maxLen = MAX_NAME_LENGTH) {
  let s = String(raw || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > maxLen) {
    s = s.slice(0, maxLen);
    const cut = s.lastIndexOf('-');
    if (cut >= Math.floor(maxLen / 3)) s = s.slice(0, cut);
    s = s.replace(/-+$/g, '');
  }
  if (!s) s = DEFAULT_NAME;
  if (WINDOWS_RESERVED.test(s)) s = `${s}-project`;
  return s;
}

function normalizeWords(text) {
  const words = String(text)
    .toLowerCase()
    .replace(/\bto[\s-]+do(?:s)?\b/g, 'todo')
    .replace(/\bweb[\s-]+(app|application|page)s?\b/g, '$1')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(w => (w === 'application' || w === 'applications' || w === 'apps' ? 'app' : w));
  return words;
}

function meaningful(words) {
  return words.filter(w => !FILLER.has(w));
}

/** Explicit "called X" / "named X" in the request. */
function extractExplicitName(description) {
  const m = /\b(?:called|named|titled)\s+["“'`]?([A-Za-z0-9][\w\s-]{0,40}?)["”'`]?(?=$|[.,;:!?]|\s+(?:using|with|that|which|in|for|and)\b)/i.exec(String(description || ''));
  return m ? m[1].trim() : null;
}

/**
 * Deterministic name from the request: the noun phrase before the first clause break,
 * ending at the last "anchor" word (app, tracker, dashboard, ...).
 * @returns {{ name: string|null, anchored: boolean }}
 */
function deriveNameFromDescription(description) {
  const firstSentence = String(description || '').split(/[.!?\n]/).map(s => s.trim()).find(Boolean) || '';
  const head = firstSentence.split(CLAUSE_BREAK)[0];
  const headWords = meaningful(normalizeWords(head));
  let lastAnchor = -1;
  headWords.forEach((w, i) => { if (ANCHORS.has(w)) lastAnchor = i; });
  if (lastAnchor >= 0) {
    const nonAnchorCount = headWords.slice(0, lastAnchor + 1).filter(w => !ANCHORS.has(w)).length;
    const picked = headWords.slice(Math.max(0, lastAnchor - 3), lastAnchor + 1);
    if (nonAnchorCount > 0 || picked.length > 1) return { name: sanitizeProjectName(picked.join('-')), anchored: true };
  }
  const allWords = meaningful(normalizeWords(firstSentence));
  if (allWords.length) return { name: sanitizeProjectName(allWords.slice(0, 4).join('-')), anchored: false };
  return { name: null, anchored: false };
}

function isReasonableAiName(name) {
  if (!name || typeof name !== 'string') return false;
  const slug = sanitizeProjectName(name);
  const words = slug.split('-');
  return slug !== DEFAULT_NAME && words.length >= 1 && words.length <= 5 && slug.length <= 40;
}

/**
 * Choose the project directory name.
 * Priority: explicit "called X" → anchored deterministic phrase → AI-proposed name → first words → default.
 */
function chooseProjectName(description, aiName) {
  const explicit = extractExplicitName(description);
  if (explicit) return sanitizeProjectName(explicit);
  const derived = deriveNameFromDescription(description);
  if (derived.anchored && derived.name) return derived.name;
  if (isReasonableAiName(aiName)) return sanitizeProjectName(aiName);
  return derived.name || DEFAULT_NAME;
}

module.exports = {
  MAX_NAME_LENGTH,
  DEFAULT_NAME,
  sanitizeProjectName,
  deriveNameFromDescription,
  extractExplicitName,
  chooseProjectName,
  isReasonableAiName
};
