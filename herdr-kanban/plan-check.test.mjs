import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { autoPlanCheck, finishPlanCheck, promotePlanned, spawnReviewer } from './lib/autospawn.mjs'
import { findCard, moveCard } from './lib/cards.mjs'
import { reserveReview, updateReviewClaim, readReviewClaims, syncReviewClaims } from './lib/review-claims.mjs'
import { evidenceFingerprint, readWorkflow } from './lib/workflow-state.mjs'
import { historyPath } from './lib/card-history.mjs'
import { recoveryState } from './lib/recovery.mjs'
import { globalSettings, assignmentFor, setCardOverride } from './lib/agent-settings.mjs'
import { startRetryHold } from './lib/spawn.mjs'
import { planCheckerPrompt } from './lib/prompt.mjs'

test('plan-check prompt requires measured AC targets and fails unmeasurable Checks', () => {
  const prompt = planCheckerPrompt({ cards: [{ id: 'T-1', path: 'TASKS/T-1.md' }],
    projectPath: '.', boardRoot: '.', reviewRoot: '.', reviewClaim: 'claim' })
  assert.match(prompt, /An AC assertion failing on the unchanged base is the expected result and is PASS/)
  assert.match(prompt, /reach and measure every AC target on every listed viewport\/state/)
  assert.match(prompt, /FAIL instead when the Check could not measure: a selector\/locator timeout, zero measurements/)
  assert.match(prompt, /exact Planner correction naming the missing selector\/state\/interaction/)
  assert.match(prompt, /RETRY is only for environment failures/)
})

