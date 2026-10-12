// Planner token-efficiency audit (2026-10-12), finding 2: audit/recovery rules moved out of
// PLANNER.md into an overlay that plannerPrompt only names for an audit or recovery card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plannerPrompt } from './lib/prompt.mjs'

const card = (extra = {}) => ({ id: 'T-1', category: 'ui', column: 'planning', path: 'nope.md', ...extra })

test('plannerPrompt names the audit/recovery overlay only for an audit or recovery card', () => {
  const plain = plannerPrompt({ cards: [card()], projectPath: '.', boardRoot: '.', tasksDir: '.' })
  assert.doesNotMatch(plain, /PLANNER-AUDIT-RECOVERY\.md/)

  const audited = plannerPrompt({ cards: [card({ audit: 'yes' })], projectPath: '.', boardRoot: '.', tasksDir: '.' })
  assert.match(audited, /PLANNER-AUDIT-RECOVERY\.md/)

  const recovery = plannerPrompt({ cards: [card({ buildAttempts: 1 })], projectPath: '.', boardRoot: '.', tasksDir: '.' })
  assert.match(recovery, /PLANNER-AUDIT-RECOVERY\.md/)
})
