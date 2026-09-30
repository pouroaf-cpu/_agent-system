import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { withBoardLock } from './lib/bindings.mjs'
import { reconcileCompletedWorktrees } from './lib/worktrees.mjs'
import { syncReviewClaims } from './lib/review-claims.mjs'
import { routeBuilderNoHandoff } from './lib/autospawn.mjs'
import { workerPrompt, plannerPrompt } from './lib/prompt.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { readWorkflow, recordOperationalFailure } from './lib/workflow-state.mjs'
import { runCardPlanner, drainIssues } from './lib/card-planner.mjs'

test('Builder fallback routes Working to Planning and preserves assignment/worktree evidence', t => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-safeguards-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-1.md'), '# T-1 — saved work\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n## Implementation\nStage: builder\n## Evidence\nCheck: node check.mjs\n')
  writeFileSync(join(root, 'app.mjs'), 'saved')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: { pane_id: 'pane-1', name: 'builder' } } }))
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building', worktreePath: join(root, 'worktree') } }))
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-1', reason: 'Session pane-1 is missing without a valid Builder handoff from Working', evidence: 'last visible output' })
  assert.equal(moved.column, 'planning')
  assert.match(readFileSync(moved.path, 'utf8'), /Kicked back[\s\S]*\[planning\] Builder fallback[\s\S]*last visible output/)
  assert.deepEqual(readWorkflow(tasks)['T-1'].builder, { pane_id: 'pane-1', name: 'builder' })
  assert.equal(readWorkflow(tasks)['T-1'].operational ?? null, null, 'no hold: a fresh Planner takes the card')
  assert.equal(JSON.parse(readFileSync(join(tasks, '.board-worktrees.json')))['T-1'].state, 'building')
  assert.match(readFileSync(join(tasks, '.history', 'T-1.jsonl'), 'utf8'), /builder-no-handoff/)
  assert.equal(existsSync(join(tasks, 'issues')), false, 'nothing lands in Issues')
})

test('Builder that filed hkb issue then exited is kicked back with its own note, not a generic one (I519)', async t => {
  const { appendHistory } = await import('./lib/card-history.mjs')
  const { correctionFingerprint } = await import('./lib/card-planner.mjs')
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-issue-'))
  const tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const prints = []
  for (const note of ['[evidence] Unmeasured opacity at Skip 0', '[operational] Signed-in /account/ route must load']) {
    mkdirSync(join(tasks, 'working'), { recursive: true })
    writeFileSync(join(tasks, 'working', 'T-1.md'), '# T-1 — issue\n**Workflow:** card-owned\n')
    writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: { pane_id: 'p', started: new Date(Date.now() - 60000).toISOString() } } }))
    appendHistory(tasks, 'T-1', { event: 'failure', stage: 'working', category: note.slice(1, note.indexOf(']')), note })
    const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-1', reason: 'Session unknown is missing without a valid Builder handoff from Working' })
    const text = readFileSync(moved.path, 'utf8')
    assert.equal(moved.column, 'planning')
    assert.match(text, new RegExp(`Builder reported: ${note.replace(/[[\]/]/g, '\\$&')}`))
    assert.doesNotMatch(text, /Session unknown is missing/)
    prints.push(correctionFingerprint(text))
    rmSync(join(tasks, 'planning'), { recursive: true, force: true })
  }
  assert.notEqual(prints[0], prints[1], 'two different causes are not "the same failure"')
})

test('Builder fallback holds a question in Planning for the operator instead of requeueing', t => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-safeguards-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-9.md'), '# T-9 — saved work\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n')
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-9', reason: 'Session pane-9 is missing without a valid Builder handoff from Working', evidence: 'Should I use approach (a) or (b)?' })
  assert.equal(moved.column, 'planning', 'still parked in Planning, where a decision hold is enforced')
  assert.doesNotMatch(readFileSync(moved.path, 'utf8'), /Kicked back/, 'not treated as a plan failure')
  assert.match(readFileSync(moved.path, 'utf8'), /Needs you[\s\S]*Should I use approach \(a\) or \(b\)\?/)
  assert.deepEqual(readWorkflow(tasks)['T-9'].waitFor, { cards: [], files: [], decision: true, why: 'Should I use approach (a) or (b)?', since: readWorkflow(tasks)['T-9'].waitFor.since })
  assert.match(readFileSync(join(tasks, '.history', 'T-9.jsonl'), 'utf8'), /agent-question-captured/)
  assert.doesNotMatch(readFileSync(join(tasks, '.history', 'T-9.jsonl'), 'utf8'), /builder-no-handoff/)
})

