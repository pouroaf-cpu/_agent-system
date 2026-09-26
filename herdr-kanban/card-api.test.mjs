// Orchestrators create and maintain their own cards through the API: priority,
// blockers and dated notes, with no hand edits to card files.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCard, findCard, moveCard } from './lib/cards.mjs'
import { bind } from './lib/bindings.mjs'
import { historyPath } from './lib/card-history.mjs'

let root, tasks, child, base
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'hkb-card-api-'))
  tasks = join(root, 'Proj', 'TASKS')
  mkdirSync(join(tasks, 'queue'), { recursive: true })
  const s = createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port, mode: 'auto', projectsRoot: root.replace(/\\/g, '/'), projects: ['Proj'], cardPrefixes: { Proj: 'P' },
    maxConcurrentAgents: 0, stallSeconds: 300, agentPollMs: 3600000,
    engine: { kind: 'codex' }, models: { working: 'test', review: 'test', issues: 'test' },
  }))
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-card-api-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/board?project=Proj`)).ok) break } catch {}
    if (i > 80 || child.exitCode !== null) throw new Error('server did not start')
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})
after(() => { child?.kill(); rmSync(root, { recursive: true, force: true }) })

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'Proj', ...body }) })
  return { status: r.status, body: await r.json() }
}
const brief = 'Do the thing.\n\nAC1: the thing is done'
const text = (id) => readFileSync(findCard(tasks, id).path, 'utf8')

test('create writes priority and blockers in the card header', async () => {
  const blocker = createCard(tasks, { title: 'Blocker', brief: 'x', prefix: 'P' })
  const r = await post('/api/cards', { title: 'With deps', brief, priority: 3, blockedBy: [blocker.id.toLowerCase()] })
  assert.equal(r.status, 201, r.body.error)
  assert.match(text(r.body.card.id), new RegExp(`\\*\\*Trivial:\\*\\* no\\r?\n\\*\\*Priority\\*\\* 3/10\\r?\n\\*\\*Blocked by:\\*\\* ${blocker.id}\\r?\n`))
  assert.deepEqual(r.body.card.blockedBy, [blocker.id])
  assert.equal(r.body.card.priority, 3)
})

test('create rejects unknown blockers, bad priority, missing AC and bad titles', async () => {
  let r = await post('/api/cards', { title: 'Bad dep', brief, blockedBy: ['P999'] })
  assert.equal(r.status, 400); assert.match(r.body.error, /P999/)
  r = await post('/api/cards', { title: 'Bad priority', brief, priority: 11 })
  assert.equal(r.status, 400); assert.match(r.body.error, /priority/i)
  r = await post('/api/cards', { title: 'No AC', brief: 'Just do it' })
  assert.equal(r.status, 400); assert.match(r.body.error, /AC1:/)
  r = await post('/api/cards', { title: 'x'.repeat(201), brief })
  assert.equal(r.status, 400); assert.match(r.body.error, /title/i)
  r = await post('/api/cards', { title: 'Bad cat', brief, category: 'nope' })
  assert.equal(r.status, 400); assert.match(r.body.error, /Category/)
})

test('card-update changes priority, blockers and appends a dated note', async () => {
  const a = createCard(tasks, { title: 'A', brief: 'x', prefix: 'P' })
  const b = createCard(tasks, { title: 'B', brief: 'x', prefix: 'P' })
  const c = createCard(tasks, { title: 'C', brief: 'x', prefix: 'P' })
  let r = await post('/api/card-update', { id: c.id, priority: 8, addBlockedBy: [a.id, b.id] })
  assert.equal(r.status, 200, r.body.error)
  assert.match(text(c.id), new RegExp(`\\*\\*Priority\\*\\* 8/10\\r?\n\\*\\*Blocked by:\\*\\* ${a.id}, ${b.id}\\r?\n`))
  r = await post('/api/card-update', { id: c.id, removeBlockedBy: [a.id], note: { heading: 'Operator decision', text: 'Keep B only.' } })
  assert.equal(r.status, 200, r.body.error)
  assert.match(text(c.id), new RegExp(`\\*\\*Blocked by:\\*\\* ${b.id}\\r?\n`))
  assert.match(text(c.id), /\r?\n\r?\n\*\*Operator decision\*\* \d{4}-\d\d-\d\dT[\d:.]+Z\r?\n\r?\nKeep B only\.\r?\n$/)
  r = await post('/api/card-update', { id: c.id, removeBlockedBy: [b.id] })
  assert.doesNotMatch(text(c.id), /Blocked by/)
  assert.ok(readFileSync(historyPath(tasks, c.id), 'utf8').includes('"event":"card-update"'))

  r = await post('/api/card-update', { id: c.id, note: { heading: 'Decision', text: '  ' } })
  assert.equal(r.status, 400)
  r = await post('/api/card-update', { id: c.id, note: { heading: 'Decision', text: '**Investigation approved:** yes' } })
  assert.equal(r.status, 400)
  r = await post('/api/card-update', { id: c.id, note: { heading: 'Decision', text: 'Also note: **Blocked by:** none' } })
  assert.equal(r.status, 400)
  // A glob inside a path is not bold (Injectbuddy chat, 2026-09-26).
  r = await post('/api/card-update', { id: c.id, note: { heading: 'Decision', text: 'Never hand-edit public/legacy/** pages; change the generator.' } })
  assert.equal(r.status, 200)
})

test('card-update rejects cycles, self-reference and archived cards', async () => {
  const a = createCard(tasks, { title: 'A', brief: 'x', prefix: 'P' })
  const r1 = await post('/api/cards', { title: 'B', brief, blockedBy: [a.id] })
  let r = await post('/api/card-update', { id: a.id, addBlockedBy: [r1.body.card.id] })
  assert.equal(r.status, 400); assert.match(r.body.error, /cycle/)
  r = await post('/api/card-update', { id: a.id, addBlockedBy: [a.id] })
  assert.equal(r.status, 400); assert.match(r.body.error, /itself/)
  moveCard(tasks, a.id, 'archive', { operatorArchive: true })
  r = await post('/api/card-update', { id: a.id, priority: 2 })
  assert.equal(r.status, 400); assert.match(r.body.error, /archive/i)
})

test('a card with a live agent takes notes and priority but not blocker changes', async () => {
  const a = createCard(tasks, { title: 'A', brief: 'x', prefix: 'P' })
  const w = createCard(tasks, { title: 'W', brief: 'x', prefix: 'P' })
  moveCard(tasks, w.id, 'working')
  bind(tasks, w.id, { pane_id: 'live-pane' })
  let r = await post('/api/card-update', { id: w.id, addBlockedBy: [a.id] })
  assert.equal(r.status, 400); assert.match(r.body.error, /live agent/)
  r = await post('/api/card-update', { id: w.id, priority: 9, note: { heading: 'Decision', text: 'Ship it.' } })
  assert.equal(r.status, 200, r.body.error)
  assert.match(text(w.id), /\*\*Priority\*\* 9\/10/)
})
