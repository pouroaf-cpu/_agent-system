// Audit 2026-10-15 F5: /api/board carries the open lanes only; archived cards and their usage,
// workflow and planner records come from /api/archive when the Archive view opens; SSE `board`
// events are a lane summary with a version, and one tab refetch per change replaces the full
// payload send (Injectbuddy's was 3,959 KB, 95% archive history, on every bookkeeping write).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { COLUMNS } from './lib/cards.mjs'

async function freePort() {
  const s = createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}

// One temp board: 3 open cards, 400 archived ones, each archived card with a verdict-sized
// workflow record, a usage run and a planner record, the shape that made the live payload 4 MB.
function board() {
  const root = mkdtempSync(join(tmpdir(), 'hkb-payload-'))
  const tasks = join(root, 'Proj', 'TASKS')
  for (const lane of ['queue', 'working', 'archive']) mkdirSync(join(tasks, lane), { recursive: true })
  const card = (id, lane, title) => writeFileSync(join(tasks, lane, `${id}-${title}.md`), `# ${id} — ${title}\n\n## Approved brief\n${title}.\n`)
  card('T-1', 'queue', 'open-one'); card('T-2', 'queue', 'open-two'); card('T-3', 'working', 'open-three')
  const workflow = {}, planners = {}, runs = {}
  const verdict = 'Plan check found 3 problems: '.padEnd(2000, 'x')
  for (let i = 1; i <= 400; i++) {
    const id = `T-${100 + i}`
    card(id, 'archive', `done-${i}`)
    workflow[id] = { completedStage: 'review', planCheck: { verdict }, builder: { pane_id: `old:${i}` } }
    planners[id] = { lifecycle: 'retired', paneId: `old:${i}`, note: verdict.slice(0, 500) }
    runs[`r${i}`] = { runId: `r${i}`, cardIds: [id], role: 'builder', status: 'complete', delta: { total: 1000 + i, uncachedInput: 1, cachedInput: 1, output: 1 }, start: { at: '2026-10-01T00:00:00Z' }, finish: { at: '2026-10-01T00:10:00Z' } }
  }
  workflow['T-3'] = { builderDifficulty: 'medium' }
  runs.open = { runId: 'open', cardIds: ['T-3'], role: 'planner', status: 'complete', delta: { total: 77, uncachedInput: 1, cachedInput: 1, output: 1 }, start: { at: '2026-10-02T00:00:00Z' }, finish: { at: '2026-10-02T00:10:00Z' } }
  writeFileSync(join(tasks, '.workflow-state.json'), JSON.stringify(workflow))
  writeFileSync(join(tasks, '.card-planners.json'), JSON.stringify(planners))
  writeFileSync(join(tasks, '.request-usage.json'), JSON.stringify({ version: 1, runs }))
  return { root, tasks, card }
}