test('independent plan gate dispatches once, queues PASS, returns FAIL to Planner without return counts, and can be disabled', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plan-check-')), repo = join(root, 'repo'), tasksDir = join(root, 'TASKS')
  const previous = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  writeFileSync(process.env.KANBAN_CONFIG, JSON.stringify({ projects: [], workflowLimits: {} }))
  t.after(() => { if (previous === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = previous })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(repo); mkdirSync(join(tasksDir, 'backlog'), { recursive: true })
  const git = args => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
    assert.equal(r.status, 0, r.stderr); return r.stdout.trim()
  }
  git(['init']); writeFileSync(join(repo, 'app.mjs'), 'export const result = false\n')
  git(['add', 'app.mjs']); git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'base'])
  const head = git(['rev-parse', 'HEAD'])
  // Integration keeps moving while a checker runs (other cards land): a PASS must still count.
  const moved = join(root, 'integration')
  assert.equal(spawnSync('git', ['clone', '-q', repo, moved], { windowsHide: true }).status, 0)
  writeFileSync(join(moved, 'other.mjs'), 'export const other = 1')
  assert.equal(spawnSync('git', ['-C', moved, 'add', 'other.mjs'], { windowsHide: true }).status, 0)
  assert.equal(spawnSync('git', ['-C', moved, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'landed'], { windowsHide: true }).status, 0)
  writeFileSync(join(tasksDir, 'backlog', 'T-1.md'), '# T-1 — checked plan\n**Workflow:** card-owned\n## Approved brief\nMake result true\n## Files\n- `app.mjs` result\n## Implementation plan\nCheck: node -e "assert(result)"\n**Base check:** result is false\n## Acceptance criteria\nResult true\n')
  const inventory = async () => [{ project: 'Proof', tasksDir, known: true, agents: [] }]
  const claim = () => {
    const c = reserveReview(root, { project: 'Proof', tasksDir, cards: ['T-1'], inventory: [{ project: 'Proof', tasksDir, known: true, agents: [] }] })
    updateReviewClaim(root, c.id, { role: 'plancheck', snapshot: { path: repo, head }, integrationPath: moved,
      inputFingerprints: { 'T-1': evidenceFingerprint(findCard(tasksDir, 'T-1'), repo) } })
    return c
  }
  assert.deepEqual(globalSettings({}).plancheck, { engine: 'claude', model: 'claude-sonnet-5', reasoning: 'medium' })
  const settings = setCardOverride(tasksDir, 'T-1', 'plancheck', { model: 'claude-haiku-4-5' }, {})
  assert.equal(assignmentFor({}, settings, 'plancheck').model, 'claude-haiku-4-5')
  assert.deepEqual(promotePlanned(tasksDir), [], 'unchecked plans cannot reach Builder Queue')
  let dispatched = 0, current
  await autoPlanCheck({ project: 'Proof', projectPath: repo, tasksDir, reviewRoot: root, inventory, spawn: async options => {
    dispatched++; assert.equal(options.planCheck, true); assert.deepEqual(options.cardIds, ['T-1']); current = claim()
  } })
  await autoPlanCheck({ project: 'Proof', projectPath: repo, tasksDir, reviewRoot: root, inventory, spawn: () => assert.fail('duplicate checker') })
  assert.equal(dispatched, 1)
  assert.throws(() => finishPlanCheck({ tasksDir, cardId: 'T-1', reviewRoot: root, claimId: 'wrong', verdict: 'PASS', evidence: 'assert failed' }), /claim/)
  const finish = (verdict, evidence, c = current) => finishPlanCheck({ tasksDir, cardId: 'T-1', reviewRoot: root, claimId: c.id, verdict, evidence })
  assert.equal(finish('PASS', 'node check: assertion result == true failed; app.mjs and fixture verified').to, 'queue')
  assert.ok(readReviewClaims(root).find(c => c.id === current.id).closedAt)
  moveCard(tasksDir, 'T-1', 'planned')
  writeFileSync(join(tasksDir, '.card-planners.json'), JSON.stringify({ 'T-1': { lifecycle: 'running', submitted: true } }))
  current = claim()
  const before = recoveryState(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')).returns
  const handoff = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)),
    '--tasks', tasksDir, '--review-root', root, '--review-claim', current.id, 'plancheck', 'T-1', 'FAIL', 'accessible name Save does not exist; use Save changes'], { encoding: 'utf8', windowsHide: true })
  assert.equal(handoff.status, 0, handoff.stderr)
  const failed = JSON.parse(handoff.stdout)
  assert.equal(failed.to, 'planning'); assert.match(failed.reason, /^Plan check: accessible name/)
  const text = readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')
  assert.match(text, /Planner correction: Plan check: accessible name/)
  assert.equal(recoveryState(text).returns, before)
  const owner = JSON.parse(readFileSync(join(tasksDir, '.card-planners.json'), 'utf8'))['T-1']
  assert.ok(owner.correctionRequestedAt); assert.equal(owner.correctionRounds, undefined)
  assert.equal(readWorkflow(tasksDir)['T-1'].correction.category, 'planning')
  const history = readFileSync(historyPath(tasksDir, 'T-1'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(history.filter(e => e.event === 'failure').length, 0, 'no Builder or plan-gap failures')
  moveCard(tasksDir, 'T-1', 'planned'); current = claim()
  assert.equal(finish('PASS', 'assertion failed; corrected targets verified').to, 'queue')
  const resolved = readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')
  assert.match(resolved, /Resolved: a Planner made this card build-ready/)
  assert.doesNotMatch(resolved, /Planner correction: Plan check: accessible name/)
  assert.match(readFileSync(historyPath(tasksDir, 'T-1'), 'utf8'), /accessible name Save does not exist/)
  moveCard(tasksDir, 'T-1', 'planned'); current = claim()
  writeFileSync(join(repo, 'app.mjs'), 'export const result = true\n')
  assert.equal(finish('PASS', 'assertion failed').to, 'planned', 'modified base requires an environment retry')
  writeFileSync(join(repo, 'app.mjs'), 'export const result = false\n')
  moveCard(tasksDir, 'T-1', 'planned'); current = claim()
  writeFileSync(findCard(tasksDir, 'T-1').path, readFileSync(findCard(tasksDir, 'T-1').path, 'utf8').replace('Result true', 'Result always true'))
  assert.equal(finish('PASS', 'assertion failed').to, 'queue', 'second invalidated verification skips the gate')
  moveCard(tasksDir, 'T-1', 'planned')
  current = claim(); updateReviewClaim(root, current.id, { paneId: 'checker-gone' })
  syncReviewClaims(root, await inventory(), current.createdAt + 120001)
  assert.equal(findCard(tasksDir, 'T-1').column, 'planned', 'missing checker verdict retries without blaming the Planner')
  assert.equal(recoveryState(readFileSync(findCard(tasksDir, 'T-1').path, 'utf8')).returns, before)
  moveCard(tasksDir, 'T-1', 'planned')
  assert.deepEqual(promotePlanned(tasksDir, { planCheck: false }), ['T-1'])
})

