import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestRuns, startTestRun, failedTests, staticAppRoutes, addRequest, listRequests, dueRequest, busyRequest, pageResults, pageHistory, pageRuns } from './lib/test-runs.mjs'

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

test('derives per-page results from nested titles, with any unexpected test failing the route', () => {
  const spec = (title, ...statuses) => ({ title, tests: statuses.map(status => ({ status })) })
  const report = { suites: [{ specs: [spec('/', 'expected'), spec('checks /about-us', 'unexpected'), spec('unrelated test', 'unexpected')],
    suites: [{ specs: [spec('console errors on /calendar', 'expected', 'flaky'), spec('/calendar', 'unexpected'),
      spec('/about-us', 'expected'), spec('checks "/about" on phone', 'expected'), spec('/empty')] }] }] }
  assert.deepEqual(pageResults(report, ['/', '/about', '/about-us', '/calendar', '/empty', '/missing']),
    { '/': 'pass', '/about-us': 'fail', '/calendar': 'fail', '/about': 'pass' })
  assert.deepEqual(pageResults({ suites: [{ specs: [spec('/calendar/details', 'unexpected')] }] }, ['/', '/calendar']), {})
  assert.deepEqual(pageResults({}, ['/']), {})
})

test('page history keeps the latest per route and type, ignoring old lines and retaining unknown types', () => {
  const older = { type: 'nightly', finished: '2026-10-01T00:00:00Z', report: 'old.json', head: 'a', pages: { '/': 'fail', '/about': 'pass' } }
  const newer = { ...older, finished: '2026-10-02T00:00:00Z', report: 'new.json', head: 'b', pages: { '/': 'pass' } }
  const custom = { ...newer, type: 'future-type', pages: { '/': 'fail' } }
  const audit = { ...newer, type: 'axe', pages: { '/about': 'fail' } }
  const runs = [older, custom, { finished: '2026-10-03T00:00:00Z' }, newer, audit, { pages: { '/': 'fail' } }]
  assert.deepEqual(pageHistory(runs), [
    { route: '/', types: { nightly: { status: 'pass', finished: newer.finished, report: 'new.json' }, 'future-type': { status: 'fail', finished: newer.finished, report: 'new.json' } } },
    { route: '/about', types: { nightly: { status: 'pass', finished: older.finished, report: 'old.json' }, axe: { status: 'fail', finished: newer.finished, report: 'new.json' } } },
  ])
  assert.deepEqual(pageRuns(runs, '/').map(({ head, type, status }) => ({ head, type, status })), [
    { head: 'b', type: 'future-type', status: 'fail' }, { head: 'b', type: 'nightly', status: 'pass' }, { head: 'a', type: 'nightly', status: 'fail' },
  ])
  assert.deepEqual(pageRuns(runs, '/missing'), [])
  assert.deepEqual(pageHistory([]), [])
})

test('full history is available beyond the recent-run limit', () => {
  const tasks = mkdtempSync(join(tmpdir(), 'page-runs-')), dir = join(tasks, 'e2e')
  mkdirSync(dir)
  const runs = Array.from({ length: 21 }, (_, i) => ({ type: 'nightly', finished: new Date(i * 1000).toISOString(), pages: { [i ? '/recent' : '/older']: 'pass' } }))
  writeFileSync(join(dir, 'runs.jsonl'), runs.map(run => JSON.stringify(run)).join('\n'))
  assert.equal(readTestRuns(tasks).runs.length, 20)
  assert.equal(pageHistory(readTestRuns(tasks, { limit: Infinity }).runs).length, 2)
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
