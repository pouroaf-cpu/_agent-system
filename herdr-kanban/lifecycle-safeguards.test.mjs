import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { routeBuilderNoHandoff, recoverBuilderNoHandoff } from './lib/autospawn.mjs'
import { workerPrompt, issuesSweeperPrompt } from './lib/prompt.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'
import { runCardPlanner } from './lib/card-planner.mjs'

test('Builder fallback routes Working to Issues and preserves assignment/worktree evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-safeguards-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-1.md'), '# T-1 — saved work\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n## Implementation\nStage: builder\n## Evidence\nCheck: node check.mjs\n')
  writeFileSync(join(root, 'app.mjs'), 'saved')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: { pane_id: 'pane-1', name: 'builder' } } }))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building', worktreePath: join(root, 'worktree') } }))
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-1', reason: 'Session pane-1 is missing without a valid Builder handoff from Working', evidence: 'last visible output' , workspace: root })
  assert.equal(moved.column, 'issues')
  assert.match(readFileSync(moved.path, 'utf8'), /Builder fallback[\s\S]*last visible output/)
  assert.deepEqual(readWorkflow(tasks)['T-1'].builder, { pane_id: 'pane-1', name: 'builder' })
  assert.equal(JSON.parse(readFileSync(join(tasks, '.board-worktrees.json')))['T-1'].state, 'building')
  assert.match(readFileSync(join(tasks, '.history', 'T-1.jsonl'), 'utf8'), /builder-no-handoff/)
  assert.equal(findCard(tasks, 'T-1').column, 'issues')
})

test('Planner and Builder prompts require prerequisite verification and one handoff', () => {
  const card = { id: 'T-2', title: 'check prerequisites', path: 'T-2.md', trivial: false }
  const builder = workerPrompt({ card, projectPath: '.', boardRoot: '.', tasksDir: '' })
  const planner = issuesSweeperPrompt({ cards: [card], projectPath: '.', boardRoot: '.', tasksDir: '' })
  assert.match(builder, /verify every named prerequisite file, route, selector, dependency and check/i)
  assert.match(builder, /exactly one of these/)
  assert.match(planner, /verify every named prerequisite file, route, selector, dependency and check/i)
  assert.match(planner, /exactly one .*move <ID> planned command/i)
})

test('Planner fallback routes a stopped session to Issues with saved pane evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'planner-fallback-'))
  const tasks = join(root, 'TASKS'), planning = join(tasks, 'planning')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(planning, { recursive: true })
  writeFileSync(join(planning, 'T-3.md'), '# T-3 — planner handoff\n**Workflow:** card-owned\n## Approved brief\nDo the approved thing\n## Files\n- `app.mjs`\n## Implementation plan\nPlan it\n## Acceptance criteria\n- AC1: works\n')
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-3': { assignmentId: 'a', lifecycle: 'active', paneId: 'pane-3', submitted: true, replacementAttempts: 0 } }))
  const io = {
    agentList: async () => [{ pane_id: 'pane-3', agent_status: 'done', state_change_seq: 8 }],
    paneRead: async () => 'Planner stopped after checking route /missing',
    agentWorkspaceOr: async () => root, tabCreate: async () => { throw new Error('not expected') },
    waitForPrompt: async () => {}, agentStart: async () => {}, paneClose: async () => {},
    deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
  }
  const args = { project: 'Proof', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'test', io, handoffGraceMs: 10 }
  await runCardPlanner({ ...args, now: 0 })
  await runCardPlanner({ ...args, now: 11 })
  assert.equal(findCard(tasks, 'T-3').column, 'issues')
  assert.match(readFileSync(findCard(tasks, 'T-3').path, 'utf8'), /Planner fallback[\s\S]*route \/missing/)
  assert.match(readFileSync(join(tasks, '.history', 'T-3.jsonl'), 'utf8'), /route \/missing/)
})

