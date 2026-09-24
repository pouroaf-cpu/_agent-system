import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { alertOwnerCards, ownerReason } from './lib/owner-alerts.mjs'

test('each card that lands in Owner alerts once; first run summarises; re-entry alerts again', async t => {
  const root = mkdtempSync(join(tmpdir(), 'owner-alerts-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const d of ['owner', 'queue']) mkdirSync(join(tasks, d), { recursive: true })
  const put = (col, id) => writeFileSync(join(tasks, col, `${id}.md`), `# ${id} — card ${id}\n\nNeeds you: approve ${id}?\n`)
  const sent = [], send = async (title, message) => { sent.push({ title, message }) }
  put('owner', 'T-1'); put('owner', 'T-2')
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), ['T-1', 'T-2'])
  assert.equal(sent.length, 1); assert.match(sent[0].title, /2 cards need you/)
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), [], 'no repeat')
  put('owner', 'T-3')
  await alertOwnerCards({ project: 'P', tasksDir: tasks, send })
  assert.match(sent[1].title, /P T-3 needs you/); assert.match(sent[1].message, /approve T-3\?/)
  renameSync(join(tasks, 'owner', 'T-1.md'), join(tasks, 'queue', 'T-1.md'))
  await alertOwnerCards({ project: 'P', tasksDir: tasks, send })
  renameSync(join(tasks, 'queue', 'T-1.md'), join(tasks, 'owner', 'T-1.md'))
  assert.deepEqual(await alertOwnerCards({ project: 'P', tasksDir: tasks, send }), ['T-1'], 'back in Owner alerts again')
})

test('ownerReason picks the latest plain question', () => {
  assert.equal(ownerReason('x\n**Needs you**\n\nFive failures. Choose.\n\nmore'), 'Five failures. Choose.')
})
