import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordUsageStart, recordUsageFinish, reconcileUsage, refreshPendingUsage, readUsage } from './lib/request-usage.mjs'
import { createCard } from './lib/cards.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

// The Token Manager inbox gets one line when a Planner or Builder run closes over
// workflowLimits.alertStepsPerRun (13) or alertTokensPerRun (3,000,000). Alert only.
const ID = 'c1a0de00-0000-4000-8000-0000000000a1'

function fixture(t, limits) {
  const root = mkdtempSync(join(tmpdir(), 'token-alert-'))
  const tasks = join(root, 'Proof', 'TASKS'); mkdirSync(tasks, { recursive: true })
  const inbox = join(root, 'inbox', 'TokenManager-INBOX.md')
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ tokenManager: { inbox }, ...(limits ? { workflowLimits: limits } : {}) }))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  const card = createCard(tasks, { title: 'Alert   me now', brief: 'do the thing' })
  return { root, tasks, inbox, card }
}

// `steps` assistant messages with distinct ids; `input` goes on the first one.
function run(f, { role = 'builder', steps, input = 1 }) {
  // The transcript must exist at start (a missed lookup is cached), with one message before it as baseline.
  const path = join(f.root, 'x', `${ID}.jsonl`)
  const row = (obj) => JSON.stringify(obj) + '\n'
  mkdirSync(join(f.root, 'x'), { recursive: true })
  writeFileSync(path, row({ type: 'mode' }) + row({ type: 'assistant', timestamp: '2026-09-25T23:59:00Z', message: { id: 'before', usage: { input_tokens: 9, output_tokens: 9 } } }))
  const rec = recordUsageStart({ tasksDir: f.tasks, project: 'Proof', requestId: f.card.id, cardIds: [f.card.id], role, paneId: 'w1:p1',
    agentSession: { agent: 'claude', kind: 'id', value: ID }, now: new Date('2026-09-26T00:00:00Z'), root: f.root })
  writeFileSync(path, readFileSync(path, 'utf8') + Array.from({ length: steps }, (_, i) => row({ type: 'assistant', timestamp: `2026-09-26T00:00:${String(i + 1).padStart(2, '0')}Z`,
    message: { id: `m${i}`, usage: { input_tokens: i === 0 ? input : 1, output_tokens: 1 } } })).join(''))
  return rec
}
const finish = (f, rec, status = 'complete') => recordUsageFinish({ tasksDir: f.tasks, runId: rec.runId, status, now: new Date('2026-09-26T00:10:00Z'), root: f.root })
const lines = (f) => existsSync(f.inbox) ? readFileSync(f.inbox, 'utf8').split('\n').filter(Boolean) : []

test('AC1: a 14-step Planner run and a 3.1M-token Builder run each write one line', async (t) => {
  const a = fixture(t)
  await finish(a, run(a, { role: 'planner', steps: 14 }))
  assert.equal(lines(a).length, 1)
  assert.match(lines(a)[0], /^- .* TOKEN ALERT /)
  assert.match(lines(a)[0], / planner steps 14 /)

  const b = fixture(t)
  await finish(b, run(b, { role: 'builder', steps: 5, input: 3100000 }))
  assert.equal(lines(b).length, 1)
  assert.match(lines(b)[0], / builder steps 5 tokens 3100009 /)
})

test('AC2: 13 steps and 2.9M tokens write nothing; a Reviewer run over the limits writes nothing', async (t) => {
  const a = fixture(t)
  await finish(a, run(a, { steps: 13, input: 2900000 }))
  assert.deepEqual(lines(a), [])
  assert.equal(Object.values(readUsage(a.tasks).runs)[0].tokenAlert, 'checked')

  const b = fixture(t)
  await finish(b, run(b, { role: 'reviewer', steps: 20, input: 3100000 }))
  assert.deepEqual(lines(b), [])
})

test('AC3: a null limit turns that test off', async (t) => {
  const a = fixture(t, { alertStepsPerRun: null })
  await finish(a, run(a, { steps: 14 }))
  assert.deepEqual(lines(a), [])

  const b = fixture(t, { alertTokensPerRun: null })
  await finish(b, run(b, { steps: 3, input: 3100000 }))
  assert.deepEqual(lines(b), [])

  const c = fixture(t, { alertStepsPerRun: null })
  await finish(c, run(c, { steps: 3, input: 3100000 }))
  assert.equal(lines(c).length, 1, 'the token test still fires with steps off')
})

test('AC4: the card file and workflow state are unchanged by an alert', async (t) => {
  const f = fixture(t)
  const before = { card: readFileSync(f.card.path, 'utf8'), workflow: JSON.stringify(readWorkflow(f.tasks)) }
  await finish(f, run(f, { steps: 14 }))
  assert.equal(lines(f).length, 1)
  assert.equal(readFileSync(f.card.path, 'utf8'), before.card)
  assert.equal(JSON.stringify(readWorkflow(f.tasks)), before.workflow)
})

test('AC5: the line is one NZ-time line naming project, card, title, role, steps, tokens, status and session file', async (t) => {
  const f = fixture(t)
  await finish(f, run(f, { role: 'planner', steps: 14 }), 'complete')
  const [line, ...rest] = lines(f)
  assert.equal(rest.length, 0)
  assert.ok(line.length < 300, `${line.length} chars`)
  assert.match(line, / TOKEN ALERT Proof /)
  assert.ok(line.includes(` ${f.card.id} "Alert me now" planner steps 14 tokens 28 ended complete session `), line)
  assert.ok(line.endsWith(join(f.root, 'x', `${ID}.jsonl`)), line)
  assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}T|\dZ\b/)
})

// Replaces only the card's first line, as a hand-written heading would look.
function setHeading(f, heading) {
  const text = readFileSync(f.card.path, 'utf8')
  writeFileSync(f.card.path, heading + text.slice(text.search(/\r?\n/)))
}

test('AC7: a heading ID of more than one word still gives the card title', async (t) => {
  const f = fixture(t)
  setHeading(f, '# I1250 part 2 — Alert me now')
  await finish(f, run(f, { role: 'planner', steps: 14 }))
  assert.equal(lines(f).length, 1)
  assert.ok(lines(f)[0].includes(' "Alert me now" planner '), lines(f)[0])
})

test('AC8: a card with no title still writes the alert and says "(no title)"', async (t) => {
  const f = fixture(t)
  setHeading(f, '# Untitled')
  await finish(f, run(f, { role: 'planner', steps: 14 }))
  assert.equal(lines(f).length, 1)
  assert.ok(lines(f)[0].includes(' "(no title)" planner '), lines(f)[0])
})

test('AC6: finishing, refreshing and reconciling the same run again writes one line only', async (t) => {
  const f = fixture(t)
  const rec = run(f, { steps: 14 })
  await finish(f, rec)
  await finish(f, rec)
  refreshPendingUsage(f.tasks, { root: f.root })
  reconcileUsage(f.tasks, [], { root: f.root })
  // reconcile may reopen and re-close a run: the persisted marker still blocks a second line.
  const all = readUsage(f.tasks)
  assert.equal(Object.values(all.runs)[0].tokenAlert, 'sent')
  reconcileUsage(f.tasks, [{ name: rec.name, pane_id: 'w1:p1', agent_session: { agent: 'claude', kind: 'id', value: ID } }], { root: f.root })
  assert.equal(lines(f).length, 1)
})
