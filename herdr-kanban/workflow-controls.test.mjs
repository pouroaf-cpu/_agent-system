import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { controlState, setProjectPaused, assertPromptAllowed } from './lib/project-control.mjs'
import { deliverWith, deliver, typedPrompt, resumeDeliveries, MAX_TYPED } from './lib/spawn.mjs'
import { pendingDeliveries, saveDelivery, readDelivery, deliveryKey, promptPath } from './lib/delivery-state.mjs'
import { workerPrompt, reviewerPrompt, plannerPrompt } from './lib/prompt.mjs'
import { focusedText, appendHistory, historyPath, writeBrief, writeCurrentFeedback } from './lib/card-history.mjs'
import { failureDestination, operationalHold, recordOperationalFailure, readWorkflow, evidenceFingerprint } from './lib/workflow-state.mjs'
import { checkWorkflowLimits } from './lib/workflow-limits.mjs'
import { createCard, findCard, moveCard, validatePlan } from './lib/cards.mjs'
import { recoveryState } from './lib/recovery.mjs'
import { autoSpawn, routeReviewVerdicts } from './lib/autospawn.mjs'
import { bind, readBindings } from './lib/bindings.mjs'
import { readCardRuns } from './lib/card-run.mjs'
import { runCardPlanner } from './lib/card-planner.mjs'
import { readCardPlanners, saveCardPlanners } from './lib/planner-state.mjs'

const here = dirname(fileURLToPath(import.meta.url))
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-controls-'))
  const tasks = join(root, 'Proof', 'TASKS'); mkdirSync(tasks, { recursive: true })
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ port: 18779, projectsRoot: root, projects: ['Proof', 'Other'], maxConcurrentAgents: 0, models: { working: 'test' }, agentPollMs: 600000 }))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  return { root, tasks, config }
}
const plan = `## Approved brief\nDeliver correct result\n## Files\n- \`app.mjs\` result\n## Implementation plan\nChange app.mjs\n## Acceptance criteria\n- AC1: correct result\n## Outcome checks\nAC1 | app.mjs | node check.mjs expects correct | remove required result and assert failure\n## Prerequisites\nNone\n## Implementation\nChanged app.mjs\n## Evidence\nnode check.mjs passed; evidence: check-output.txt\n`

test('Pause persists, blocks prompt boundary, Start preserves other pauses and confirmed delivery is deduplicated', async t => {
  const f = fixture(t)
  assert.throws(() => assertPromptAllowed('proof'), /paused/)
  await assert.rejects(deliver('pane', 'assigned job', 'proof'), /paused/)
  assert.equal(pendingDeliveries('proof').length, 1)
  setProjectPaused('Proof', true)
  assert.equal(controlState('Proof').paused, true)
  assert.equal(JSON.parse(readFileSync(f.config)).maxConcurrentAgents, 0)
  assert.equal(JSON.parse(readFileSync(f.config)).projectControls.Other.paused, true)
  setProjectPaused('Proof', false)
  assert.equal(controlState('Proof').paused, false)
  assert.equal(controlState('Other').paused, true)
  saveDelivery('proof', 'pane', { key: deliveryKey('assigned job'), text: 'assigned job', status: 'confirmed' })
  await deliver('pane', 'assigned job', 'proof') // No HERDR call is possible on duplicate.
  assert.equal(pendingDeliveries('proof').length, 0)
  assert.equal(JSON.parse(readFileSync(f.config)).maxConcurrentAgents, 10)
})

test('a pause during uncertain delivery prevents retry/Enter and never resends a possibly accepted prompt', async t => {
  fixture(t); setProjectPaused('Proof', false)
  let prompts = 0, enters = 0
  await assert.rejects(deliverWith({ paneId: 'p', session: 'proof', text: 'job', confirmMs: 1,
    prompt: async () => { prompts++; setProjectPaused('Proof', true); throw new Error('timeout') },
    list: async () => [], read: async () => 'Pasted Content',
    sendKeys: async () => { assertPromptAllowed('proof'); enters++ },
  }), /paused/)
  assert.equal(prompts, 1); assert.equal(enters, 0)
  await assert.rejects(deliverWith({ paneId: 'p', text: 'job', prompt: async () => { prompts++; throw new Error('unknown') }, list: async () => [], read: async () => '' }), /unconfirmed/)
  assert.equal(prompts, 2)
})

