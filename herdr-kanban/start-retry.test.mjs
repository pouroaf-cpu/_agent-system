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

// Injectbuddy I213 Builder pane, 2026-09-26 04:21Z: Claude Code shows `❯` and wraps the
// typed pointer inside its box, so the prompt sat unsubmitted for 17 minutes.
const CLAUDE_RULE = '─'.repeat(64)
const CLAUDE_STAGED = `   Claude Code v2.1.281
  Sonnet 5 with medium effort · Claude Pro


${CLAUDE_RULE}
❯\u00a0Read
  C:/Users/PFrew/Projects/herdr-kanban/.deliveries/f1dcc5c8ea0
  0ba52a99fe65b0e88194cd570c304087ddb7d879051a1cf8ae85c.md
  (revision cbe860196adc9bbf6dc041eca8a8ffdd5114a0009aecad47d2
  aa76918285afd8) and follow it exactly; it is your complete
  task.

${CLAUDE_RULE}
  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SE…
  i213-muhvr4z3-36368  |  Ctx --  |  ~1.3M/h  |  5h --  |  7d…`
const CLAUDE_SUBMITTED = `   Claude Code v2.1.281


${CLAUDE_RULE}
❯
${CLAUDE_RULE}
  ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SE…
  i213-muhvr4z3-36368  |  Ctx --  |  ~1.4M/h  |  5h 54% (1h16…
  ⏵⏵ bypass permissions on (shift+tab to cycle)`
const I213_POINTER = 'Read C:/Users/PFrew/Projects/herdr-kanban/.deliveries/f1dcc5c8ea00ba52a99fe65b0e88194cd570c304087ddb7d879051a1cf8ae85c.md (revision cbe860196adc9bbf6dc041eca8a8ffdd5114a0009aecad47d2aa76918285afd8) and follow it exactly; it is your complete task.'

