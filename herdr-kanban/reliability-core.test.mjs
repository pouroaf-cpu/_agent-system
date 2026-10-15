// node --test reliability-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { bind, readBindings, unbind, liveBindings, onBindingsAlert } from './lib/bindings.mjs'

// Audit 2026-10-15 F6 AC1: a truncated .board.json reads as empty with one alert; the
// callers that decide slots or rewrite the file still stop, so the file is never overwritten.
test('truncated binding state reads as empty with one alert and is never overwritten by bind', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-bindings-'))
  const tasks = join(root, 'TASKS')
  mkdirSync(tasks)
  const path = join(tasks, '.board.json')
  const alerts = []
  onBindingsAlert(message => alerts.push(message))
  try {
    bind(tasks, 'T-1', { pane_id: 'p1' })
    const whole = readFileSync(path, 'utf8')
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)))
    const truncated = readFileSync(path, 'utf8')
    assert.deepEqual(readBindings(tasks), {})
    assert.deepEqual(readBindings(tasks), {})
    assert.equal(alerts.length, 1, 'one alert for the file, not one per read')
    assert.match(alerts[0], /cannot read bindings at .*\.board\.json/)
    assert.throws(() => bind(tasks, 'T-2', { pane_id: 'p2' }), /cannot read bindings/)
    assert.throws(() => liveBindings(tasks, [{ pane_id: 'p1' }]), /cannot read bindings/)
    assert.equal(readFileSync(path, 'utf8'), truncated, 'the damaged file is kept for repair')
    writeFileSync(path, whole)
    assert.deepEqual(Object.keys(readBindings(tasks)), ['T-1'])
    writeFileSync(path, truncated)
    readBindings(tasks)
    assert.equal(alerts.length, 2, 'a file that parsed again alerts afresh when it breaks again')
  } finally {
    onBindingsAlert(message => console.error(message))
    rmSync(root, { recursive: true, force: true })
  }
})

test('binding mutations complete atomically without leaving temporary state', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-bindings-'))
  const tasks = join(root, 'TASKS')
  try {
    bind(tasks, 'T-1', { pane_id: 'p1' })
    bind(tasks, 'T-2', { pane_id: 'p2' })
    assert.deepEqual(Object.keys(readBindings(tasks)), ['T-1', 'T-2'])
    unbind(tasks, 'T-1')
    assert.deepEqual(Object.keys(readBindings(tasks)), ['T-2'])
    assert.equal(readdirSync(tasks).some((name) => name.endsWith('.tmp') || name === '.board.lock'), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('hkb rework uses explicit --tasks even when cwd belongs to another project', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-rework-'))
  const tasks = join(root, 'board', 'TASKS')
  const cwd = join(root, 'other-project')
  mkdirSync(join(tasks, 'review'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(tasks, 'review', 'T-1-card.md'), '# T-1 — Card\n\n**Review feedback** old\n\n**Review feedback** older\n')
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'hkb.mjs'), '--tasks', tasks, 'rework', 'T-1', '[planning] omitted criterion'], { cwd, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(tasks, 'planning', 'T-1-card.md')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
