import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { reconcileCompletedHandoffs, returnIntegrationConflict } from './lib/completed-handoff.mjs'
import { readWorktrees } from './lib/worktrees.mjs'
import { archiveNoReviewCards, promoteAutoReview, routeReviewVerdicts } from './lib/autospawn.mjs'
import { appendReviewPass, canArchive, findCard, moveCard } from './lib/cards.mjs'
import { evidenceFingerprint, readWorkflow } from './lib/workflow-state.mjs'

const cardText = (id, flag = 'no') => `# ${id} — task\n**Workflow:** card-owned\n${flag === null ? '' : `**Auto-review:** ${flag}\n`}**Category:** code\n**Workspace:** .\n**Workflow version:** 2\n\n## Implementation\nStage: builder\nOutcome: PASS\nFiles: example.js\nBlocker: none\n\n## Evidence\nStage: builder\nOutcome: PASS\nCheck: check\nResult: passed\nEvidence: proof\nBlocker: none\n`

function putCard(tasksDir, column, id, flag = 'no') {
  mkdirSync(join(tasksDir, column), { recursive: true })
  const path = join(tasksDir, column, `${id}.md`)
  writeFileSync(path, cardText(id, flag))
  return path
}

function runHkb(tasksDir, verb, id, note = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasksDir, verb, id, ...(note ? [note] : [])], { encoding: 'utf8', windowsHide: true })
}

function markUnchangedIntegrated(tasksDir, root, id) {
  const card = findCard(tasksDir, id)
  const registryPath = join(tasksDir, '.board-worktrees.json')
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'))
  registry[id] = { state: 'integrated', noOp: true, environmentSignature: null, integrationWorkspace: root, inputFingerprint: evidenceFingerprint(card, root), commit: 'base', cleaned: true }
  writeFileSync(registryPath, JSON.stringify(registry))
}

test('no-review done waits for integration, yes still reviews, and verified unchanged archives', t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-routing-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  putCard(tasksDir, 'working', 'T-1')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building' } }))
  assert.equal(runHkb(tasksDir, 'done', 'T-1').status, 0)
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'integrated' } }))
  assert.deepEqual(archiveNoReviewCards(tasksDir).archived, ['T-1'])
  assert.equal(findCard(tasksDir, 'T-1').column, 'archive')

  const absentFlag = putCard(tasksDir, 'working', 'T-2', null)
  writeFileSync(absentFlag, readFileSync(absentFlag, 'utf8').replaceAll('Stage: builder', '**Stage:** builder').replaceAll('Outcome: PASS', '**Outcome:** PASS'))
  assert.equal(runHkb(tasksDir, 'done', 'T-2').status, 0)
  assert.equal(findCard(tasksDir, 'T-2').column, 'completed')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'integrated' }, 'T-2': { state: 'integrated' } }))
  assert.deepEqual(archiveNoReviewCards(tasksDir).archived, ['T-2'])

  putCard(tasksDir, 'working', 'T-3', 'yes')
  assert.equal(runHkb(tasksDir, 'done', 'T-3').status, 0)
  assert.equal(findCard(tasksDir, 'T-3').column, 'completed', 'Auto-review cards integrate before review')

  for (const [id, flag, expected] of [['T-4', 'no', 'archive'], ['T-5', null, 'archive'], ['T-6', 'yes', 'review']]) {
    putCard(tasksDir, 'working', id, flag)
    markUnchangedIntegrated(tasksDir, root, id)
    const result = runHkb(tasksDir, 'unchanged', id, 'node --test: 1 passed')
    assert.equal(result.status, 0, result.stderr)
    assert.equal(findCard(tasksDir, id).column, expected)
    assert.match(readFileSync(findCard(tasksDir, id).path, 'utf8'), /Verified unchanged/)
  }
})

test('hkb done refuses a version-2 card with an AC that has no recorded test result', t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-ac-result-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = putCard(tasksDir, 'working', 'T-1')
  writeFileSync(path, readFileSync(path, 'utf8').replace('## Implementation', '## Acceptance criteria\n- AC1: helper() returns 1.\n## Implementation'))
  let result = runHkb(tasksDir, 'done', 'T-1')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /missing a recorded test for AC1/)
  writeFileSync(path, readFileSync(path, 'utf8').replace('Blocker: none\n\n## Evidence', 'AC1: node --test -> 1 passed\nBlocker: none\n\n## Evidence'))
  result = runHkb(tasksDir, 'done', 'T-1')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
})

test('re-running hkb done finishes a handoff that stopped after the card move (Tradeflow T-43)', t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-resume-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  putCard(tasksDir, 'completed', 'T-1')
  // Half-applied: moved to Completed, but the Builder is still bound and no stage is recorded.
  writeFileSync(join(tasksDir, '.board.json'), JSON.stringify({ 'T-1': { pane_id: 'p', name: 'b-t-1' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: { pane_id: 'p' } } }))
  const result = runHkb(tasksDir, 'done', 'T-1')
  assert.equal(result.status, 0, result.stderr)
  const saved = JSON.parse(readFileSync(join(tasksDir, '.workflow-state.json'), 'utf8'))['T-1']
  assert.equal(saved.completedStage, 'working')
  assert.ok(saved.completedAt)
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.board.json'), 'utf8'))['T-1'], undefined)
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
})

test('a Completed card whose hkb done stopped half-applied is repaired and integrates on the next poll', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-half-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  putCard(tasksDir, 'completed', 'T-1')
  putCard(tasksDir, 'completed', 'T-2')
  const builder = id => ({ pane_id: `p${id}`, name: `b${id}` })
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building' }, 'T-2': { cardId: 'T-2', state: 'building' } }))
  writeFileSync(join(tasksDir, '.board.json'), JSON.stringify({ 'T-1': builder(1), 'T-2': builder(2) }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { builder: builder(1) }, 'T-2': { builder: builder(2) } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: { a: { paneId: 'p1', role: 'builder', cardIds: ['T-1'], sessionId: 's1' }, b: { paneId: 'p2', role: 'builder', cardIds: ['T-2'], sessionId: 's2' } } }))
  // T-1's Builder ran hkb done (history has the handoff); T-2's card was moved without one.
  mkdirSync(join(tasksDir, '.history'), { recursive: true })
  writeFileSync(join(tasksDir, '.history', 'T-1.jsonl'), [{ event: 'transition', from: 'queue', to: 'working' }, { event: 'transition', from: 'working', to: 'completed' }, { event: 'handoff', stage: 'working', outcome: 'done' }].map(e => JSON.stringify(e)).join('\n') + '\n')
  let agents = [1, 2].map(n => ({ pane_id: `p${n}`, name: `b${n}`, agent_session: { value: `s${n}` }, agent_status: 'idle' }))
  const io = { agentList: async () => agents, paneRead: async () => 'out', recordUsageFinish: async () => {},
    paneClose: async pane => { agents = agents.filter(a => a.pane_id !== pane) }, reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const results = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', io })
  assert.equal(results.find(r => r.id === 'T-1').status, 'integrated')
  assert.match(results.find(r => r.id === 'T-2').reason, /Builder handoff is not complete/)
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.workflow-state.json'), 'utf8'))['T-1'].completedStage, 'working')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(tasksDir, '.board.json'), 'utf8'))), ['T-2'])
})