test('history is append-only, focused briefing excludes transcript and feedback updates preserve scope', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'history', brief: 'all requirements' })
  writeFileSync(card.path, `# ${card.id} — history\n**Workflow:** card-owned\n${plan}\n**Build attempt** old\nold transcript\n`)
  const first = appendHistory(f.tasks, card.id, { event: 'old', text: 'first attempt' })
  const bytes = readFileSync(historyPath(f.tasks, card.id), 'utf8')
  writeCurrentFeedback(f.tasks, card, 'Review feedback', '[planning] preserve required keyboard behavior')
  appendFileSync(card.path, '\n**Recovery:** {"failedReturns":3}\n')
  writeCurrentFeedback(f.tasks, card, 'Review feedback', '[planning] keyboard check needs a negative case')
  const text = readFileSync(card.path, 'utf8')
  assert.equal((text.match(/## Current feedback/g) || []).length, 1)
  assert.match(text, /\*\*Workflow:\*\* card-owned/)
  assert.match(text, /\*\*Recovery:\*\* \{"failedReturns":3\}/)
  const brief = readFileSync(writeBrief(f.tasks, card, 'builder'), 'utf8')
  assert.match(brief, /correct result/); assert.match(brief, /negative case/)
  assert.doesNotMatch(brief, /old transcript/)
  assert.ok(readFileSync(historyPath(f.tasks, card.id), 'utf8').startsWith(bytes))
  assert.ok(first.id)
})

test('new plans require outcome/check mapping; missing requirement fails validation', () => {
  validatePlan('**Workflow version:** 2\n' + plan)
  assert.throws(() => validatePlan('**Workflow version:** 2\n' + plan.replace('AC1 | app.mjs', 'AC2 | app.mjs')), /map each AC/)
})

test('relevant code and acceptance changes invalidate evidence; optional caps remain disabled until chosen', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'evidence', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — evidence\n${plan}`)
  writeFileSync(join(f.root, 'app.mjs'), 'export const result = 1')
  const original = evidenceFingerprint(card, f.root)
  writeFileSync(join(f.root, 'unrelated.txt'), 'unrelated')
  assert.equal(evidenceFingerprint(card, f.root), original)
  writeFileSync(join(f.root, 'app.mjs'), 'export const result = 2')
  assert.notEqual(evidenceFingerprint(card, f.root), original)
  const changedCode = evidenceFingerprint(card, f.root)
  writeFileSync(card.path, readFileSync(card.path, 'utf8').replace('- AC1: correct result', '- AC1: exact new requirement'))
  assert.notEqual(evidenceFingerprint(card, f.root), changedCode)
  writeFileSync(join(f.tasks, '.request-usage.json'), JSON.stringify({ version: 1, runs: { one: { cardIds: [card.id], role: 'builder', delta: { total: 100 }, start: { at: new Date().toISOString() } } } }))
  assert.equal(checkWorkflowLimits(f.tasks, card.id, 'builder'), null)
  const config = JSON.parse(readFileSync(f.config)); config.workflowLimits = { maxRunsPerStage: 1 }
  writeFileSync(f.config, JSON.stringify(config))
  assert.match(checkWorkflowLimits(f.tasks, card.id, 'builder'), /maxRunsPerStage reached/)
})

// Injectbuddy I553 (2026-10-02): a Builder prompt lost on a slow Claude start went to Owner.
test('a lost Builder delivery retries with a fresh tab instead of going to Owner', async t => {
  const f = fixture(t)
  const path = join(f.tasks, 'queue'); mkdirSync(path)
  writeFileSync(join(path, 'T-1.md'), '# T-1 — task\n' + plan)
  recordOperationalFailure(f.tasks, findCard(f.tasks, 'T-1'), 'Delivery unconfirmed: agent prompt stalled; inspect the existing session before retrying', join(f.root, 'Proof'))
  let calls = 0
  await autoSpawn({ project: 'Proof', projectPath: join(f.root, 'Proof'), tasksDir: f.tasks, max: 1, agents: [], spawn: async () => { calls++; throw Object.assign(new Error('Delivery unconfirmed: again'), { preservePane: true }) } })
  assert.notEqual(findCard(f.tasks, 'T-1').column, 'owner')
  assert.equal(calls, 1, 'retried once')
  assert.equal(readWorkflow(f.tasks)['T-1'].startFailure.count, 1)
})

test('operational failure preserves pending stage and blocks unchanged redispatch until prerequisite changes', async t => {
  const f = fixture(t)
  const path = join(f.tasks, 'queue'); mkdirSync(path)
  writeFileSync(join(path, 'T-1.md'), '# T-1 — task\n' + plan)
  const card = findCard(f.tasks, 'T-1')
  recordOperationalFailure(f.tasks, card, 'dependency missing', join(f.root, 'Proof'))
  const original = readWorkflow(f.tasks)['T-1'].operational.historyId
  recordOperationalFailure(f.tasks, card, 'dependency missing', join(f.root, 'Proof'))
  assert.equal(readWorkflow(f.tasks)['T-1'].operational.historyId, original)
  assert.equal(operationalHold(f.tasks, card, join(f.root, 'Proof')), 'dependency missing')
  let calls = 0
  await autoSpawn({ project: 'Proof', projectPath: join(f.root, 'Proof'), tasksDir: f.tasks, max: 1, agents: [], spawn: async () => { calls++; return { pane_id: 'p' } } })
  // T-9: an environment hold leaves Queue for Owner with the reason; it never starts a Builder.
  assert.equal(calls, 0); assert.equal(findCard(f.tasks, 'T-1').column, 'owner')
  assert.match(readFileSync(findCard(f.tasks, 'T-1').path, 'utf8'), /Needs you[\s\S]*Operational recovery held: [\s\S]*dependency missing/)
  const held = findCard(f.tasks, 'T-1')
  writeFileSync(join(f.root, 'Proof', 'package.json'), '{}')
  assert.equal(operationalHold(f.tasks, held, join(f.root, 'Proof')), null)
})

test('normal task flow requires independent verdict; duplicate transitions do not duplicate history', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'normal flow', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — normal\n**Workflow:** card-owned\n**Workflow version:** 2\n${plan}`)
  for (const stage of ['planned', 'queue', 'working', 'review']) moveCard(f.tasks, card.id, stage)
  const before = readFileSync(historyPath(f.tasks, card.id), 'utf8')
  moveCard(f.tasks, card.id, 'review')
  assert.equal(readFileSync(historyPath(f.tasks, card.id), 'utf8'), before)
  assert.throws(() => moveCard(f.tasks, card.id, 'completed'), /Builder PASS/)
  assert.throws(() => moveCard(f.tasks, card.id, 'archive'), /Reviewer evidence/)
  appendFileSync(findCard(f.tasks, card.id).path, '\n## Reviewer evidence\nAC1 independent positive and negative checks passed.\n**Review verdict:** PASS\n')
  assert.equal(routeReviewVerdicts(f.tasks).length, 1)
  assert.equal(findCard(f.tasks, card.id).column, 'completed')
  moveCard(f.tasks, card.id, 'archive')
  assert.equal(findCard(f.tasks, card.id).column, 'archive')
})

