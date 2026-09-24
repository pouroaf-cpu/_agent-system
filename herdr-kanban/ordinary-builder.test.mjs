import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('ordinary spawn delivers real current prompt without experimental hooks; explicit experiment and pause refuse before preparation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ordinary-builder-')), tasks = join(root, 'TASKS')
  mkdirSync(tasks)
  const card = { id: 'T-1', title: 'Fixture', path: join(tasks, 'T-1.md') }
  writeFileSync(card.path, '# T-1\n## Files\n- app.js\n## Acceptance criteria\nExact result\n')
  const calls = [], deliveries = new Map(); let working = false, paused = false
  const agent = () => ({ pane_id: 'fixture-pane', tab_id: 'fixture-tab', agent_session: 'fixture-session', agent_status: working ? 'working' : 'idle' })
  mock.module('./lib/herdr.mjs', { namedExports: {
    sessionOf: p => p, herdrLog: () => {}, tabCreate: async () => ({ root_pane: agent() }),
    agentStart: async args => calls.push(['start', args]),
    agentPrompt: async (pane, text) => { calls.push(['prompt', text]); working = true },
    paneClose: async () => {}, agentWorkspaceOr: async p => p, waitForPrompt: async () => {},
    paneRead: async () => '', paneSendKeys: async () => {}, agentList: async () => [agent()],
  } })
  mock.module('./lib/worktrees.mjs', { namedExports: {
    prepareCardWorktree: () => { calls.push(['prepare']); return { workspacePath: root } }, cleanupPreparedWorktree: () => {},
  } })
  mock.module('./lib/bindings.mjs', { namedExports: { readBindings: () => ({}), unbind: () => {} } })
  mock.module('./lib/cards.mjs', { namedExports: { readBoard: () => ({ queue: [card] }), findCard: () => card, moveCard: () => card, columnByKey: () => ({}), needsBrowser: () => true } })
  mock.module('./lib/request-usage.mjs', { namedExports: { recordUsageFinish: async () => {}, readUsage: () => ({}) } })
  mock.module('./lib/project-control.mjs', { namedExports: { assertPromptAllowed: () => { calls.push(['pause-check']); if (paused) throw new Error('paused') } } })
  mock.module('./lib/card-run.mjs', { namedExports: {
    assertCardRunSelection: (p, ids, stage) => { assert.deepEqual([p, ids, stage], ['Fixture', ['T-1'], 'builder']); calls.push(['identity-check']) },
    cardRunContext: () => ({ runId: 'fixture-run' }), bindCardRunAssignment: () => {},
  } })
  mock.module('./lib/workflow-state.mjs', { namedExports: { readWorkflow: () => ({}), updateWorkflow: () => {} } })
  mock.module('./lib/delivery-state.mjs', { namedExports: {
    deliveryKey: text => text, readDelivery: (s, p) => deliveries.get(p),
    saveDelivery: (s, p, value) => deliveries.set(p, value), pendingDeliveries: () => [],
  } })
  const { spawnForCard } = await import('./lib/spawn.mjs')
  const options = { project: 'Fixture', projectPath: root, tasksDir: tasks, boardRoot: root, card, engine: 'codex' }
  await spawnForCard(options)
  assert.equal(calls.filter(c => c[0] === 'start').length, 1)
  assert.equal(calls.find(c => c[0] === 'start')[1].guardArgs, undefined)
  const prompt = calls.find(c => c[0] === 'prompt')[1]
  assert.match(prompt, /login:false/)
  assert.match(prompt, /done T-1/)
  assert.doesNotMatch(prompt, /Restricted Builder|builder-guard|base64url|Approved command IDs/)
  assert.equal(existsSync(join(tasks, '.builder-guard')), false)
  assert.equal(deliveries.get('fixture-pane').status, 'confirmed')
  calls.length = 0
  await assert.rejects(spawnForCard({ ...options, restrictedBuilder: true }), /restricted dispatch remains disabled/)
  assert.deepEqual(calls.map(c => c[0]), ['identity-check', 'pause-check'])
  calls.length = 0; paused = true
  await assert.rejects(spawnForCard(options), /paused/)
  assert.deepEqual(calls.map(c => c[0]), ['identity-check', 'pause-check'])
  mock.restoreAll()
})
