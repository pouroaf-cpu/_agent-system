import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { reconcileCompletedHandoffs } from './lib/completed-handoff.mjs'
import { archiveNoReviewCards, promoteAutoReview, routeReviewVerdicts } from './lib/autospawn.mjs'
import { appendReviewPass, canArchive, findCard, moveCard } from './lib/cards.mjs'
import { evidenceFingerprint } from './lib/workflow-state.mjs'

const cardText = (id, flag = 'no') => `# ${id} — task\n**Workflow:** card-owned\n${flag === null ? '' : `**Auto-review:** ${flag}\n`}**Category:** code\n**Workspace:** .\n**Workflow version:** 2\n\n## Implementation\nStage: builder\nOutcome: PASS\nFiles: example.js\nBlocker: none\n\n## Evidence\nStage: builder\nOutcome: PASS\nCheck: check\nResult: passed\nEvidence: proof\nBlocker: none\n`

function putCard(tasksDir, column, id, flag = 'no') {
  mkdirSync(join(tasksDir, column), { recursive: true })
  const path = join(tasksDir, column, `${id}.md`)
  writeFileSync(path, cardText(id, flag))
  return path
}

function runHkb(tasksDir, verb, id, note = '') {
  return spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasksDir, verb, id, ...(note ? [note] : [])], { encoding: 'utf8' })
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
    { id: 'T-4', reason: 'worktree state is building, not integrated' },
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
  const git = (cwd, ...args) => { const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
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

test('integration conflicts never loop: one Builder resolution, then Owner; a clean rebase must pass the recorded check', async t => {
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
  assert.equal(JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))['T-1'].state, 'conflict')
  // The Builder hands off again but it still conflicts: one plain question to Owner.
  moveCard(tasksDir, 'T-1', 'completed'); registry({ 'T-1': 'building' })
  const [second] = await reconcileCompletedHandoffs({ tasksDir, project: 'Proof', onlyIds: ['T-1'], io })
  assert.equal(second.to, 'owner')
  assert.match(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8'), /Needs you: T-1 still does not integrate with master after 2 tries[\s\S]*\?/)

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
