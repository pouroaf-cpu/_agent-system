import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { reserveReview, updateReviewClaim, syncReviewClaims, readReviewClaims, assertReviewHandoff, busyReviewCards, prepareReviewSnapshot, failReviewClaim } from './lib/review-claims.mjs'
import { saveReviewGroups, computeReviewPlan } from './lib/review-plan.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { routeReviewVerdicts, reconcileReviewers } from './lib/autospawn.mjs'
import { readCardPlanners } from './lib/card-planner.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'review-cap-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tasks = join(root, 'TASKS'); mkdirSync(tasks)
  const inventory = ['one', 'two'].map(project => ({ project, tasksDir: tasks, known: true, agents: [] }))
  const reserve = (cards, project = 'one', now = Date.now()) => reserveReview(root, { project, tasksDir: tasks, cards, inventory, now })
  const card = (id, column = 'review', extra = '') => {
    mkdirSync(join(tasks, column), { recursive: true })
    writeFileSync(join(tasks, column, `${id}-test.md`), `# ${id} — Test\n\n**Workflow:** card-owned\n\n${extra}`)
  }
  return { root, tasks, inventory, reserve, card }
}
test('four global slots include starts and legacy agents; duplicate claims survive reload', t => {
  const f = fixture(t)
  f.inventory[1].agents.push({ name: 'kb-review-old', pane_id: 'w2:p1', agent_status: 'working' })
  const a = f.reserve(['T-1'])
  assert.throws(() => f.reserve(['T-1']), /already claimed/)
  f.reserve(['T-2']); f.reserve(['T-3'])
  assert.equal(readReviewClaims(f.root).length, 4)
  assert.throws(() => f.reserve(['T-4']), /limit is four/)
  assertReviewHandoff(f.root, f.tasks, 'T-1', a.id)
  assert.throws(() => assertReviewHandoff(f.root, f.tasks, 'T-2', a.id), /not owned/)
  assert.throws(() => assertReviewHandoff(f.root, f.tasks, 'T-1'), /claim required/)
})
test('unknown inventory and corrupt persisted claims fail closed', t => {
  const f = fixture(t)
  f.inventory[1].known = false
  assert.throws(() => f.reserve(['T-1']), /inventory unavailable/)
  writeFileSync(join(f.root, '.review-claims.json'), JSON.stringify({ version: 1, claims: [{}] }))
  assert.throws(() => readReviewClaims(f.root), /shape/)
})
test('stale dead-owner launch preserves Review and blocks unchanged redispatch', t => {
  const f = fixture(t); f.card('T-1')
  writeFileSync(join(f.tasks, '.card-planners.json'), JSON.stringify({ 'T-1': { paneId: 'original', submitted: true } }))
  const c = f.reserve(['T-1'], 'one', 1000)
  updateReviewClaim(f.root, c.id, { ownerPid: 2147483647 })
  const lock = join(f.root, '.review-claims.json.lock')
  writeFileSync(lock, JSON.stringify({ pid: 2147483647 })); utimesSync(lock, new Date(0), new Date(0))
  assert.equal(syncReviewClaims(f.root, f.inventory, 122000).length, 0)
  assert.equal(findCard(f.tasks, 'T-1').column, 'review')
  assert.equal(readCardPlanners(f.tasks)['T-1'].paneId, 'original')
  assert.equal(readCardPlanners(f.tasks)['T-1'].submitted, true)
  syncReviewClaims(f.root, f.inventory, 250000)
  assert.match(readWorkflow(f.tasks)['T-1'].operational.reason, /without a per-card verdict/)
})
test('a launch whose board process died after opening the pane is retired, not held in starting (Tradeflow T-38)', t => {
  const f = fixture(t); f.card('T-1')
  const c = f.reserve(['T-1'], 'one', 1000)
  updateReviewClaim(f.root, c.id, { ownerPid: 2147483647, paneId: 'w1:p9' })
  f.inventory[0].agents.push({ name: 'r-t-1', pane_id: 'w1:p9', agent_status: 'idle' })
  assert.equal(syncReviewClaims(f.root, f.inventory, 122000).length, 0)
  assert.match(readWorkflow(f.tasks)['T-1'].operational.reason, /restarted before the reviewer prompt/)
  assert.equal(syncReviewClaims(f.root, f.inventory, 130000).length, 0, 'the idle pane is not re-adopted as a legacy claim')
})

