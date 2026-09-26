// A failed agent start (Tradeflow T-41: agent_pane_busy) or a prompt left unsubmitted
// closes that pane, is recorded on the card history, and retries once with a fresh
// tab on the next poll; a second failure in a row goes to Owner with one question.
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Reviewer spawns talk to HERDR and the global claim ledger; fake both.
const herdr = { closed: [], startError: null }
mock.module('./lib/herdr.mjs', { namedExports: {
  sessionOf: p => String(p).toLowerCase(), herdrLog: () => {}, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => true,
  tabCreate: async () => ({ root_pane: { pane_id: 'r1' }, tab: { tab_id: 't1' } }),
  agentStart: async () => { if (herdr.startError) throw new Error(herdr.startError) },
  agentList: async () => [], agentsForProject: async () => [], agentPrompt: async () => {}, paneRead: async () => '', paneSendKeys: async () => {},
  paneClose: async pane => { herdr.closed.push(pane) }, isSpawning: () => false, beginSpawn: () => {}, endSpawn: () => {},
} })
const ledger = { failed: [], uncertain: [] }
mock.module('./lib/review-claims.mjs', { namedExports: {
  syncReviewClaims: () => [], readReviewClaims: () => [], reserveReview: () => ({ id: 'c1' }), prepareReviewSnapshot: (root, projectPath) => ({ path: projectPath }),
  updateReviewClaim: (root, id, patch) => { if (patch.phase === 'uncertain') ledger.uncertain.push(id) },
  failReviewClaim: (root, id) => { ledger.failed.push(id) }, assertReviewInputs: () => {}, snapshotContains: () => true, reviewClaimFor: () => null,
} })

