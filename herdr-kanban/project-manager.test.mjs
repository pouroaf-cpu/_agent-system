// Project chats self-serve: they register as their project's manager (findings go to
// their inbox), and read stuck cards and a per-project summary without the Kanban Manager.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCard, moveCard } from './lib/cards.mjs'
import { historyPath } from './lib/card-history.mjs'

let root, tasks, child, base, configPath
before(async () => {
  root = mkdtempSync(join(tmpdir(), 'hkb-project-manager-'))
  tasks = join(root, 'Proj', 'TASKS')
  mkdirSync(join(tasks, 'queue'), { recursive: true })
  const s = createServer()
  await new Promise((done) => s.listen(0, '127.0.0.1', done))
  const port = s.address().port
  await new Promise((done) => s.close(done))
  configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port, mode: 'auto', projectsRoot: root.replace(/\\/g, '/'), projects: ['Proj'], cardPrefixes: { Proj: 'P' },
    maxConcurrentAgents: 0, stallSeconds: 300, agentPollMs: 3600000,
    engine: { kind: 'codex' }, models: { working: 'test', review: 'test', issues: 'test' },
  }))
  child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-project-manager-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/board?project=Proj`)).ok) break } catch {}
    if (i > 80 || child.exitCode !== null) throw new Error('server did not start')
    await new Promise((done) => setTimeout(done, 100))
  }
})
after(() => { child?.kill(); rmSync(root, { recursive: true, force: true }) })

const post = async (path, body) => {
  const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const get = async (path) => { const r = await fetch(base + path); return { status: r.status, body: await r.json() } }
const savedConfig = () => JSON.parse(readFileSync(configPath, 'utf8'))

test('project-manager registers, persists, reads back, unregisters and rejects bad input', async () => {
  const inbox = join(root, 'inbox', 'Proj-INBOX.md').replace(/\\/g, '/')
  let r = await post('/api/project-manager', { project: 'Proj', chat: 'Proj work', inbox })
  assert.equal(r.status, 200, r.body.error)
  assert.deepEqual(r.body.manager, { chat: 'Proj work', inbox })
  assert.deepEqual(savedConfig().projectSettings.Proj.manager, { chat: 'Proj work', inbox })
  assert.ok(existsSync(join(root, 'inbox')), 'inbox folder created')
  r = await get('/api/project-manager?project=Proj')
  assert.deepEqual(r.body, { ok: true, project: 'Proj', manager: { chat: 'Proj work', inbox } })

  for (const bad of [{ project: 'Nope', chat: 'x' }, { project: 'Proj', chat: '' }, { project: 'Proj', chat: 'x'.repeat(61) }, { project: 'Proj', chat: 'x', inbox: 'relative/inbox.md' }]) {
    r = await post('/api/project-manager', bad)
    assert.equal(r.status, 400, JSON.stringify(bad))
  }
  assert.equal((await get('/api/project-manager?project=Nope')).status, 400)

  r = await post('/api/project-manager', { project: 'Proj', chat: null })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(r.body.manager, null)
  assert.equal(savedConfig().projectSettings?.Proj?.manager, undefined)
  assert.equal((await get('/api/project-manager?project=Proj')).body.manager, null)
})

let old, fresh
test('stuck lists a card over the threshold with its reason and omits a fresh one', async () => {
  old = createCard(tasks, { title: 'Old', brief: 'x', prefix: 'P' })
  moveCard(tasks, old.id, 'planning')
  moveCard(tasks, old.id, 'owner')
  // Two hours in Owner.
  const path = historyPath(tasks, old.id), then = new Date(Date.now() - 2 * 3600000).toISOString()
  writeFileSync(path, readFileSync(path, 'utf8').replace(/"at":"[^"]+"/g, `"at":"${then}"`))
  fresh = createCard(tasks, { title: 'Fresh', brief: 'x', prefix: 'P' })

  let r = await get('/api/stuck?project=Proj&minutes=60')
  assert.equal(r.status, 200, r.body.error)
  assert.equal(r.body.cards.length, 1)
  const [card] = r.body.cards
  assert.deepEqual({ ...card, minutes: undefined }, { project: 'Proj', id: old.id, title: 'Old', lane: 'owner', minutes: undefined, agent: null, waitingOn: [], reason: 'Planning issue; see card feedback' })
  assert.ok(card.minutes >= 119, String(card.minutes))
  r = await get('/api/stuck?minutes=0')
  assert.deepEqual(r.body.cards.map(c => c.id).sort(), [old.id, fresh.id].sort())
  // A card waiting on an unfinished blocker is queued, not stuck (I310 waited on I307).
  const waiting = createCard(tasks, { title: 'Waiting', brief: 'x', prefix: 'P' })
  writeFileSync(waiting.path, readFileSync(waiting.path, 'utf8').replace(/^(\*\*Trivial:\*\*.*)$/m, `$1\n**Blocked by:** ${fresh.id}`))
  r = await get('/api/stuck?minutes=0')
  assert.ok(!r.body.cards.some(c => c.id === waiting.id), 'blocked card listed as stuck')
  assert.equal((await get('/api/stuck?project=Nope')).status, 400)
  assert.equal((await get('/api/stuck?minutes=-1')).status, 400)
})

test('summary has lane counts, the oldest card, owner ids and the stuck count', async () => {
  const r = await get('/api/summary')
  assert.equal(r.status, 200, r.body.error)
  const [s] = r.body.projects
  assert.equal(s.project, 'Proj')
  assert.equal(s.paused, true) // maxConcurrentAgents 0
  assert.equal(s.lanes.owner, 1)
  assert.equal(s.lanes.planning, 2) // Fresh and the blocked Waiting card
  assert.deepEqual({ ...s.oldestCard, minutes: undefined }, { id: old.id, lane: 'owner', minutes: undefined })
  assert.deepEqual(s.owner, [old.id])
  assert.deepEqual(s.pou, [])
  assert.equal(s.stuck, 1)
  assert.deepEqual(s.quotaBlocks, {})
  assert.equal(s.integrationAheadOfMaster, null) // not a Git project
  assert.ok(!('release' in s))
})

test('hkb found goes to the registered manager inbox, to the Kanban Manager without one, and always with --board', async () => {
  mkdirSync(join(tasks, 'working'), { recursive: true })
  writeFileSync(join(tasks, 'working', 'T-1-card.md'), '# T-1 — Card\n')
  const managerInbox = join(root, 'inbox', 'Proj-INBOX.md'), kmInbox = join(root, 'km.md')
  const hkb = (...a) => spawnSync(process.execPath, [resolve('hkb.mjs'), '--tasks', tasks, 'found', ...a], { encoding: 'utf8', env: { ...process.env, KANBAN_CONFIG: configPath, KANBAN_MANAGER_INBOX: kmInbox } })
  const read = (file) => existsSync(file) ? readFileSync(file, 'utf8') : ''

  let r = hkb('T-1', 'no manager yet')
  assert.equal(r.status, 0, r.stderr)
  assert.match(read(kmInbox), /FOUND Proj T-1 \(working\): no manager yet/)

  assert.equal((await post('/api/project-manager', { project: 'Proj', chat: 'Proj work', inbox: managerInbox })).status, 200)
  r = hkb('T-1', 'product bug in checkout')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /Proj work/)
  assert.match(read(managerInbox), /FOUND Proj T-1 \(working\): product bug in checkout/)
  assert.doesNotMatch(read(kmInbox), /product bug/)

  r = hkb('--board', 'T-1', 'hkb refused a valid handoff')
  assert.equal(r.status, 0, r.stderr)
  assert.match(read(kmInbox), /FOUND Proj T-1 \(working\): hkb refused a valid handoff/)
  assert.doesNotMatch(read(managerInbox), /hkb refused/)
  assert.notEqual(hkb('--board', 'T-1').status, 0)

  const history = readFileSync(historyPath(tasks, 'T-1'), 'utf8')
  assert.equal(history.match(/"event":"found"/g).length, 3)
})
