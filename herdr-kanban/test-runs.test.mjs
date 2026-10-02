import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestRuns, startTestRun, failedTests, staticAppRoutes, addRequest, listRequests, dueRequest, busyRequest } from './lib/test-runs.mjs'

test('reads runs newest first, skips bad lines, drops a dead running marker', () => {
  const tasks = mkdtempSync(join(tmpdir(), 'test-runs-')), dir = join(tasks, 'e2e')
  mkdirSync(dir)
  assert.deepEqual(readTestRuns(tasks), { running: null, runs: [] })
  writeFileSync(join(dir, 'runs.jsonl'), '{"head":"a","failed":0}\nnot json\n{"head":"b","failed":2}\n')
  writeFileSync(join(dir, 'running.json'), JSON.stringify({ pid: 999999, started: 'x', head: 'c' }))
  assert.deepEqual(readTestRuns(tasks), { running: null, runs: [{ head: 'b', failed: 2 }, { head: 'a', failed: 0 }] })
  writeFileSync(join(dir, 'running.json'), JSON.stringify({ pid: process.pid, started: 'x', head: 'c' }))
  assert.equal(readTestRuns(tasks).running.head, 'c')
  assert.throws(() => startTestRun({ project: 'Injectbuddy', tasksDir: tasks, boardDir: '.' }), /already going/)
  assert.throws(() => startTestRun({ project: 'Nope', tasksDir: tasks, boardDir: '.' }), /no test runner/)
})

test('lists failed tests from a nested Playwright JSON report', () => {
  const report = { suites: [{ specs: [{ file: 'a.spec.ts', title: 'ok', tests: [{ status: 'expected' }] }],
    suites: [{ specs: [{ file: 'a.spec.ts', title: 'breaks', tests: [{ status: 'unexpected', projectName: 'phone' }, { status: 'flaky' }] }] }] }] }
  assert.deepEqual(failedTests(report), ['a.spec.ts › breaks [phone]'])
})

test('lists static app routes for warming, skipping dynamic and private folders', () => {
  const app = mkdtempSync(join(tmpdir(), 'app-'))
  for (const p of ['', 'calendar', '(marketing)/about', 'guides/[slug]', '_lib', 'api/x']) mkdirSync(join(app, p), { recursive: true })
  for (const p of ['page.tsx', 'calendar/page.tsx', '(marketing)/about/page.tsx', 'guides/[slug]/page.tsx', '_lib/page.tsx', 'api/x/route.ts']) writeFileSync(join(app, p), '')
  assert.deepEqual(staticAppRoutes(app), ['/', '/about', '/calendar'])
})

test('validates requests and picks the oldest due scheduled request', () => {
  const tasks = mkdtempSync(join(tmpdir(), 'test-requests-')), app = join(tasks, 'app')
  mkdirSync(app); writeFileSync(join(app, 'page.tsx'), '')
  const input = { type: 'console-errors', pages: ['/'], at: '2026-10-02T10:00:00Z' }
  assert.deepEqual(listRequests(tasks), [])
  assert.equal(dueRequest(tasks), null)
  assert.throws(() => addRequest(tasks, { ...input, type: 'nope' }, app), /Unknown.*type/)
  assert.throws(() => addRequest(tasks, { ...input, type: 'toString' }, app), /Unknown.*type/)
  assert.throws(() => addRequest(tasks, { ...input, pages: [] }, app), /at least one page/)
  assert.throws(() => addRequest(tasks, { ...input, pages: ['/missing'] }, app), /Unknown page/)
  assert.throws(() => addRequest(tasks, { ...input, at: 'nope' }, app), /Invalid date/)
  const later = addRequest(tasks, input, app)
  const oldest = addRequest(tasks, { ...input, at: '2026-10-02T09:00:00Z' }, app)
  addRequest(tasks, { ...input, at: '2026-10-03T09:00:00Z' }, app)
  const finished = addRequest(tasks, { ...input, at: '2026-10-01T09:00:00Z' }, app)
  finished.state = 'done'
  writeFileSync(join(tasks, 'test-lab', 'requests', finished.id + '.json'), JSON.stringify(finished))
  assert.equal(dueRequest(tasks, '2026-10-02T10:00:00Z').id, oldest.id)
  oldest.state = 'writing'
  oldest.pid = 999999 // dead: does not block
  writeFileSync(join(tasks, 'test-lab', 'requests', oldest.id + '.json'), JSON.stringify(oldest))
  assert.equal(dueRequest(tasks, '2026-10-02T10:00:00Z').id, later.id)
  assert.equal(busyRequest(tasks), null)
  oldest.pid = process.pid
  writeFileSync(join(tasks, 'test-lab', 'requests', oldest.id + '.json'), JSON.stringify(oldest))
  assert.equal(busyRequest(tasks).id, oldest.id)
  assert.throws(() => startTestRun({ project: 'Injectbuddy', tasksDir: tasks, boardDir: '.' }), /already going/)
})