test('archive requires Builder PASS and integration while Review PASS and audit gates remain', t => {
  const root = mkdtempSync(join(tmpdir(), 'archive-gate-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const noPass = putCard(tasksDir, 'completed', 'T-1')
  writeFileSync(noPass, readFileSync(noPass, 'utf8').replaceAll('Outcome: PASS', 'Outcome: BLOCKED'))
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'integrated' } }))
  assert.equal(canArchive(findCard(tasksDir, 'T-1')), false)
  writeFileSync(noPass, cardText('T-1'))
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building' } }))
  assert.equal(canArchive(findCard(tasksDir, 'T-1')), false)
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'integrated' } }))
  assert.equal(canArchive(findCard(tasksDir, 'T-1')), true)
  moveCard(tasksDir, 'T-1', 'archive')

  const yes = putCard(tasksDir, 'review', 'T-2', 'yes')
  assert.equal(canArchive(findCard(tasksDir, 'T-2')), false)
  appendReviewPass({ path: yes }, 'reviewed and passed')
  assert.equal(canArchive(findCard(tasksDir, 'T-2')), true)
  const audit = putCard(tasksDir, 'review', 'T-3')
  writeFileSync(audit, readFileSync(audit, 'utf8').replace('**Category:** code', '**Category:** code\n**Audit:** seo'))
  assert.equal(canArchive(findCard(tasksDir, 'T-3')), true)
})

test('migration archives both lanes once and reports cards missing PASS or integration', t => {
  const root = mkdtempSync(join(tmpdir(), 'archive-migration-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  putCard(tasksDir, 'review', 'T-1')
  putCard(tasksDir, 'completed', 'T-2', null)
  const missingPass = putCard(tasksDir, 'review', 'T-3')
  writeFileSync(missingPass, readFileSync(missingPass, 'utf8').replaceAll('Outcome: PASS', 'Outcome: BLOCKED'))
  putCard(tasksDir, 'completed', 'T-4')
  putCard(tasksDir, 'review', 'T-5', 'yes')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({
    'T-1': { state: 'integrated' }, 'T-2': { state: 'integrated' },
    'T-3': { state: 'integrated' }, 'T-4': { state: 'building' }, 'T-5': { state: 'integrated' },
  }))
  const first = archiveNoReviewCards(tasksDir)
  assert.deepEqual(first.archived, ['T-1', 'T-2'])
  assert.deepEqual(first.skipped, [
    { id: 'T-3', reason: 'missing Builder PASS' },
    { id: 'T-4', reason: 'worktree state is building, not integrated', expected: true },
  ])
  assert.deepEqual(archiveNoReviewCards(tasksDir).archived, [])
  const notes = readFileSync(join(tasksDir, '.history/T-1.jsonl'), 'utf8').match(/Archived without independent review \(Auto-review: no\)/g)
  assert.equal(notes.length, 1)
  assert.equal(findCard(tasksDir, 'T-5').column, 'review')
})

test('review failure and rework continue to enable Auto-review', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-kickback-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const failed = putCard(tasksDir, 'review', 'T-1', null)
  writeFileSync(failed, `${readFileSync(failed, 'utf8').replace('**Workflow:** card-owned\n', '')}\n**Review feedback**\n\n## Reviewer evidence\n\n[implementation] Defect found.\n\n**Review verdict:** FAIL\n`)
  assert.equal(routeReviewVerdicts(tasksDir, { log: () => {} })[0].to, 'planning', 'a failed review of integrated code goes back to the Planner')
  assert.equal(findCard(tasksDir, 'T-1').autoReview, true)
  putCard(tasksDir, 'working', 'T-2', null)
  assert.equal(runHkb(tasksDir, 'rework', 'T-2', '[evidence] verification incomplete').status, 0)
  assert.equal(findCard(tasksDir, 'T-2').autoReview, true)
})

test('finished Builder output is durable before close; working/mismatched sessions never close; restart does not replay', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n**Auto-review:** yes\n**Recovery:** {"returns":2}\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'builder' } } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: { r: { paneId: 'p', role: 'builder', cardIds: ['T-1'], sessionId: 'original' } } }))
  let agent = { pane_id: 'p', name: 'builder', agent_session: { value: 'original' }, agent_status: 'working' }, closed = 0, integrated = 0
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'finished output', recordUsageFinish: async () => {},
    paneClose: async () => { assert.match(readFileSync(join(tasksDir, '.history/T-1.jsonl'), 'utf8'), /finished output/); agent = null; closed++ },
    reconcile: () => { assert.equal(agent, null); integrated++; return [{ id: 'T-1', status: 'integrated' }] } }
  const run = () => reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.equal((await run())[0].status, 'waiting-builder'); assert.equal(closed, 0); assert.equal(integrated, 0)
  agent.agent_status = 'done'; agent.agent_session.value = 'other'
  assert.match((await run())[0].reason, /identity/); assert.equal(closed, 0)
  agent.agent_session.value = 'original'
  await run(); await run()
  assert.equal(closed, 1); assert.equal(integrated, 2)
  assert.match(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8'), /"returns":2/)
})

test('Auto-review OFF stays Completed even manager mode; ON waits for safe cleanup', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-gate-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  for (const [id, flag] of [['T-1', 'no'], ['T-2', 'yes']]) writeFileSync(join(tasksDir, 'completed', `${id}.md`), `# ${id} — task\n**Auto-review:** ${flag}\n`)
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-2': { state: 'integrated', cleaned: false } }))
  assert.deepEqual(promoteAutoReview(tasksDir, { all: true }), [])
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-2': { state: 'integrated', cleaned: true } }))
  assert.deepEqual(promoteAutoReview(tasksDir, { all: true }), ['T-2'])
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
})

