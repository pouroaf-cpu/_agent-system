import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkBoardAlerts, ALERT_THRESHOLDS } from './lib/board-alerts.mjs'

test('board alerts fire at each threshold, persist cooldowns across restarts, and ignore quiet fixtures', async t => {
  mkdirSync(join(import.meta.dirname, 'tmp'), { recursive: true })
  const root = mkdtempSync(join(import.meta.dirname, 'tmp', 'board-alerts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let now = Date.parse('2026-10-03T12:00:00Z')
  t.mock.method(Date, 'now', () => now)
  let serial = 0
  const fixture = (records = {}, runs = []) => {
    const tasksDir = join(root, String(serial++), 'TASKS')
    mkdirSync(join(tasksDir, '.history'), { recursive: true })
    mkdirSync(join(tasksDir, 'e2e'))
    for (const [card, events] of Object.entries(records)) writeFileSync(join(tasksDir, '.history', card + '.jsonl'),
      events.map(e => JSON.stringify({ at: new Date(now - 1000).toISOString(), ...e })).join('\n') + '\nnot json\n')
    writeFileSync(join(tasksDir, 'e2e', 'runs.jsonl'), runs.map(run => JSON.stringify(run)).join('\n'))
    const pushes = [], lines = [], inboxPath = join(tasksDir, 'inbox.md')
    const options = { project: 'Fixture', tasksDir, inboxPath, send: async (...args) => pushes.push(args),
      append: (path, line) => { assert.equal(path, inboxPath); lines.push(line); appendFileSync(path, line) } }
    return { tasksDir, pushes, lines, options }
  }
  const repeat = (event, count, extra = {}) => Array.from({ length: count }, () => ({ event, ...extra }))
  const kick = count => repeat('failure', count, { stage: 'working' })
  const plan = count => repeat('plan-check', count, { verdict: 'FAIL' })
  const reportPath = join(root, 'report.json')
  writeFileSync(reportPath, JSON.stringify({ suites: [{ specs: [{ file: 'a.spec.ts', title: 'broken', tests: [{ status: 'unexpected' }] }] }] }))
  const nightly = { type: 'nightly', failures: ['a.spec.ts › broken'] }
  for (const [records, runs, expected] of [
    [{ 'T-1': kick(3).map(e => ({ ...e, at: new Date(now - 2 * 3600000).toISOString() })) }, [], /builder-kick-back: 3.*T-1/],
    [{ 'T-2': plan(3) }, [], /plan-check-fail: 3.*T-2/],
    [{ 'T-1': kick(2), 'T-2': kick(2), 'T-3': kick(1) }, [], /burst: 5.*T-1, T-2, T-3/],
    [{ 'T-4': repeat('builder-delivery-failed', 3) }, [], /builder-delivery-failed burst: 3.*T-4/],
    [{ 'T-5': repeat('builder-no-handoff', 3) }, [], /builder-no-handoff burst: 3.*T-5/],
    [{}, [nightly, { type: 'axe', failures: [] }, { ...nightly, report: reportPath, failures: [] }], /a.spec.ts › broken.*2 consecutive/],
  ]) {
    const f = fixture(records, runs)
    assert.equal((await checkBoardAlerts({ ...f.options, now })).length, 1)
    assert.equal(f.pushes.length, 1)
    assert.equal(f.pushes[0][0], 'Board alert: Fixture')
    assert.match(f.pushes[0][1], expected)
    assert.equal(f.lines.length, 1)
    assert.match(f.lines[0], /^- 2026-10-03T12:00:00.000Z ALERT Fixture /)
    assert.match(f.lines[0], expected)
    assert.equal(f.lines[0].split('\n').length, 2)
    assert.deepEqual(await checkBoardAlerts({ ...f.options, now: now + ALERT_THRESHOLDS.dedupeMs - 1 }), [])
    // A fresh Node process cannot fall back on module memory for deduplication.
    execFileSync(process.execPath, ['--input-type=module', '-e',
      "import { checkBoardAlerts } from './lib/board-alerts.mjs'; await checkBoardAlerts({ project: 'Fixture', tasksDir: process.argv[1], now: Number(process.argv[2]), send: () => { throw Error('duplicate push') }, append: () => { throw Error('duplicate inbox') } })",
      f.tasksDir, String(now)], { cwd: import.meta.dirname })
    assert.equal(f.pushes.length, 1)
    assert.equal(Object.keys(JSON.parse(readFileSync(join(f.tasksDir, '.board-alerted.json')))).length, 1)
  }
  for (const [records, runs] of [
    [{ 'T-1': kick(2), 'T-2': kick(2), 'T-3': plan(2), 'T-4': repeat('builder-delivery-failed', 2), 'T-5': repeat('builder-no-handoff', 2) }, []],
    [{ 'T-1': [...kick(3), ...plan(3)].map(e => ({ ...e, at: new Date(now - ALERT_THRESHOLDS.cardWindowMs - 1).toISOString() })) }, []],
    [{ 'T-1': kick(3).map(e => ({ ...e, stage: 'review' })), 'T-2': repeat('plan-check', 3, { verdict: 'PASS' }), 'T-3': repeat('plan-check', 3, { verdict: 'RETRY' }) }, []],
    [{ 'T-1': repeat('builder-no-handoff', 3, { at: new Date(now + 1).toISOString() }) }, []],
    [{}, [nightly, { type: 'nightly', failures: [] }, nightly]],
    [{}, [nightly]],
  ]) {
    const f = fixture(records, runs)
    assert.deepEqual(await checkBoardAlerts({ ...f.options, now }), [])
    assert.equal(f.pushes.length + f.lines.length, 0)
  }
  const f = fixture({ 'T-1': plan(2) })
  assert.deepEqual(await checkBoardAlerts({ ...f.options, now }), [])
  appendFileSync(join(f.tasksDir, '.history', 'T-1.jsonl'), JSON.stringify({ at: new Date(now).toISOString(), event: 'plan-check', verdict: 'FAIL' }) + '\n')
  now += 5001 // the shared history cache refreshes on the next poll
  assert.equal((await checkBoardAlerts({ ...f.options, now })).length, 1)
  now += ALERT_THRESHOLDS.dedupeMs
  assert.equal((await checkBoardAlerts({ ...f.options, now })).length, 0, 'a stuck card alerts once a day, not hourly')
  assert.equal(f.pushes.length, 1)
  // Notification failure still attempts both channels and never repeats ambiguous sends.
  const broken = fixture({ 'T-1': plan(3) })
  let attempts = 0
  await assert.rejects(checkBoardAlerts({ ...broken.options, now, append: () => { throw Error('inbox unavailable') }, send: () => { attempts++; throw Error('push timeout') } }), /inbox unavailable; push timeout/)
  assert.equal(attempts, 1)
  assert.deepEqual(await checkBoardAlerts({ ...broken.options, now }), [])
})
