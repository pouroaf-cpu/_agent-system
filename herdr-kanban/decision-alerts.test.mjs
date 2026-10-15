import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCard, findCard } from './lib/cards.mjs'
import { realertDecisionWaits, DECISION_REALERT } from './lib/decision-alerts.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { operatorRetry } from './lib/card-planner.mjs'
import { historyPath } from './lib/card-history.mjs'

const HOUR = 60 * 60 * 1000
const T0 = Date.parse('2026-10-15T08:31:00Z')
const iso = ms => new Date(ms).toISOString()

// A Planning card with a manager inbox for its project; KANBAN_CONFIG points at it while the test runs.
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'decision-alerts-'))
  const dir = join(root, 'Proj', 'TASKS')
  mkdirSync(dir, { recursive: true })
  const config = join(root, 'board.config.json'), inbox = join(root, 'inbox.md')
  writeFileSync(config, JSON.stringify({ projectsRoot: root, projects: ['Proj'], projectSettings: { Proj: { manager: { inbox } } } }))
  const previous = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = config
  const restore = () => {
    if (previous === undefined) delete process.env.KANBAN_CONFIG
    else process.env.KANBAN_CONFIG = previous
    rmSync(root, { recursive: true, force: true })
  }
  return { root, dir, inbox, restore }
}
const decide = (dir, id, extra = {}) => updateWorkflow(dir, id, { waitFor: { cards: [], files: [], decision: true, why: 'Pick A or B: A one page, B two pages', since: iso(T0), ...extra } })

test('an unanswered decision wait is asked again in the manager inbox every 3 h, up to the cap', () => {
  const { dir, inbox, restore } = setup()
  try {
    const card = createCard(dir, { title: 'Pick a layout', brief: 'x' })
    decide(dir, card.id)
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 2 * HOUR }), { ids: [], errors: [] })
    assert.equal(existsSync(inbox), false)

    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 3 * HOUR }).ids, [card.id])
    assert.match(readFileSync(inbox, 'utf8'), new RegExp(`ASK Proj ${card.id} \\(planning\\): still waiting on a decision \\(reminder 1 of ${DECISION_REALERT.cap}\\): Pick A or B`))
    assert.equal(readWorkflow(dir)[card.id].waitFor.realerts, 1)
    assert.equal(readWorkflow(dir)[card.id].waitFor.alertedAt, iso(T0 + 3 * HOUR))
    assert.match(readFileSync(historyPath(dir, card.id), 'utf8'), /"event":"decision-realert"/)

    // Asked again at once: nothing until another 3 h has passed.
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 4 * HOUR }).ids, [])
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 6 * HOUR }).ids, [card.id])
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 9 * HOUR }).ids, [card.id])
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 12 * HOUR }).ids, [card.id])
    assert.equal(readWorkflow(dir)[card.id].waitFor.realerts, DECISION_REALERT.cap)
    // The cap stops it.
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 30 * HOUR }).ids, [])
    const lines = readFileSync(inbox, 'utf8').split('\n').filter(l => l.includes(' ASK Proj '))
    assert.equal(lines.length, DECISION_REALERT.cap)
    assert.match(lines[3], /reminder 4 of 4/)
  } finally { restore() }
})

test('a board wait, a finder hold, a wait that was answered, and a card that left Planning are not asked again', () => {
  const { dir, inbox, restore } = setup()
  try {
    const board = createCard(dir, { title: 'Board question', brief: 'x' })
    decide(dir, board.id, { board: true })
    const finder = createCard(dir, { title: 'Held brief', brief: 'x' })
    decide(dir, finder.id, { finder: true })
    const answered = createCard(dir, { title: 'Answered', brief: 'x' })
    decide(dir, answered.id)
    operatorRetry(dir, answered.id, 'planning')
    assert.equal(readWorkflow(dir)[answered.id].waitFor, null)
    const left = createCard(dir, { title: 'Moved on', brief: 'x' })
    decide(dir, left.id)
    // Only a Planning card is in the list: the one that left it stays out. (A plain file move, not moveCard,
    // which checks the plan before it lets a card leave Planning.)
    mkdirSync(join(dir, 'queue'), { recursive: true })
    renameSync(findCard(dir, left.id).path, join(dir, 'queue', `${left.id}-moved on.md`))
    assert.notEqual(findCard(dir, left.id).column, 'planning')

    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 5 * HOUR }), { ids: [], errors: [] })
    assert.equal(existsSync(inbox), false)
  } finally { restore() }
})

test('a failed inbox write is reported once and the wait is not asked again straight away', () => {
  const { dir, restore } = setup()
  try {
    const card = createCard(dir, { title: 'Pick a layout', brief: 'x' })
    decide(dir, card.id)
    const failing = () => { throw new Error('inbox locked') }
    const first = realertDecisionWaits({ tasksDir: dir, now: T0 + 3 * HOUR, append: failing })
    assert.deepEqual(first.ids, [card.id])
    assert.equal(first.errors.length, 1)
    assert.equal(first.errors[0].message, 'inbox locked')
    // The reminder is recorded before the write, so the next poll does not send it again.
    assert.equal(readWorkflow(dir)[card.id].waitFor.realerts, 1)
    assert.deepEqual(realertDecisionWaits({ tasksDir: dir, now: T0 + 3 * HOUR + 1000, append: failing }).ids, [])
  } finally { restore() }
})