test('plan-check start failures, missing verdicts and RETRY share a hold and skip after two environment failures', async t => {
  const root = mkdtempSync(join(tmpdir(), 'plan-check-retry-')), repo = join(root, 'repo'), tasksDir = join(root, 'TASKS')
  const previous = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  writeFileSync(process.env.KANBAN_CONFIG, JSON.stringify({ projects: [], workflowLimits: {} }))
  t.after(() => { if (previous === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = previous })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(repo); mkdirSync(join(tasksDir, 'backlog'), { recursive: true })
  for (const id of ['T-1', 'T-2']) writeFileSync(join(tasksDir, 'backlog', `${id}.md`), `# ${id} — retry plan\n**Workflow:** card-owned\n## Approved brief\nMake result true\n## Files\n- \`app.mjs\`\n## Implementation plan\nCheck: node app.mjs\n## Acceptance criteria\nResult true\n`)
  const inventory = async () => [{ project: 'Proof', tasksDir, known: true, agents: [] }]
  const claim = async id => {
    const c = reserveReview(root, { project: 'Proof', tasksDir, cards: [id], inventory: await inventory() })
    updateReviewClaim(root, c.id, { role: 'plancheck', integrationPath: repo })
    return c
  }
  // A non-Git checkout fails preparation before any herdr call.
  await assert.rejects(spawnReviewer({ project: 'Proof', projectPath: repo, tasksDir, boardRoot: root,
    reviewRoot: root, inventory, planCheck: true, cardIds: ['T-1'] }), /isolated Git card checkout/)
  assert.equal(findCard(tasksDir, 'T-1').column, 'planned')
  assert.equal(readWorkflow(tasksDir)['T-1'].startFailure.count, 1)
  assert.ok(startRetryHold(readWorkflow(tasksDir)['T-1'], 'plancheck'))
  assert.ok(readReviewClaims(root).every(c => c.closedAt))
  await autoPlanCheck({ project: 'Proof', projectPath: repo, tasksDir, reviewRoot: root, inventory,
    spawn: options => assert.equal(options.cardIds[0], 'T-2', 'held T-1 cannot dispatch') })
  const c = await claim('T-1')
  updateReviewClaim(root, c.id, { paneId: 'checker-gone' })
  syncReviewClaims(root, await inventory(), c.createdAt + 120001)
  assert.equal(findCard(tasksDir, 'T-1').column, 'queue', 'no verdict is the second environment failure')
  assert.equal(readWorkflow(tasksDir)['T-1'].operational, null)
  assert.equal(readWorkflow(tasksDir)['T-1'].startFailure, null)
  for (const [i, reason] of ['Playwright timeout under machine load', 'install/network failure'].entries()) {
    const c = await claim('T-2')
    const handoff = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)),
      '--tasks', tasksDir, '--review-root', root, '--review-claim', c.id, 'plancheck', 'T-2', 'RETRY', reason], { encoding: 'utf8', windowsHide: true })
    assert.equal(handoff.status, 0, handoff.stderr)
    assert.equal(JSON.parse(handoff.stdout).to, i ? 'queue' : 'planned')
    if (!i) assert.ok(startRetryHold(readWorkflow(tasksDir)['T-2'], 'plancheck'))
  }
  for (const id of ['T-1', 'T-2']) {
    const history = readFileSync(historyPath(tasksDir, id), 'utf8').trim().split('\n').map(JSON.parse)
    assert.ok(history.some(e => e.event === 'operational-failure'))
    assert.equal(history.filter(e => e.event === 'start-failed').length, 2)
    assert.ok(history.some(e => /^Plan check skipped: environment \(/.test(e.reason)))
    assert.equal(readWorkflow(tasksDir)[id].correction, undefined)
    assert.equal(recoveryState(readFileSync(findCard(tasksDir, id).path, 'utf8')).returns, 0)
  }
})
