// Strict yes/no parsing for plan approval. Anything else is "invalid" and must be re-asked.

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

/** @returns {'yes'|'no'|'invalid'} */
function parseConfirmation(answer) {
  if (answer === null || answer === undefined) return 'invalid';
  const normalized = String(answer).trim().toLowerCase();
  if (YES.has(normalized)) return 'yes';
  if (NO.has(normalized)) return 'no';
  return 'invalid';
}

module.exports = { parseConfirmation };