test('finished Builder whose card sits in Review is retired and integrated', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-review-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'review'), { recursive: true })
  writeFileSync(join(tasksDir, 'review', 'T-1.md'), '# T-1 — task\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'builder' } } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: { r: { paneId: 'p', role: 'builder', cardIds: ['T-1'], sessionId: 's' } } }))
  let agent = { pane_id: 'p', name: 'builder', agent_session: { value: 's' }, agent_status: 'idle' }
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'out', recordUsageFinish: async () => {},
    paneClose: async () => { agent = null }, reconcile: () => [{ id: 'T-1', status: 'integrated' }] }
  assert.equal((await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io }))[0].status, 'integrated')
})

test('Auto-review yes: done, Completed, integrated, Review on integrated code, PASS archives', t => {
  const root = mkdtempSync(join(tmpdir(), 'review-after-integration-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const registry = entry => writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': entry }))
  putCard(tasksDir, 'working', 'T-1', 'yes')
  registry({ state: 'building' })
  assert.equal(runHkb(tasksDir, 'done', 'T-1').status, 0)
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
  assert.deepEqual(promoteAutoReview(tasksDir), [], 'no review before integration')
  assert.deepEqual(archiveNoReviewCards(tasksDir).archived, [], 'Auto-review cards are not archived unreviewed')
  registry({ state: 'integrated', cleaned: true, commit: 'abc' })
  assert.deepEqual(promoteAutoReview(tasksDir), ['T-1'])
  appendReviewPass({ path: findCard(tasksDir, 'T-1').path }, 'AC1 checked on integrated code')
  assert.equal(routeReviewVerdicts(tasksDir, { log: () => {} })[0].to, 'completed')
  assert.deepEqual(archiveNoReviewCards(tasksDir).archived, ['T-1'])
  assert.equal(findCard(tasksDir, 'T-1').column, 'archive')

  // Legacy: a card sent to Review before integration goes back to Completed to integrate.
  putCard(tasksDir, 'review', 'T-2', 'yes')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-2': { state: 'building' } }))
  promoteAutoReview(tasksDir)
  assert.equal(findCard(tasksDir, 'T-2').column, 'completed')
})

test('reviewer snapshot contains the integrated card commit and a real PASS survives later integration', async t => {
  const { snapshotContains, assertReviewInputs } = await import('./lib/review-claims.mjs')
  const root = mkdtempSync(join(tmpdir(), 'review-snapshot-')), repo = join(root, 'repo'), snap = join(root, 'snap'), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', windowsHide: true }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  mkdirSync(repo)
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(join(repo, 'example.js'), 'base\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base')
  git(repo, 'checkout', '-qb', 'card')
  writeFileSync(join(repo, 'example.js'), 'card change\n'); git(repo, 'commit', '-qam', 'card')
  const cardCommit = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  assert.equal(snapshotContains(repo, cardCommit), false, 'integration HEAD without the card commit is refused')
  git(repo, 'cherry-pick', '-x', cardCommit)
  assert.equal(snapshotContains(repo, cardCommit), true, 'cherry-picked card commit is found by its -x trailer')

  // Snapshot = reviewed code. Integration moving on afterwards must not void a real PASS.
  git(repo, 'worktree', 'add', '-q', '--detach', snap, 'HEAD')
  const cardPath = putCard(tasksDir, 'review', 'T-1', 'yes')
  writeFileSync(cardPath, readFileSync(cardPath, 'utf8').replace('**Workflow version:** 2\n', '**Workflow version:** 2\n\n## Files\n- `example.js` — changed\n'))
  const fingerprint = evidenceFingerprint(findCard(tasksDir, 'T-1'), snap)
  writeFileSync(join(root, '.review-claims.json'), JSON.stringify({ version: 1, claims: [{ id: 'c1', project: 'Proof', tasksDir, cards: ['T-1'], createdAt: 1, phase: 'running', snapshot: { path: snap }, integrationPath: repo, environment: null, inputFingerprints: { 'T-1': fingerprint } }] }))
  writeFileSync(join(repo, 'example.js'), 'a later card changed this\n')
  assert.doesNotThrow(() => assertReviewInputs(root, tasksDir, 'T-1'))
  writeFileSync(join(snap, 'example.js'), 'reviewed code edited\n')
  assert.throws(() => assertReviewInputs(root, tasksDir, 'T-1'), /must run again/)
})

