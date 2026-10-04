// I863/I858: covered fixes need no Builder or failing unchanged-base Check.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard, moveCard } from './lib/cards.mjs'
import { readCardPlanners, saveCardPlanners } from './lib/planner-state.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { appendHistory, historyPath } from './lib/card-history.mjs'
import { plannerPrompt } from './lib/prompt.mjs'

function fixture(t, lane = 'archive') {
  const dir = mkdtempSync(join(tmpdir(), 'planner-covered-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const card = createCard(dir, { title: 'Already fixed', brief: 'Preserve the approved scope' })
  mkdirSync(join(dir, lane), { recursive: true })
  writeFileSync(join(dir, lane, 'I858.md'), '# I858 — covering fix\n')
  const owners = readCardPlanners(dir)
  owners[card.id] = { assignmentId: 'a1', lifecycle: 'active', paneId: 'p1', submitted: true }
  saveCardPlanners(dir, owners)
  const run = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, '--planner-assignment', 'a1', ...args], { encoding: 'utf8' })
  return { dir, card, run }
}

for (const lane of ['archive', 'completed', 'review']) test(`covered archives a Planning card covered by a fix in ${lane}`, t => {
  const { dir, card, run } = fixture(t, lane)
  updateWorkflow(dir, card.id, { plannerIssues: 2, plannerEscalation: {}, waitFor: {}, planCheck: { verdict: 'FAIL' } })
  const result = run('covered', card.id, 'I858', 'node check.mjs -> PASS: all assertions passed')
  assert.equal(result.status, 0, result.stderr)
  const archived = findCard(dir, card.id)
  assert.equal(archived.column, 'archive')
  assert.match(readFileSync(archived.path, 'utf8'), /\*\*Covered by I858\*\*[\s\S]*node check.mjs -> PASS/)
  const history = readFileSync(historyPath(dir, card.id), 'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(history.some(entry => entry.event === 'covered' && entry.coveringCard === 'I858'))
  for (const key of ['plannerIssues', 'plannerEscalation', 'waitFor', 'planCheck']) assert.equal(readWorkflow(dir)[card.id][key], null)
  for (const amend of [undefined, 'wrong path']) assert.match(plannerPrompt({ cards: [card], projectPath: dir, boardRoot: dir, tasksDir: dir, plannerAssignment: 'a1', amend }), /covered/)
})

for (const covering of ['I858', 'I999']) test(`covered refuses an unfinished or missing covering card ${covering}`, t => {
  const { dir, card, run } = fixture(t, 'planning')
  const result = run('covered', card.id, covering, 'node check.mjs -> PASS')
  assert.equal(result.status, 1)
  assert.match(result.stderr, new RegExp(`hkb wait ${card.id} ${covering}`))
  assert.equal(findCard(dir, card.id).column, 'planning')
  assert.doesNotMatch(readFileSync(card.path, 'utf8'), /Covered by/)
})

test('covered refuses stale Planner ownership, missing evidence and a non-Planning source', t => {
  const { dir, card, run } = fixture(t)
  const owners = readCardPlanners(dir)
  owners[card.id].assignmentId = 'a2'; saveCardPlanners(dir, owners)
  assert.match(run('covered', card.id, 'I858', 'node check.mjs -> PASS').stderr, /stale callback refused/)
  const fresh = readCardPlanners(dir)
  fresh[card.id].assignmentId = 'a1'; saveCardPlanners(dir, fresh)
  assert.equal(run('covered', card.id, 'I858', 'no check').status, 1)
  moveCard(dir, card.id, 'owner')
  assert.match(run('covered', card.id, 'I858', 'node check.mjs -> PASS').stderr, /is in owner/)
})

test('covered preserves the assigned-Planner and dropped-section guards', t => {
  const { dir, card, run } = fixture(t)
  const owners = readCardPlanners(dir)
  owners[card.id].assignmentId = null; saveCardPlanners(dir, owners)
  assert.match(run('covered', card.id, 'I858', 'node check.mjs -> PASS').stderr, /requires the assigned Planner/)
  const fresh = readCardPlanners(dir)
  fresh[card.id].assignmentId = 'a1'; saveCardPlanners(dir, fresh)
  const text = readFileSync(card.path, 'utf8')
  appendHistory(dir, card.id, { event: 'transition', from: 'planning', to: 'planning', text })
  writeFileSync(card.path, text.replace(/## Approved brief[\s\S]*?(?=## )/, ''))
  assert.match(run('covered', card.id, 'I858', 'node check.mjs -> PASS').stderr, /## Approved brief had content/)
  assert.equal(findCard(dir, card.id).column, 'planning')
})

for (const lane of ['planned', 'queue']) test(`Planner handoff to ${lane} refuses empty Files with the covered close path`, t => {
  const { dir, card, run } = fixture(t)
  const result = run('move', card.id, lane)
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes(`no exact files listed: list the files to change, or if another card already fixed this use hkb covered ${card.id} <card> "<check> -> <result>"`), result.stderr)
  assert.equal(findCard(dir, card.id).column, 'planning')
})
