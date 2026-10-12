import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Own temp board root and config, set before any lib import, so the block file written here
// never leaks into another test file.
const root = mkdtempSync(join(tmpdir(), 'engine-rejection-'))
writeFileSync(join(root, 'board.config.json'), '{}')
process.env.KANBAN_CONFIG = join(root, 'board.config.json')
process.on('exit', () => rmSync(root, { recursive: true, force: true }))

const { usageLimit, readQuota, quotaHold } = await import('./lib/quota.mjs')
const { routeBuilderNoHandoff } = await import('./lib/autospawn.mjs')
const { moveCard } = await import('./lib/cards.mjs')
const { readWorkflow } = await import('./lib/workflow-state.mjs')

// The Codex 400 as the finished-output log holds it: the error event, then turn.failed.
const inner = JSON.stringify({ type: 'error', status: 400, error: { type: 'invalid_request_error', message: "The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." } })
const evidence = ['{"type":"turn.started"}', JSON.stringify({ type: 'error', message: inner }), JSON.stringify({ type: 'turn.failed', error: { message: inner } })].join('\n')
const now = Date.parse('2026-10-12T20:38:00Z')

test('usageLimit reads an engine model rejection as a model-level hold (AC1)', () => {
  const limit = usageLimit(evidence, now)
  assert.ok(limit)
  assert.equal(limit.modelCap, true)
  assert.equal(limit.why, 'model rejected')
  assert.equal(limit.until, now + 3600000)
})

test('usageLimit ignores the phrase above the last 20 lines and plain mentions of it (AC4)', () => {
  assert.equal(usageLimit(`${evidence}\n${'working on the card\n'.repeat(25)}`, now), null)
  assert.equal(usageLimit('the model is not supported on this build -> AC2 pass', now), null)
  assert.equal(usageLimit('the card quotes invalid_request_error in its prose and passes', now), null)
})

test('a rejected model requeues the card uncounted and never reaches Planning (AC2, AC3)', () => {
  const tasks = join(root, 'TASKS')
  mkdirSync(join(tasks, 'working'), { recursive: true })
  writeFileSync(join(tasks, 'working', 'T-1.md'), '# T-1 — rejected\n**Workflow:** card-owned\n## Approved brief\nKeep it passing.\n## Files\n- `app.mjs`\n## Implementation plan\nFix the bug.\n## Acceptance criteria\n- AC1: it works\n')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: { pane_id: 'pane-1', name: 'builder' }, noHandoffStreak: 1 } }))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building', worktreePath: join(root, 'worktree') } }))
  const call = () => routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-1', reason: 'Session pane-1 exited with code=1 without a valid Builder handoff from Working', evidence, boardRoot: root, engine: 'codex', model: 'gpt-6-sol', now })

  const before = readWorkflow(tasks)['T-1']
  assert.equal(call().column, 'queue')
  assert.equal(readWorkflow(tasks)['T-1'].noHandoffStreak, 1)
  const history = readFileSync(join(tasks, '.history', 'T-1.jsonl'), 'utf8')
  assert.match(history, /"event":"engine-usage-limit"[^\n]*"engine":"codex:gpt-6-sol"/)
  assert.doesNotMatch(history, /builder-no-handoff|builder-return/)
  const quota = readQuota(root)
  assert.equal(quota['codex:gpt-6-sol'].why, 'model rejected')
  assert.equal(quota.codex, undefined, 'only the rejected model is blocked, not the engine')

  for (let i = 0; i < 2; i++) {
    moveCard(tasks, 'T-1', 'working')
    assert.equal(call().column, 'queue')
    const state = readWorkflow(tasks)['T-1']
    assert.equal(state.noHandoffStreak, before.noHandoffStreak)
    assert.equal(state.builderDifficulty, before.builderDifficulty)
    assert.equal(state.builderFailureAttempt, before.builderFailureAttempt)
  }
  assert.match(quotaHold(root, 'codex:gpt-6-sol', now + 1000), /model rejected; retrying at/)
  assert.equal(quotaHold(root, 'codex:gpt-5-other', now + 1000), null)
})