test('integration conflicts never loop: a Builder resolution, one fresh re-apply, then Owner; a clean rebase must pass the recorded check', async t => {
  const { runRecordedCheck } = await import('./lib/completed-handoff.mjs')
  const root = mkdtempSync(join(tmpdir(), 'integration-conflict-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const planned = id => `# ${id} — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: node -e "process.exit(0)"\nResult: passed\n`
  for (const id of ['T-1', 'T-2', 'T-3']) { mkdirSync(join(tasksDir, 'completed'), { recursive: true }); writeFileSync(join(tasksDir, 'completed', `${id}.md`), planned(id)) }
  const registryPath = join(tasksDir, '.board-worktrees.json')
  const registry = states => { // sets states, keeps each card's conflict counter
    let prior = {}; try { prior = JSON.parse(readFileSync(registryPath, 'utf8')) } catch {}
    const entry = (id, state) => ({ cardId: id, state, worktreePath: root, workspacePath: root, baseCommit: 'b0', conflictFailures: prior[id]?.conflictFailures })
    writeFileSync(registryPath, JSON.stringify(Object.fromEntries(Object.entries(states).map(([id, state]) => [id, entry(id, state)]))))
  }
  let reconciles = 0
  const conflict = { status: 'conflict', reason: 'integration conflict: CONFLICT (content): Merge conflict in app.js', files: ['app.js'], hunks: '<<<<<<< HEAD\nmaster\n=======\ncard\n>>>>>>> card', head: 'h1' }
  const io = { agentList: async () => [], runCheck: async () => ({ ok: false, output: 'check failed: 1 test' }),
    reconcile: ({ onlyIds }) => { reconciles++; return onlyIds[0] === 'T-1' ? [{ id: 'T-1', ...conflict }] : [{ id: onlyIds[0], status: 'integrated' }] } }

  registry({ 'T-1': 'building' })
  const [first] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.deepEqual([first.status, first.to], ['returned', 'queue'])
  let text = readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')
  assert.match(text, /Kicked back: Integration conflict with master[\s\S]*git rebase --onto h1 b0, fix app\.js[\s\S]*<<<<<<< HEAD/)
  const checkoutOverride = "For this return, your worktree is expected at the card's earlier commit or base; this overrides any plan prerequisite or check requiring a clean checkout on current integration HEAD until the rebase/reset is done, then the plan's checks apply again."
  assert.ok(text.includes(checkoutOverride))
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1'].state, 'conflict')
  // It conflicts again: one fresh re-apply on the new base (Injectbuddy I387/I388/I390), then Owner.
  moveCard(tasksDir, 'T-1', 'completed'); registry({ 'T-1': 'building' })
  const [second] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.equal(second.to, 'queue')
  text = readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')
  assert.match(text, /start fresh on the new base[\s\S]*git branch kanban-backup\/T-1-2 HEAD, git reset --hard h1/)
  assert.ok(text.includes(checkoutOverride))
  moveCard(tasksDir, 'T-1', 'completed'); registry({ 'T-1': 'building' })
  const [third] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.equal(third.to, 'owner')
  text = readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')
  assert.match(text, /Needs you: T-1 still does not integrate with master after 3 tries[\s\S]*\?/)
  assert.ok(!text.includes(checkoutOverride))
  // The ask names the files and an action that works: dragging it back makes the board retry the rebase.
  for (const out of [text, third.reason]) { assert.match(out, /app\.js/); assert.match(out, /drag the card back to Completed/) }

  // Clean rebase: the recorded check gates integration.
  registry({ 'T-2': 'rebased', 'T-3': 'rebased' })
  reconciles = 0
  const [passed] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-2'], io: { ...io, runCheck: async () => ({ ok: true, output: 'ok' }) } })
  assert.equal(passed.status, 'integrated'); assert.equal(reconciles, 1)
  const [failed] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-3'], io })
  assert.deepEqual([failed.status, failed.to], ['returned', 'queue'])
  assert.match(readFileSync(findCard(tasksDir, 'T-3').path, 'utf8'), /recorded check failed: check failed: 1 test/)

  // The real runner executes the card's Check: in the card worktree.
  assert.equal((await runRecordedCheck(findCard(tasksDir, 'T-2'), { workspacePath: root })).ok, true)
  writeFileSync(findCard(tasksDir, 'T-2').path, planned('T-2').replace('process.exit(0)', 'process.exit(3)'))
  assert.equal((await runRecordedCheck(findCard(tasksDir, 'T-2'), { workspacePath: root })).ok, false)
})

test('a conflict whose move is refused is a held result with the reason, and the worktree state is not changed to conflict', t => {
  const root = mkdtempSync(join(tmpdir(), 'refused-conflict-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  // No card file: the move back out of Completed is refused, as it was for a card moved by hand (2026-10-15 audit).
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-9': { cardId: 'T-9', state: 'rebased', worktreePath: root, workspacePath: root, baseCommit: 'b0123456789abcdef', conflictFailures: 0 } }))
  const result = returnIntegrationConflict(tasksDir, 'T-9', { reason: 'integration conflict while rebasing onto master', files: ['app.js'] })
  assert.equal(result.status, 'held')
  assert.equal(result.id, 'T-9')
  assert.match(result.reason, /could not move it to owner \(unknown card: T-9\).*integration conflict while rebasing onto master/)
  assert.equal(readWorktrees(tasksDir)['T-9'].state, 'rebased')
})

test('a card the board could not retry goes to Owner with the files and action, and spends no try', async t => {
  const root = mkdtempSync(join(tmpdir(), 'integration-blocked-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- `app.js` — change\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'conflict', worktreePath: root, workspacePath: root, baseCommit: 'b0123456789abcdef' } }))
  const rebase = () => ({ status: 'conflict', blocked: true, reason: 'expected exactly one card commit; found 2', files: ['app.js'] })
  const [result] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], integrationCheck: 'node -e ""', io: { agentList: async () => [], rebase } })
  assert.deepEqual([result.status, result.to], ['returned', 'owner'])
  assert.ok(!JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1'].conflictFailures)
  for (const out of [result.reason, readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')]) {
    assert.match(out, /expected exactly one card commit; found 2 \(files: app\.js\)/)
    assert.match(out, /drag the card back to Completed/)
  }
})

test('a timed-out integration or recorded check backs off without counting as a conflict; a real failure still returns', async t => {
  const root = mkdtempSync(join(tmpdir(), 'check-timeout-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  for (const id of ['T-1', 'T-2']) writeFileSync(join(tasksDir, 'completed', `${id}.md`), `# ${id} — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n`)
  const entry = (id, state) => ({ cardId: id, state, worktreePath: root, workspacePath: root, baseCommit: 'b0' })
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': entry('T-1', 'building'), 'T-2': entry('T-2', 'rebased') }))
  const t0 = Date.now(), min = 60000
  let checks = 0, result = { ok: false, timedOut: true, output: 'npm test\ntimed out after 300s' }
  const io = { agentList: async () => [], rebase: () => ({ status: 'rebased', commit: 'c1' }),
    runIntegrationCheck: async () => { checks++; return result }, runCheck: async () => { checks++; return result },
    reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const run = (id, now) => reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: [id], integrationCheck: 'npm test', io, now })
  const [held] = await run('T-1', t0)
  assert.equal(held.status, 'held'); assert.match(held.reason, /integration check npm test timed out.*; retrying at \d{4}-/)
  const [recorded] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-2'], io, now: t0 })
  assert.match(recorded.reason, /recorded check timed out.*; retrying at /)
  const registry = () => JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))
  assert.equal(registry()['T-1'].conflictFailures, undefined); assert.equal(registry()['T-2'].conflictFailures, undefined)
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
  checks = 0
  assert.equal((await run('T-1', t0 + 30000))[0].status, 'held'); assert.equal(checks, 0, 'no rerun before the retry time')
  // A genuine failure (tsc error) still goes back to the Builder as today.
  result = { ok: false, output: 'error TS2322: Type string is not assignable to type number' }
  const [returned] = await run('T-1', t0 + 2 * min)
  assert.deepEqual([returned.status, returned.to], ['returned', 'queue'])
  assert.equal(registry()['T-1'].conflictFailures, 1)
})

test('a timed-out integration check holds only its own card; the same poll still checks the next card (HK63)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'check-timeout-next-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  const cwds = { 'T-1': join(root, 'w1'), 'T-2': join(root, 'w2') }
  for (const id of ['T-1', 'T-2']) {
    mkdirSync(cwds[id])
    writeFileSync(join(tasksDir, 'completed', `${id}.md`), `# ${id} — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n`)
  }
  const entry = id => ({ cardId: id, state: 'building', worktreePath: cwds[id], workspacePath: cwds[id], baseCommit: 'b0' })
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': entry('T-1'), 'T-2': entry('T-2') }))
  const called = []
  const io = { agentList: async () => [], rebase: () => ({ status: 'rebased', commit: 'c1' }),
    runIntegrationCheck: async (_command, cwd) => { called.push(cwd); return cwd === cwds['T-1'] ? { ok: false, timedOut: true, output: 'npm test\ntimed out after 300s' } : { ok: true, output: '' } },
    reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const results = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', integrationCheck: 'npm test', io, now: Date.now() })
  assert.deepEqual(called, [cwds['T-1'], cwds['T-2']])
  const held = results.find(r => r.id === 'T-1'), next = results.find(r => r.id === 'T-2')
  assert.equal(held.status, 'held'); assert.match(held.reason, /integration check npm test timed out.*; retrying at \d{4}-/)
  assert.equal(next.status, 'integrated')
  const registry = JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))
  assert.equal(registry['T-1'].conflictFailures, undefined)
  const workflow = readWorkflow(tasksDir)
  assert.equal(workflow['T-1'].integrationRetry.tries, 1)
  assert.equal(workflow['T-2']?.integrationRetry ?? null, null)
})

// One completed card, polled in background mode like pollProject (no onlyIds).
function backgroundFixture(t, runIntegrationCheck) {
  const root = mkdtempSync(join(tmpdir(), 'check-background-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), `# T-1 — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n`)
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', worktreePath: root, workspacePath: root, baseCommit: 'b0' } }))
  const calls = { rebase: 0, check: 0 }
  const io = { agentList: async () => [], rebase: () => { calls.rebase++; return { status: 'rebased', commit: 'c1' } },
    runIntegrationCheck: (...args) => { calls.check++; return runIntegrationCheck(...args) },
    reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const poll = (now = Date.now()) => Promise.race([
    reconcileCompletedHandoffs({ tasksDir, project: 'Proof', integrationCheck: 'npm test', io, now, background: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('poll waited for the integration check')), 2000).unref())])
  return { tasksDir, calls, poll }
}

test('a running integration check does not hold the poll, and is not started or rebased again (HK72 AC1)', async t => {
  const { calls, poll } = backgroundFixture(t, () => new Promise(() => {}))
  const [first] = await poll()
  assert.equal(first.status, 'held'); assert.match(first.reason, /running in the background/)
  const [second] = await poll()
  assert.match(second.reason, /running in the background/)
  assert.deepEqual(calls, { rebase: 1, check: 1 })
})

test('a timing-out integration check returns the poll first, then holds its own card with backoff (HK72 AC2)', async t => {
  const { tasksDir, calls, poll } = backgroundFixture(t, () => new Promise(done => setTimeout(() => done({ ok: false, timedOut: true, output: 'npm test\ntimed out after 300s' }), 200)))
  const now = Date.now(), start = performance.now()
  const [first] = await poll(now)
  assert.ok(performance.now() - start < 200, 'poll returned before the check timed out')
  assert.match(first.reason, /running in the background/)
  await new Promise(done => setTimeout(done, 300))
  const [second] = await poll(now)
  assert.equal(second.status, 'held'); assert.match(second.reason, /integration check npm test timed out.*; retrying at \d{4}-/)
  assert.equal(readWorkflow(tasksDir)['T-1'].integrationRetry.tries, 1)
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1'].conflictFailures, undefined)
  assert.equal(calls.check, 1)
})

test('a background integration check that passes integrates its card on the next poll (HK72)', async t => {
  const { calls, poll } = backgroundFixture(t, async () => ({ ok: true, output: '' }))
  assert.equal((await poll())[0].status, 'held')
  await new Promise(done => setImmediate(done))
  assert.equal((await poll())[0].status, 'integrated')
  assert.equal(calls.check, 1)
})

// Rebased cards, no integration check, polled in background mode like pollProject (no onlyIds).
// `checks[id]` is that card's recorded Check stub.
function recordedFixture(t, checks) {
  const root = mkdtempSync(join(tmpdir(), 'recorded-background-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  const worktrees = {}, calls = {}
  for (const id of Object.keys(checks)) {
    writeFileSync(join(tasksDir, 'completed', `${id}.md`), `# ${id} — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n`)
    worktrees[id] = { cardId: id, state: 'rebased', worktreePath: root, workspacePath: root, baseCommit: 'b0', commit: 'c1' }
    calls[id] = 0
  }
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify(worktrees))
  const io = { agentList: async () => [], runCheck: card => { calls[card.id]++; return checks[card.id]() },
    reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const poll = (now = Date.now()) => Promise.race([
    reconcileCompletedHandoffs({ tasksDir, project: 'Proof', io, now, background: true }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('poll waited for the recorded check')), 2000).unref())])
  return { tasksDir, calls, poll }
}

test('a running recorded check does not hold the poll or the next card, and is not started again (HK73 AC1)', async t => {
  const { calls, poll } = recordedFixture(t, { 'T-1': () => new Promise(() => {}), 'T-2': async () => ({ ok: true, output: '' }) })
  const results = await poll()
  assert.match(results.find(r => r.id === 'T-1').reason, /running in the background/)
  assert.equal(results.find(r => r.id === 'T-2').status, 'held')
  await new Promise(done => setImmediate(done))
  const second = await poll()
  assert.match(second.find(r => r.id === 'T-1').reason, /running in the background/)
  assert.equal(second.find(r => r.id === 'T-2').status, 'integrated')
  assert.deepEqual(calls, { 'T-1': 1, 'T-2': 1 })
})

test('a timing-out recorded check returns the poll first, then holds its own card with backoff (HK73 AC2)', async t => {
  const { tasksDir, calls, poll } = recordedFixture(t, { 'T-1': () => new Promise(done => setTimeout(() => done({ ok: false, timedOut: true, output: 'npm test\ntimed out after 600s' }), 200)) })
  const now = Date.now(), start = performance.now()
  const [first] = await poll(now)
  assert.ok(performance.now() - start < 200, 'poll returned before the check timed out')
  assert.match(first.reason, /running in the background/)
  await new Promise(done => setTimeout(done, 300))
  const [second] = await poll(now)
  assert.equal(second.status, 'held'); assert.match(second.reason, /recorded check timed out.*; retrying at /)
  assert.equal(readWorkflow(tasksDir)['T-1'].integrationRetry.tries, 1)
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1'].conflictFailures, undefined)
  assert.equal(calls['T-1'], 1)
})

test('a background recorded check that passes integrates, and one that fails returns to the Builder (HK73 AC3)', async t => {
  const { tasksDir, poll } = recordedFixture(t, { 'T-1': async () => ({ ok: true, output: '' }), 'T-2': async () => ({ ok: false, output: 'npm test\n1 failing' }) })
  assert.deepEqual((await poll()).map(r => r.status), ['held', 'held'])
  await new Promise(done => setImmediate(done))
  const results = await poll()
  assert.equal(results.find(r => r.id === 'T-1').status, 'integrated')
  const returned = results.find(r => r.id === 'T-2')
  assert.deepEqual([returned.status, returned.to], ['returned', 'queue'])
  assert.match(returned.reason, /recorded check failed/)
  assert.equal(findCard(tasksDir, 'T-2').column, 'queue')
})

test('a failed integration check on a card whose plan fails the plan check goes to Owner with the reason, not silently stuck in Completed (HK25)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plan-return-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  // No Acceptance criteria section: moveCard to queue throws "Plan incomplete".
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n**Workflow:** card-owned\n**Plan readiness:** build-ready\n\n## Approved brief\nDo it\n## Files\n- `app.js` — change\n## Implementation plan\nChange app.js\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', worktreePath: root, workspacePath: root, baseCommit: 'b0' } }))
  const io = { agentList: async () => [], rebase: () => ({ status: 'rebased', commit: 'c1' }), runIntegrationCheck: async () => ({ ok: false, output: '1 failing' }) }
  const results = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], integrationCheck: 'npm test', io })
  assert.equal(results.length, 1)
  assert.deepEqual([results[0].status, results[0].to], ['returned', 'owner'])
  assert.match(results[0].reason, /Plan incomplete/)
  assert.equal(findCard(tasksDir, 'T-1').column, 'owner')
  const saved = JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1']
  assert.deepEqual([saved.state, saved.conflictFailures], ['conflict', 1])
  assert.match(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8'), /Needs you: T-1 cannot go back to a Builder: its plan fails the plan check \(Plan check found 2 problems/)
})

test('a Completed card in conflict state is never silent: one repeating held result per poll; Review cards return none (HK25)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'silent-conflict-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plan = id => `# ${id} — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n`
  for (const [column, id] of [['completed', 'T-1'], ['review', 'T-2']]) { mkdirSync(join(tasksDir, column), { recursive: true }); writeFileSync(join(tasksDir, column, `${id}.md`), plan(id)) }
  const entry = id => ({ cardId: id, state: 'conflict', conflictFailures: 1, worktreePath: root, workspacePath: root, baseCommit: 'b0', reason: 'integration check npm test failed on current master (full output: x.log)' })
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': entry('T-1'), 'T-2': entry('T-2') }))
  const io = { agentList: async () => [], rebase: () => null, reconcile: () => [] }
  for (const poll of [1, 2]) {
    const results = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', io })
    assert.equal(results.length, 1, `poll ${poll}`)
    assert.deepEqual([results[0].id, results[0].status, results[0].repeat], ['T-1', 'held', true])
    assert.match(results[0].reason, /worktree state conflict.*integration check npm test failed/)
  }
})

