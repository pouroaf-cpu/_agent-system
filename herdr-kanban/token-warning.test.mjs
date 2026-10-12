import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWorkflowLimits, tokenWarnings } from './lib/workflow-limits.mjs'
import { createCard } from './lib/cards.mjs'

// Audit 2026-10-12 finding 10: board.config.json has no card size/spend warning, so a card
// as large as the week's worst Planner run ($48.56, 338k tokens of peak context) is never
// flagged. maxTokensPerCard exists but holds the card once reached (stall-watchdog sends a
// workflow-limit hold straight to Owner), which the audit says a warning must not do. This
// checks the new warn-only reader instead of that hold path.
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'token-warning-'))
  const tasks = join(root, 'Proof', 'TASKS'); mkdirSync(tasks, { recursive: true })
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ port: 18780, projectsRoot: root, projects: ['Proof'], maxConcurrentAgents: 10, models: { working: 'test' }, agentPollMs: 600000 }))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  return { root, tasks, config }
}

test('AC1: a card past the warn threshold is named with its total, and AC2: it is not held', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'big card', brief: 'do the thing' })
  writeFileSync(join(f.tasks, '.request-usage.json'), JSON.stringify({
    version: 1,
    runs: {
      one: { cardIds: [card.id], role: 'planner', delta: { total: 300000 }, start: { at: new Date().toISOString() } },
      two: { cardIds: [card.id], role: 'planner', delta: { total: 100000 }, start: { at: new Date().toISOString() } },
    },
  }))
  // No warnTokensPerCard configured yet: nothing to report.
  assert.deepEqual(tokenWarnings(f.tasks), [])

  const config = JSON.parse(readFileSync(f.config)); config.workflowLimits = { warnTokensPerCard: 375000 }
  writeFileSync(f.config, JSON.stringify(config))

  const warnings = tokenWarnings(f.tasks)
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].id, card.id)
  assert.equal(warnings[0].total, 400000)
  assert.equal(warnings[0].threshold, 375000)
  // Only cards still on the board are named: an archived card is not (616 inbox lines, 2026-10-12).
  assert.equal(tokenWarnings(f.tasks, new Set([card.id])).length, 1)
  assert.deepEqual(tokenWarnings(f.tasks, new Set()), [])
  // maxTokensPerCard was never set, so dispatch is still unheld (AC2).
  assert.equal(checkWorkflowLimits(f.tasks, card.id, 'planner'), null)
})

test('a card below the threshold is not reported', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'small card', brief: 'do the thing' })
  writeFileSync(join(f.tasks, '.request-usage.json'), JSON.stringify({
    version: 1,
    runs: { one: { cardIds: [card.id], role: 'planner', delta: { total: 1000 }, start: { at: new Date().toISOString() } } },
  }))
  const config = JSON.parse(readFileSync(f.config)); config.workflowLimits = { warnTokensPerCard: 375000 }
  writeFileSync(f.config, JSON.stringify(config))
  assert.deepEqual(tokenWarnings(f.tasks), [])
})
