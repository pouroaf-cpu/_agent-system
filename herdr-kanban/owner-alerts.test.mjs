import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { alertOwnerCards, ownerReason, pushover } from './lib/owner-alerts.mjs'
import { updateWorkflow } from './lib/workflow-state.mjs'

test('each card that lands in Pou alerts once; first run summarises; re-entry alerts again', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-alerts-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const d of ['pou', 'queue']) mkdirSync(join(tasks, d), { recursive: true })
  const put = (col, id) => writeFileSync(join(tasks, col, `${id}.md`), `# ${id} — card ${id}\n\nNeeds you: approve ${id}?\n`)
  const sent = [], send = async (title, message) => { sent.push({ title, message }) }
  put('pou', 'T-1'); put('pou', 'T-2')
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), ['T-1', 'T-2'])
  assert.equal(sent.length, 1); assert.match(sent[0].title, /2 cards need you/)
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), [], 'no repeat')
  put('pou', 'T-3')
  await alertOwnerCards({ project: 'P', tasksDir: tasks, send })
  assert.match(sent[1].title, /P T-3 needs you/); assert.match(sent[1].message, /approve T-3\?/)
  renameSync(join(tasks, 'pou', 'T-1.md'), join(tasks, 'queue', 'T-1.md'))
  await alertOwnerCards({ project: 'P', tasksDir: tasks, send })
  renameSync(join(tasks, 'queue', 'T-1.md'), join(tasks, 'pou', 'T-1.md'))
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), ['T-1'], 'back in Pou alerts again')
})

test('ownerReason picks the latest plain question', () => {
  assert.equal(ownerReason('x\n**Needs you**\n\nFive failures. Choose.\n\nmore'), 'Five failures. Choose.')
})

// Operator 2026-10-09: questions for the operator go as emergency (critical) alerts, which Pushover
// rejects without retry and expire.
test('a critical alert sends emergency priority with retry and expire', async t => {
  const sent = []
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => { sent.push(Object.fromEntries(body)); return { status: 200, json: async () => ({ status: 1 }) } })
  const env = { PUSHOVER_APP_TOKEN: 't', PUSHOVER_USER_KEY: 'u' }
  await pushover('q', 'm', env, 2)
  await pushover('board', 'm', env)
  assert.deepEqual([sent[0].priority, sent[0].retry, sent[0].expire], ['2', '60', '1800'])
  assert.deepEqual([sent[1].priority, sent[1].retry], ['0', undefined])
})

// Operator 2026-10-10: a card held in Planning for a decision never alerted; only Pou did.
test('a card waiting in Planning for a decision alerts once with its question', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-alerts-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  for (const id of ['T-1', 'T-2']) writeFileSync(join(tasks, 'planning', `${id}.md`), `# ${id} — card ${id}\n`)
  writeFileSync(join(tasks, '.owner-alerted.json'), '{}')
  updateWorkflow(tasks, 'T-1', { waitFor: { cards: [], files: [], decision: true, why: 'Which dose unit?' } })
  const sent = [], send = async (title, message) => { sent.push({ title, message }) }
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), ['T-1'])
  assert.match(sent[0].title, /P T-1 needs you/); assert.match(sent[0].message, /Which dose unit\?/)
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), [], 'no repeat')
})

// Operator 2026-10-10: I989/I991 were [board] plan-check conflicts, not product questions; they
// paged the operator anyway because owner-alerts only checked waitFor.decision. hkb.mjs now also
// sets waitFor.board for that category, so it must never reach `send`.
test('a card waiting in Planning for a board/process conflict never pages the operator', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-alerts-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'planning'), { recursive: true })
  writeFileSync(join(tasks, 'planning', 'T-1.md'), '# T-1 — card T-1\n')
  writeFileSync(join(tasks, '.owner-alerted.json'), '{}')
  updateWorkflow(tasks, 'T-1', { waitFor: { cards: [], files: [], decision: true, board: true, why: 'plan check demands an AC3 FAIL base line' } })
  const sent = [], send = async (title, message) => { sent.push({ title, message }) }
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), [])
  assert.equal(sent.length, 0)
})
