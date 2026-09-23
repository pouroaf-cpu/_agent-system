import test from 'node:test'
import assert from 'node:assert/strict'
import { compact } from './migrate-current-cards.mjs'
import { recoveryState } from '../lib/recovery.mjs'
import { currentReviewDecision } from '../lib/cards.mjs'

test('migration preserves current requirements, trailing counters, verdict reset and latest failure', () => {
  const source = `# T-7 — Example\n**Workflow:** card-owned\n\n## Approved brief\nNo deployment.\n\n## Files\n\n## Acceptance criteria\nMissing plan remains unresolved.\n\n## Reviewer evidence\nObserved check.\n**Review verdict:** PASS\n\n**Build attempt** first\n\n**Review feedback** first\n\nOld launch failure ${'duplicated prompt '.repeat(35)} **Review feedback** quoted\n\n---\n\n**Build attempt** second\n\n**Review feedback** second\n\nCurrent failure: evidence unavailable; no retry authorized.\n\n**Recovery:** {"returns":2,"attempt":"second","counted":"second"}\n`
  const next = compact(source,'C:/tasks/.history/T-7.jsonl','abc')
  assert.ok(next.length < source.length)
  assert.equal(compact(next,'ignored','ignored'),next)
  assert.equal((next.match(/\*\*Review feedback\*\*/g)||[]).length,(source.match(/\*\*Review feedback\*\*/g)||[]).length)
  assert.deepEqual(recoveryState(next),recoveryState(source))
  assert.deepEqual(currentReviewDecision(next),currentReviewDecision(source))
  assert.equal(currentReviewDecision(next),null)
  assert.ok(next.includes('## Files\n\n## Acceptance criteria\nMissing plan remains unresolved.'))
  assert.ok(next.includes('Current failure: evidence unavailable; no retry authorized.'))
  assert.ok(!next.includes('**Workflow version:** 2'))
  assert.ok(next.includes('No new plan approval or retry authorization.'))
})
