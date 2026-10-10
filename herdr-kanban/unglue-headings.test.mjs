import test from 'node:test'
import assert from 'node:assert/strict'
import { unglueHeadings, emptySectionError } from './lib/cards.mjs'

test('a heading glued to the previous line gets its newline back (I996)', () => {
  const glued = '## Implementation\nStage: builder, Blocker: none## Evidence\nStage: builder, Blocker: none## Reviewer evidence\n<!-- x -->\n'
  const fixed = unglueHeadings(glued)
  assert.match(fixed, /^## Evidence$/m)
  assert.match(fixed, /^## Reviewer evidence$/m)
  assert.equal(unglueHeadings(fixed), fixed)
  assert.equal(unglueHeadings('see ## Notes inline\n'), 'see ## Notes inline\n')
})

test('empty section errors point to the first section and mention a later duplicate when present', () => {
  const duplicate = '## Evidence\n<!-- placeholder -->\n## Evidence\nPASS\n'
  const single = '## Evidence\n<!-- placeholder -->\n'
  const duplicateError = emptySectionError('done', 'Evidence', duplicate)
  const singleError = emptySectionError('done', 'Evidence', single)
  assert.match(duplicateError, /first ## Evidence section on the card is empty/)
  assert.match(duplicateError, /later ## Evidence heading is not read and must be moved under the first one/)
  assert.match(duplicateError, /Replace the comment under that existing heading/)
  assert.match(duplicateError, /full logs belong in linked evidence files/i)
  assert.doesNotMatch(singleError, /later ## Evidence heading/)
})
