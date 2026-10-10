import test from 'node:test'
import assert from 'node:assert/strict'
import { unglueHeadings } from './lib/cards.mjs'

test('a heading glued to the previous line gets its newline back (I996)', () => {
  const glued = '## Implementation\nStage: builder, Blocker: none## Evidence\nStage: builder, Blocker: none## Reviewer evidence\n<!-- x -->\n'
  const fixed = unglueHeadings(glued)
  assert.match(fixed, /^## Evidence$/m)
  assert.match(fixed, /^## Reviewer evidence$/m)
  assert.equal(unglueHeadings(fixed), fixed)
  assert.equal(unglueHeadings('see ## Notes inline\n'), 'see ## Notes inline\n')
})
