// Project chats self-serve: they register as their project's manager (findings go to
// their inbox), and read stuck cards and a per-project summary without the Kanban Manager.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync, existsSync, renameSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createCard, moveCard } from './lib/cards.mjs'
import { historyPath } from './lib/card-history.mjs'
import { updateWorkflow } from './lib/workflow-state.mjs'
import { formatNZClock } from './lib/nz-time.mjs'

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
const fillPlan = card => writeFileSync(card.path, `# ${card.id} — ${card.title}\n\n**Workflow:** card-owned\n**Workspace:** .\n\n## Approved brief\n\nDo it.\n\n## Files\n\n- \`app.js\`\n\n## Implementation plan\n\nChange app.js.\n\n## Acceptance criteria\n\n- AC1: done\n`)

test('/api/stuck omits Planned file waits even before a scheduler dispatch pass', async () => {
  const holder = createCard(tasks, { title: 'File holder', brief: 'x', prefix: 'P' })
  const waiting = createCard(tasks, { title: 'Waiting plan', brief: 'x', prefix: 'P' })
  for (const card of [holder, waiting]) writeFileSync(card.path, `# ${card.id} — file wait\n## Files\n- \`public/legacy/**/index.html\`\n`)
  mkdirSync(join(tasks, 'working'), { recursive: true }); mkdirSync(join(tasks, 'backlog'), { recursive: true })
  const holderPath = join(tasks, 'working', `${holder.id}.md`), waitingPath = join(tasks, 'backlog', `${waiting.id}.md`)
  renameSync(holder.path, holderPath); renameSync(waiting.path, waitingPath)
  const then = new Date(Date.now() - 30 * 60000)
  utimesSync(waitingPath, then, then)
  writeFileSync(join(tasks, '.board-worktrees.json'), JSON.stringify({ [holder.id]: {
    state: 'building', integrationWorkspace: join(root, 'Proj'), files: [join(root, 'Proj/public/legacy/**/index.html').replaceAll('\\', '/').toLowerCase()],
  } }))
  try {
    const r = await get('/api/stuck?project=Proj&minutes=20')
    assert.equal(r.status, 200, r.body.error)
    assert.ok(!r.body.cards.some(c => c.id === waiting.id))
    mkdirSync(join(tasks, 'archive'), { recursive: true })
    renameSync(holderPath, join(tasks, 'archive', `${holder.id}.md`))
    assert.ok((await get('/api/stuck?project=Proj&minutes=20')).body.cards.some(c => c.id === waiting.id), 'closing the holder exposes the otherwise stalled plan')
  } finally {
    rmSync(holderPath, { force: true }); rmSync(waitingPath)
    rmSync(join(tasks, 'archive', `${holder.id}.md`), { force: true })
    rmSync(join(tasks, '.board-worktrees.json'))
  }
})

test('/api/stuck and board agree that an open Planned plan check is active', async () => {
  const card = createCard(tasks, { title: 'Checking plan', brief: 'x', prefix: 'P' })
  mkdirSync(join(tasks, 'backlog'), { recursive: true })
  const path = join(tasks, 'backlog', `${card.id}.md`)
  renameSync(card.path, path)
  const then = Date.now() - 90 * 60000
  utimesSync(path, new Date(then), new Date(then))
  const file = join(root, '.review-claims.json')
  const claim = { id: 'plan-check', project: 'Proj', tasksDir: tasks, cards: [card.id], role: 'plancheck', phase: 'running', paneId: 'r1', createdAt: then }
  const save = c => writeFileSync(file, JSON.stringify({ version: 1, claims: [c] }))
  try {
    save(claim)
    const board = (await get('/api/board?project=Proj')).body
    assert.equal(board.laneTimes[card.id].agentActive, true)
    assert.equal(board.laneTimes[card.id].agentRole, 'plan check')
    assert.ok(board.laneTimes[card.id].agentName)
    assert.equal(board.cardWaits[card.id].stuck, false)
    assert.ok(!(await get('/api/stuck?project=Proj&minutes=20')).body.cards.some(c => c.id === card.id))
    save({ ...claim, closedAt: then + 60000 })
    assert.equal((await get('/api/board?project=Proj')).body.cardWaits[card.id].stuck, true)
    assert.ok((await get('/api/stuck?project=Proj&minutes=20')).body.cards.some(c => c.id === card.id))
  } finally {
    rmSync(path, { force: true }); rmSync(file, { force: true })
  }
})

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
  writeFileSync(waiting.path, readFileSync(waiting.path, 'utf8').replace(/^(\*\*Difficulty:\*\*.*)$/m, `$1\n**Blocked by:** ${fresh.id}`))
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
  assert.equal(s.waiting, 1)
  assert.deepEqual(s.waitingCards, [{ id: (await get('/api/board?project=Proj')).body.board.planning.find(c => c.title === 'Waiting').id, lane: 'planning', on: `cards ${fresh.id}` }])
  assert.deepEqual(s.quotaBlocks, {})
  assert.equal(s.integrationAheadOfMaster, null) // not a Git project
  assert.ok(!('release' in s))
})

