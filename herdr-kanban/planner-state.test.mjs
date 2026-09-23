import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readCardPlanners, saveCardPlanners, reconcilePlannerAssignment, assertPlannerHandoff, assertPlannerAssignment, assertPlannerPaneAllowed } from './lib/planner-state.mjs'
import { saveDelivery, pendingDeliveries } from './lib/delivery-state.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { cardRunEligibility, tickCardRun } from './lib/card-runner.mjs'
import { authorizeCardRun, activeCardRun, readCardRuns, bindCardRunAssignment } from './lib/card-run.mjs'
import { runCardPlanner } from './lib/card-planner.mjs'
import { assertPromptAllowed } from './lib/project-control.mjs'

function fixture(t, column = 'queue') {
  const root = mkdtempSync(join(tmpdir(), 'planner-lifecycle-')), tasksDir = join(root, 'Proof', 'TASKS')
  mkdirSync(join(tasksDir, column), { recursive: true })
  const card = '# T-1 — Approved recovery\n**Workflow:** card-owned\n**Auto-review:** yes\n## Approved brief\nOnly approved scope\n## Files\n- `app.mjs`\n## Implementation plan\nPreserve saved work\n## Acceptance criteria\nCheck result\n\n**Recovery:** {"returns":3}\n'
  writeFileSync(join(tasksDir, column, 'T-1.md'), card)
  writeFileSync(join(root, 'Proof', 'app.mjs'), 'source')
  const owner = { paneId: 'old', submitted: true, replacementAttempts: 1, correctionRounds: 2, sameFailureCount: 1 }
  writeFileSync(join(tasksDir, '.card-planners.json'), JSON.stringify({ 'T-1': owner, 'T-2': { paneId: 'other' } }))
  const config = { projectsRoot: root, projects: ['Proof', 'Other'], maxConcurrentAgents: 0, projectControls: { Proof: { paused: true }, Other: { paused: true } }, models: { planning: 'fixture' } }
  const configPath = join(root, 'board.config.json'); writeFileSync(configPath, JSON.stringify(config))
  const previous = process.env.KANBAN_CONFIG; process.env.KANBAN_CONFIG = configPath
  t.after(() => { if (previous === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = previous; rmSync(root, { recursive: true, force: true }) })
  let agents = [{ pane_id: 'old', agent_status: 'done', state_change_seq: 1, agent_session: 'saved-session' }]
  const io = { agentList: async () => agents, paneRead: async () => 'Saved output', paneClose: async id => { agents = agents.filter(a => a.pane_id !== id) } }
  const options = { project: 'Proof', tasksDir, cardId: 'T-1', reason: 'Verified obsolete saved assignment', io }
  const eligibility = () => cardRunEligibility({ ...options, projectPath: join(root, 'Proof'), card: findCard(tasksDir, 'T-1'), agents, known: true })
  return { root, tasksDir, card, owner, config, configPath, io, options, eligibility, agents }
}

test('retirement preserves unregistered build residual and verifies cleaned integration provenance', async t => {
  const f = fixture(t)
  const integration = join(f.root, 'integration'), residual = join(f.root, 'old-worktree')
  mkdirSync(integration); mkdirSync(join(residual, '.next'), { recursive: true })
  writeFileSync(join(residual, '.next', 'evidence.log'), 'preserved build output')
  const git = args => execFileSync('git', ['-C', integration, ...args], { encoding: 'utf8', windowsHide: true })
  git(['init']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid'])
  writeFileSync(join(integration, 'source'), 'saved implementation'); git(['add', 'source']); git(['commit', '-m', 'fixture'])
  const base = git(['rev-parse', 'HEAD']).trim()
  git(['checkout', '-b', 'source']); writeFileSync(join(integration, 'source'), 'corrected implementation'); git(['commit', '-am', 'source change'])
  const commit = git(['rev-parse', 'HEAD']).trim()
  git(['checkout', '-b', 'integration', base]); writeFileSync(join(integration, 'other'), 'unrelated preserved'); git(['add', 'other']); git(['commit', '-m', 'integration advance']); git(['cherry-pick', '-x', commit])
  const registry = { 'T-1': { state: 'integrated', cleaned: true, commit, baseCommit: commit, integrationWorkspace: integration, worktreePath: residual } }
  writeFileSync(join(f.tasksDir, '.board-worktrees.json'), JSON.stringify(registry))
  await reconcilePlannerAssignment(f.options)
  assert.equal(readCardPlanners(f.tasksDir)['T-1'].lifecycle, 'retired')
  assert.equal(readFileSync(join(residual, '.next', 'evidence.log'), 'utf8'), 'preserved build output')
  assert.equal(readFileSync(join(f.tasksDir, '.board-worktrees.json'), 'utf8'), JSON.stringify(registry))
  const history = readFileSync(join(f.tasksDir, '.history', 'T-1.jsonl'), 'utf8')
  assert.match(history, /Unregistered residual preserved unchanged/)
  assert.match(history, new RegExp(commit))
})

test('retire preserves originals/counters and clears only stale eligibility; old callbacks and delivery cannot replay', async t => {
  const f = fixture(t)
  assert.match(f.eligibility(), /Planner assignment/)
  const stale = readCardPlanners(f.tasksDir)
  saveDelivery('proof', 'old', { status: 'confirmed', text: 'saved prompt' })
  await reconcilePlannerAssignment(f.options)
  assert.equal(f.eligibility(), null)
  const owner = readCardPlanners(f.tasksDir)['T-1']
  assert.equal(owner.replacementAttempts, 1); assert.equal(owner.correctionRounds, 2)
  assert.deepEqual(readCardPlanners(f.tasksDir)['T-2'], { paneId: 'other' })
  assert.equal(readFileSync(findCard(f.tasksDir, 'T-1').path, 'utf8'), f.card)
  const history = readFileSync(join(f.tasksDir, '.history', 'T-1.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.deepEqual(history[0].assignment, f.owner)
  assert.equal(Buffer.from(history[0].originalBase64, 'base64').toString(), f.card)
  assert.equal(history[0].output, 'Saved output'); assert.equal(history[0].session.agent_session, 'saved-session')
  stale['T-1'].submitted = false
  assert.throws(() => saveCardPlanners(f.tasksDir, stale), /stale callback/)
  assert.throws(() => assertPlannerAssignment(f.tasksDir, 'T-1', f.owner), /stale callback/)
  assert.throws(() => assertPlannerHandoff(f.tasksDir, 'T-1'), /stale callback/)
  assert.throws(() => assertPlannerPaneAllowed('proof', 'old'), /stale callback/)
  assert.doesNotThrow(() => assertPlannerPaneAllowed('other', 'old'))
  assert.equal(pendingDeliveries('proof').length, 0)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})

test('pending/running/unresolved blocked retirement refuses before mutation; independent CAS merges', async t => {
  const f = fixture(t), original = readFileSync(join(f.tasksDir, '.card-planners.json'), 'utf8')
  f.agents[0].agent_status = 'working'
  await assert.rejects(reconcilePlannerAssignment(f.options), /Running/)
  f.agents[0].agent_status = 'blocked'
  await assert.rejects(reconcilePlannerAssignment(f.options), /unresolved blocked/)
  f.agents[0].agent_status = 'done'
  saveDelivery('proof', 'old', { status: 'paused', text: 'pending' })
  await assert.rejects(reconcilePlannerAssignment(f.options), /Pending/)
  assert.equal(readFileSync(join(f.tasksDir, '.card-planners.json'), 'utf8'), original)
  const a = readCardPlanners(f.tasksDir), b = readCardPlanners(f.tasksDir)
  a['T-1'].note = 'first'; saveCardPlanners(f.tasksDir, a)
  b['T-2'].note = 'second'; saveCardPlanners(f.tasksDir, b)
  assert.equal(readCardPlanners(f.tasksDir)['T-1'].note, 'first')
})

test('explicit recovered Planner gets new identity, retains counters and stops before Builder even Auto-review on', async t => {
  const f = fixture(t, 'planning')
  await reconcilePlannerAssignment({ ...f.options, recovery: true })
  const registry = { 'T-1': { state: 'issue', reason: 'Two preserved commits', files: ['app.mjs'] } }
  writeFileSync(join(f.tasksDir, '.board-worktrees.json'), JSON.stringify(registry))
  assert.equal(f.eligibility(), null)
  const run = authorizeCardRun({ project: 'Proof', cardId: 'T-1', autoReview: true, requestId: randomUUID() })
  assert.equal(run.planningRecoveryOnly, true)
  let starts = 0, builds = 0
  const plannerIO = { agentList: async () => [{ pane_id: 'new', agent_status: 'idle' }], agentWorkspaceOr: async () => 'test', tabCreate: async () => ({ root_pane: { pane_id: 'new' } }), waitForPrompt: async () => {}, agentStart: async () => { starts++ }, paneClose: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {}, deliver: async (pane, text) => {
    assert.match(text, /--planner-assignment/); assert.match(text, /Recovery provenance/)
    assertPromptAllowed('proof', { paneId: pane, action: 'prompt' })
    const owner = readCardPlanners(f.tasksDir)['T-1']
    assertPlannerHandoff(f.tasksDir, 'T-1', owner.assignmentId)
    assert.throws(() => assertPlannerHandoff(f.tasksDir, 'T-1', 'old'), /stale callback/)
    moveCard(f.tasksDir, 'T-1', 'planned')
  } }
  const options = { project: 'Proof', projectPath: join(f.root, 'Proof'), tasksDir: f.tasksDir, boardRoot: f.root, config: f.config, agents: [], io: { runCardPlanner: o => runCardPlanner({ ...o, io: plannerIO }), autoSpawn: () => { builds++ } } }
  await tickCardRun(options); await tickCardRun(options)
  assert.equal(starts, 1); assert.equal(builds, 0); assert.equal(activeCardRun(), undefined)
  assert.match(readCardRuns()[0].reason, /Planning recovery handed off/)
  assert.equal(readCardPlanners(f.tasksDir)['T-1'].replacementAttempts, 1)
  assert.equal(readFileSync(join(f.tasksDir, '.board-worktrees.json'), 'utf8'), JSON.stringify(registry))
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})
