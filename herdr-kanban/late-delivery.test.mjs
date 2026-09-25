import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { confirmLateDeliveries } from './lib/spawn.mjs'
import { saveDelivery, readDelivery } from './lib/delivery-state.mjs'
import { updateWorkflow, readWorkflow } from './lib/workflow-state.mjs'

test('a slow-starting agent seen working confirms its delivery and clears the false hold (8 false alarms, 2026-09-25)', t => {
  const root = mkdtempSync(join(tmpdir(), 'late-delivery-'))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  writeFileSync(process.env.KANBAN_CONFIG, '{}')
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  const tasks = join(root, 'TASKS'); mkdirSync(tasks)
  saveDelivery('proof', 'wG:pF7@default', { status: 'uncertain' })
  saveDelivery('proof', 'wG:pF70@default', { status: 'uncertain' })
  updateWorkflow(tasks, 'I248', { operational: { reason: 'Delivery unconfirmed: Command failed: herdr agent prompt wG:pF7 Read x.md --wait' } })
  updateWorkflow(tasks, 'I249', { operational: { reason: 'Delivery unconfirmed: Command failed: herdr agent prompt wG:pF70 Read y.md --wait' } })
  const cleared = confirmLateDeliveries({ tasksDir: tasks, session: 'proof', agents: [{ pane_id: 'wG:pF7@default', agent_status: 'working' }, { pane_id: 'wG:pF70@default', agent_status: 'idle' }] })
  assert.deepEqual(cleared, ['I248'])
  assert.equal(readDelivery('proof', 'wG:pF7@default').status, 'confirmed')
  assert.equal(readWorkflow(tasks).I248.operational, null)
  assert.ok(readWorkflow(tasks).I249.operational, 'an idle pane keeps its hold, and pF7 never matches pF70')
})

test('a Builder that handed off after an uncertain delivery still integrates (Tradeflow TF71)', async t => {
  const { reconcileCompletedHandoffs } = await import('./lib/completed-handoff.mjs')
  const root = mkdtempSync(join(tmpdir(), 'late-handoff-'))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  writeFileSync(process.env.KANBAN_CONFIG, '{}')
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  const tasks = join(root, 'TASKS'); mkdirSync(join(tasks, 'completed'), { recursive: true })
  writeFileSync(join(tasks, 'completed', 'T-1.md'), '# T-1 — task\n')
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'builder' } } }))
  writeFileSync(join(tasks, '.request-usage.json'), JSON.stringify({ runs: { r: { paneId: 'p', role: 'builder', cardIds: ['T-1'], sessionId: 's' } } }))
  saveDelivery('proof', 'p', { status: 'uncertain' })
  let agent = { pane_id: 'p', name: 'builder', agent_session: { value: 's' }, agent_status: 'idle' }
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'out', recordUsageFinish: async () => {},
    paneClose: async () => { agent = null }, reconcile: () => [{ id: 'T-1', status: 'integrated' }] }
  assert.equal((await reconcileCompletedHandoffs({ tasksDir: tasks, project: 'Proof', onlyIds: ['T-1'], io }))[0].status, 'integrated')
})