test('an integration check waits while dependencies install instead of failing the card (InjectbuddyApp IA154, IA155)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'check-install-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- `app.js` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', worktreePath: root, workspacePath: root, integrationWorkspace: join(root, 'main'), baseCommit: 'b0' } }))
  const t0 = Date.now(), min = 60000
  let checks = 0, installing = true, startsDuringCheck = false, result = { ok: false, output: "error TS2307: Cannot find module 'expo-router'" }
  const io = { agentList: async () => [], rebase: () => ({ status: 'rebased', commit: 'c1' }), installRunning: () => installing,
    runIntegrationCheck: async () => { checks++; installing ||= startsDuringCheck; return result }, reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const run = now => reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], integrationCheck: 'npm test', io, now })
  const registry = () => JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1']
  // An install is running in the shared folder: the check does not run at all.
  const [held] = await run(t0)
  assert.equal(held.status, 'held'); assert.match(held.reason, /integration check npm test is waiting for dependencies to install; retrying at \d{4}-/)
  assert.equal(checks, 0); assert.equal(registry().conflictFailures, undefined); assert.equal(findCard(tasksDir, 'T-1').column, 'completed')
  // The install started while the check ran: its failure is not the card's.
  installing = false; startsDuringCheck = true
  assert.equal((await run(t0 + 2 * min))[0].status, 'held')
  assert.equal(checks, 1); assert.equal(registry().conflictFailures, undefined)
  // Install finished: the same commit passes and integrates.
  installing = startsDuringCheck = false; result = { ok: true, output: 'ok' }
  assert.equal((await run(t0 + 10 * min))[0].status, 'integrated')
})

