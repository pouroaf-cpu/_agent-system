import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stageIndicators } from './lib/stage-indicators.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kanban-indicators-'))
try {
  const path = join(dir, 'T-1.md')
  const plan = `**Plan readiness:** investigation\n**Investigation approved:** yes\n## Approved brief\nMeasure the issue.\n## Files\n- \`evidence/\`\n## Implementation plan\nMeasurement command: node measure.mjs\nExpected result: record timing\nStop rules: stop if unavailable\n## Acceptance criteria\n- Measurement saved.\n`
  writeFileSync(path, plan)
  const card = (id, column, file = path) => ({ id, column, path: file })
  const board = { planning: [card('T-1', 'planning')], review: [], issues: [], owner: [] }
  const planners = { 'T-1': { lifecycle: 'active', paneId: 'p1', submitted: true } }
  const agents = [{ pane_id: 'p1', agent_status: 'working' }]
  const input = { tasksDir: dir, board, planners, claims: [], agents, workflow: {} }
  assert.equal(stageIndicators(input)['T-1'].status, 'working')
  agents[0].agent_status = 'done'
  assert.equal(stageIndicators(input)['T-1'].status, 'passed')
  writeFileSync(path, plan.replace('Stop rules:', 'Unclear rules:'))
  assert.equal(stageIndicators(input)['T-1'].status, 'issue')
  delete planners['T-1']
  assert.equal(stageIndicators(input)['T-1'], undefined)

  const reviewPath = join(dir, 'T-2.md')
  writeFileSync(reviewPath, '## Reviewer evidence\nChecked the outcome.\n')
  board.review.push(card('T-2', 'review', reviewPath))
  const claims = [{ tasksDir: dir, cards: ['T-2'], paneId: 'p2' }]
  agents.push({ pane_id: 'p2', agent_status: 'working' })
  assert.equal(stageIndicators({ ...input, claims })['T-2'].status, 'working')
  writeFileSync(reviewPath, '## Reviewer evidence\nChecked the outcome.\n**Review verdict:** PASS 2026-09-21T00:00:00Z\n')
  assert.equal(stageIndicators({ ...input, claims })['T-2'].status, 'passed')
  writeFileSync(reviewPath, '## Reviewer evidence\nCheck failed.\n**Review verdict:** FAIL 2026-09-21T00:00:00Z\n')
  assert.equal(stageIndicators({ ...input, claims })['T-2'].status, 'issue')

  mkdirSync(join(dir, '.history'))
  writeFileSync(join(dir, '.history', 'T-3.jsonl'), JSON.stringify({ event: 'transition', from: 'review', to: 'owner' }) + '\n')
  board.owner.push(card('T-3', 'owner'))
  assert.equal(stageIndicators(input)['T-3'].status, 'issue')
  writeFileSync(join(dir, '.history', 'T-4.jsonl'), JSON.stringify({ event: 'transition', from: 'working', to: 'issues' }) + '\n')
  board.issues.push(card('T-4', 'issues'))
  assert.equal(stageIndicators(input)['T-4'], undefined)
} finally { rmSync(dir, { recursive: true, force: true }) }
console.log('stage indicators: ok')
