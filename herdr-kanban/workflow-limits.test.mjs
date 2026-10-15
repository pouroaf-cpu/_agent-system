import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkWorkflowLimits, maxStepsPerRun, managerInboxOf, projectOf } from './lib/workflow-limits.mjs'
import { createCard } from './lib/cards.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

// Audit 2026-10-15 F4 AC1: a card reaching maxTokensPerCard is held with an activity line and
// one inbox alert. Before this the hold was silent on a Planning card and 26 cards passed 12M
// tokens with the key unset. One temp board, Proof, with a manager inbox unless `inbox: false`.
function fixture(t, limits, { inbox = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-limits-'))
  const tasks = join(root, 'Proof', 'TASKS'); mkdirSync(tasks, { recursive: true })
  const config = join(root, 'board.config.json'), inboxPath = join(root, 'Proof-INBOX.md')
  writeFileSync(config, JSON.stringify({ projectsRoot: root, projects: ['Proof'], projectSettings: inbox ? { Proof: { manager: { chat: 'Proof chat', inbox: inboxPath } } } : {}, workflowLimits: limits }))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  const card = createCard(tasks, { title: 'big card', brief: 'do the thing' })
  const at = new Date(Date.now() - 1000).toISOString()
  // A null total is a run with no usage record (status unknown_usage); a `file` key names its session transcript.
  const usage = (totals, extra = {}) => writeFileSync(join(tasks, '.request-usage.json'), JSON.stringify({ version: 1, runs: Object.fromEntries(totals.map((total, i) => [`r${i}`, { runId: `r${i}`, cardIds: [card.id], role: i % 2 ? 'builder' : 'planner', ...(total == null ? { status: 'unknown_usage', delta: null } : { delta: { total } }), start: { at }, finish: { at, ...extra[i] } }])) }))
  const activity = () => existsSync(join(tasks, 'activity.log')) ? readFileSync(join(tasks, 'activity.log'), 'utf8').split('\n').filter(l => l.includes('event=hold')) : []
  return { root, tasks, inbox: inboxPath, card, usage, activity }
}

test('F4 AC1: a card reaching maxTokensPerCard is held, with one activity line and one inbox alert', t => {
  const f = fixture(t, { maxTokensPerCard: 12000000 })
  f.usage([5000000, 6999999])
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'builder'), null)
  assert.deepEqual(f.activity(), [])
  assert.equal(existsSync(f.inbox), false)
  f.usage([5000000, 7000000])
  const reason = 'maxTokensPerCard reached (12000000/12000000); dispatch held'
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'builder'), reason)
  // The Planner path (card-planner skips the card) records the same hold, once.
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'planner'), reason)
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'builder'), reason)
  assert.equal(f.activity().length, 1)
  assert.match(f.activity()[0], new RegExp(`project=Proof card=${f.card.id} event=hold message=maxTokensPerCard reached \\(12000000/12000000\\); dispatch held`))
  const lines = readFileSync(f.inbox, 'utf8').split('\n').filter(Boolean)
  assert.equal(lines.length, 1, 'one alert for the hold, not one per poll')
  assert.match(lines[0], new RegExp(`^- HO \\d+ .* HOLD Proof ${f.card.id} \\(builder\\): maxTokensPerCard reached \\(12000000/12000000\\); dispatch held\\. Dispatch is held until`))
  assert.equal(readWorkflow(f.tasks)[f.card.id].limitWarning, reason)
})

test('a temp board without a manager inbox alerts in the activity log only; the step cap is off by default', t => {
  const f = fixture(t, { maxRunsPerStage: 1 }, { inbox: false })
  assert.equal(projectOf(f.tasks), 'Proof')
  assert.equal(managerInboxOf(f.tasks), null, 'KANBAN_TEST with nothing configured: no real inbox')
  assert.equal(maxStepsPerRun(), null)
  f.usage([10, 10])
  assert.match(checkWorkflowLimits(f.tasks, f.card.id, 'builder'), /^maxRunsPerStage reached \(1\/1\); dispatch held$/)
  assert.equal(existsSync(f.inbox), false)
  assert.equal(f.activity().length, 1)
})

// Audit 2026-10-15 F11 AC2: a card whose runs have no usage record still holds at
// maxTokensPerCard, by estimate. Before this one unknown run made the cap refuse with
// "Token cap cannot be established", so 39 cards marked unknown had no cap at all.
test('F11 AC2: a card with unknown usage holds at maxTokensPerCard using an estimate, never a refusal', t => {
  const f = fixture(t, { maxTokensPerCard: 12000000 }, { inbox: false })
  // Runs alternate planner/builder. A Planner run with no usage record is estimated at the
  // median of the board's known Planner runs (3M): 3M + 4M + ~3M is under the cap, no refusal.
  f.usage([3000000, 4000000, null])
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'builder'), null, 'an unknown run is estimated, not a reason to refuse the cap')
  // A Builder run with no usage record is estimated at the known Builder median (4M): 11M + ~4M reaches the cap.
  f.usage([3000000, 4000000, 4000000, null])
  const reason = checkWorkflowLimits(f.tasks, f.card.id, 'builder')
  assert.equal(reason, 'maxTokensPerCard reached (15000000/12000000, including ~4000000 estimated for 1 run without usage); dispatch held')
  assert.doesNotMatch(reason, /cannot be established/)
  assert.equal(readWorkflow(f.tasks)[f.card.id].limitWarning, reason)
  assert.equal(f.activity().length, 1)
})

test('F11 AC2: with no known run to take a median from, the estimate is the session file at four bytes a token', t => {
  const f = fixture(t, { maxTokensPerCard: 1000 }, { inbox: false })
  const file = join(f.root, 'rollout-sol-run.jsonl')
  writeFileSync(file, 'x'.repeat(3900))
  f.usage([null], { 0: { file } })
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'planner'), null, '3900 bytes is ~975 tokens, under the cap')
  writeFileSync(file, 'x'.repeat(4000))
  assert.equal(checkWorkflowLimits(f.tasks, f.card.id, 'planner'), 'maxTokensPerCard reached (1000/1000, including ~1000 estimated for 1 run without usage); dispatch held')
})
