// Board guards from the 2026-09 Injectbuddy incidents: T-147 (Builder dropped card
// sections), T-148 (Planner looped on an operator-only approval) and the workflow
// limit that held a retried card forever.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { findCard, moveCard } from './lib/cards.mjs'
import { runCardPlanner, operatorRetry } from './lib/card-planner.mjs'
import { checkWorkflowLimits } from './lib/workflow-limits.mjs'
import { checkStalls } from './lib/stall-watchdog.mjs'
import { workerPrompt } from './lib/prompt.mjs'

const PLAN = `**Workflow:** card-owned
**Plan readiness:** investigation
## Approved brief
Measure the slow page.
## Files
- \`evidence/\`
## Implementation plan
Measurement command: node measure.mjs
Expected result: timing recorded
Stop rules: stop if the page is unavailable
## Acceptance criteria
- Measurement saved.
`
function board(t, column, id, text) {
  const root = mkdtempSync(join(tmpdir(), 'card-guards-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, column), { recursive: true })
  writeFileSync(join(tasks, column, `${id}.md`), `# ${id} — card\n${text}`)
  return tasks
}
const hkb = (tasks, ...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, ...args], { encoding: 'utf8' })

test('a handoff that drops a required section is refused and nothing is restored', t => {
  const tasks = board(t, 'queue', 'T-1', PLAN.replace('## Acceptance criteria\n- Measurement saved.', '## Acceptance criteria\n<!-- empty in the saved copy -->'))
  moveCard(tasks, 'T-1', 'working') // the board snapshots the card on every transition
  const saved = readFileSync(findCard(tasks, 'T-1').path, 'utf8')
  const rewritten = saved.replace(/## Files[\s\S]*?(?=## Implementation plan)/, '').replace('Measurement command: node measure.mjs\nExpected result: timing recorded\nStop rules: stop if the page is unavailable\n', '')
  writeFileSync(findCard(tasks, 'T-1').path, rewritten)
  const refused = hkb(tasks, 'move', 'T-1', 'review')
  assert.equal(refused.status, 1)
  assert.match(refused.stderr, /handoff refused\. ## Files, ## Implementation plan had content/)
  assert.doesNotMatch(refused.stderr, /Acceptance criteria/, 'a section empty in the saved copy may stay empty')
  assert.equal(findCard(tasks, 'T-1').column, 'working')
  assert.equal(readFileSync(findCard(tasks, 'T-1').path, 'utf8'), rewritten, 'nothing restored automatically')

  writeFileSync(findCard(tasks, 'T-1').path, saved)
  assert.equal(hkb(tasks, 'move', 'T-1', 'review').status, 0)
  assert.equal(findCard(tasks, 'T-1').column, 'review')
})

// Tradeflow T-42: the board moved the card out of Working under a live Builder,
// which then wrote its result to the old lane path and recreated the file.
test('a card recreated in the lane it just left is merged into the live copy, not held as ambiguous', t => {
  const tasks = board(t, 'working', 'T-1', PLAN)
  moveCard(tasks, 'T-1', 'planning')
  const live = readFileSync(join(tasks, 'planning', 'T-1.md'), 'utf8')
  writeFileSync(join(tasks, 'working', 'T-1.md'), '## Evidence\nBuilt; node measure.mjs passed.\n')
  const card = findCard(tasks, 'T-1')
  assert.equal(card.column, 'planning')
  const merged = readFileSync(card.path, 'utf8')
  assert.ok(merged.startsWith(live), 'the live copy is kept as is')
  assert.match(merged, /## Evidence\nBuilt; node measure\.mjs passed\./)
  assert.ok(!existsSync(join(tasks, 'working', 'T-1.md')), 'no second live copy')
  assert.match(readFileSync(join(tasks, '.stray', readdirSync(join(tasks, '.stray'))[0]), 'utf8'), /Built; node measure/, 'the stale copy is kept')
  // The agent writes again: nothing it already delivered is appended twice.
  writeFileSync(join(tasks, 'working', 'T-1.md'), `${live}\n## Evidence\nBuilt; node measure.mjs passed.\n`)
  assert.equal(readFileSync(findCard(tasks, 'T-1').path, 'utf8'), merged)
})

test('two genuinely different live cards with one id are still held', t => {
  const tasks = board(t, 'planning', 'T-1', PLAN)
  mkdirSync(join(tasks, 'review'))
  writeFileSync(join(tasks, 'review', 'T-1.md'), `# T-1 — other card\n${PLAN}`)
  assert.throws(() => findCard(tasks, 'T-1'), /ambiguous/)
  moveCard(tasks, 'T-1', 'working', { sourcePath: join(tasks, 'review', 'T-1.md') }) // last move review -> working, other copy in planning
  assert.throws(() => findCard(tasks, 'T-1'), /ambiguous/, 'the other copy is not in the lane the card left')
})

test('the Builder prompt keeps Builders to their own sections and stays one line', () => {
  const prompt = workerPrompt({ card: { id: 'T-1', path: 'C:/x/TASKS/working/T-1.md' }, projectPath: 'C:/x', boardRoot: 'C:/board' })
  assert.match(prompt, /Do not print the authoritative card; the briefing already holds its current text\. Replace only the Implementation and Evidence section bodies .*; never rewrite, reorder or delete any other section/)
  assert.doesNotMatch(prompt, /\n/)
})

test('a Planner handoff waiting on investigation approval goes to Owner with one question', t => {
  const tasks = board(t, 'planning', 'T-2', PLAN)
  const result = hkb(tasks, 'issue', 'T-2', '[planning] waiting for Investigation approved: yes')
  assert.equal(result.status, 0, result.stderr)
  const card = findCard(tasks, 'T-2')
  assert.equal(card.column, 'owner')
  assert.match(readFileSync(card.path, 'utf8'), /Needs you: Approve the investigation for T-2\?/)
})

test('the board never re-prompts a Planner for a plan waiting on approval', async t => {
  const tasks = board(t, 'planning', 'T-3', PLAN)
  const fail = async () => { throw new Error('Planner must not be launched') }
  const io = { agentList: async () => [], agentWorkspaceOr: fail, tabCreate: fail, waitForPrompt: fail, agentStart: fail, paneClose: fail, paneRead: fail, deliver: fail, recordUsageStart: fail, recordUsageFinish: fail }
  assert.equal(await runCardPlanner({ project: 'Guards', projectPath: tasks, tasksDir: tasks, boardRoot: tasks, model: 'm', io }), null)
  assert.equal(findCard(tasks, 'T-3').column, 'owner')
  assert.match(readFileSync(findCard(tasks, 'T-3').path, 'utf8'), /Approve the investigation for T-3\?/)

  // Approved: the plan is complete, so nothing asks the operator again.
  writeFileSync(findCard(tasks, 'T-3').path, readFileSync(findCard(tasks, 'T-3').path, 'utf8').replace('**Plan readiness:** investigation', '**Plan readiness:** investigation\n**Investigation approved:** yes'))
  assert.equal(moveCard(tasks, 'T-3', 'planned').column, 'planned')
})

test('workflow limits count only runs since the operator retried; a held card reaches Owner with the reason', t => {
  const tasks = board(t, 'planning', 'T-4', PLAN)
  const config = join(tasks, '..', 'board.config.json')
  writeFileSync(config, JSON.stringify({ workflowLimits: { maxRunsPerStage: 2 } }))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior })
  const run = at => ({ cardIds: ['T-4'], role: 'planner', delta: { total: 1 }, start: { at } })
  const old = new Date(Date.now() - 3600000).toISOString()
  writeFileSync(join(tasks, '.request-usage.json'), JSON.stringify({ version: 1, runs: { a: run(old), b: run(old), c: run(old) } }))
  assert.match(checkWorkflowLimits(tasks, 'T-4', 'planner'), /maxRunsPerStage reached \(3\/2\)/)

  // The stall watchdog skips the useless retry and asks the operator, naming the limit.
  const [stall] = checkStalls({ tasksDir: tasks, now: Date.now() + 20 * 60000 })
  assert.equal(stall.action, 'moved to Owner')
  assert.match(readFileSync(findCard(tasks, 'T-4').path, 'utf8'), /Last hold\/error: maxRunsPerStage reached \(3\/2\); dispatch held\.[\s\S]*resets its workflow-limit counters/)

  // Dragging it out of Owner restarts the count.
  moveCard(tasks, 'T-4', 'planning')
  operatorRetry(tasks, 'T-4', 'planning')
  assert.equal(checkWorkflowLimits(tasks, 'T-4', 'planner'), null)
  const usage = JSON.parse(readFileSync(join(tasks, '.request-usage.json'), 'utf8'))
  usage.runs.d = run(new Date(Date.now() + 1000).toISOString()); usage.runs.e = run(new Date(Date.now() + 2000).toISOString())
  writeFileSync(join(tasks, '.request-usage.json'), JSON.stringify(usage))
  assert.match(checkWorkflowLimits(tasks, 'T-4', 'planner'), /maxRunsPerStage reached \(2\/2\)/)
})

test('hkb found sends an out-of-scope finding to the Kanban Manager inbox and leaves the card where it is (I213)', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-found-')), tasks = join(root, 'Proj', 'TASKS'), inbox = join(root, 'inbox.md')
  try {
    mkdirSync(join(tasks, 'working'), { recursive: true })
    writeFileSync(join(tasks, 'working', 'T-1-card.md'), '# T-1 — Card\n')
    const run = (...a) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, ...a], { encoding: 'utf8', env: { ...process.env, KANBAN_MANAGER_INBOX: inbox } })
    assert.notEqual(run('found', 'T-1').status, 0)
    const ok = run('found', 'T-1', 'e2e/i201.spec.ts fails on base too: timeout at Bacteriostatic water')
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(readFileSync(inbox, 'utf8'), /FOUND Proj T-1 \(working\): e2e\/i201\.spec\.ts fails on base too/)
    assert.equal(findCard(tasks, 'T-1').column, 'working')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