test('Builder fallback judges only the agent\'s last message in a scraped pane (I385)', t => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-safeguards-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  const pane = (last) => `+194 lines\n\n• Reading the brief.\n\n• Ran Get-Content skill.md\n  │ … +5 lines\n  └ Should you ask? You cannot.\n\n• ${last}\n\n  Worked for 1m 15s · 3:30 PM\n\n\n› Ask Codex to do anything\n\n  GPT-6-Luna medium`
  writeFileSync(join(working, 'T-7.md'), '# T-7 — plan gap\n**Workflow:** card-owned\n')
  const gap = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-7', reason: 'no handoff', evidence: pane('[planning] The delivery requires extracting\n  the flow machinery; recording the blocker.') })
  assert.equal(readWorkflow(tasks)['T-7']?.waitFor ?? null, null, 'plan gap goes to the Planner, not a person')
  assert.match(readFileSync(gap.path, 'utf8'), /Kicked back/)
  writeFileSync(join(working, 'T-8.md'), '# T-8 — question\n**Workflow:** card-owned\n')
  routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-8', reason: 'no handoff', evidence: pane('Should I keep the old\n  selector or rename it?') })
  assert.equal(readWorkflow(tasks)['T-8'].waitFor.why, 'Should I keep the old selector or rename it?', 'ask text is the agent\'s question, not the pane')
})

test('a Builder whose task pointer was never submitted is a failed start, back to Queue (I401)', t => {
  const root = mkdtempSync(join(tmpdir(), 'lifecycle-safeguards-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-5.md'), '# T-5 — build-ready\n')
  const pane = '│ >_ OpenAI Codex (v0.156.1) │\n╰──────╯\n\n  Tip: New Use /fast.\n\n\n› Read C:/Users/PFrew/Projects/herdr-kanban/.deliveries/f2d4.md (revision\n  60c8) (use the PowerShell tool with login:false) and follow it exactly; it is your\n  complete task.\n\n\n  GPT-6-Sol medium · ~\\cards\\t-5'
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-5', reason: 'finished with status=done without a valid Builder handoff', evidence: pane, io: { readDelivery: () => null, saveDelivery: () => {} } })
  assert.equal(moved.column, 'queue', 'a fresh Builder, not a Planner correction')
  assert.doesNotMatch(readFileSync(moved.path, 'utf8'), /Kicked back/)
  assert.match(readFileSync(join(tasks, '.history', 'T-5.jsonl'), 'utf8'), /builder-delivery-failed/)
})

test('Planner and Builder prompts require prerequisite verification and one handoff', () => {
  const card = { id: 'T-2', title: 'check prerequisites', path: 'T-2.md', trivial: false }
  const builder = workerPrompt({ card, projectPath: '.', boardRoot: '.', tasksDir: '' })
  const planner = plannerPrompt({ cards: [card], projectPath: '.', boardRoot: '.', tasksDir: '' })
  assert.match(builder, /verify every named prerequisite file, route, selector, dependency and check/i)
  assert.match(builder, /exactly one of these/)
  assert.match(planner, /verify every named prerequisite file, route, selector, dependency and check/i)
  assert.match(planner, /exactly one .*move <ID> planned command/i)
})