test('the integration check gets at least 900000 ms so a full suite is not killed at 300 s (HK58)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'check-timeout-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- `app.js` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', worktreePath: root, workspacePath: root, integrationWorkspace: join(root, 'main'), baseCommit: 'b0' } }))
  let seen
  const io = { agentList: async () => [], rebase: () => ({ status: 'rebased', commit: 'c1' }), installRunning: () => false,
    runIntegrationCheck: async (command, cwd, timeout) => { seen = timeout; return { ok: true, output: '' } }, reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], integrationCheck: 'npm test', io })
  assert.ok(seen >= 900000, `timeout ${seen}`)
})

// Audit 2026-10-15 F3. One Completed card with a worktree and the project's integration checkout;
// `outcomes(command, where)` is what the check returns in each folder ('card' or 'main').
function verdictFixture(t, outcomes, command = 'node herdr-kanban/run-tests.mjs --changed master') {
  const root = mkdtempSync(join(tmpdir(), 'check-verdict-')), tasksDir = join(root, 'TASKS'), card = join(root, 'card'), main = join(root, 'main')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), `# T-1 — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: npm test\nResult: passed\n`)
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', worktreePath: card, workspacePath: card, integrationWorkspace: main, baseCommit: 'b0' } }))
  const calls = []
  let commit = 'c1'
  const io = { agentList: async () => [], rebase: () => ({ status: 'rebased', commit }), installRunning: () => false,
    runIntegrationCheck: async (cmd, cwd) => { const where = cwd === card ? 'card' : cwd === main ? 'main' : cwd; calls.push([cmd, where]); return outcomes(cmd, where) },
    reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'integrated' }] }
  const run = (now = Date.now()) => reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], integrationCheck: command, io, now })
  const registry = () => JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1']
  return { tasksDir, card, main, calls, run, registry, moveMaster: c => { commit = c } }
}
const suiteFail = 'node herdr-kanban/run-tests.mjs --changed master\nok    syntax.test.mjs (1) 20s\nFAIL  builder-role-size.test.mjs (exit 1)\nnot ok 1 - size\n\n2 files, 3 tests, 1 failing files: builder-role-size.test.mjs'

