// Orchestrators create and maintain their own cards through the API: priority,
// blockers and dated notes, with no hand edits to card files.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createCard, findCard, moveCard } from './lib/cards.mjs'
import { bind } from './lib/bindings.mjs'
import { historyPath } from './lib/card-history.mjs'
import { readWorkflow, updateWorkflow } from './lib/workflow-state.mjs'
import { chromium } from 'playwright'

let root, tasks, child, base, stderr = ''
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
    windowsHide: true,
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', () => {})
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
  assert.match(text(r.body.card.id), new RegExp(`\\*\\*Difficulty:\\*\\* [^\\n]*\\r?\n\\*\\*Priority\\*\\* 3/10\\r?\n\\*\\*Blocked by:\\*\\* ${blocker.id}\\r?\n`))
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

test('create refuses a Workspace folder missing from the project', async () => {
  const count = () => readdirSync(join(tasks, 'planning')).length
  createCard(tasks, { title: 'Seed', brief: 'x', prefix: 'P' })
  const before = count()
  let r = await post('/api/cards', { title: 'Bad workspace', brief, workspace: 'no-such-folder' })
  assert.equal(r.status, 400)
  assert.match(r.body.error, /no-such-folder/); assert.match(r.body.error, /Proj/)
  assert.equal(count(), before, 'no card file is written')
  mkdirSync(join(root, 'Proj', 'app'))
  r = await post('/api/cards', { title: 'Existing folder', brief, workspace: 'app' })
  assert.equal(r.status, 201, r.body.error)
  r = await post('/api/cards', { title: 'Project root', brief, workspace: '.' })
  assert.equal(r.status, 201, r.body.error)
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

test('card-update notes lift Planner decision waits but preserve board waits', async () => {
  const decision = createCard(tasks, { title: 'Decision', brief: 'x', prefix: 'P' })
  const board = createCard(tasks, { title: 'Board', brief: 'x', prefix: 'P' })
  moveCard(tasks, decision.id, 'planning')
  moveCard(tasks, board.id, 'planning')
  updateWorkflow(tasks, decision.id, { waitFor: { cards: [], files: [], decision: true } })
  updateWorkflow(tasks, board.id, { waitFor: { cards: [], files: [], decision: true, board: true } })

  let r = await post('/api/card-update', { id: decision.id, priority: 5 })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(readWorkflow(tasks)[decision.id].waitFor.decision, true)
  r = await post('/api/card-update', { id: decision.id, note: { heading: 'Decision', text: 'Proceed.' } })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(readWorkflow(tasks)[decision.id].waitFor, null)

  r = await post('/api/card-update', { id: board.id, note: { heading: 'Decision', text: 'Proceed.' } })
  assert.equal(r.status, 200, r.body.error)
  assert.equal(readWorkflow(tasks)[board.id].waitFor.board, true)
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

// Audit 2026-10-15 F7: a bad request body is a 400 with a message, never a 500 with a stack
// on stderr; the card routes check the project and the card id before any work.
const raw = async (path, body, method = 'POST') => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body })
  return { status: r.status, body: await r.json() }
}

test('F7 AC1: malformed and empty JSON bodies answer 400 on every card route with nothing on stderr', async () => {
  const before = stderr.length
  for (const path of ['/api/spawn', '/api/priority', '/api/auto-review', '/api/review', '/api/stop', '/api/cards', '/api/card-update', '/api/open', '/api/config']) {
    let r = await raw(path, '{bad')
    assert.equal(r.status, 400, `${path} with malformed JSON`)
    assert.match(r.body.error, /not valid JSON/)
    r = await raw(path, '[1]')
    assert.equal(r.status, 400, `${path} with a JSON array`)
    assert.match(r.body.error, /JSON object/)
    r = await raw(path, '')
    // An empty body is {}: a config save with nothing to change is fine, a card route is not.
    if (path !== '/api/config') assert.ok(r.status >= 400 && r.status < 500, `${path} with an empty body answered ${r.status}`)
  }
  assert.equal(stderr.slice(before), '', 'no stack on stderr for a client error')
})

test('F7 AC2: card routes refuse an unknown project or a bad card id with 400 and keep the board up', async () => {
  const before = stderr.length
  for (const path of ['/api/spawn', '/api/priority', '/api/auto-review', '/api/stop']) {
    let r = await raw(path, JSON.stringify({ project: 'Nope', id: 'P1' }))
    assert.equal(r.status, 400, path); assert.equal(r.body.error, 'Unknown project')
    r = await raw(path, JSON.stringify({ project: 'Proj', id: '../x' }))
    assert.equal(r.status, 400, path); assert.equal(r.body.error, 'Invalid card identity')
    r = await raw(path, JSON.stringify({ project: 'Proj' }))
    assert.equal(r.status, 400, path); assert.equal(r.body.error, 'Invalid card identity')
  }
  let r = await raw('/api/review', JSON.stringify({ project: 'Nope' }))
  assert.equal(r.status, 400); assert.equal(r.body.error, 'Unknown project')
  r = await raw('/api/review', JSON.stringify({ project: 'Proj', cardIds: ['../x'] }))
  assert.equal(r.status, 400); assert.match(r.body.error, /cardIds/)
  assert.equal(stderr.slice(before), '')
  assert.equal(child.exitCode, null)
  assert.equal((await fetch(`${base}/api/board?project=Proj`)).status, 200)
})

test('F7 AC3: /api/priority refuses a value outside 0-10 instead of clamping it', async () => {
  const a = createCard(tasks, { title: 'Pri', brief: 'x', prefix: 'P' })
  let r = await post('/api/priority', { id: a.id, priority: 99 })
  assert.equal(r.status, 400); assert.match(r.body.error, /priority/i)
  r = await post('/api/priority', { id: a.id, priority: 2.5 })
  assert.equal(r.status, 400); assert.match(r.body.error, /priority/i)
  r = await post('/api/priority', { id: a.id, priority: '7' })
  assert.equal(r.status, 400); assert.match(r.body.error, /priority/i)
  assert.doesNotMatch(text(a.id), /Priority\*\* 10\/10/)
  r = await post('/api/priority', { id: a.id.toLowerCase(), priority: 0 })
  assert.equal(r.status, 200, r.body.error)
  assert.match(text(a.id), /\*\*Priority\*\* 0\/10/)
  r = await post('/api/priority', { id: a.id, priority: 10 })
  assert.equal(r.status, 200, r.body.error)
})

test('F7: a fresh board answers the page-load GETs with 200', async () => {
  const tasksRoutes = await fetch(`${base}/api/tests/routes?project=Proj`)
  assert.equal(tasksRoutes.status, 200)
  assert.deepEqual(await tasksRoutes.json(), { ok: true, routes: [], types: [], note: 'No e2e audit writer for this project' })
  assert.equal((await fetch(`${base}/api/tests/routes?project=Nope`)).status, 400)
  const managerTasks = await fetch(`${base}/api/manager-tasks`)
  assert.equal(managerTasks.status, 200)
  const body = await managerTasks.json()
  assert.deepEqual([body.ok, body.tasks], [true, []])
  for (const path of ['/api/audits?project=Proj', '/api/tests?project=Proj', '/api/projects', '/api/archive?project=Proj']) {
    assert.equal((await fetch(base + path)).status, 200, path)
  }
})

test('F7 AC4: the board page loads against a real server with no console error and no 4xx or 5xx response', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = [], failed = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${new URL(r.url()).pathname}`) })
    await page.goto(`${base}/?project=Proj`)
    await page.locator('#menu-archive').waitFor({ state: 'attached' })
    for (const view of ['tasks', 'audits', 'settings', 'board']) {
      await page.evaluate(v => document.querySelector(`[data-view="${v}"]`).click(), view)
      await page.waitForTimeout(300)
    }
    assert.deepEqual(errors, [])
    assert.deepEqual(failed, [])
  } finally { await browser.close() }
})