test('version-2 handoff validates a structured result and repeated completion is a no-op', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'structured result', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — structured\n**Workflow:** card-owned\n**Workflow version:** 2\n${plan}`)
  moveCard(f.tasks, card.id, 'working')
  const done = () => spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, 'done', card.id], { encoding: 'utf8' })
  assert.notEqual(done().status, 0)
  const current = findCard(f.tasks, card.id)
  writeFileSync(current.path, readFileSync(current.path, 'utf8').replace('Changed app.mjs', 'Stage: builder\nOutcome: PASS\nFiles: app.mjs\nBlocker: none').replace('node check.mjs passed; evidence: check-output.txt', 'Check: node check.mjs\nResult: expected output and negative case passed\nEvidence: check-output.txt'))
  assert.equal(done().status, 0)
  const before = readFileSync(historyPath(f.tasks, card.id), 'utf8')
  assert.equal(done().status, 0)
  assert.equal(readFileSync(historyPath(f.tasks, card.id), 'utf8'), before)
})

test('product corrections route by cause and retain the five-return stop', t => {
  const f = fixture(t)
  assert.equal(failureDestination('planning', 'review'), 'planning')
  assert.equal(failureDestination('implementation', 'review'), 'planning')
  assert.equal(failureDestination('implementation', 'working'), 'queue')
  assert.equal(failureDestination('evidence', 'review'), 'review')
  const card = createCard(f.tasks, { title: 'correction', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — correction\n**Workflow:** card-owned\n${plan}`)
  moveCard(f.tasks, card.id, 'queue')
  for (let i = 0; i < 5; i++) {
    moveCard(f.tasks, card.id, 'working')
    moveCard(f.tasks, card.id, 'review')
    moveCard(f.tasks, card.id, 'queue', { correction: true })
  }
  assert.equal(findCard(f.tasks, card.id).column, 'owner')
  assert.equal(recoveryState(readFileSync(findCard(f.tasks, card.id).path, 'utf8')).returns, 5)
})

