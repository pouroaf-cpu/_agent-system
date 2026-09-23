import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { authorizeCardRun, activeCardRun, readCardRuns, stopCardRun, withCardRunAssignment, assertCardRunSelection, bindCardRunAssignment, resumeStagedCardRunEnter, interruptedCardRun } from './lib/card-run.mjs'
import { reserveReview, updateReviewClaim } from './lib/review-claims.mjs'
import { recoverReviewEnvironment } from './recover-review-environment.mjs'
import { assertPromptAllowed, setProjectPaused } from './lib/project-control.mjs'
import { cardRunEligibility, tickCardRun } from './lib/card-runner.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { pendingDeliveries, saveDelivery } from './lib/delivery-state.mjs'
import { deliver } from './lib/spawn.mjs'
import { recordOperationalFailure } from './lib/workflow-state.mjs'
import { autoSpawn, spawnReviewer, spawnIssuesSweeper } from './lib/autospawn.mjs'

const plan = '# T-1 — approved task\n**Workflow:** card-owned\n**Auto-review:** yes\n## Approved brief\nChange only this result\n## Files\n- `app.mjs` result\n## Implementation plan\nChange result\n## Acceptance criteria\nResult correct\n## Implementation\nDone\n## Evidence\nCheck passed\n'
function fixture(t, column = 'queue') {
  const root = mkdtempSync(join(tmpdir(), 'card-run-')), tasksDir = join(root, 'Proof', 'TASKS')
  mkdirSync(join(tasksDir, column), { recursive: true })
  writeFileSync(join(tasksDir, column, 'T-1.md'), plan)
  writeFileSync(join(root, 'Proof', 'app.mjs'), 'export const result = 1')
  const config = { projectsRoot: root, projects: ['Proof', 'Other'], projectControls: { Proof: { paused: true }, Other: { paused: true } }, maxConcurrentAgents: 0, models: { working: 'test', review: 'test' } }
  const configPath = join(root, 'board.config.json'); writeFileSync(configPath, JSON.stringify(config))
  const previous = process.env.KANBAN_CONFIG; process.env.KANBAN_CONFIG = configPath
  t.after(() => { if (previous === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = previous; rmSync(root, { recursive: true, force: true }) })
  const options = { project: 'Proof', projectPath: join(root, 'Proof'), tasksDir, boardRoot: root, reviewRoot: root, agents: [], config, known: true }
  const authorize = (autoReview = true) => authorizeCardRun({ project: 'Proof', cardId: 'T-1', autoReview, requestId: randomUUID() })
  return { root, configPath, options, tasksDir, authorize }
}
const prompt = (paneId, action = 'prompt') => assertPromptAllowed('proof', { paneId, action })

test('assignment identity, mixed-card denial, duplicate click/prompt/Enter, and zero capacity', async t => {
  const f = fixture(t, 'working'), requestId = randomUUID()
  const run = authorizeCardRun({ project: 'Proof', cardId: 'T-1', autoReview: true, requestId })
  assert.equal(authorizeCardRun({ project: 'Proof', cardId: 'T-1', autoReview: true, requestId }).runId, run.runId)
  assert.throws(() => f.authorize(), /active/)
  assert.throws(() => assertPromptAllowed('proof'), /paused/)
  await withCardRunAssignment(run, 'builder', async () => {
    assertCardRunSelection('Proof', ['T-1'], 'builder')
    assert.throws(() => assertCardRunSelection('Proof', ['T-2'], 'builder'), /match/)
    assert.throws(() => assertPromptAllowed('other'), /match/)
    await assert.rejects(autoSpawn({ project: 'Proof', onlyIds: ['T-2'] }), /match/)
    await assert.rejects(spawnReviewer({ project: 'Proof', cardIds: ['T-1', 'T-2'] }), /match/)
    await assert.rejects(spawnIssuesSweeper({ project: 'Proof' }), /not permitted/)
    assert.throws(() => prompt('p'), /pane mismatch/)
    bindCardRunAssignment('Proof', ['T-1'], 'builder', 'p')
    prompt('p', 'start'); prompt('p')
    assert.throws(() => prompt('wrong'), /pane mismatch/)
    assert.throws(() => prompt('p'), /Duplicate prompt/)
    prompt('p', 'enter'); assert.throws(() => prompt('p', 'enter'), /duplicate Enter/)
  })
  await assert.rejects(withCardRunAssignment(run, 'builder', async () => {}), /already assigned/)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})

test('remaining review recovery requires Builder handoff and never replays earlier stages', async t => {
  const f = fixture(t, 'completed')
  const eligibility = () => cardRunEligibility({ ...f.options, card: findCard(f.tasksDir, 'T-1') })
  assert.match(eligibility(), /Builder completion/)
  writeFileSync(join(f.tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working' } }))
  assert.equal(eligibility(), null)
  const run = f.authorize(); assert.equal(run.reviewOnly, true)
  let reviews = 0
  const io = { autoSpawn: () => assert.fail('Builder replay'), runCardPlanner: () => assert.fail('Planner replay'), spawnReviewer: async () => {
    reviews++; moveCard(f.tasksDir, 'T-1', 'review'); bindCardRunAssignment('Proof', ['T-1'], 'reviewer', 'r'); prompt('r')
  } }
  await tickCardRun({ ...f.options, io })
  await tickCardRun({ ...f.options, agents: [{ pane_id: 'r', agent_status: 'working' }], io })
  assert.equal(reviews, 1)
  stopCardRun('Proof', 'T-1', 'operator cancelled')
  moveCard(f.tasksDir, 'T-1', 'queue')
  // A cancelled review never restarts itself, regardless of the card moving.
  await tickCardRun({ ...f.options, io }); assert.equal(reviews, 1)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})

test('concurrent filesystem handoff makes stale eligibility fail closed, not crash', t => {
  const f = fixture(t), card = findCard(f.tasksDir, 'T-1')
  const board = { queue: [card] }
  moveCard(f.tasksDir, 'T-1', 'working')
  assert.match(cardRunEligibility({ ...f.options, board, card }), /changed during inspection/)
})

test('explicit timed-out Reviewer recovery submits same staged task once with fresh authorization', async t => {
  const f = fixture(t, 'review'), run = f.authorize()
  const claim = reserveReview(f.root, { project: 'Proof', tasksDir: f.tasksDir, cards: ['T-1'], inventory: [{ project: 'Proof', tasksDir: f.tasksDir, known: true, agents: [] }] })
  updateReviewClaim(f.root, claim.id, { paneId: 'r', phase: 'running' })
  await withCardRunAssignment(run, 'reviewer', async () => { bindCardRunAssignment('Proof', ['T-1'], 'reviewer', 'r'); prompt('r') })
  saveDelivery('proof', 'r', { status: 'confirmed', runId: run.runId, text: 'existing task' })
  stopCardRun('Proof', 'T-1', 'Agent ended without the required handoff; no retry')
  let enters = 0
  const io = { agentList: async () => [{ pane_id: 'r', agent_status: 'done' }], paneRead: async () => 'Pasted Content', paneSendKeys: async () => { prompt('r', 'enter'); enters++ } }
  await assert.rejects(resumeStagedCardRunEnter('Proof', run.runId, 'reviewer', { requestId: randomUUID(), io: { ...io, paneRead: async () => 'ordinary idle prompt' } }), /visibly staged/)
  const recovered = await resumeStagedCardRunEnter('Proof', run.runId, 'reviewer', { requestId: randomUUID(), io })
  assert.notEqual(recovered.runId, run.runId); assert.equal(enters, 1)
  assert.equal(activeCardRun().reviewOnly, true); assert.equal(activeCardRun().stages.reviewer.entered, true)
  await assert.rejects(resumeStagedCardRunEnter('Proof', run.runId, 'reviewer', { requestId: randomUUID(), io }), /authorization/)
  assert.equal(enters, 1); assert.equal(readCardRuns()[0].status, 'stopped')
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})

test('environment recovery targets the existing idle Reviewer and preserves pause/counters', async t => {
  const f = fixture(t, 'review'), env = join(f.root, 'approved.env')
  writeFileSync(env, 'APP_TEST=fixture')
  const config = JSON.parse(readFileSync(f.configPath)); config.projectSettings = { Proof: { envFile: env } }; writeFileSync(f.configPath, JSON.stringify(config))
  writeFileSync(join(f.tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { operational: { historyId: 'held', reason: 'missing env for check' } } }))
  const claim = reserveReview(f.root, { project: 'Proof', tasksDir: f.tasksDir, cards: ['T-1'], inventory: [{ project: 'Proof', tasksDir: f.tasksDir, known: true, agents: [] }] })
  updateReviewClaim(f.root, claim.id, { paneId: 'r', snapshot: { path: f.options.projectPath } })
  let deliveries = 0
  const options = { project: 'Proof', cardId: 'T-1', historyId: 'held', requestId: randomUUID(), io: {
    agentList: async () => [{ pane_id: 'r', agent_status: 'done' }], paneRead: async () => 'finished', deliver: async (pane, text) => { assert.equal(pane, 'r'); assert.ok(text.includes(env)); prompt('r'); deliveries++ }
  } }
  await assert.rejects(recoverReviewEnvironment({ ...options, historyId: 'wrong' }), /Exact operational/)
  await recoverReviewEnvironment(options)
  assert.equal(deliveries, 1); assert.equal(activeCardRun().reviewOnly, true)
  await assert.rejects(recoverReviewEnvironment(options), /no active/)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})

test('Pause/cancel blocks further Enter and stale explicit delivery never joins ordinary resume', async t => {
  const f = fixture(t, 'working'), run = f.authorize()
  await assert.rejects(withCardRunAssignment(run, 'builder', async () => {
    bindCardRunAssignment('Proof', ['T-1'], 'builder', 'p'); prompt('p'); setProjectPaused('Proof', true)
    assert.throws(() => prompt('p', 'enter'), /match/)
    await deliver('p', 'old assignment', 'proof')
  }), /match/)
  saveDelivery('proof', 'old', { runId: run.runId, status: 'paused', text: 'stale' })
  assert.equal(pendingDeliveries('proof').length, 0)
  assert.equal(activeCardRun(), undefined)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
  assert.equal(readCardRuns()[0].status, 'stopped')
})

test('restart retains authorization but interrupted reserved stage fails closed without replay', async t => {
  assert.equal(interruptedCardRun({ stages: { reviewer: { status: 'reserved', owner: 'live-maintenance', ownerPid: process.pid } } }), false)
  const f = fixture(t, 'working')
  const script = `import {authorizeCardRun,withCardRunAssignment} from './lib/card-run.mjs'; import {randomUUID} from 'node:crypto'; const r=authorizeCardRun({project:'Proof',cardId:'T-1',autoReview:true,requestId:randomUUID()}); await withCardRunAssignment(r,'builder',async()=>process.exit(0));`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('.', import.meta.url), env: process.env, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  assert.ok(activeCardRun())
  await tickCardRun(f.options)
  assert.equal(activeCardRun(), undefined)
  assert.match(readCardRuns()[0].reason, /Interrupted/)
})

test('selected normal stages; Auto-review snapshot off stops ready, on starts one Reviewer then verdict stops', async t => {
  const f = fixture(t, 'planning'); let builds = 0, plans = 0, reviews = 0
  const io = {
    runCardPlanner: async o => { plans++; assert.deepEqual(o.onlyIds, ['T-1']); bindCardRunAssignment('Proof', ['T-1'], 'planner', 'planner'); prompt('planner'); moveCard(f.tasksDir, 'T-1', 'planned'); return { cards: ['T-1'] } },
    autoSpawn: async o => { builds++; assert.deepEqual(o.onlyIds, ['T-1']); assert.equal(o.max, 1); moveCard(f.tasksDir, 'T-1', 'working'); bindCardRunAssignment('Proof', ['T-1'], 'builder', 'builder'); prompt('builder'); moveCard(f.tasksDir, 'T-1', 'completed'); return ['T-1'] },
    spawnReviewer: async o => { reviews++; assert.deepEqual(o.cardIds, ['T-1']); moveCard(f.tasksDir, 'T-1', 'review'); bindCardRunAssignment('Proof', ['T-1'], 'reviewer', 'reviewer'); prompt('reviewer'); return {} },
  }
  f.authorize(false)
  for (let n = 0; n < 3; n++) await tickCardRun({ ...f.options, io })
  assert.equal(readCardRuns()[0].status, 'ready-review'); assert.equal(reviews, 0); assert.equal(builds, 1); assert.equal(plans, 1)
  moveCard(f.tasksDir, 'T-1', 'queue'); f.authorize(true)
  await tickCardRun({ ...f.options, io }); await tickCardRun({ ...f.options, io })
  assert.equal(reviews, 1)
  appendFileSync(findCard(f.tasksDir, 'T-1').path, '\n## Reviewer evidence\nIndependent check failed criterion\n**Review verdict:** FAIL\n')
  await tickCardRun({ ...f.options, io }); assert.equal(activeCardRun(), undefined)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})

test('eligibility rejects blockers/Owner/completed/old assignments; operational failure revokes without loops', async t => {
  const f = fixture(t)
  const eligibility = () => cardRunEligibility({ ...f.options, card: findCard(f.tasksDir, 'T-1') })
  assert.equal(eligibility(), null)
  appendFileSync(findCard(f.tasksDir, 'T-1').path, '\n**Blocked by:** T-99\n')
  assert.match(eligibility(), /Blocked by T-99/)
  moveCard(f.tasksDir, 'T-1', 'owner'); assert.match(eligibility(), /Only approved/)
  moveCard(f.tasksDir, 'T-1', 'completed'); assert.match(eligibility(), /Builder completion/)
  moveCard(f.tasksDir, 'T-1', 'queue')
  f.authorize()
  recordOperationalFailure(f.tasksDir, findCard(f.tasksDir, 'T-1'), 'setup missing', f.options.projectPath)
  assert.equal(activeCardRun(), undefined)
  assert.match(readCardRuns()[0].reason, /setup missing/)
  assert.equal(JSON.parse(readFileSync(f.configPath)).maxConcurrentAgents, 0)
})
