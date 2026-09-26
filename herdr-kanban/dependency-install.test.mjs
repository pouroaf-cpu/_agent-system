import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import { dependencyInstallHold, startDependencyInstall } from './lib/worktrees.mjs'

// Running installs are recorded beside the board config, so a restarted board can see them.
const stateDir = mkdtempSync(join(tmpdir(), 'hkb-deps-state-'))
process.env.KANBAN_CONFIG = join(stateDir, 'board.config.json')
process.on('exit', () => rmSync(stateDir, { recursive: true, force: true }))
const installsFile = join(stateDir, '.dependency-installs.json')
const sleeper = t => { const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)']); t.after(() => child.kill()); return { child, exited: new Promise(r => child.on('exit', r)) } }

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
  await tick()
  assert.deepEqual(f.calls, ['npm ci --no-audit --no-fund'])
  mkdirSync(join(f.folder, 'node_modules', 'dep'), { recursive: true }) // what a finished install leaves
  writeFileSync(join(f.folder, 'node_modules', 'dep', 'package.json'), '{}')
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

test('ENOTEMPTY install failures back off and retry instead of failing twice (I246, I248)', async t => {
  const f = fixture(t)
  const t0 = Date.now(), min = 60000
  f.hold({ now: t0 }); await tick()
  f.settle().fail(new Error('npm ci exited with code 1: ENOTEMPTY: directory not empty, rename')); await tick()
  assert.match(f.hold({ now: t0 + 1000 }), /^installing dependencies in .*ENOTEMPTY.*; retrying at \d{4}-/)
  assert.equal(f.calls.length, 1, 'waits for the backoff')
  f.hold({ now: t0 + 2 * min }); await tick()
  f.settle().fail(new Error('EPERM: operation not permitted, unlink')); await tick()
  assert.match(f.hold({ now: t0 + 3 * min }), /^installing dependencies in .*EPERM.*; retrying at /)
  assert.equal(f.calls.length, 2)
  assert.match(f.hold({ now: t0 + 4 * 60 * min }), /^dependency install kept failing in .* for 3 hours: EPERM/)
})

test('a hung install is killed after 20 minutes and frees the board-wide slot', async t => {
  const f = fixture(t)
  const { child, exited } = sleeper(t)
  const install = (dir, command, log, onStart) => { onStart(child.pid); return new Promise(() => {}) } // hangs forever
  const t0 = Date.now(), min = 60000
  assert.equal(f.hold({ install, now: t0 }), `installing dependencies in ${f.folder}`)
  await tick()
  assert.equal(JSON.parse(readFileSync(installsFile, 'utf8'))[Object.keys(JSON.parse(readFileSync(installsFile, 'utf8')))[0]].pid, child.pid, 'the running install is recorded')
  const other = mkdtempSync(join(tmpdir(), 'hkb-deps-other-')); t.after(() => rmSync(other, { recursive: true, force: true }))
  writeFileSync(join(other, 'package-lock.json'), '{}')
  let otherCalls = 0
  const otherInstall = () => { otherCalls++; return Promise.resolve() }
  assert.match(startDependencyInstall({ folder: other, tasksDir: f.folder, install: otherInstall, free: () => 20, now: t0 + 5 * min }), /queued behind another install/)
  assert.equal(f.hold({ install, now: t0 + 19 * min }), `installing dependencies in ${f.folder}`, 'an allowed wait while under the timeout')
  assert.match(f.hold({ install, now: t0 + 21 * min }), /^installing dependencies in .*timed out after 20 min.*; retrying at /)
  await exited // the whole process tree was killed
  assert.equal(startDependencyInstall({ folder: other, tasksDir: f.folder, install: otherInstall, free: () => 20, now: t0 + 21 * min }), `installing dependencies in ${other}`)
  await tick()
  assert.equal(otherCalls, 1, 'other installs proceed after the timeout')
})

test('after a board restart, an install still running in that folder is waited for, never doubled', async t => {
  const f = fixture(t)
  const { child, exited } = sleeper(t)
  // What the previous board process recorded before it was killed; its npm is still running.
  writeFileSync(installsFile, JSON.stringify({ previous: { folder: f.folder, pid: child.pid, startedAt: Date.now() } }))
  assert.match(f.hold(), /^installing dependencies in .*started before the board restarted/)
  assert.deepEqual(f.calls, [], 'no second npm ci in the same folder')
  child.kill(); await exited
  assert.equal(f.hold(), `installing dependencies in ${f.folder}`)
  await tick()
  assert.deepEqual(f.calls, ['npm ci --no-audit --no-fund'])
})

test('an install failure names the file-lock error from npm\'s log so the backoff treats it as transient (I266)', async () => {
  const { installFailure } = await import('./lib/worktrees.mjs')
  const { isTransient } = await import('./lib/transient.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'install-log-')), log = join(dir, 'install.log')
  try {
    writeFileSync(log, "npm error [Error: EPERM: operation not permitted, unlink 'x.node'] {\nnpm error   errno: -4048,\n")
    const err = installFailure('npm ci', 4294963248, log)
    assert.match(err.message, /\(EPERM\)/)
    assert.ok(isTransient(err))
    writeFileSync(log, 'npm error code ERESOLVE\n')
    assert.ok(!isTransient(installFailure('npm ci', 1, log)))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
