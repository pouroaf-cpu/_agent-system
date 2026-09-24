import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { operatorApprove } from './lib/card-planner.mjs'
import { operatorFinish } from './lib/completed-handoff.mjs'
import { archiveNoReviewCards, promoteAutoReview } from './lib/autospawn.mjs'
import { awaitsOperatorApproval, findCard, moveCard, validatePlan } from './lib/cards.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

const plan = (approved = true) => `**Plan readiness:** investigation\n${approved ? '**Investigation approved:** yes\n' : ''}## Approved brief\nMeasure the issue.\n## Files\n- \`app.mjs\` result\n## Implementation plan\nMeasurement command: node measure.mjs\nExpected result: record timing\nStop rules: stop if unavailable\n## Acceptance criteria\n- AC1: measurement saved\n## Implementation\nStage: builder\nOutcome: PASS\nFiles: app.mjs\nBlocker: none\n## Evidence\nCheck: node check.mjs\nResult: passed\nEvidence: proof\n`
const card = (id, { autoReview = 'no', approved } = {}) => `# ${id} — task\n**Workflow:** card-owned\n**Auto-review:** ${autoReview}\n**Workspace:** .\n${plan(approved)}`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'operator-buttons-')), tasksDir = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return tasksDir
}
function put(tasksDir, lane, id, options) {
  mkdirSync(join(tasksDir, lane), { recursive: true })
  writeFileSync(join(tasksDir, lane, `${id}.md`), card(id, options))
}
const registry = (tasksDir, entries) => writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify(Object.fromEntries(Object.entries(entries).map(([id, state]) => [id, { cardId: id, state, commit: 'c1' }]))))
const stateOf = (tasksDir, id) => JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))[id]?.state
// Stands in for the poll's cherry-pick: lands the card, or reports a hold.
const integrates = tasksDir => ({ agentList: async () => [], reconcile: ({ onlyIds }) => {
  const all = JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8'))
  all[onlyIds[0]].state = 'integrated'
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify(all))
  return [{ id: onlyIds[0], status: 'integrated', commit: 'c1' }]
} })
const heldIo = { agentList: async () => [], reconcile: ({ onlyIds }) => [{ id: onlyIds[0], status: 'held', reason: 'integration worktree is dirty: C:/repo' }] }