test('Planner that stops without a handoff gets one fresh Planner with saved evidence, then Owner', async t => {
  const root = mkdtempSync(join(tmpdir(), 'planner-fallback-'))
  const tasks = join(root, 'TASKS'), planning = join(tasks, 'planning')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(planning, { recursive: true })
  writeFileSync(join(planning, 'T-3.md'), '# T-3 — planner handoff\n**Workflow:** card-owned\n## Approved brief\nDo the approved thing\n## Files\n- `app.mjs`\n## Implementation plan\nPlan it\n## Acceptance criteria\n- AC1: works\n')
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-3': { assignmentId: 'a', lifecycle: 'active', paneId: 'pane-3', submitted: true, replacementAttempts: 0 } }))
  let agents = [{ pane_id: 'pane-3', agent_status: 'done', state_change_seq: 8 }], pane = 3
  const delivered = [], closed = []
  const io = {
    agentList: async () => agents,
    paneRead: async id => `${id} stopped after checking route /missing`,
    agentWorkspaceOr: async () => root, tabCreate: async () => ({ root_pane: { pane_id: `pane-${++pane}` } }),
    waitForPrompt: async () => {}, agentStart: async ({ paneId }) => { agents = [...agents, { pane_id: paneId, agent_status: 'idle' }] },
    paneClose: async id => { closed.push(id); agents = agents.filter(a => a.pane_id !== id) },
    deliver: async id => { delivered.push(id) }, recordUsageStart: () => {}, recordUsageFinish: async () => {},
  }
  const args = { project: 'Proof', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'test', io, handoffGraceMs: 10 }
  await runCardPlanner({ ...args, now: 0 })
  await runCardPlanner({ ...args, now: 11 })
  assert.equal(findCard(tasks, 'T-3').column, 'planning', 'the card is not parked in Issues')
  assert.deepEqual(closed, ['pane-3']); assert.deepEqual(delivered, ['pane-4'])
  assert.match(readFileSync(findCard(tasks, 'T-3').path, 'utf8'), /Planner fallback[\s\S]*fresh Planner/)
  assert.match(readFileSync(join(tasks, '.history', 'T-3.jsonl'), 'utf8'), /pane-3 stopped after checking route \/missing/)
  assert.equal(readWorkflow(tasks)['T-3']?.operational ?? null, null, 'no operational hold')
  const owner = JSON.parse(readFileSync(join(tasks, '.card-planners.json'), 'utf8'))['T-3']
  assert.equal(owner.paneId, 'pane-4'); assert.ok(owner.revokedPaneIds.includes('pane-3')); assert.equal(owner.noHandoffCount, 1)
  // The fresh Planner also stops without a handoff: one plain-language Owner question, no third Planner.
  await runCardPlanner({ ...args, now: 20 })
  await runCardPlanner({ ...args, now: 31 })
  assert.equal(findCard(tasks, 'T-3').column, 'owner')
  assert.deepEqual(delivered, ['pane-4'])
  assert.match(readFileSync(findCard(tasks, 'T-3').path, 'utf8'), /Needs you: Two Planner sessions in a row stopped[\s\S]*\?/)
})

test('a card an older board left in Issues goes to Planning on startup and gets a fresh Planner (T-8)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'planner-hold-'))
  const tasks = join(root, 'TASKS'), issues = join(tasks, 'issues')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(issues, { recursive: true })
  writeFileSync(join(issues, 'T-8.md'), '# T-8 — held\n**Workflow:** card-owned\n## Approved brief\nDo it\n')
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ 'T-8': { assignmentId: 'a', lifecycle: 'active', paneId: 'w1:pK', submitted: false, replacementAttempts: 0 } }))
  recordOperationalFailure(tasks, findCard(tasks, 'T-8'), 'Planner session w1:pK ended without a valid handoff after 120000ms; observed status=idle, state_change_seq=4', root)
  assert.deepEqual(drainIssues(tasks), ['T-8'])
  assert.equal(findCard(tasks, 'T-8').column, 'planning')
  assert.equal(readWorkflow(tasks)['T-8'].operational, null)
  assert.match(readFileSync(join(tasks, '.history', 'T-8.jsonl'), 'utf8'), /issues-retired/)
  let agents = [{ pane_id: 'w1:pK', agent_status: 'idle' }]
  const delivered = []
  const io = {
    agentList: async () => agents, paneRead: async () => 'old output', agentWorkspaceOr: async () => root,
    tabCreate: async () => ({ root_pane: { pane_id: 'w1:pNew' } }), waitForPrompt: async () => {},
    agentStart: async ({ paneId }) => { agents = [{ pane_id: paneId, agent_status: 'idle' }] }, paneClose: async () => {},
    deliver: async id => { delivered.push(id) }, recordUsageStart: () => {}, recordUsageFinish: async () => {},
  }
  const result = await runCardPlanner({ project: 'Proof', projectPath: root, tasksDir: tasks, boardRoot: root, model: 'test', io })
  assert.equal(result.spawnedNewAgent, true)
  assert.deepEqual(delivered, ['w1:pNew'])
  assert.deepEqual(drainIssues(tasks), [], 'nothing left to drain')
})

