// node --test reliability-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { bind, readBindings, unbind } from './lib/bindings.mjs'
import { breakerState, recordSpawn, recordSpawnFailure, resetBreaker } from './lib/breaker.mjs'

test('corrupt binding state fails closed and is never overwritten by bind', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-bindings-'))
  const tasks = join(root, 'TASKS')
  mkdirSync(tasks)
  const path = join(tasks, '.board.json')
  writeFileSync(path, '{broken')
  try {
    assert.throws(() => readBindings(tasks), /cannot read bindings/)
    assert.throws(() => bind(tasks, 'T-1', { pane_id: 'p1' }), /cannot read bindings/)
    assert.equal(readFileSync(path, 'utf8'), '{broken')
  } finally { rmSync(root, { recursive: true, force: true }) }
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

test('only consecutive failures trip the breaker, and the trip cools down', () => {
  const project = 'reliability-proof'
  const t0 = 1_000_000
  resetBreaker(project)
  recordSpawnFailure({ project, cap: 3, now: t0, reason: 'boot' })
  recordSpawn({ project, now: t0 + 1 })
  recordSpawnFailure({ project, cap: 3, now: t0 + 2, reason: 'boot' })
  recordSpawnFailure({ project, cap: 3, now: t0 + 3, reason: 'boot' })
  assert.equal(breakerState(project, t0 + 3).breakerTripped, false)
  const state = recordSpawnFailure({ project, cap: 3, now: t0 + 4, reason: 'boot' })
  assert.equal(state.breakerTripped, true)
  assert.equal(state.count, 3)
  assert.equal(state.resetsAt, t0 + 4 + 10 * 60 * 1000)
  assert.equal(breakerState(project, state.resetsAt).breakerTripped, false)
  resetBreaker(project)
})

test('hkb rework uses explicit --tasks even when cwd belongs to another project', () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-rework-'))
  const tasks = join(root, 'board', 'TASKS')
  const cwd = join(root, 'other-project')
  mkdirSync(join(tasks, 'review'), { recursive: true })
  mkdirSync(cwd)
  writeFileSync(join(tasks, 'review', 'T-1-card.md'), '# T-1 — Card\n\n**Review feedback** old\n\n**Review feedback** older\n')
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), 'hkb.mjs'), '--tasks', tasks, 'rework', 'T-1', '[planning] omitted criterion'], { cwd, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(tasks, 'planning', 'T-1-card.md')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
