import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// An implementation correction whose Builder pane is gone must start a fresh
// Builder in the same worktree with the feedback, not throw the card to Owner.
test('implementation correction: missing prior Builder gets a fresh Builder with the feedback; a live legacy pane is resumed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'builder-correction-')), tasks = join(root, 'TASKS')
  mkdirSync(tasks)
  const card = { id: 'T-1', title: 'Fixture', path: join(tasks, 'T-1.md') }
  writeFileSync(card.path, '# T-1\n## Files\n- app.js\n')
  let agents = []
  const calls = [], logs = [], deliveries = new Map()
  const fresh = { pane_id: 'w1:p9@default', tab_id: 'w1:t9@default', agent_session: 'fresh' }
  mock.module('./lib/herdr.mjs', { namedExports: {
    sessionOf: p => p.toLowerCase(), herdrLog: () => {},
    tabCreate: async args => { calls.push(['tab', args.cwd]); agents.push({ ...fresh, agent_status: 'idle' }); return { root_pane: fresh } },
    agentStart: async () => calls.push(['start']),
    agentPrompt: async (pane, text) => { calls.push(['prompt', pane, text]); for (const a of agents) if (a.pane_id === pane) a.agent_status = 'working' },
    paneClose: async () => {}, agentWorkspaceOr: async p => p, waitForPrompt: async () => {},
    paneRead: async () => '', paneSendKeys: async () => {}, agentList: async () => agents,
  } })
  mock.module('./lib/worktrees.mjs', { namedExports: {
    prepareCardWorktree: () => ({ git: true, workspacePath: join(root, 'wt'), created: false, entry: { worktreePath: join(root, 'wt'), workspacePath: join(root, 'wt') } }),
    cleanupPreparedWorktree: () => { calls.push(['cleanup']) },
  } })
  mock.module('./lib/activity.mjs', { namedExports: { activityLog: entry => logs.push(entry) } })
  mock.module('./lib/bindings.mjs', { namedExports: { readBindings: () => ({}), unbind: () => {} } })
  mock.module('./lib/cards.mjs', { namedExports: { readBoard: () => ({ queue: [card] }) } })
  mock.module('./lib/request-usage.mjs', { namedExports: { recordUsageFinish: async () => {}, readUsage: () => ({}) } })
  mock.module('./lib/project-control.mjs', { namedExports: { assertPromptAllowed: () => {} } })
  mock.module('./lib/card-run.mjs', { namedExports: { assertCardRunSelection: () => {}, cardRunContext: () => null, bindCardRunAssignment: () => {} } })
  mock.module('./lib/workflow-state.mjs', { namedExports: { readWorkflow: () => ({ 'T-1': {
    builder: { pane_id: 'wJ:pFE', name: 'kb-old' },
    correction: { category: 'implementation', note: 'AC4: move the guard\nto process-wide state.' },
  } }), updateWorkflow: () => {} } })
  mock.module('./lib/delivery-state.mjs', { namedExports: {
    deliveryKey: t => t, readDelivery: (s, p) => deliveries.get(p), saveDelivery: (s, p, v) => deliveries.set(p, v), pendingDeliveries: () => [],
  } })
  const { spawnForCard } = await import('./lib/spawn.mjs')
  const options = { project: 'Fixture', projectPath: root, tasksDir: tasks, boardRoot: root, card, engine: 'claude' }

  // Prior pane gone: fresh tab in the card worktree, feedback in the prompt, logged, work kept.
  const result = await spawnForCard(options)
  assert.equal(result.pane_id, fresh.pane_id)
  assert.deepEqual(calls.find(c => c[0] === 'tab'), ['tab', join(root, 'wt')])
  assert.ok(calls.some(c => c[0] === 'start'))
  const prompt = calls.find(c => c[0] === 'prompt')[2]
  assert.match(prompt, /previous Builder session \(wJ:pFE\) is unavailable/)
  assert.match(prompt, /AC4: move the guard to process-wide state\./)
  assert.doesNotMatch(prompt, /\n/)
  assert.equal(logs[0]?.event, 'builder-replaced')
  assert.ok(!calls.some(c => c[0] === 'cleanup'))

  // Legacy bare pane id alive in the project's old session: resumed, no new tab.
  calls.length = 0; logs.length = 0
  agents = [{ pane_id: 'wJ:pFE', tab_id: 'wJ:tFE', name: 'kb-old', agent_status: 'idle', session: 'fixture' }]
  await spawnForCard(options)
  assert.ok(!calls.some(c => c[0] === 'tab' || c[0] === 'start'))
  assert.equal(calls.find(c => c[0] === 'prompt')[1], 'wJ:pFE')
  assert.doesNotMatch(calls.find(c => c[0] === 'prompt')[2], /unavailable/)
  assert.equal(logs.length, 0)
  mock.restoreAll()
})
