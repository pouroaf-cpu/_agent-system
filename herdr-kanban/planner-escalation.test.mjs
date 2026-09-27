import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'
import { readCardPlanners, runCardPlanner, operatorRetry } from './lib/card-planner.mjs'
import { saveCardPlanners } from './lib/planner-state.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { agentStartArgs } from './lib/herdr.mjs'

const HKB = fileURLToPath(new URL('./hkb.mjs', import.meta.url))
// Hand off as the card's Planner, recorded on the given engine.
const handoff = (dir, id, n, engine, ...args) => {
  const owners = readCardPlanners(dir)
  owners[id] = { ...(owners[id] || {}), assignmentId: `a${n}`, lifecycle: 'active', paneId: `p${n}`, submitted: true, revokedPaneIds: [], engine }
  saveCardPlanners(dir, owners)
  return spawnSync(process.execPath, [HKB, '--tasks', dir, '--planner-assignment', `a${n}`, ...args], { encoding: 'utf8' })
}

// Operator 2026-09-27: a Codex Planner gets one try, then claude-opus-5-5 gets the other two.
test('the first Codex Planner blocker escalates the card to an Opus Planner; the third blocker goes to Owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-escalation-'))
  try {
    const card = createCard(dir, { title: 'Hard plan', brief: 'x' })
    assert.equal(handoff(dir, card.id, 1, 'codex', 'issue', card.id, '[planning] blocker remains, attempt 1').status, 0)
    assert.equal(findCard(dir, card.id).column, 'planning')
    assert.equal(readWorkflow(dir)[card.id].plannerEscalation.model, 'claude-opus-5-5')
    const log = readFileSync(join(dir, 'codex-planner-failures.log'), 'utf8').trim().split('\n')
    assert.equal(log.length, 1)
    assert.deepEqual(log[0].split('\t').slice(1), [card.id, '[planning] blocker remains, attempt 1'])
    assert.match(readFileSync(join(dir, 'activity.log'), 'utf8'), new RegExp(`card=${card.id} event=codex-planner-failure`))

    const starts = [], prompts = []
    const agents = []
    const io = {
      agentList: async () => agents, agentWorkspaceOr: async () => 'w', waitForPrompt: async () => {},
      tabCreate: async () => ({ root_pane: { pane_id: 'p9' } }),
      agentStart: async (args) => { starts.push(args); agents.push({ name: args.name, pane_id: args.paneId, agent_status: 'idle' }) },
      deliver: async (paneId, text) => { prompts.push(text) }, paneClose: async () => {}, paneRead: async () => '', recordUsageStart: () => {}, recordUsageFinish: async () => {},
    }
    const assignmentForCard = () => ({ engine: 'codex', model: 'gpt-6-luna', reasoning: 'high' })
    await runCardPlanner({ project: 'P', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'gpt-6-luna', engine: { kind: 'codex' }, assignmentForCard, io })
    assert.equal(starts.length, 1)
    assert.equal(starts[0].model, 'claude-opus-5-5')
    assert.equal(starts[0].engine.kind, 'claude')
    assert.match(prompts[0], /Escalation: a Codex Planner could not make this card build-ready/)
    // The launch guard lets a Planner start on it.
    assert.deepEqual(agentStartArgs({ name: starts[0].name, paneId: 'p9', model: 'claude-opus-5-5', engine: starts[0].engine }).slice(-2), ['--model', 'claude-opus-5-5'])

    assert.equal(handoff(dir, card.id, 2, 'claude', 'issue', card.id, '[planning] blocker remains, attempt 2').status, 0)
    assert.equal(findCard(dir, card.id).column, 'planning')
    assert.equal(handoff(dir, card.id, 3, 'claude', 'issue', card.id, '[planning] blocker remains, attempt 3').status, 0)
    const moved = findCard(dir, card.id)
    assert.equal(moved.column, 'owner')
    assert.match(moved.ask?.text || '', /Three Planners in a row[\s\S]*claude-opus-5-5 escalation Planners also failed[\s\S]*attempt 3/)
    assert.equal(readFileSync(join(dir, 'codex-planner-failures.log'), 'utf8').trim().split('\n').length, 1, 'only Codex failures are logged')

    operatorRetry(dir, card.id, 'planning')
    assert.equal(readWorkflow(dir)[card.id].plannerEscalation, null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a Claude-planned card keeps the old path: no escalation, no Codex log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'planner-no-escalation-'))
  try {
    const card = createCard(dir, { title: 'Hard plan', brief: 'x' })
    assert.equal(handoff(dir, card.id, 1, 'claude', 'issue', card.id, '[planning] blocker remains').status, 0)
    assert.equal(readWorkflow(dir)[card.id].plannerEscalation, undefined)
    assert.throws(() => readFileSync(join(dir, 'codex-planner-failures.log')))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a plan accepted into Planned clears the escalation flag', () => {
  const root = mkdtempSync(join(tmpdir(), 'planner-escalation-clear-'))
  try {
    const tasks = join(root, 'TASKS'); mkdirSync(join(tasks, 'planning'), { recursive: true })
    writeFileSync(join(tasks, 'planning', 'T-1.md'), `# T-1 — escalated plan
**Workflow:** card-owned
**Workflow version:** 2
**Plan readiness:** build-ready
**Workspace:** .
## Approved brief
Add the helper.
## Files
- \`src/app.mjs\` (new) — helper()
- \`test/app.test.mjs\` (new) — focused check
## Implementation plan
Outcome: helper returns 1.
Unchanged constraints: no API, data, or deployment changes.
Observed cause: helper is missing.
Evidence: src/app.mjs does not exist.
Inspected current revision/state: git revision abc123; working tree clean.
**Callers checked:** none
Changes: add helper() and its test.
Setup: none; use the existing Node runtime.
Check: node --test test/app.test.mjs
Expected result: the check passes.
Scope: only the two new files.
Stop rules: stop if src/app.mjs already exists.
## Acceptance criteria
- AC1: helper() returns 1.
## Outcome checks
AC1 | src/app.mjs helper() | node --test test/app.test.mjs passes | return 0 and the check fails
## Prerequisites
Existing Node runtime; no additional access.
`)
    updateWorkflow(tasks, 'T-1', { plannerIssues: 1, plannerEscalation: { model: 'claude-opus-5-5', at: 'x' } })
    const result = spawnSync(process.execPath, [HKB, '--tasks', tasks, 'move', 'T-1', 'planned'], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const saved = readWorkflow(tasks)['T-1']
    assert.equal(saved.plannerIssues, null)
    assert.equal(saved.plannerEscalation, null)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