test('project control API survives a real server restart with no agent dispatch', async t => {
  const f = fixture(t)
  let child, base // server.mjs prints its port; another test run may hold the config one
  const launch = async () => {
    child = spawn(process.execPath, [join(here, 'server.mjs')], { cwd: here, env: { ...process.env, KANBAN_CONFIG: f.config, HERDR_BIN_PATH: 'nonexistent-workflow-test-herdr' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('test server startup timeout')), 30000)
      child.stdout.on('data', bytes => { const port = String(bytes).match(/127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`) } })
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`test server exited ${code}`)) })
    })
  }
  const stop = () => new Promise(resolve => { child.once('exit', resolve); child.kill() })
  t.after(() => { if (child && child.exitCode === null) child.kill() })
  await launch()
  const post = paused => fetch(`${base}/api/project-control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Proof', paused }) }).then(r => r.json())
  assert.equal((await post(true)).control.paused, true)
  await stop(); await launch()
  const response = await fetch(`${base}/api/board?project=Proof`).then(r => r.json())
  assert.equal(response.control.paused, true)
  assert.equal((await post(false)).control.paused, false)
  assert.equal(controlState('Other').paused, true)
  await stop()
})

test('board operator can archive each lane while agent archive remains gated', async t => {
  const f = fixture(t)
  let child
  child = spawn(process.execPath, [join(here, 'server.mjs')], { cwd: here, env: { ...process.env, KANBAN_CONFIG: f.config, HERDR_BIN_PATH: 'nonexistent-workflow-test-herdr' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(() => { if (child && child.exitCode === null) child.kill() })
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 30000)
    child.stdout.on('data', bytes => { const port = String(bytes).match(/127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`) } })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`test server exited ${code}`)) })
  })

  const postArchive = id => fetch(`${base}/api/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Proof', id, to: 'archive' }) })
  for (const lane of ['review', 'completed', 'issues', 'owner']) {
    const card = createCard(f.tasks, { title: `operator archive from ${lane}`, brief: 'board archive' })
    if (lane === 'completed') writeFileSync(card.path, readFileSync(card.path, 'utf8') + '\n**Trivial:** yes\n')
    moveCard(f.tasks, card.id, lane)
    const response = await postArchive(card.id)
    assert.equal(response.status, 200, `${lane} archive response`)
    assert.equal((await response.json()).card.column, 'archive')
    const transitions = readFileSync(historyPath(f.tasks, card.id), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'transition' && entry.to === 'archive')
    assert.equal(transitions.length, 1)
    assert.equal(transitions[0].note, 'Archived by operator from board without independent review')
    assert.equal((await postArchive(card.id)).status, 200)
    assert.equal(readFileSync(historyPath(f.tasks, card.id), 'utf8').trim().split('\n').map(JSON.parse).filter(entry => entry.event === 'transition' && entry.to === 'archive').length, 1)
  }

  const guarded = createCard(f.tasks, { title: 'agent archive stays gated', brief: 'review required' })
  writeFileSync(guarded.path, readFileSync(guarded.path, 'utf8').replace('**Auto-review:** no', '**Auto-review:** yes'))
  assert.throws(() => moveCard(f.tasks, guarded.id, 'archive'), /Reviewer evidence/)
  const cliMove = spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, 'move', guarded.id, 'archive'], { encoding: 'utf8' })
  assert.notEqual(cliMove.status, 0)
  assert.match(cliMove.stderr + cliMove.stdout, /Reviewer evidence/)
  moveCard(f.tasks, guarded.id, 'review')
  const cliPass = spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, 'pass', guarded.id], { encoding: 'utf8' })
  assert.notEqual(cliPass.status, 0)
  assert.equal(findCard(f.tasks, guarded.id).column, 'review')

  const active = createCard(f.tasks, { title: 'archive cleanup', brief: 'release assignments' })
  moveCard(f.tasks, active.id, 'review')
  bind(f.tasks, active.id, { pane_id: 'planner-pane' })
  const runsFile = join(f.root, '.card-runs', 'runs.json')
  mkdirSync(join(f.root, '.card-runs'), { recursive: true })
  writeFileSync(runsFile, JSON.stringify([{ project: 'Proof', cardId: active.id, runId: 'run-1', status: 'running' }]))
  const planners = readCardPlanners(f.tasks)
  planners[active.id] = { paneId: 'planner-pane', lifecycle: 'active' }
  saveCardPlanners(f.tasks, planners)
  const worktrees = join(f.tasks, '.board-worktrees.json')
  writeFileSync(worktrees, JSON.stringify({ [active.id]: { state: 'building', commit: 'kept-commit' } }))
  const response = await postArchive(active.id)
  assert.equal(response.status, 200)
  assert.equal(readBindings(f.tasks)[active.id], undefined)
  assert.equal(readCardRuns().find(run => run.runId === 'run-1').status, 'stopped')
  const calls = []
  await runCardPlanner({ project: 'Proof', projectPath: f.root, tasksDir: f.tasks, boardRoot: here, io: {
    agentList: async () => [{ pane_id: 'planner-pane', agent_status: 'idle' }],
    recordUsageFinish: async () => calls.push('finish'), paneClose: async () => calls.push('close'),
  } })
  assert.deepEqual(calls, ['finish', 'close'])
  assert.ok(readCardPlanners(f.tasks)[active.id].closedAt)
  assert.deepEqual(JSON.parse(readFileSync(worktrees, 'utf8'))[active.id], { state: 'building', commit: 'kept-commit' })
  assert.equal(existsSync(join(f.tasks, 'archive', `${active.id}-approved-job.md`)), true)
})

test('every role is typed as a short one-line pointer; the file holds the task and resume sees a brief changed behind it', async t => {
  const f = fixture(t); setProjectPaused('Proof', false)
  const card = createCard(f.tasks, { title: 'typed', brief: 'all requirements' })
  writeFileSync(card.path, `# ${card.id} — typed\n${plan}`)
  const args = { projectPath: f.root, boardRoot: here, tasksDir: f.tasks }
  const prompts = {
    builder: workerPrompt({ ...args, card }) + ' Implementation correction: continue from the existing commits.',
    reviewer: reviewerPrompt({ ...args, cards: [card, { ...card, id: 'T-98' }, { ...card, id: 'T-99' }], reviewClaim: 'claim', envFile: join(f.root, '.env') }),
    planner: plannerPrompt({ ...args, cards: [{ ...card, column: 'planning' }], plannerAssignment: 'assignment' }) + ' Plan only this card; do not delegate.',
  }
  const file = promptPath('proof', 'w12:p34@default')
  for (const [role, full] of Object.entries(prompts)) {
    const typed = typedPrompt(full, file)
    assert.ok(full.length > 1000, role)
    assert.ok(typed.text.length < MAX_TYPED, `${role} typed ${typed.text.length} chars`)
    assert.doesNotMatch(typed.text, /\n/, role)
    assert.equal(typed.text, `Read ${file} (revision ${deliveryKey(full)}) and follow it exactly; it is your complete task.`)
    assert.equal(typed.full, full)
  }
  assert.deepEqual(typedPrompt('Finish T-1 then report.', file), { text: 'Finish T-1 then report.' })
  // A paused delivery whose brief changed behind the prompt file is not resent blind.
  const { text } = typedPrompt(prompts.builder, file)
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, prompts.builder)
  saveDelivery('proof', 'w12:p34@default', { text, key: deliveryKey(text), status: 'paused' })
  appendFileSync(join(f.tasks, '.briefs', `${card.id}-builder.md`), 'changed\n')
  await resumeDeliveries('proof')
  assert.match(readDelivery('proof', 'w12:p34@default').reason, /Brief changed/)
})

test('a pending delivery while paused waits quietly instead of aborting the poll (I553 release drain)', async t => {
  fixture(t)
  saveDelivery('proof', 'pane', { key: deliveryKey('assigned job'), text: 'assigned job', status: 'paused' })
  await resumeDeliveries('proof')
  assert.equal(pendingDeliveries('proof').length, 1)
})

test('version-2 done reads one-line comma fields and "Outcome: PASS: note" the same (Injectbuddy I556)', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'comma result', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — comma\n**Workflow:** card-owned\n**Workflow version:** 2\n${plan}`)
  moveCard(f.tasks, card.id, 'working')
  const done = () => spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, 'done', card.id], { encoding: 'utf8' })
  const write = (impl, ev) => { const c = findCard(f.tasks, card.id); writeFileSync(c.path, readFileSync(c.path, 'utf8').replace(/Changed app\.mjs|- Stage:.*/, impl).replace(/node check\.mjs passed; evidence: check-output\.txt|Check: node check.*/, ev)) }
  write('- Stage: builder, Outcome: FAIL, Files: app.mjs, Blocker: none', 'Check: node check.mjs, Result: failed, Evidence: check-output.txt')
  assert.match(done().stderr, /requires Stage: builder and Outcome: PASS/)
  write('- Stage: builder, Outcome: PASS: fixed the toggle, Files: app.mjs, Blocker: none', 'Check: node check.mjs, Result: 3 passed, Evidence: check-output.txt')
  assert.equal(done().status, 0, done().stderr)
})

test('done repairs a literal PowerShell `r`n that hid the Implementation heading (Injectbuddy I711)', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'escaped result', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — escaped\n**Workflow:** card-owned\n**Workflow version:** 2\n${plan}`
    .replace('## Implementation\nChanged app.mjs', '## Implementation`r`nStage: builder, Outcome: PASS, Files: app.mjs, Blocker: none')
    .replace('## Evidence\nnode check.mjs passed; evidence: check-output.txt', '## Evidence`r`nCheck: node check.mjs; Result: passed; Evidence: check-output.txt'))
  moveCard(f.tasks, card.id, 'working')
  const run = spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, 'done', card.id], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(readFileSync(findCard(f.tasks, card.id).path, 'utf8'), /`r`n/)
})

test('issue/done restore a prefix-overwritten plan and relocate duplicate Builder results (I854/I823)', t => {
  const f = fixture(t)
  for (const verb of ['issue', 'done']) {
    const card = createCard(f.tasks, { title: 'prefix splice', brief: 'correct result' })
    writeFileSync(card.path, `# ${card.id} — splice\n**Workflow:** card-owned\n**Workflow version:** 2\n${plan}`)
    moveCard(f.tasks, card.id, 'working')
    const current = findCard(f.tasks, card.id), saved = readFileSync(current.path, 'utf8')
    const outcome = verb === 'done' ? 'PASS' : 'BLOCKED'
    const result = `## Implementation\x60nStage: builder, Outcome: ${outcome}, Files: app.mjs, Blocker: none\x60n`
    // The Builder's first '## Implementation' match is the Planner's plan heading.
    const start = saved.indexOf('## Implementation'), end = saved.indexOf('## Acceptance criteria', start)
    writeFileSync(current.path, (saved.slice(0, start) + result + saved.slice(end))
      .replace('## Implementation\nChanged app.mjs', result + '\n## Implementation\n<!-- empty -->')
      .replace('## Evidence\nnode check.mjs passed; evidence: check-output.txt', '## Evidence\x60r\x60nCheck: node check.mjs; Result: passed; Evidence: check-output.txt'))
    const run = spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, verb, card.id, ...(verb === 'issue' ? ['[planning] specified target is incomplete'] : [])], { encoding: 'utf8' })
    assert.equal(run.status, 0, run.stderr)
    assert.match(run.stdout, /restored ## Implementation plan from history/)
    const text = readFileSync(findCard(f.tasks, card.id).path, 'utf8')
    assert.match(text, /## Implementation plan\nChange app.mjs/)
    assert.deepEqual([...text.matchAll(/^## ([^\n]+)/gm)].map(m => m[1]).filter(s => s !== 'Current feedback'), [...saved.matchAll(/^## ([^\n]+)/gm)].map(m => m[1]))
    assert.equal(text.match(/Stage: builder/g).length, 1, 'duplicate content is retained once, empty placeholders removed')
    assert.match(text, new RegExp(`## Implementation\nStage: builder, Outcome: ${outcome}`))
    assert.doesNotMatch(text, /`[rn]/)
    const restored = readFileSync(historyPath(f.tasks, card.id), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.event === 'sections-restored')
    assert.equal(restored.length, 1)
    assert.deepEqual(restored[0].sections, ['Implementation plan'])
    assert.equal(findCard(f.tasks, card.id).column, verb === 'done' ? 'completed' : 'planning')
  }
})

test('shared handoff repairs lone PowerShell newlines but preserves inline `npm run`', t => {
  const f = fixture(t)
  const card = createCard(f.tasks, { title: 'inline command', brief: 'correct result' })
  writeFileSync(card.path, `# ${card.id} — inline\n${plan}\n## Notes\nUse \x60npm run\x60 and \x60node check.mjs\x60.\x60n# Details\x60n- one\x60n* two\x60n`)
  moveCard(f.tasks, card.id, 'working')
  const run = spawnSync(process.execPath, [join(here, 'hkb.mjs'), '--tasks', f.tasks, 'move', card.id, 'completed'], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.match(readFileSync(findCard(f.tasks, card.id).path, 'utf8'), /Use `npm run` and `node check.mjs`\.\n# Details\n- one\n\* two\n/)
})