test("a Claude prompt wrapped inside its ❯ box is staged; the empty ❯ line after submission is not (Injectbuddy I213)", async () => {
  const { stagedInput } = await import('./lib/spawn.mjs')
  assert.equal(stagedInput(CLAUDE_STAGED, I213_POINTER), true)
  assert.equal(stagedPrompt(CLAUDE_STAGED, I213_POINTER), true)
  assert.equal(stagedInput(CLAUDE_SUBMITTED, I213_POINTER), false)
  assert.equal(stagedPrompt(CLAUDE_SUBMITTED, I213_POINTER), false)
  let enters = 0
  await deliverWith({ paneId: 'p', text: I213_POINTER, confirmMs: 10, prompt: async () => {}, sendKeys: async () => { enters++ },
    list: async () => [{ pane_id: 'p', agent_status: enters >= 2 ? 'working' : 'idle' }],
    read: async () => enters >= 2 ? CLAUDE_SUBMITTED : CLAUDE_STAGED })
  assert.equal(enters, 2, 'Enters until the Claude agent works, no delivery failure')
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
  assert.equal(recordStartFailure(tasks, 'T-1', 'builder', 'agent quit at start'), null)
  assert.equal(recordStartFailure(tasks, 'T-1', 'reviewer', 'busy'), null, 'another role starts its own count')
  const moved = recordStartFailure(tasks, 'T-1', 'reviewer', 'agent_pane_busy')
  assert.equal(moved.column, 'owner')
  assert.match(readFileSync(moved.path, 'utf8'), /Needs you: The Reviewer for T-1 failed to start twice in a row \(last error: agent_pane_busy\)[\s\S]*Should the board try again\? Drag it back to Review/)
  assert.deepEqual(events(tasks, 'T-1').map(e => [e.role, e.count, e.reason]), [['builder', 1, 'agent quit at start'], ['reviewer', 1, 'busy'], ['reviewer', 2, 'agent_pane_busy']])
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
  const spawn = async () => { calls++; throw Object.assign(new Error('agent start failed: agent_pane_busy: agent target pane p is not an available shell'), { startFailed: true }) }
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

test('Builder: a start refused by a pause returns the card to Queue and closes its pane, counting nothing (I496)', async () => {
  const tasks = project()
  mkdirSync(join(tasks, 'queue')); writeFileSync(join(tasks, 'queue', 'T-1.md'), '# T-1 — task\n' + plan)
  const spawn = async ({ onPane }) => { onPane({ pane_id: 'paused-pane', name: 'b-t-1' }); throw Object.assign(new Error('Project p is paused; assignment retained pending Start'), { paused: true, preservePane: true }) }
  await autoSpawn({ project: 'PausedStart', projectPath: join(tasks, '..'), tasksDir: tasks, max: 2, agents: [], spawn })
  assert.equal(findCard(tasks, 'T-1').column, 'queue')
  assert.ok(herdr.closed.includes('paused-pane'))
  herdr.closed.length = 0
  assert.equal(readWorkflow(tasks)['T-1']?.startFailure ?? null, null)
})

test('transient start failures (unsubmitted prompt, start timeout) back off with a visible retry time, Owner only after the budget (I157, TF50)', async () => {
  const { checkStalls } = await import('./lib/stall-watchdog.mjs')
  const tasks = project()
  mkdirSync(join(tasks, 'queue')); writeFileSync(join(tasks, 'queue', 'T-1.md'), '# T-1 — task\n' + plan)
  const t0 = Date.now(), min = 60000
  assert.equal(recordStartFailure(tasks, 'T-1', 'builder', 'Builder prompt was never submitted', t0), null)
  assert.equal(recordStartFailure(tasks, 'T-1', 'builder', 'agent start failed: timed out after 240000ms', t0 + 2 * min), null)
  assert.equal(findCard(tasks, 'T-1').column, 'queue')
  assert.equal(readWorkflow(tasks)['T-1'].startFailure.nextAt, t0 + 7 * min, 'second backoff step is 5 minutes')
  let calls = 0
  await autoSpawn({ project: 'Backoff', projectPath: join(tasks, '..'), tasksDir: tasks, max: 2, agents: [], spawn: async () => { calls++; return {} }, now: t0 + 3 * min })
  assert.equal(calls, 0, 'no start before the retry time')
  assert.equal(findCard(tasks, 'T-1').column, 'queue')
  assert.match(holdsFor('Backoff')['T-1'], /^Builder start failed \(agent start failed: timed out after 240000ms\); retrying at \d{4}-/)
  assert.deepEqual(checkStalls({ tasksDir: tasks, holds: holdsFor('Backoff'), minutes: 1, now: t0 + 30 * min }), [], 'a backoff is a wait, not a stall')
  const moved = recordStartFailure(tasks, 'T-1', 'builder', 'Builder prompt was never submitted', t0 + 3 * 60 * min)
  assert.equal(moved.column, 'owner')
  assert.match(readFileSync(moved.path, 'utf8'), /Needs you: The Builder for T-1 kept failing to start for 3 hours/)
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

// Injectbuddy 2026-09-26 01:30Z: the Codex account ran out and every Planner printed this,
// went idle, and was counted as a no-handoff; I191, I221 and I240 reached Owner in minutes.
const CODEX_LIMIT = `│ >_ OpenAI Codex (v0.156.1)                │
╰───────────────────────────────────────────╯

› Read C:/Users/PFrew/Projects/herdr-
  kanban/.deliveries/7ea28d3e.md and follow it
  exactly; it is your complete task.


↳ Hook · PONYTAIL:FULL

■ You’ve hit your usage limit. Visit
https://chatgpt.com/codex/settings/usage to
purchase more credits or try again at Oct
1st, 2026 10:36 AM.


› Ask Codex to do anything

  GPT-6-Sol high · ~\\KanbanProjec…  ⚠ 4 · f2`

test('an engine usage-limit screen is recognised with its reset time; other output is not', async () => {
  const { usageLimit } = await import('./lib/quota.mjs')
  const now = Date.parse('2026-09-26T01:33:14Z'), hour = 3600000
  assert.deepEqual(usageLimit(CODEX_LIMIT, now), { until: new Date(2026, 9, 1, 10, 36).getTime() }, 'local time, as Codex prints it')
  assert.equal(usageLimit('saved planner output\n› Ask Codex to do anything', now), null)
  assert.equal(usageLimit(`■ You’ve hit your usage limit. Try again later.\n${'working on the card\n'.repeat(30)}`, now), null, 'only the end of the screen counts, not old scrollback')
  assert.deepEqual(usageLimit('Claude usage limit reached. Your limit will reset soon.', now), { until: now + hour }, 'unreadable reset: an hour')
  const five = new Date(now); five.setHours(17, 0, 0, 0); if (five <= now) five.setDate(five.getDate() + 1)
  assert.deepEqual(usageLimit('5-hour limit reached ∙ resets 5pm', now), { until: five.getTime() })
  assert.deepEqual(usageLimit('Claude AI usage limit reached|1790400000', now), { until: 1790400000000 })
  assert.deepEqual(usageLimit('■ Selected model is at capacity. Please try a\ndifferent model.\n › Ask Codex to do anything', now), { until: now + 15 * 60000, modelCap: true }, 'I534: a busy model waits 15 min on that model only')
})

test('a usage limit blocks that engine: the card keeps its lane with no failure counted, nothing of that engine starts, the wait is not a stall, and work resumes after the reset', async () => {
  const { quotaHold, quotaHolds } = await import('./lib/quota.mjs')
  const { checkStalls } = await import('./lib/stall-watchdog.mjs')
  const { readBoard } = await import('./lib/cards.mjs')
  const tasks = project(), boardRoot = join(tasks, '..')
  const card = createCard(tasks, { title: 'Proof', brief: 'A specific approved outcome' })
  mkdirSync(join(tasks, 'queue')); writeFileSync(join(tasks, 'queue', 'T-9.md'), '# T-9 — task\n' + plan)
  const now = Date.now(), until = Math.ceil((now + 2 * 86400000) / 60000) * 60000
  const reset = new Date(until).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  let agents = [], panes = 0, screen = ''
  const closes = []
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
    tabCreate: async () => ({ root_pane: { pane_id: `q-${++panes}` } }),
    agentStart: async ({ name, paneId }) => { agents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
    deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async pane => { closes.push(pane); agents = [] }, paneRead: async () => screen,
  }
  const args = { project: 'Quota', projectPath: tasks, tasksDir: tasks, boardRoot, model: 'gpt-6-sol', engine: 'codex', io, handoffGraceMs: 10 }
  await runCardPlanner({ ...args, now })
  screen = CODEX_LIMIT.replace('Oct\n1st, 2026 10:36 AM', reset)
  await runCardPlanner({ ...args, now: now + 1000 })
  await runCardPlanner({ ...args, now: now + 2000 })
  const owner = readCardPlanners(tasks)[card.id]
  assert.equal(findCard(tasks, card.id).column, 'planning')
  assert.equal(owner.noHandoffCount, undefined, 'not a no-handoff')
  assert.deepEqual(closes, ['q-1'], 'the idle pane is closed')
  const hold = `Codex usage limit; retrying at ${new Date(until).toISOString()}`
  assert.equal(quotaHold(boardRoot, 'codex', now + 3000), hold)
  assert.equal(quotaHold(boardRoot, 'claude', now + 3000), null, 'only that engine')

  await runCardPlanner({ ...args, now: now + 3000 })
  assert.equal(panes, 1, 'no Planner starts while blocked')
  let builds = 0
  const spawn = async () => { builds++; return { pane_id: 'b1' } }
  await autoSpawn({ project: 'QuotaBuild', projectPath: boardRoot, tasksDir: tasks, boardRoot, max: 2, agents: [], engine: { kind: 'codex' }, spawn, now: now + 3000 })
  assert.equal(builds, 0, 'no Builder starts while blocked')
  assert.equal(holdsFor('QuotaBuild')['T-9'], hold)
  const holds = quotaHolds(boardRoot, readBoard(tasks), () => 'codex', now + 3000)
  assert.deepEqual(holds, { [card.id]: hold, 'T-9': hold })
  assert.deepEqual(checkStalls({ tasksDir: tasks, holds, minutes: 1, now: now + 30 * 60000 }), [], 'waiting out the limit is not a stall')

  await runCardPlanner({ ...args, now: until + 1000 })
  assert.equal(panes, 2, 'after the reset a fresh Planner starts')
  assert.equal(readCardPlanners(tasks)[card.id].replacementAttempts, 0, 'not a failed-launch replacement')
  await autoSpawn({ project: 'QuotaBuild', projectPath: boardRoot, tasksDir: tasks, boardRoot, max: 2, agents: [], engine: { kind: 'codex' }, spawn, now: until + 1000 })
  assert.equal(builds, 1, 'and Builders start again')
})

test('Builder: a usage-limit screen sends the card back to Queue to wait instead of Issues; the Reviewer waits too', async () => {
  const { routeBuilderNoHandoff } = await import('./lib/autospawn.mjs')
  const { quotaHold } = await import('./lib/quota.mjs')
  const tasks = project(), boardRoot = join(tasks, '..')
  mkdirSync(join(tasks, 'working')); writeFileSync(join(tasks, 'working', 'T-1.md'), '# T-1 — task\n' + plan)
  const moved = routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-1', reason: 'Session b1 finished with status=done without a valid Builder handoff from Working', evidence: CODEX_LIMIT, workspace: boardRoot, boardRoot, engine: 'codex', now: Date.parse('2026-09-26T01:33:14Z') })
  assert.equal(moved.column, 'queue')
  assert.equal(readWorkflow(tasks)['T-1']?.operational, undefined, 'no failure recorded')
  assert.match(quotaHold(boardRoot, 'codex', Date.parse('2026-09-26T02:00:00Z')), /^Codex usage limit; retrying at /)

  mkdirSync(join(tasks, 'review')); writeFileSync(join(tasks, 'review', 'T-2.md'), '# T-2 — task\n' + plan)
  herdr.startError = null; herdr.closed = []
  const err = await spawnReviewer({ project: 'Proof', projectPath: boardRoot, tasksDir: tasks, boardRoot, reviewRoot: root, model: 'm', engine: 'codex', cardIds: ['T-2'], inventory: async () => [] }).catch(e => e)
  assert.equal(err.busy, true); assert.match(err.message, /Codex usage limit/)
  assert.deepEqual(herdr.closed, []); assert.equal(findCard(tasks, 'T-2').column, 'review')
})

// Audit 2026-09-26 finding 5: every board role runs on Claude, so a model's own cap (an
// Opus weekly limit) must not stop the Sonnet and Haiku agents; the shared 5-hour
// session limit still stops them all.
test('a model cap blocks only that model; the shared 5-hour limit blocks every Claude agent', async () => {
  const { quotaHold, quotaKey, activeQuota } = await import('./lib/quota.mjs')
  const { routeBuilderNoHandoff } = await import('./lib/autospawn.mjs')
  const tasks = project(), boardRoot = join(tasks, '..')
  const card = createCard(tasks, { title: 'Proof', brief: 'A specific approved outcome' })
  const now = Date.parse('2026-09-26T04:30:00Z'), until = new Date(2026, 9, 3, 10).getTime()
  let agents = [], panes = 0, screen = ''
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
    tabCreate: async () => ({ root_pane: { pane_id: `o-${++panes}` } }),
    agentStart: async ({ name, paneId }) => { agents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
    deliver: async () => {}, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async () => { agents = [] }, paneRead: async () => screen,
  }
  const args = { project: 'OpusCap', projectPath: tasks, tasksDir: tasks, boardRoot, model: 'claude-opus-5-5', engine: 'claude', io, handoffGraceMs: 10 }
  await runCardPlanner({ ...args, now })
  screen = `${CLAUDE_RULE}\n❯ \n${CLAUDE_RULE}\n  Opus weekly limit reached ∙ resets Oct 3, 10am`
  await runCardPlanner({ ...args, now: now + 1000 })
  await runCardPlanner({ ...args, now: now + 2000 })
  assert.equal(findCard(tasks, card.id).column, 'planning')
  assert.equal(quotaHold(boardRoot, quotaKey('claude', 'claude-opus-5-5'), now + 3000), `Claude claude-opus-5-5 usage limit; retrying at ${new Date(until).toISOString()}`)
  assert.equal(quotaHold(boardRoot, quotaKey('claude', 'claude-sonnet-5'), now + 3000), null, 'a Sonnet Builder still starts')
  const claudeBlocks = () => Object.keys(activeQuota(boardRoot, now + 3000)).filter(k => k.startsWith('claude')).sort() // earlier tests share the file
  assert.deepEqual(claudeBlocks(), ['claude:claude-opus-5-5'], 'the board payload names the blocked model')

  mkdirSync(join(tasks, 'working')); writeFileSync(join(tasks, 'working', 'T-7.md'), '# T-7 — task\n' + plan)
  routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'T-7', reason: 'Session b1 finished with status=done without a valid Builder handoff from Working', evidence: '5-hour limit reached ∙ resets 5pm', workspace: boardRoot, boardRoot, engine: 'claude', model: 'claude-sonnet-5', now })
  assert.match(quotaHold(boardRoot, quotaKey('claude', 'claude-haiku-4-5'), now + 3000), /^Claude usage limit; retrying at /, 'the session limit stops every Claude agent')
  assert.deepEqual(claudeBlocks(), ['claude', 'claude:claude-opus-5-5'])
})