test('held Builder gets one nudge, returns to Working, then recovers to Planner if idle', async t => {
  const root = mkdtempSync(join(tmpdir(), 'builder-recovery-nudge-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-4.md'), '# T-4 — saved work\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n## Implementation\nStage: builder\n## Evidence\nCheck: node check.mjs\n')
  writeFileSync(join(root, 'app.mjs'), 'saved')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-4': { builder: { pane_id: 'pane-4', name: 'builder' } } }))
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'T-4': { pane_id: 'pane-4' } }))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-4': { state: 'building', worktreePath: join(root, 'worktree') } }))
  const held = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-4', reason: 'Session pane-4 is missing without a valid Builder handoff from Working', workspace: root })
  const sent = []
  const io = { paneRead: async () => 'asked a question before stopping', deliver: async (_pane, prompt) => sent.push(prompt) }
  const agents = [{ pane_id: 'pane-4', agent_status: 'idle' }]
  assert.equal(await recoverBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-4', agents, io, workspace: root, now: 1000 }), true)
  assert.equal(findCard(tasks, 'T-4').column, 'working')
  assert.match(sent[0], /do not ask questions.*hkb done.*hkb issue.*hkb owner/i)
  assert.equal(await recoverBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-4', agents, io, workspace: root, graceMs: 10000, now: 2000 }), true)
  assert.equal(sent.length, 1)
  assert.equal(await recoverBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-4', agents, io, workspace: root, graceMs: 1000, now: 3000 }), true)
  assert.equal(findCard(tasks, 'T-4').column, 'planning')
  assert.match(readFileSync(join(tasks, '.history', 'T-4.jsonl'), 'utf8'), /asked a question before stopping/)
  assert.equal(JSON.parse(readFileSync(join(tasks, '.board-worktrees.json')))['T-4'].state, 'building')
  assert.equal(held.column, 'issues')
})

test('missing Builder pane returns to Planner with hold and prior output retained', async t => {
  const root = mkdtempSync(join(tmpdir(), 'builder-recovery-missing-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-5.md'), '# T-5 — saved work\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n## Implementation\nStage: builder\n## Evidence\nCheck: node check.mjs\n')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-5': { builder: { pane_id: 'gone', name: 'builder' } } }))
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-5', reason: 'Session gone is missing without a valid Builder handoff from Working', evidence: 'saved output', workspace: root })
  assert.equal(await recoverBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-5', agents: [], workspace: root, now: 2000 }), true)
  assert.equal(findCard(tasks, 'T-5').column, 'planning')
  assert.match(readFileSync(findCard(tasks, 'T-5').path, 'utf8'), /Builder recovery failed \(missing-pane\)/)
  assert.match(readFileSync(join(tasks, '.history', 'T-5.jsonl'), 'utf8'), /saved output/)
  assert.equal(moved.column, 'issues')
})

test('two Builder recovery failures for the same cause ask the Owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'builder-recovery-owner-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-6.md'), '# T-6 — saved work\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n## Implementation\nStage: builder\n## Evidence\nCheck: node check.mjs\n')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-6': { builder: { pane_id: 'gone', name: 'builder' } } }))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-6': { state: 'building', worktreePath: join(root, 'worktree') } }))
  routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-6', reason: 'Session gone is missing without a valid Builder handoff from Working', workspace: root })
  await recoverBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-6', agents: [], workspace: root, now: 1000 })
  moveCard(tasks, 'T-6', 'working')
  routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-6', reason: 'Session gone is missing without a valid Builder handoff from Working', workspace: root })
  await recoverBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-6', agents: [], workspace: root, now: 2000 })
  assert.equal(findCard(tasks, 'T-6').column, 'owner')
  assert.match(readFileSync(findCard(tasks, 'T-6').path, 'utf8'), /Should the Planner change the recovery plan/)
  assert.equal(JSON.parse(readFileSync(join(tasks, '.board-worktrees.json')))['T-6'].state, 'building')
})
