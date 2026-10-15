// Planner token audit (2026-10-15, I1306): `hkb precheck` runs the plan gate read-only and prints
// PASS, or every failing item numbered in one output, so a Planner fixes them all in one pass.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const hkb = (tasks, ...args) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, ...args], { encoding: 'utf8', windowsHide: true })

function board(t, card) {
  const root = mkdtempSync(join(tmpdir(), 'precheck-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  mkdirSync(join(root, 'herdr-kanban'), { recursive: true })
  writeFileSync(join(root, 'herdr-kanban', 'a.mjs'), 'export const a = 1\n')
  const path = join(tasks, 'planning', 'T-1.md')
  writeFileSync(path, card)
  return { root, tasks, path }
}

const WHOLE = `# T-1 — card
**Workflow:** card-owned
**Workflow version:** 2
**Plan readiness:** build-ready
**Difficulty:** tiny
## Approved brief
Change a.
## Files
- \`herdr-kanban/a.mjs\` lines 1-1, \`a\` — change it
## Prerequisites
none
## Implementation plan
**Callers checked:** none
Agreed outcome: a is 2.
Unchanged constraints: none.
Cause: a is 1 by design.
Evidence: herdr-kanban/a.mjs lines 1-1.
Inspected current state: a.mjs line 1 is \`export const a = 1\`.
Changes: herdr-kanban/a.mjs lines 1-1, \`a\` set to 2.
Scope: herdr-kanban/a.mjs only.
## Acceptance criteria
- AC1: a is 2
## Evidence
<!-- none -->
`

test('precheck prints PASS and writes nothing when the plan passes the gate', (t) => {
  const { tasks, path } = board(t, WHOLE)
  const before = readFileSync(path, 'utf8')
  const run = hkb(tasks, 'precheck', 'T-1')
  assert.equal(run.status, 0, run.stdout + run.stderr)
  assert.match(run.stdout, /^PRECHECK PASS T-1: move T-1 planned now/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('precheck lists every failing item in one numbered output and exits 1', (t) => {
  // No ## Files and duplicate AC ids: two problems, one refusal, one run.
  const card = WHOLE.replace(/## Files\n[^\n]*\n/, '## Files\n').replace('- AC1: a is 2', '- AC1: a is 2\n- AC1: again')
  const { tasks, path } = board(t, card)
  const before = readFileSync(path, 'utf8')
  const run = hkb(tasks, 'precheck', 'T-1')
  assert.equal(run.status, 1)
  assert.match(run.stdout, /^PRECHECK FAIL T-1: 2 problem\(s\); fix only these, then precheck again:/)
  assert.match(run.stdout, /\n1\. no exact files listed/)
  assert.match(run.stdout, /\n2\. Plan incomplete: give each acceptance criterion its own unique AC ID/)
  assert.equal(readFileSync(path, 'utf8'), before)
})

test('precheck needs a card id and a TASKS folder', (t) => {
  const { tasks } = board(t, WHOLE)
  const run = hkb(tasks, 'precheck', 'T-404')
  assert.equal(run.status, 1)
  assert.match(run.stderr, /hkb: /)
})

test('the Planner prompt runs precheck before move planned, and a fresh correction carries only the outstanding items', async () => {
  const { plannerPrompt, plannerReentryPrompt } = await import('./lib/prompt.mjs')
  const card = { id: 'T-1', column: 'planning', path: 'C:/fake/T-1.md', category: 'code' }
  const base = { cards: [card], projectPath: 'C:/fake/project', boardRoot: 'C:/Users/PFrew/Projects/herdr-kanban', tasksDir: 'C:/fake/TASKS', engine: 'claude' }
  const fresh = plannerPrompt({ ...base, outstanding: 'Files path a.mjs missing' })
  assert.match(fresh, /precheck <ID>: it prints PASS/)
  assert.match(fresh, /Outstanding from the last hand-off \(fix only these, then hand off\): Files path a\.mjs missing\./)
  assert.doesNotMatch(plannerPrompt(base), /Outstanding from the last hand-off/)
  assert.doesNotMatch(fresh, /\n/)
  const reentry = plannerReentryPrompt({ card, boardRoot: 'C:/Users/PFrew/Projects/herdr-kanban', tasksDir: 'C:/fake/TASKS', engine: 'claude', note: 'x' })
  assert.match(reentry, /precheck T-1 until it prints PASS/)
})
