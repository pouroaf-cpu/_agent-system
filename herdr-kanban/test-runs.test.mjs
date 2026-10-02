import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTestRuns, startTestRun, failedTests, staticAppRoutes } from './lib/test-runs.mjs'

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