test('summary and board share card, file, decision and slot waits, separate from stuck', async () => {
  const make = title => createCard(tasks, { title, brief: 'x', prefix: 'P' })
  const dependency = make('Needs two cards'), files = make('Needs file'), decision = make('Needs decision'), slot = make('Needs Planner slot'), queueSlot = make('Needs Builder slot')
  fillPlan(queueSlot)
  moveCard(tasks, queueSlot.id, 'queue')
  updateWorkflow(tasks, dependency.id, { waitFor: { cards: [fresh.id, files.id], files: [] } })
  updateWorkflow(tasks, files.id, { waitFor: { cards: [], files: ['public/new.html'] } })
  updateWorkflow(tasks, decision.id, { waitFor: { cards: [], files: [], decision: true } })
  // A starting Planner reserves the slot, and a live Builder fills the Builder slot.
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify({ [fresh.id]: { paneId: 'starting', createdAt: new Date().toISOString() } }))
  writeFileSync(join(tasks, '.board.json'), JSON.stringify({ 'P999': { pane_id: 'builder', spawning: true, started: new Date().toISOString() } }))
  await post('/api/config', { maxConcurrentAgents: 1 })
  try {
    const summary = (await get('/api/summary')).body.projects[0]
    const byId = Object.fromEntries(summary.waitingCards.map(c => [c.id, c]))
    for (const [card, on] of [[dependency, `cards ${fresh.id}, ${files.id}`], [files, 'files public/new.html'], [decision, 'decision'], [slot, 'free Planner slot'], [queueSlot, 'free Builder slot']]) {
      assert.deepEqual(byId[card.id], { id: card.id, lane: card.id === queueSlot.id ? 'queue' : 'planning', on })
      const board = (await get('/api/board?project=Proj')).body
      assert.equal(board.cardWaits[card.id].on, on)
      assert.equal(board.cardWaits[card.id].stuck, false)
    }
    assert.equal(summary.waiting, summary.waitingCards.length)
    assert.equal(summary.stuck, 1)
    assert.equal((await get('/api/board?project=Proj')).body.cardWaits[old.id].stuck, true)
    assert.ok(!(await get('/api/stuck?minutes=0')).body.cards.some(c => c.id === decision.id))
  } finally {
    rmSync(join(tasks, '.card-planners.json'), { force: true })
    rmSync(join(tasks, '.board.json'), { force: true })
    await post('/api/config', { maxConcurrentAgents: 0 })
    for (const c of [dependency, files, decision, slot, queueSlot]) moveCard(tasks, c.id, 'archive', { operatorArchive: true })
  }
})

// Injectbuddy I341/I344 read "stuck" the moment their blocker landed (2026-09-27).
test('a card whose blocker landed a minute ago is not stuck, however long it waited', async () => {
  const blocker = createCard(tasks, { title: 'Blocker', brief: 'x', prefix: 'P' })
  moveCard(tasks, blocker.id, 'archive', { operatorArchive: true })
  const card = createCard(tasks, { title: 'Was blocked', brief: 'x', prefix: 'P' })
  writeFileSync(card.path, readFileSync(card.path, 'utf8').replace(/^(\*\*Difficulty:\*\*.*)$/m, `$1\n**Blocked by:** ${blocker.id}`))
  moveCard(tasks, card.id, 'owner')
  moveCard(tasks, card.id, 'planning')
  // Three hours in Planning; the blocker's archive move one minute ago.
  const age = (id, ms) => { const path = historyPath(tasks, id); writeFileSync(path, readFileSync(path, 'utf8').replace(/"at":"[^"]+"/g, `"at":"${new Date(Date.now() - ms).toISOString()}"`)) }
  age(card.id, 3 * 3600000)
  age(blocker.id, 60000)
  const r = await get('/api/stuck?project=Proj&minutes=60')
  assert.equal(r.status, 200, r.body.error)
  assert.ok(!r.body.cards.some(c => c.id === card.id), 'card listed as stuck right after its blocker landed')
  assert.ok((await get('/api/stuck?project=Proj&minutes=0')).body.cards.some(c => c.id === card.id && c.minutes <= 2))
})

// Injectbuddy I521 read "stuck" an hour into a three-day Codex usage limit (2026-10-01).
test('a card held by a usage limit is not stuck; it is again once the limit is gone', async () => {
  const card = createCard(tasks, { title: 'Quota held', brief: 'x', prefix: 'P' })
  moveCard(tasks, card.id, 'owner')
  moveCard(tasks, card.id, 'planning')
  const path = historyPath(tasks, card.id)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/"at":"[^"]+"/g, `"at":"${new Date(Date.now() - 3 * 3600000).toISOString()}"`))
  const quotaFile = join(root, '.engine-quota.json')
  const until = Date.now() + 86400000
  writeFileSync(quotaFile, JSON.stringify({ codex: { until, since: new Date().toISOString() } }))
  try {
    const r = await get('/api/stuck?project=Proj&minutes=60')
    assert.equal(r.status, 200, r.body.error)
    assert.ok(!r.body.cards.some(c => c.id === card.id), 'quota-held card listed as stuck')
    const summary = (await get('/api/summary')).body.projects[0]
    assert.deepEqual(summary.waitingCards.find(c => c.id === card.id), { id: card.id, lane: 'planning', on: `usage limit until ${formatNZClock(until)}` })
    assert.equal(formatNZClock('2026-10-04T08:00:00Z'), '9:00 pm')
  } finally { rmSync(quotaFile, { force: true }) }
  assert.ok((await get('/api/stuck?project=Proj&minutes=60')).body.cards.some(c => c.id === card.id), 'card not stuck after the limit cleared')
  moveCard(tasks, card.id, 'archive', { operatorArchive: true })
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