test('a check failing on the card and on integration HEAD without it holds the card for the Kanban Manager, no Builder return (audit 2026-10-15 F3 AC1)', async t => {
  const f = verdictFixture(t, () => ({ ok: false, output: suiteFail }))
  const t0 = Date.now()
  const [held] = await f.run(t0)
  assert.equal(held.status, 'held')
  assert.match(held.reason, /^integration check node herdr-kanban\/run-tests\.mjs builder-role-size\.test\.mjs broken on master: it fails on integration HEAD without the card too, in .*main \(full output: /)
  assert.doesNotMatch(held.reason, /failed on current master/)
  assert.deepEqual([held.alert.key, held.alert.title], ['integration-check:base', 'integration check broken on master, T-1 held'])
  // Full suite on the card, the failing file again on the card, then that file on master without the card.
  assert.deepEqual(f.calls, [['node herdr-kanban/run-tests.mjs --changed master', 'card'], ['node herdr-kanban/run-tests.mjs builder-role-size.test.mjs', 'card'], ['node herdr-kanban/run-tests.mjs builder-role-size.test.mjs', 'main']])
  assert.equal(findCard(f.tasksDir, 'T-1').column, 'completed')
  assert.deepEqual([f.registry().state, f.registry().conflictFailures], ['building', undefined])
  assert.equal(readWorkflow(f.tasksDir)['T-1'].integrationBroken.commit, 'c1')
  // The hold is kept for this commit: the next poll repeats it without running anything.
  const [again] = await f.run(t0 + 60000)
  assert.deepEqual([again.status, again.reason, f.calls.length], ['held', held.reason, 3])
  // Master moved (new rebased commit): checked again.
  f.moveMaster('c2')
  assert.equal((await f.run(t0 + 120000))[0].status, 'held')
  assert.equal(f.calls.length, 6)
})

test('a check command that cannot start is a configuration hold naming the command and cwd, not a failure on master (audit 2026-10-15 F3 AC2)', async t => {
  const f = verdictFixture(t, () => ({ ok: false, output: "node herdr-kanban/run-tests.mjs --changed master\nnode:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module 'C:\\w\\T-1\\herdr-kanban\\run-tests.mjs'\n    at Module._resolveFilename\n  code: 'MODULE_NOT_FOUND'" }))
  const [held] = await f.run()
  assert.equal(held.status, 'held')
  assert.ok(held.reason.startsWith(`integration check node herdr-kanban/run-tests.mjs --changed master could not run in ${f.card}: Error: Cannot find module`), held.reason)
  assert.doesNotMatch(held.reason, /failed on current master/)
  assert.equal(held.alert.key, 'integration-check:config')
  assert.equal(f.calls.length, 1, 'no rerun of a command that cannot start')
  assert.equal(findCard(f.tasksDir, 'T-1').column, 'completed')
  assert.equal(f.registry().conflictFailures, undefined)
})

test('a check that fails only on the card still returns it to a Builder; one that passes on rerun integrates (audit 2026-10-15 F3 AC3)', async t => {
  const f = verdictFixture(t, (cmd, where) => ({ ok: where === 'main', output: where === 'main' ? 'ok    builder-role-size.test.mjs (1) 2s\n1 files, 1 tests, 0 failing files' : suiteFail }))
  const [returned] = await f.run()
  assert.deepEqual([returned.status, returned.to], ['returned', 'queue'])
  assert.match(returned.reason, /integration check node herdr-kanban\/run-tests\.mjs builder-role-size\.test\.mjs failed on current master and passes there without the card/)
  assert.equal(f.calls.length, 3)
  assert.deepEqual([f.registry().state, f.registry().conflictFailures], ['conflict', 1])
  assert.equal(findCard(f.tasksDir, 'T-1').column, 'queue')
  assert.match(readFileSync(findCard(f.tasksDir, 'T-1').path, 'utf8'), /Kicked back: integration check[\s\S]*=== on integration HEAD without the card/)

  let tries = 0
  const flaky = verdictFixture(t, () => ({ ok: ++tries > 1, output: tries > 1 ? '1 files, 1 tests, 0 failing files' : suiteFail }))
  const [integrated] = await flaky.run()
  assert.equal(integrated.status, 'integrated')
  assert.deepEqual(flaky.calls.map(c => c[0]), ['node herdr-kanban/run-tests.mjs --changed master', 'node herdr-kanban/run-tests.mjs builder-role-size.test.mjs'])
  assert.equal(flaky.registry().integrationChecked, 'c1')
  // A command that does not name failing files reruns whole; a type error that ran is the card's.
  const { cannotRun, narrowedCheck } = await import('./lib/completed-handoff.mjs')
  assert.equal(narrowedCheck('npx tsc --noEmit && npm test', 'FAIL  x.test.mjs'), 'npx tsc --noEmit && npm test')
  assert.equal(narrowedCheck('node herdr-kanban/run-tests.mjs', 'no FAIL lines'), 'node herdr-kanban/run-tests.mjs')
  assert.equal(cannotRun("error TS2307: Cannot find module 'expo-router'"), false)
  assert.equal(cannotRun("'npx' is not recognized as an internal or external command"), true)
})

test('a replacement Builder recorded with the previous pane session is still retired', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-replaced-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p2', name: 'b-t-1-2' } } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: {
    a: { paneId: 'p1', role: 'builder', cardIds: ['T-1'], sessionId: 'old' },
    b: { paneId: 'p2', role: 'builder', cardIds: ['T-1'], sessionId: 'old' } } }))
  let agent = { pane_id: 'p2', name: 'b-t-1-2', agent_session: { value: 'new' }, agent_status: 'done' }
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'out', recordUsageFinish: async () => {},
    paneClose: async () => { agent = null }, reconcile: () => [{ id: 'T-1', status: 'integrated' }] }
  assert.equal((await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io }))[0].status, 'integrated')
})

