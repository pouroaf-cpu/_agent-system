import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { dependencyInstallHold } from './lib/worktrees.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'hkb-deps-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const folder = join(root, 'integration'), tasksDir = join(root, 'TASKS')
  mkdirSync(folder); mkdirSync(tasksDir)
  writeFileSync(join(folder, 'package.json'), '{"dependencies":{"dep":"1"}}')
  writeFileSync(join(folder, 'package-lock.json'), '{}')
  spawnSync('git', ['-C', folder, 'init'])
  const calls = []
  let settle
  const install = (dir, command) => { calls.push(command); return new Promise((ok, fail) => { settle = { ok, fail } }) }
  const hold = (extra = {}) => dependencyInstallHold({ card: { id: 'T-1' }, projectPath: folder, tasksDir, install, free: () => 20, ...extra })
  return { folder, calls, hold, settle: () => settle }
}
const tick = () => new Promise(r => setImmediate(r))

test('a missing node_modules starts one background install; the card waits, then starts', async t => {
  const f = fixture(t)
  assert.equal(f.hold(), `installing dependencies in ${f.folder}`)
  await tick()
  assert.equal(f.hold(), `installing dependencies in ${f.folder}`, 'still running: no second install')
  assert.deepEqual(f.calls, ['npm ci --no-audit --no-fund'])
  mkdirSync(join(f.folder, 'node_modules'))
  f.settle().ok(); await tick()
  assert.equal(f.hold(), null)
})

test('low disk goes to Owner without installing', t => {
  const f = fixture(t)
  assert.match(f.hold({ free: () => 2.34 }), /has only 2\.3 GB free; free up space so dependencies can install$/)
  assert.deepEqual(f.calls, [])
})

test('a failed install retries once, then holds for Owner with the reason', async t => {
  const f = fixture(t)
  f.hold(); await tick()
  f.settle().fail(new Error('ERESOLVE')); await tick()
  assert.match(f.hold(), /^installing dependencies in .* \(retry after: ERESOLVE\)$/)
  await tick()
  f.settle().fail(new Error('ERESOLVE again')); await tick()
  assert.equal(f.hold(), `dependency install failed twice in ${f.folder}: ERESOLVE again`)
  assert.equal(f.calls.length, 2)
})