test('Approve adds the investigation marker above the brief and returns the card to Planning', t => {
  const tasksDir = fixture(t)
  put(tasksDir, 'planning', 'T-1', { approved: false })
  assert.equal(awaitsOperatorApproval(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')), true)
  moveCard(tasksDir, 'T-1', 'owner')
  const { card: moved, investigation } = operatorApprove(tasksDir, 'T-1')
  assert.equal(investigation, true)
  assert.equal(moved.column, 'planning')
  const text = readFileSync(moved.path, 'utf8')
  assert.match(text, /\*\*Plan readiness:\*\* investigation\n\*\*Investigation approved:\*\* yes\n## Approved brief/)
  assert.match(text, /\*\*Operator decision\*\* \d{4}-\d\d-\d\dT[^\n]+\n\nApproved by operator from board/)
  assert.doesNotThrow(() => validatePlan(text))
  assert.ok(readWorkflow(tasksDir)['T-1'].limitsResetAt, 'operatorRetry reset the limits')
})

test('Approve without the investigation marker returns the card to the lane it left, else Planning', t => {
  const tasksDir = fixture(t)
  for (const [id, from, expected] of [['T-1', 'review', 'review'], ['T-2', 'working', 'queue'], ['T-3', 'planning', 'planning'], ['T-4', 'queue', 'queue']]) {
    put(tasksDir, from, id)
    moveCard(tasksDir, id, 'owner')
    const { card: moved, investigation } = operatorApprove(tasksDir, id)
    assert.equal(investigation, false)
    assert.equal(moved.column, expected, `${id} from ${from}`)
    assert.equal(readFileSync(moved.path, 'utf8').match(/Investigation approved/g).length, 1, 'marker untouched')
  }
  put(tasksDir, 'owner', 'T-5') // no history: Planning
  assert.equal(operatorApprove(tasksDir, 'T-5').card.column, 'planning')
  put(tasksDir, 'queue', 'T-6')
  assert.throws(() => operatorApprove(tasksDir, 'T-6'), /only on Owner cards/)
})

test('Finish on Review adds an operator PASS that survives integration and archives instead of re-reviewing', async t => {
  const tasksDir = fixture(t)
  put(tasksDir, 'review', 'T-1', { autoReview: 'yes' })
  registry(tasksDir, { 'T-1': 'integrated' })
  const done = await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-1' })
  assert.equal(done.card.column, 'archive')
  const text = readFileSync(done.card.path, 'utf8')
  assert.match(text, /## Reviewer evidence\n\n\*\*Operator decision\*\* [^\n]+\n\nOperator finished from board; no independent review\n\n\*\*Review verdict:\*\* PASS/)

  // Not integrated yet and integration held: it waits in Completed with the PASS.
  put(tasksDir, 'review', 'T-2', { autoReview: 'yes' })
  registry(tasksDir, { 'T-2': 'building' })
  const held = await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-2', io: heldIo })
  assert.equal(held.held, 'integration worktree is dirty: C:/repo')
  assert.equal(findCard(tasksDir, 'T-2').column, 'completed')
  // The poll integrates it later: no trip back to Review, the normal flow archives it.
  registry(tasksDir, { 'T-2': 'integrated' })
  const all = JSON.parse(readFileSync(join(tasksDir, '.board-worktrees.json'), 'utf8')); all['T-2'].cleaned = true
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify(all))
  assert.deepEqual(promoteAutoReview(tasksDir), [])
  assert.deepEqual(archiveNoReviewCards(tasksDir).archived, ['T-2'])
})

test('Finish on Completed: integrated and legacy archive now, unintegrated integrates first, a hold refuses', async t => {
  const tasksDir = fixture(t)
  put(tasksDir, 'completed', 'T-1'); put(tasksDir, 'completed', 'T-2'); put(tasksDir, 'completed', 'T-3'); put(tasksDir, 'completed', 'T-4')
  registry(tasksDir, { 'T-1': 'integrated', 'T-3': 'building', 'T-4': 'ready' })
  const never = { agentList: async () => [], reconcile: () => { throw new Error('must not integrate') } }

  assert.equal((await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-1', io: never })).card.column, 'archive')
  assert.equal((await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-2', io: never })).card.column, 'archive', 'legacy: no board worktree')

  const landed = await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-3', io: integrates(tasksDir) })
  assert.equal(stateOf(tasksDir, 'T-3'), 'integrated')
  assert.equal(landed.card.column, 'archive')
  assert.equal(landed.results[0].status, 'integrated')

  const held = await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-4', io: heldIo })
  assert.equal(held.held, 'integration worktree is dirty: C:/repo')
  assert.equal(findCard(tasksDir, 'T-4').column, 'completed')
  assert.equal(stateOf(tasksDir, 'T-4'), 'ready', 'code kept, nothing forced')
  const noGit = await operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-4', git: false })
  assert.match(noGit.held, /no Git integration settings/)
  assert.equal(findCard(tasksDir, 'T-4').column, 'completed')

  put(tasksDir, 'queue', 'T-5')
  await assert.rejects(operatorFinish({ tasksDir, project: 'Proof', cardId: 'T-5' }), /only on Review and Completed/)
})

test('board API: Approve and Finish route, release the archive, and a held Finish refuses', async t => {
  const root = join(fixture(t), '..') // the fixture's own temp dir, removed after the test
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ port: 18785, projectsRoot: root, projects: ['Proof'], maxConcurrentAgents: 0, models: { working: 'test' }, agentPollMs: 600000 }))
  const tasks = join(root, 'Proof', 'TASKS')
  put(tasks, 'review', 'T-1'); moveCard(tasks, 'T-1', 'owner')
  put(tasks, 'completed', 'T-2'); put(tasks, 'completed', 'T-3'); put(tasks, 'review', 'T-4')
  registry(tasks, { 'T-3': 'ready', 'T-4': 'building' })
  const child = spawn(process.execPath, [join(import.meta.dirname, 'server.mjs')], { cwd: import.meta.dirname, env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'nonexistent-operator-test-herdr' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(() => { if (child.exitCode === null) child.kill() })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 10000)
    child.stdout.on('data', bytes => { if (String(bytes).includes('http://')) { clearTimeout(timer); resolve() } })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`test server exited ${code}`)) })
  })
  const post = (op, id) => fetch(`http://127.0.0.1:18785/api/${op}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Proof', id }) }).then(async r => ({ status: r.status, ...(await r.json()) }))
  const approved = await post('approve', 'T-1')
  assert.deepEqual([approved.status, approved.card.column], [200, 'review'])
  assert.equal((await post('approve', 'T-1')).status, 400, 'only Owner cards')
  const finished = await post('finish', 'T-2')
  assert.deepEqual([finished.status, finished.card.column], [200, 'archive'])
  const refused = await post('finish', 'T-3')
  assert.equal(refused.status, 409)
  assert.match(refused.error, /T-3 not finished: integration held — project has no Git integration settings/)
  assert.equal(findCard(tasks, 'T-3').column, 'completed')
  const review = await post('finish', 'T-4')
  assert.deepEqual([review.status, review.card.column], [200, 'completed'])
  assert.match(review.held, /no Git integration settings/)
  assert.match(await fetch('http://127.0.0.1:18785/board.js').then(r => r.text()), /card-op[\s\S]*'Approve' : 'Finish'/)
})
