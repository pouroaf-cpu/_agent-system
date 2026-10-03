import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { startProjectPolling } from './lib/project-polling.mjs'

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms = 1500) {
  const end = Date.now() + ms
  while (!fn()) { if (Date.now() > end) assert.fail('Poll did not arrive'); await wait(10) }
}
function setup(t, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'board-watch-'))
  const tasksDirOf = project => join(root, project, 'TASKS')
  for (const project of ['one', 'two']) mkdirSync(join(tasksDirOf(project), 'queue'), { recursive: true })
  const agentsDir = join(root, '.agents'); mkdirSync(agentsDir)
  const rows = [{ id: 'headless-one', session: 'one', exitFile: join(agentsDir, 'headless-one.launch.json.exit.json') }]
  const save = () => writeFileSync(join(agentsDir, 'registry.json'), JSON.stringify(rows))
  save()
  const calls = [], watches = new Map(), errors = []
  const options = { projects: ['one', 'two'], tasksDirOf, agentsDir, sessionOf: p => p,
    poll: async p => { calls.push(p) }, onError: err => errors.push(err),
    watchFs: (dir, options, callback) => {
      assert.equal(options.recursive, true)
      const watcher = new EventEmitter(); watcher.close = () => {}
      watches.set(dir, { callback, watcher }); return watcher
    }, ...extra }
  const polling = startProjectPolling(options)
  t.after(() => { polling.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, tasksDirOf, agentsDir, rows, save, calls, watches, polling, errors,
    event: (dir, name, event = 'change') => watches.get(dir).callback(event, name) }
}

test('debounces only the owning project, ignores poll churn, defaults to a minute', async t => {
  const s = setup(t)
  assert.equal(s.polling.intervalMs, 60000)
  await wait(0); s.calls.length = 0
  const dir = s.tasksDirOf('one')
  for (const name of ['activity.log', 'stalls.log', '.request-usage.json', '.request-usage.json.tmp', '.board-heartbeat.json', '.board.lock']) {
    writeFileSync(join(dir, name), String(Date.now())); s.event(dir, name)
  }
  s.save(); s.event(s.agentsDir, 'registry.json')
  s.event(s.agentsDir, 'headless-one.log')
  await wait(350); assert.deepEqual(s.calls, [])
  for (let n = 0; n < 3; n++) {
    writeFileSync(join(dir, 'queue', 'T-1.md'), String(n))
    s.event(dir, Buffer.from('queue\\T-1.md'))
    await wait(30)
  }
  await until(() => s.calls.length === 1)
  assert.deepEqual(s.calls, ['one'])
  // The board's own state files (rewritten every poll) never trigger a poll.
  writeFileSync(join(dir, '.board.json'), '{}'); s.event(dir, '.board.json')
  s.event(dir, '.evidence/T-1/trace.json'); s.save(); s.event(s.agentsDir, 'registry.json')
  await wait(350); assert.equal(s.calls.length, 1)
  s.rows[0].closedAt = 'now'; s.save(); s.event(s.agentsDir, 'registry.json')
  await until(() => s.calls.length === 2)
  assert.equal(s.calls.at(-1), 'one')
  // A removed card might never have appeared in this watcher's content cache.
  s.event(dir, 'queue/T-99.md', 'rename')
  await until(() => s.calls.length === 3)
  assert.equal(s.calls.at(-1), 'one')
})

test('a change during a poll queues a follow-up without concurrent project polls', async t => {
  let release, active = 0, max = 0, count = 0, busy = 0
  const s = setup(t, { projects: ['one'], onBusy: () => busy++, poll: async () => {
    count++; max = Math.max(max, ++active)
    if (count === 1) await new Promise(resolve => { release = resolve })
    active--
  } })
  const dir = s.tasksDirOf('one')
  writeFileSync(join(dir, 'queue', 'T-1.md'), 'handoff'); s.event(dir, 'queue/T-1.md')
  await wait(350); assert.equal(count, 1)
  assert.equal(busy, 1)
  release()
  await until(() => count === 2)
  assert.equal(max, 1)
})

test('watch setup and runtime errors leave safety polling running', async t => {
  const s = setup(t, { agentPollMs: 40 })
  for (const { watcher } of s.watches.values()) watcher.emit('error', new Error('watch failed'))
  await until(() => s.calls.length >= 4)
  assert.equal(s.errors.length, 3)
  const fallback = setup(t, { watchFs: () => { throw new Error('unsupported') } })
  assert.equal(fallback.polling.intervalMs, 5000)
  assert.equal(fallback.errors.length, 3)
})

test('real recursive watch catches card rename and supervisor exit within a second', async t => {
  const s = setup(t, { watchFs: undefined })
  // Undefined uses Node's built-in watcher, including its recursive path handling.
  await wait(0); s.calls.length = 0
  const dir = s.tasksDirOf('two')
  writeFileSync(join(dir, 'queue', 'T-1.tmp'), 'new card')
  renameSync(join(dir, 'queue', 'T-1.tmp'), join(dir, 'queue', 'T-1.md'))
  await until(() => s.calls.includes('two'))
  s.calls.length = 0
  const spec = join(s.agentsDir, 'launch.json')
  writeFileSync(spec, JSON.stringify({ exe: process.execPath, args: ['-e', 'process.exit(0)'], cwd: s.root, exitFile: s.rows[0].exitFile }))
  const child = spawn(process.execPath, ['scripts/agent-process.mjs', spec], { cwd: import.meta.dirname, stdio: 'ignore', windowsHide: true })
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error(`supervisor exit ${code}`))) })
  const exitedAt = Date.now()
  await until(() => s.calls.includes('one'), 950)
  assert.ok(Date.now() - exitedAt < 1000)
  assert.deepEqual(s.calls, ['one'])
  assert.deepEqual(s.errors, [])
})