test('a finished Builder whose pane is already gone counts as retired, so the card still integrates (Tradeflow T-38)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-gone-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'builder' } } }))
  let closed = 0
  const io = { agentList: async () => [], paneRead: async () => '', recordUsageFinish: async () => {},
    paneClose: async () => { closed++ }, reconcile: () => [{ id: 'T-1', status: 'integrated' }] }
  assert.equal((await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io }))[0].status, 'integrated')
  assert.equal(closed, 0)
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.workflow-state.json'), 'utf8'))['T-1'].builderRetired.note, 'pane already closed')
})

test('a Claude Builder with no recorded session is identified by its live board-named pane (I265)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'handoff-claude-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  writeFileSync(join(tasksDir, 'completed', 'T-1.md'), '# T-1 — task\n')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { cardId: 'T-1', state: 'building', commit: 'saved' } }))
  writeFileSync(join(tasksDir, '.workflow-state.json'), JSON.stringify({ 'T-1': { completedStage: 'working', builder: { pane_id: 'p', name: 'b-t-1' } } }))
  writeFileSync(join(tasksDir, '.request-usage.json'), JSON.stringify({ runs: { r: { paneId: 'p', role: 'builder', cardIds: ['T-1'], sessionId: null } } }))
  let agent = { pane_id: 'p', name: 'b-t-1', agent_session: { value: 'claude-session' }, agent_status: 'done' }, integrated = 0
  const io = { agentList: async () => agent ? [agent] : [], paneRead: async () => 'out', recordUsageFinish: async () => {},
    paneClose: async () => { agent = null }, reconcile: () => { integrated++; return [{ id: 'T-1', status: 'integrated' }] } }
  const [result] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.doesNotMatch(result.reason || '', /identity/)
  assert.equal(integrated, 1)
})

test('a rebase that fails without a conflicting file is re-run with backoff twice before a Builder is spent; a content conflict returns at once (audit 2026-10-15 F8)', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rebase-retry-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plan = id => `# ${id} — task\n**Workflow:** card-owned\n\n## Approved brief\nDo it\n## Files\n- \`app.js\` — change\n## Implementation plan\nChange app.js\n## Acceptance criteria\n- AC1: works\n## Implementation\nStage: builder\nOutcome: PASS\n## Evidence\nCheck: node -e "process.exit(0)"\nResult: passed\n`
  mkdirSync(join(tasksDir, 'completed'), { recursive: true })
  for (const id of ['T-1', 'T-2']) writeFileSync(join(tasksDir, 'completed', `${id}.md`), plan(id))
  const entry = id => ({ cardId: id, state: 'building', worktreePath: root, workspacePath: root, baseCommit: 'b0' })
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': entry('T-1'), 'T-2': entry('T-2') }))
  let rebases = 0
  const noFiles = { status: 'conflict', reason: 'integration conflict while rebasing onto master h1h1h1h1h1h1', files: [], hunks: 'fatal: Unable to create index.lock: File exists.', head: 'h1' }
  const io = { agentList: async () => [], reconcile: ({ onlyIds }) => { rebases++; return [{ id: onlyIds[0], ...noFiles }] } }
  let now = 1_000_000
  const poll = () => reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io, now })
  let [r] = await poll()
  assert.equal(r.status, 'held'); assert.match(r.reason, /^rebase onto integration failed without a conflicting file \(integration conflict while rebasing onto master h1h1h1h1h1h1\); re-running it; retrying at /)
  assert.equal(findCard(tasksDir, 'T-1').column, 'completed', 'no Builder spent')
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1'].state, 'building')
  ;[r] = await poll()
  assert.equal(r.status, 'held'); assert.equal(rebases, 1, 'not re-run before the backoff passes')
  now += 2 * 60000
  ;[r] = await poll()
  assert.equal(rebases, 2); assert.equal(r.status, 'held')
  now += 6 * 60000
  ;[r] = await poll()
  assert.equal(rebases, 3)
  assert.deepEqual([r.status, r.to], ['returned', 'queue'], 'the third failure returns it to a Builder')
  assert.equal(findCard(tasksDir, 'T-1').column, 'queue')
  assert.equal(readWorkflow(tasksDir)['T-1'].integrationRetry, null)

  // A content conflict names its files: a re-run would hit the same conflict, so it returns now.
  const conflict = { ...noFiles, files: ['app.js'], hunks: '<<<<<<< HEAD\nmaster\n=======\ncard\n>>>>>>> card' }
  const [first] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-2'], io: { ...io, reconcile: ({ onlyIds }) => [{ id: onlyIds[0], ...conflict }] }, now })
  assert.deepEqual([first.status, first.to], ['returned', 'queue'])
  assert.match(first.reason, /\(files: app\.js\)/)
})

// Audit 2026-10-15 F9: waiting for integration is the normal state of a Completed card, so that
// skip is marked expected (the scheduler does not log it); other states and a missing worktree are not.
test('an archive skip for a worktree still before integration is expected; a conflict or a missing worktree is not (audit 2026-10-15 F9)', t => {
  const root = mkdtempSync(join(tmpdir(), 'archive-expected-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const id of ['T-1', 'T-2', 'T-3', 'T-4']) putCard(tasksDir, 'completed', id)
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({ 'T-1': { state: 'building' }, 'T-2': { state: 'integrating' }, 'T-3': { state: 'conflict' } }))
  const { archived, skipped } = archiveNoReviewCards(tasksDir)
  assert.deepEqual(archived, [])
  assert.deepEqual(skipped.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'T-1', reason: 'worktree state is building, not integrated', expected: true },
    { id: 'T-2', reason: 'worktree state is integrating, not integrated', expected: true },
    { id: 'T-3', reason: 'worktree state is conflict, not integrated' },
    { id: 'T-4', reason: 'worktree state is missing, not integrated' },
  ])
})