test('finished group returns missing verdicts while another group remains independently busy', t => {
  const f = fixture(t); f.card('T-1'); f.card('T-2')
  const a = f.reserve(['T-1']), b = f.reserve(['T-2'])
  updateReviewClaim(f.root, a.id, { paneId: 'a', phase: 'running' })
  updateReviewClaim(f.root, b.id, { paneId: 'b', phase: 'running' })
  f.inventory[0].agents = [{ name: 'kb-review-a', pane_id: 'a', agent_status: 'done' }, { name: 'kb-review-b', pane_id: 'b', agent_status: 'working' }]
  const now = Date.now(); syncReviewClaims(f.root, f.inventory, now)
  assert.deepEqual(busyReviewCards(f.root, f.tasks, f.inventory[0].agents), ['T-2'])
  syncReviewClaims(f.root, f.inventory, now + 120001)
  assert.equal(findCard(f.tasks, 'T-1').column, 'review')
  assert.equal(findCard(f.tasks, 'T-2').column, 'review')
  assert.equal(readReviewClaims(f.root).filter(c => !c.closedAt).length, 1)
})
test('startup failure preserves Review and closes reservation', t => {
  const f = fixture(t); f.card('T-1')
  const c = f.reserve(['T-1']); failReviewClaim(f.root, c.id, 'dependency setup missing')
  assert.equal(findCard(f.tasks, 'T-1').column, 'review')
  assert.ok(readReviewClaims(f.root)[0].closedAt)
})
test('explicit group registration does not move or split Completed cards', t => {
  const f = fixture(t); f.card('T-1', 'completed'); f.card('T-2', 'completed')
  saveReviewGroups(f.tasks, [{ name: 'dashboard', cards: ['T-1', 'T-2'] }])
  assert.equal(findCard(f.tasks, 'T-1').column, 'completed')
  assert.deepEqual(computeReviewPlan({ tasksDir: f.tasks }).batches[0].cards, ['T-1', 'T-2'])
  assert.equal(computeReviewPlan({ tasksDir: f.tasks, claimedIds: ['T-1'] }).batches.length, 0)
  assert.throws(() => saveReviewGroups(f.tasks, [{ name: 'x', cards: ['T-1', 'T-1'] }]), /duplicate/)
})
test('per-card verdicts route independently and preserve original Planner', t => {
  const f = fixture(t)
  f.card('T-1', 'review', '## Reviewer evidence\n[planning] Plan omitted keyboard support.\n\n**Review verdict:** FAIL\n')
  f.card('T-2', 'review', '## Reviewer evidence\nExpected check passed.\n\n**Review verdict:** PASS\n')
  writeFileSync(join(f.tasks, '.card-planners.json'), JSON.stringify({ 'T-1': { paneId: 'original', submitted: true } }))
  assert.equal(routeReviewVerdicts(f.tasks, { busyCardIds: ['T-2'] }).length, 1)
  assert.equal(findCard(f.tasks, 'T-1').column, 'planning')
  assert.equal(readCardPlanners(f.tasks)['T-1'].paneId, 'original')
  assert.equal(readCardPlanners(f.tasks)['T-1'].submitted, false)
  assert.equal(findCard(f.tasks, 'T-2').column, 'review')
  routeReviewVerdicts(f.tasks)
  assert.equal(findCard(f.tasks, 'T-2').column, 'completed')
})
test('an uncertain reviewer left idle is retired and its pane closed; one seen working becomes running (audit 2026-09-26 #12)', async t => {
  const f = fixture(t); f.card('T-1'); f.card('T-2')
  const a = f.reserve(['T-1'], 'one', 1000), b = f.reserve(['T-2'], 'one', 1000)
  updateReviewClaim(f.root, a.id, { paneId: 'a', phase: 'uncertain' })
  updateReviewClaim(f.root, b.id, { paneId: 'b', phase: 'uncertain' })
  const agents = [{ name: 'r-t-1', pane_id: 'a', agent_status: 'idle' }, { name: 'r-t-2', pane_id: 'b', agent_status: 'working' }]
  const closed = []
  const poll = now => reconcileReviewers({ reviewRoot: f.root, project: 'one', tasksDir: f.tasks, agents, now, close: async pane => closed.push(pane) })
  await poll(10000)
  assert.deepEqual(readReviewClaims(f.root).map(c => [c.paneId, c.phase, !!c.closedAt]), [['a', 'uncertain', false], ['b', 'running', false]])
  await poll(10000 + 180000)
  assert.deepEqual(readReviewClaims(f.root).filter(c => !c.closedAt).map(c => c.paneId), ['b'], 'the idle claim frees its slot')
  assert.deepEqual(closed, ['a'])
  assert.match(readWorkflow(f.tasks)['T-1'].operational.reason, /never started/)
  await poll(10000 + 240000)
  assert.deepEqual(closed, ['a'], 'a retired pane is closed once')
})
test('a claim whose pane is gone is retired on a poll with no review work (audit 2026-09-26 #12)', async t => {
  const f = fixture(t)
  const a = f.reserve(['T-9'], 'one', 1000)
  updateReviewClaim(f.root, a.id, { paneId: 'lost', phase: 'running' })
  await reconcileReviewers({ reviewRoot: f.root, project: 'one', tasksDir: f.tasks, agents: [], now: 200000, close: async () => {} })
  assert.equal(readReviewClaims(f.root).filter(c => !c.closedAt).length, 0)
})
test('a Reviewer that stopped on an engine usage limit blocks that engine, closes its pane and leaves no failure on its cards', async t => {
  const { quotaHold } = await import('./lib/quota.mjs')
  const f = fixture(t); f.card('T-1')
  const a = f.reserve(['T-1'], 'one', 1000)
  updateReviewClaim(f.root, a.id, { paneId: 'a', phase: 'running', engine: 'codex' })
  const agents = [{ name: 'r-t-1', pane_id: 'a', agent_status: 'done' }]
  const closed = []
  const poll = now => reconcileReviewers({ reviewRoot: f.root, boardRoot: f.root, project: 'one', tasksDir: f.tasks, agents, now, close: async pane => closed.push(pane),
    read: async () => '■ You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again later.\n\n› Ask Codex to do anything' })
  await poll(10000)
  await poll(10000 + 180000)
  assert.deepEqual(closed, ['a'])
  assert.equal(readWorkflow(f.tasks)['T-1'].operational, null)
  assert.match(quotaHold(f.root, 'codex', 10000 + 180000 + 60000), /^Codex usage limit; retrying at /)
})
test('isolated snapshots pin committed HEAD and separate build output; non-Git is report-only', t => {
  const f = fixture(t); const repo = join(f.root, 'repo'); mkdirSync(repo)
  const git = (...args) => { const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim() }
  git('init'); git('config', 'user.email', 'test@example.invalid'); git('config', 'user.name', 'Test')
  writeFileSync(join(repo, 'page.txt'), 'committed'); git('add', 'page.txt'); git('commit', '-m', 'fixture')
  writeFileSync(join(repo, 'page.txt'), 'uncommitted')
  const a = prepareReviewSnapshot(f.root, repo, 'a'), b = prepareReviewSnapshot(f.root, repo, 'b')
  assert.equal(a.head, git('rev-parse', 'HEAD')); assert.equal(a.head, b.head)
  assert.notEqual(join(a.path, '.next'), join(b.path, '.next'))
  assert.equal(readFileSync(join(a.path, 'page.txt'), 'utf8'), 'committed')
  assert.equal(readFileSync(join(repo, 'page.txt'), 'utf8'), 'uncommitted')
  assert.equal(prepareReviewSnapshot(f.root, f.tasks, 'nongit').reportOnly, true)
})
