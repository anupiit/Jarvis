const test = require('node:test');
const assert = require('node:assert/strict');
const { parseConfirmation } = require('../utils/confirm');

test('y / yes approve in any case, with surrounding whitespace', () => {
  for (const a of ['y', 'yes', 'Y', 'YES', 'Yes', ' y ', '\tyes\r']) assert.equal(parseConfirmation(a), 'yes', JSON.stringify(a));
});

test('n / no cancel in any case', () => {
  for (const a of ['n', 'no', 'N', 'NO', 'No', ' n ']) assert.equal(parseConfirmation(a), 'no', JSON.stringify(a));
});

test('anything else is invalid and must be re-asked (no accidental approval)', () => {
  for (const a of ['', ' ', 'yellow', 'yess', 'yeah', 'nope', 'ok', 'sure', 'y n', '1', null, undefined]) {
    assert.equal(parseConfirmation(a), 'invalid', JSON.stringify(a));
  }
});
