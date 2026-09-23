import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { reconcileCompletedHandoffs } from './lib/completed-handoff.mjs'
import { promoteAutoReview } from './lib/autospawn.mjs'
import { findCard } from './lib/cards.mjs'

test('finished Builder output is durable before close; working/mismatched sessions never close; restart does not replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n**Auto-review:** yes\n**Recovery:** {"returns":2}\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'builder' } } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: { r: { paneId: 'p', role: 'builder', cardIds: ['T-1'], sessionId: 'original' } } }))
  let agent = { pane_id: 'p', name: 'builder', agent_session: { value: 'original' }, agent_status: 'working' }, closed = 0, integrated = 0
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'finished output', recordUsageFinish: async () => {},
    paneClose: async () => { assert.match(readFileSync(join(tasksDir, '.history/T-1.jsonl'), 'utf8'), /finished output/); agent = null; closed++ },
    reconcile: () => { assert.equal(agent, null); integrated++; return [{ id: 'T-1', status: 'integrated' }] } }
  const run = () => reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.equal((await run())[0].status, 'waiting-builder'); assert.equal(closed, 0); assert.equal(integrated, 0)
  agent.agent_status = 'done'; agent.agent_session.value = 'other'
  await assert.rejects(run, /identity/); assert.equal(closed, 0)
  agent.agent_session.value = 'original'
  await run(); await run()
  assert.equal(closed, 1); assert.equal(integrated, 2)
  assert.match(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8'), /"returns":2/)
})

test('Auto-review OFF stays Completed even manager mode; ON waits for safe cleanup', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-gate-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  for (const [id, flag] of [['T-1', 'no'], ['T-2', 'yes']]) writeFileSync(join(tasksDir, 'completed', `${id}.md`), `# ${id} — task\n**Auto-review:** ${flag}\n`)
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-2': { state: 'integrated', cleaned: false } }))
  assert.deepEqual(promoteAutoReview(tasksDir, { all: true }), [])
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-2': { state: 'integrated', cleaned: true } }))
  assert.deepEqual(promoteAutoReview(tasksDir, { all: true }), ['T-2'])
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
})

test('finished Builder whose card sits in Review is retired and integrated', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-review-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'review'), { recursive: true })
  writeFileSync(join(tasksDir, 'review', 'T-1.md'), '# T-1 — task\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'builder' } } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: { r: { paneId: 'p', role: 'builder', cardIds: ['T-1'], sessionId: 's' } } }))
  let agent = { pane_id: 'p', name: 'builder', agent_session: { value: 's' }, agent_status: 'done' }
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'out', recordUsageFinish: async () => {},
    paneClose: async () => { agent = null }, reconcile: () => [{ id: 'T-1', status: 'integrated' }] }
  assert.equal((await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io }))[0].status, 'integrated')
})