const root = mkdtempSync(join(tmpdir(), 'start-retry-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
writeFileSync(join(root, 'board.config.json'), JSON.stringify({ projectsRoot: root, projects: ['Proof'], maxConcurrentAgents: 10, models: {} }))
process.env.KANBAN_CONFIG = join(root, 'board.config.json')
const { deliverWith, stagedPrompt, recordStartFailure } = await import('./lib/spawn.mjs')
const { autoSpawn, holdsFor, spawnReviewer } = await import('./lib/autospawn.mjs')
const { runCardPlanner, readCardPlanners, operatorRetry } = await import('./lib/card-planner.mjs')
const { createCard, findCard, moveCard } = await import('./lib/cards.mjs')
const { readWorkflow } = await import('./lib/workflow-state.mjs')
const { historyPath } = await import('./lib/card-history.mjs')

let n = 0
const project = () => { const tasks = join(root, `P${++n}`, 'TASKS'); mkdirSync(tasks, { recursive: true }); return tasks }
const events = (tasks, id) => readFileSync(historyPath(tasks, id), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'start-failed')
const plan = '**Workflow:** card-owned\n## Approved brief\nDeliver\n## Files\n- `app.mjs` result\n## Implementation plan\nChange app.mjs\n## Acceptance criteria\n- AC1: result\n## Outcome checks\nAC1 | app.mjs | node check.mjs | break it\n## Prerequisites\nNone\n'

test('a swallowed Enter on a staged paste is pressed again until the agent works', async () => {
  let enters = 0, prompts = 0
  await deliverWith({ paneId: 'p', text: 'long task prompt', confirmMs: 10,
    prompt: async () => { prompts++ }, sendKeys: async () => { enters++ },
    list: async () => [{ pane_id: 'p', agent_status: enters >= 2 ? 'working' : 'idle' }],
    read: async () => enters >= 2 ? '' : 'earlier output\n› [Pasted Content 4232 chars]\n  ? for shortcuts' })
  assert.equal(prompts, 1, 'never a second paste')
  assert.equal(enters, 2, 'the first Enter was swallowed, the second submitted it')
})

test('the prompt text still on the input line counts as staged; placeholders and old scrollback do not', async () => {
  const text = 'Plan only this card; do not delegate. Remain idle after the plan.'
  assert.equal(stagedPrompt('│ › Plan only this card; do not delegate. │', text), true)
  assert.equal(stagedPrompt('› Improve documentation in @filename', text), false, 'Codex placeholder')
  assert.equal(stagedPrompt(['[Pasted Content 900 chars]', ...Array(20).fill('worked on it'), '›'].join('\n'), text), false, 'an earlier paste far up the scrollback')
  let enters = 0
  await deliverWith({ paneId: 'p', text, confirmMs: 10, prompt: async () => {}, sendKeys: async () => { enters++ },
    list: async () => [{ pane_id: 'p', agent_status: enters >= 2 ? 'working' : 'idle' }],
    read: async () => '› Plan only this card; do not delegate. Remain idle' })
  assert.equal(enters, 2)
})

test('a brief working flash with the paste still on the input line is not a delivery (Injectbuddy I149)', async () => {
  let enters = 0
  await deliverWith({ paneId: 'p', text: 'task', confirmMs: 10, prompt: async () => {}, sendKeys: async () => { enters++ },
    list: async () => [{ pane_id: 'p', agent_status: 'working' }],
    read: async () => enters ? '› Improve documentation in @filename' : '› [Pasted Content 2668 chars][Pasted Content\n  1572 chars]\n\n  GPT-6-Sol high' })
  assert.equal(enters, 1)
})

test('a paste still unsubmitted after three Enters is a failed start, not a preserved pane', async () => {
  let enters = 0
  const err = await deliverWith({ paneId: 'p', text: 'task', confirmMs: 1, prompt: async () => {}, sendKeys: async () => { enters++ },
    list: async () => [{ pane_id: 'p', agent_status: 'idle' }], read: async () => '› [Pasted Content 4232 chars]' }).catch(e => e)
  assert.equal(enters, 3)
  assert.match(err.message, /unsubmitted/)
  assert.equal(err.startFailed, true); assert.equal(err.unsubmitted, true); assert.ok(!err.preservePane)
})

test('recordStartFailure: first failure waits for the retry, second in a row for the same role asks Owner', () => {
  const tasks = project()
  mkdirSync(join(tasks, 'review')); writeFileSync(join(tasks, 'review', 'T-1.md'), '# T-1 — task\n' + plan)
  assert.equal(recordStartFailure(tasks, 'T-1', 'builder', 'timeout'), null)
  assert.equal(recordStartFailure(tasks, 'T-1', 'reviewer', 'busy'), null, 'another role starts its own count')
  const moved = recordStartFailure(tasks, 'T-1', 'reviewer', 'agent_pane_busy')
  assert.equal(moved.column, 'owner')
  assert.match(readFileSync(moved.path, 'utf8'), /Needs you: The Reviewer for T-1 failed to start twice in a row \(last error: agent_pane_busy\)[\s\S]*Should the board try again\? Drag it back to Review/)
  assert.deepEqual(events(tasks, 'T-1').map(e => [e.role, e.count, e.reason]), [['builder', 1, 'timeout'], ['reviewer', 1, 'busy'], ['reviewer', 2, 'agent_pane_busy']])
  operatorRetry(tasks, 'T-1', 'review')
  assert.equal(readWorkflow(tasks)['T-1'].startFailure, null, 'dragging it back restarts the count')
})

test('Planner: agent_pane_busy closes the pane, retries with a fresh tab next poll, then Owner (Tradeflow T-41)', async () => {
  const tasks = project()
  const card = createCard(tasks, { title: 'Proof', brief: 'A specific approved outcome' })
  let agents = [], panes = 0, fail = 2
  const closes = [], tabs = []
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
    tabCreate: async () => { tabs.push(`pane-${++panes}`); return { root_pane: { pane_id: `pane-${panes}` } } },
    agentStart: async ({ name, paneId }) => { if (fail-- > 0) throw new Error(`herdr agent start ${name}: agent_pane_busy: agent target pane ${paneId} is not an available shell`); agents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
    deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async pane => { closes.push(pane) }, paneRead: async () => '',
  }
  const args = { project: 'StartRetry', projectPath: tasks, tasksDir: tasks, boardRoot: tasks, model: 'm', io }
  await assert.rejects(runCardPlanner(args), /agent_pane_busy/)
  let owner = readCardPlanners(tasks)[card.id]
  assert.deepEqual(closes, ['pane-1'])
  assert.equal(owner.startRetry, true); assert.equal(owner.submitted, false); assert.deepEqual(owner.revokedPaneIds, ['pane-1'])
  assert.equal(readWorkflow(tasks)[card.id].operational, undefined, 'no hold: the next poll retries')
  assert.equal(findCard(tasks, card.id).column, 'planning')
  assert.equal(events(tasks, card.id).length, 1)

  await assert.rejects(runCardPlanner(args), /agent_pane_busy/)
  assert.deepEqual(tabs, ['pane-1', 'pane-2'], 'the retry opened a fresh tab')
  assert.equal(findCard(tasks, card.id).column, 'owner')
  assert.match(readFileSync(findCard(tasks, card.id).path, 'utf8'), /Needs you: The Planner for .* failed to start twice in a row[\s\S]*Drag it back to Planning/)

  // The operator drags it back: a fresh Planner starts and the count clears.
  moveCard(tasks, card.id, 'planning'); operatorRetry(tasks, card.id, 'planning')
  const started = await runCardPlanner(args)
  assert.equal(started.pane_id, 'pane-3')
  owner = readCardPlanners(tasks)[card.id]
  assert.equal(owner.startRetry, undefined); assert.equal(owner.submitted, true)
  assert.equal(readWorkflow(tasks)[card.id].startFailure, null)
})

test('Builder: a failed start returns the card to Queue without a hold, retries next poll, then Owner', async () => {
  const tasks = project()
  mkdirSync(join(tasks, 'queue')); writeFileSync(join(tasks, 'queue', 'T-1.md'), '# T-1 — task\n' + plan)
  let calls = 0
  const spawn = async () => { calls++; throw Object.assign(new Error('agent start failed: timed out after 240000ms'), { startFailed: true }) }
  const args = { project: 'BuilderRetry', projectPath: join(tasks, '..'), tasksDir: tasks, max: 2, agents: [], spawn }
  await autoSpawn(args)
  assert.equal(findCard(tasks, 'T-1').column, 'queue')
  assert.equal(readWorkflow(tasks)['T-1'].operational, undefined)
  assert.match(holdsFor('BuilderRetry')['T-1'], /retrying once with a fresh tab/)
  await autoSpawn(args)
  assert.equal(calls, 2)
  assert.equal(findCard(tasks, 'T-1').column, 'owner')
  assert.match(readFileSync(findCard(tasks, 'T-1').path, 'utf8'), /The Builder for T-1 failed to start twice in a row[\s\S]*Drag it back to Queue/)
})

test('Reviewer: a failed start closes the pane, releases the claim and retries; the second failure asks Owner', async () => {
  const tasks = project()
  mkdirSync(join(tasks, 'review')); writeFileSync(join(tasks, 'review', 'T-1.md'), '# T-1 — task\n' + plan)
  herdr.startError = 'agent_pane_busy: agent target pane r1 is not an available shell'
  const args = { project: 'Proof', projectPath: join(tasks, '..'), tasksDir: tasks, boardRoot: root, reviewRoot: root, model: 'm', inventory: async () => [] }
  await assert.rejects(spawnReviewer(args), /reviewer spawn failed: agent_pane_busy/)
  assert.deepEqual(herdr.closed, ['r1']); assert.deepEqual(ledger.failed, ['c1']); assert.deepEqual(ledger.uncertain, [])
  assert.equal(readWorkflow(tasks)['T-1'].operational, undefined, 'no hold: the next poll retries')
  assert.equal(findCard(tasks, 'T-1').column, 'review')
  await assert.rejects(spawnReviewer(args), /agent_pane_busy/)
  assert.equal(findCard(tasks, 'T-1').column, 'owner')
  assert.match(readFileSync(findCard(tasks, 'T-1').path, 'utf8'), /The Reviewer for T-1 failed to start twice in a row/)
})
