import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard } from './lib/cards.mjs'
import { runCardPlanner } from './lib/card-planner.mjs'

test('concurrent Planners per project are capped; the rest wait (Injectbuddy: 11 at once pinned the CPU)', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-cap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const title of ['One', 'Two', 'Three']) createCard(dir, { title, brief: 'A specific approved outcome' })
  let agents = [], starts = 0, panes = 0
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'workspace',
    tabCreate: async () => ({ root_pane: { pane_id: `pane-${++panes}` } }), waitForPrompt: async () => {},
    agentStart: async ({ name, paneId }) => { starts++; agents = [...agents, { name, pane_id: paneId, agent_status: 'working' }] },
    deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async () => {}, paneRead: async () => '',
  }
  const args = { project: 'Proof', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'm', io, maxPlanners: 2 }
  await runCardPlanner(args)
  await runCardPlanner(args)
  assert.equal(starts, 2, 'two Planners run, the third card waits')
  agents = agents.map((a, i) => i === 0 ? { ...a, agent_status: 'done' } : a)
  await runCardPlanner(args)
  assert.equal(starts, 3, 'a finished Planner frees a slot')
})
