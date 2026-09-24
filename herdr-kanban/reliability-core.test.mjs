// node --test reliability-core.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { bind, readBindings, unbind } from './lib/bindings.mjs'

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