async function startServer(root) {
  const port = await freePort()
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port, mode: 'auto', projectsRoot: root.replace(/\\/g, '/'), projects: ['Proj'],
    maxConcurrentAgents: 0, stallSeconds: 300, agentPollMs: 3600000,
    engine: { kind: 'codex' }, models: { working: 'test', review: 'test', issues: 'test' },
  }))
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-payload-test' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let log = ''
  child.stdout.on('data', d => { log += d }); child.stderr.on('data', d => { log += d })
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${base}/api/board?project=Proj`)).ok) break } catch {}
    if (i > 100 || child.exitCode !== null) throw new Error('server did not start\n' + log)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { child, base, log: () => log }
}

// Reads SSE events off one connection; `next()` resolves with the next parsed event.
async function sseClient(url) {
  const res = await fetch(url)
  const reader = res.body.getReader(), decoder = new TextDecoder()
  let buffer = '', queue = [], waiting = []
  // Only `board` events count; the `agents` event that follows a feed's first poll is not a change.
  const push = e => { if (e.event !== 'board') return; const w = waiting.shift(); w ? w(e) : queue.push(e) }
  ;(async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let at
      while ((at = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, at); buffer = buffer.slice(at + 2)
        const event = chunk.match(/^event: (.*)$/m)?.[1], data = chunk.match(/^data: (.*)$/m)?.[1]
        if (event) push({ event, data: JSON.parse(data) })
      }
    }
  })().catch(() => {})
  return {
    next: (ms = 3000) => new Promise((resolve, reject) => { if (queue.length) return resolve(queue.shift()); const t = setTimeout(() => { waiting = waiting.filter(w => w !== r); reject(new Error('no SSE event')) }, ms); const r = e => { clearTimeout(t); resolve(e) }; waiting.push(r) }),
    close: () => reader.cancel().catch(() => {}),
  }
}

test('F5 AC1/AC2: /api/board carries open cards only and /api/archive the archived ones with their usage', async () => {
  const b = board()
  const s = await startServer(b.root)
  try {
    const res = await fetch(`${s.base}/api/board?project=Proj`)
    const text = await res.text(), payload = JSON.parse(text)
    assert.ok(text.length < 300 * 1024, `open payload is ${Math.round(text.length / 1024)} KB`)
    assert.deepEqual(payload.board.queue.map(c => c.id), ['T-1', 'T-2'])
    assert.deepEqual(payload.board.working.map(c => c.id), ['T-3'])
    assert.deepEqual([payload.board.archive, payload.archiveCount], [[], 400])
    assert.deepEqual(Object.keys(payload.workflow), ['T-3'], 'archived workflow records stay out')
    assert.deepEqual(Object.keys(payload.cardUsage), ['T-3'])
    assert.deepEqual(Object.keys(payload.planners), [])
    assert.equal(typeof payload.version, 'number')
    const archive = await (await fetch(`${s.base}/api/archive?project=Proj`)).json()
    assert.equal(archive.archive.length, 400)
    assert.equal(archive.archive[0].column, 'archive')
    assert.equal(Object.keys(archive.cardUsage).length, 400)
    assert.equal(archive.cardUsage['T-101'].tokens.total, 1001)
    assert.equal(Object.keys(archive.workflow).length, 400)
    assert.equal(archive.cardUsage['T-3'], undefined, 'open cards are not repeated in the archive payload')
    assert.equal(archive.version, payload.version)
  } finally { s.child.kill(); rmSync(b.root, { recursive: true, force: true }) }
})

test('F5 AC3: one SSE board event per change carries the lane summary and version, never the cards', async () => {
  const b = board()
  const s = await startServer(b.root)
  let sse
  try {
    const before = await (await fetch(`${s.base}/api/board?project=Proj`)).json()
    sse = await sseClient(`${s.base}/api/events?project=Proj`)
    const first = await sse.next()
    assert.equal(first.event, 'board')
    assert.deepEqual([first.data.board, first.data.lanes.queue, first.data.archiveCount], [undefined, 2, 400])
    assert.equal(first.data.version, before.version)
    b.card('T-4', 'queue', 'open-four')
    const change = await sse.next(5000)
    assert.equal(change.event, 'board')
    assert.equal(change.data.board, undefined, 'the summary, not the payload')
    assert.ok(change.data.version > before.version)
    assert.equal(change.data.lanes.queue, 3)
    assert.equal(JSON.stringify(change.data).length < 1024, true)
    // Windows delivers the lane folder's own change event after the debounce has fired; a
    // broadcast whose payload equals the last one sent is dropped, so one change is one event.
    const extra = await sse.next(700).catch(() => null)
    assert.equal(extra, null, 'one event for one change, got ' + JSON.stringify(extra))
    const after = await (await fetch(`${s.base}/api/board?project=Proj`)).json()
    assert.deepEqual(after.board.queue.map(c => c.id), ['T-1', 'T-2', 'T-4'])
    assert.equal(after.version, change.data.version, 'the refetch serves the version the event named')
  } finally { sse?.close(); s.child.kill(); rmSync(b.root, { recursive: true, force: true }) }
})

test('F5 AC2 (UI): the Archive view loads /api/archive once per version and the menu count comes from archiveCount (mocked transport)', async () => {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
    const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
    const tokens = { uncachedInput: 100, cachedInput: 900, output: 50, total: 1050 }
    const archived = n => ({ id: `T-${n}`, title: `Archived ${n}`, column: 'archive', priority: 5, mtime: 1, createdAt: '2026-10-01T00:00:00Z', text: `# Archived ${n}` })
    const payload = { project: 'Proof', version: 7, columns: COLUMNS, archive: { key: 'archive', label: 'Archive' }, board: Object.fromEntries([...COLUMNS.map(c => c.key), 'archive'].map(k => [k, []])), archiveCount: 2, control: { paused: true }, config: { maxConcurrentAgents: 0, stallSeconds: 300 }, slotsFree: 0, bindings: {}, planners: {}, workflow: {}, holds: {}, retries: {}, herdrUp: true, agents: [], cardRuns: [], cardRunEligibility: {}, cardUsage: {} }
    let archiveCalls = 0
    await page.route('**/*', async route => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/board') return route.fulfill({ json: payload })
      if (path === '/api/archive') { archiveCalls++; return route.fulfill({ json: { project: 'Proof', version: 7, archive: [archived(8), archived(9)], cardUsage: { 'T-8': { tokens, unknown: 0, agents: [] } }, workflow: {}, planners: {} } }) }
      if (path === '/api/projects') return route.fulfill({ json: { projects: ['Proof'] } })
      if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: '' })
      const file = path === '/' ? 'index.html' : path.slice(1)
      if (['index.html', 'board.js', 'nz-time.js', 'dependency-hover.js', 'board.css'].includes(file)) return route.fulfill({ contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html', body: readFileSync(new URL('./public/' + file, import.meta.url), 'utf8') })
      return route.fulfill({ status: 404, body: '' })
    })
    await page.goto('http://localhost:18787/?project=Proof')
    await page.locator('#menu-archive').waitFor({ state: 'attached' })
    assert.equal(await page.locator('#menu-archive').innerText(), '2')
    assert.equal(archiveCalls, 0, 'the board load fetches no archive')
    await page.evaluate(() => document.querySelector('[data-view="archive"]').click())
    const grid = page.locator('.archive-grid .card')
    await grid.first().waitFor()
    assert.deepEqual(await grid.evaluateAll(cards => cards.map(c => c.dataset.id)), ['T-8', 'T-9'])
    assert.equal(archiveCalls, 1)
    await page.evaluate(() => document.querySelector('[data-view="board"]').click())
    await page.evaluate(() => document.querySelector('[data-view="archive"]').click())
    await page.locator('.archive-grid .card').first().waitFor()
    assert.equal(archiveCalls, 1, 'same version: no second archive fetch')
    assert.deepEqual(errors, [])
  } finally { await browser.close() }
})