test('a Builder whose prompt never landed gets a fresh start, not a Planner round', async t => {
  const root = mkdtempSync(join(tmpdir(), 'builder-undelivered-'))
  const tasks = join(root, 'TASKS'), working = join(tasks, 'working')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(working, { recursive: true })
  writeFileSync(join(working, 'T-6.md'), '# T-6 — never started\n')
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify({ 'T-6': { builder: { pane_id: 'pane-6', name: 'builder' } } }))
  const saved = []
  const io = { readDelivery: () => ({ status: 'uncertain', at: '2026-09-24T07:45:00Z' }), saveDelivery: (_s, _p, data) => saved.push(data) }
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-6', reason: 'Session pane-6 finished with status=done without a valid Builder handoff from Working', io })
  assert.equal(moved.column, 'queue')
  assert.equal(saved[0].status, 'failed')
  // An unsubmitted prompt is machine load, not a strike: it backs off (I157, TF50).
  const failure = readWorkflow(tasks)['T-6'].startFailure
  assert.deepEqual([failure.count, failure.tries], [0, 1]); assert.ok(failure.nextAt > Date.now())
})

// Windows reuses PIDs quickly after a crash or forced restart. A lock whose PID now belongs to
// a process that started after the lock was written is reclaimed past its bound (audit 2026-09-26 #11).
test('locks whose PID was reused by a later process are reclaimed past their bound; a live owner keeps its lock', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'lock-reuse-'))
  const tasks = join(root, 'TASKS'); mkdirSync(tasks)
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'])
  t.after(() => { other.kill(); rmSync(root, { recursive: true, force: true }) })
  await new Promise(done => other.once('spawn', done))
  const minutesAgo = m => new Date(Date.now() - m * 60000)

  const board = join(tasks, '.board.lock')
  writeFileSync(board, String(other.pid)); utimesSync(board, minutesAgo(10), minutesAgo(10))
  assert.equal(withBoardLock(tasks, () => 'ran'), 'ran')

  const integration = join(tasks, '.board-integration.lock')
  writeFileSync(integration, JSON.stringify({ pid: other.pid, at: minutesAgo(20).toISOString() }))
  reconcileCompletedWorktrees({ tasksDir: tasks })
  assert.equal(existsSync(integration), true, 'inside its 30-minute bound the lock is kept')
  writeFileSync(integration, JSON.stringify({ pid: other.pid, at: minutesAgo(40).toISOString() }))
  reconcileCompletedWorktrees({ tasksDir: tasks })
  assert.equal(existsSync(integration), false)

  const ledger = join(root, '.review-claims.json.lock')
  writeFileSync(ledger, JSON.stringify({ pid: other.pid, createdAt: minutesAgo(10).getTime() })); utimesSync(ledger, minutesAgo(10), minutesAgo(10))
  assert.deepEqual(syncReviewClaims(root, [{ project: 'one', tasksDir: tasks, known: true, agents: [] }]), [])

  // 40 minutes on, but its PID's process started before it wrote the lock: still the owner.
  writeFileSync(integration, JSON.stringify({ pid: other.pid, at: new Date().toISOString() }))
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 40 * 60000 })
  reconcileCompletedWorktrees({ tasksDir: tasks })
  t.mock.timers.reset()
  assert.equal(existsSync(integration), true, 'a live owner keeps its lock')
})
