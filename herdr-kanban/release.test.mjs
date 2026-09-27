import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { releaseWaiting, finishRelease } from './lib/release.mjs'
import { createCard, moveCard } from './lib/cards.mjs'
import { bind } from './lib/bindings.mjs'
import { updateWorktree } from './lib/worktrees.mjs'
import { controlState, setProjectPaused } from './lib/project-control.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
  if (r.status) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

// A bare origin, a developer clone that releases kanban-integration into master, and
// the board's integration clone on kanban-integration.
function repos(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const origin = join(root, 'origin.git'), dev = join(root, 'dev'), integ = join(root, 'integ')
  spawnSync('git', ['init', '--bare', '-b', 'master', origin])
  spawnSync('git', ['clone', origin, dev])
  for (const cwd of [dev]) { git(cwd, 'config', 'user.email', 't@t'); git(cwd, 'config', 'user.name', 't') }
  writeFileSync(join(dev, 'a.txt'), 'one\n'); git(dev, 'add', '.'); git(dev, 'commit', '-m', 'init'); git(dev, 'push', 'origin', 'master')
  git(dev, 'checkout', '-b', 'kanban-integration')
  writeFileSync(join(dev, 'b.txt'), 'card\n'); git(dev, 'add', '.'); git(dev, 'commit', '-m', 'card'); git(dev, 'push', 'origin', 'kanban-integration')
  spawnSync('git', ['clone', '-b', 'kanban-integration', origin, integ])
  git(integ, 'config', 'user.email', 't@t'); git(integ, 'config', 'user.name', 't')
  // The release: optional sitemap commit on kanban-integration, then a --no-ff merge into master.
  writeFileSync(join(dev, 'sitemap.xml'), '<urlset/>\n'); git(dev, 'add', '.'); git(dev, 'commit', '-m', 'sitemap'); git(dev, 'push', 'origin', 'kanban-integration')
  git(dev, 'checkout', 'master'); git(dev, 'merge', '--no-ff', 'kanban-integration', '-m', 'release'); git(dev, 'push', 'origin', 'master')
  const release = git(dev, 'rev-parse', 'HEAD')
  return { root, origin, dev, integ, release }
}

test('finish fast-forwards the integration checkout to the released master commit', t => {
  const r = repos(t)
  const short = finishRelease({ integrationPath: r.integ, commit: r.release })
  assert.equal(git(r.integ, 'rev-parse', 'HEAD'), r.release)
  assert.equal(git(r.integ, 'branch', '--show-current'), 'kanban-integration')
  assert.equal(short, git(r.integ, 'rev-parse', '--short', 'HEAD'))
})

test('finish refuses a dirty checkout, an unreleased commit, a diverged HEAD and a missing checkout, changing nothing', t => {
  const r = repos(t)
  const before = git(r.integ, 'rev-parse', 'HEAD')
  writeFileSync(join(r.integ, 'b.txt'), 'local edit\n')
  assert.throws(() => finishRelease({ integrationPath: r.integ, commit: r.release }), /uncommitted changes/)
  git(r.integ, 'checkout', '--', 'b.txt')

  git(r.dev, 'checkout', '-b', 'side'); writeFileSync(join(r.dev, 'c.txt'), 'side\n'); git(r.dev, 'add', '.'); git(r.dev, 'commit', '-m', 'side'); git(r.dev, 'push', 'origin', 'side')
  assert.throws(() => finishRelease({ integrationPath: r.integ, commit: git(r.dev, 'rev-parse', 'HEAD') }), /not on origin\/master/)
  assert.throws(() => finishRelease({ integrationPath: r.integ, commit: 'deadbeefdeadbeef' }), /not found/)

  writeFileSync(join(r.integ, 'd.txt'), 'integrated after release\n'); git(r.integ, 'add', '.'); git(r.integ, 'commit', '-m', 'late card')
  const diverged = git(r.integ, 'rev-parse', 'HEAD')
  assert.throws(() => finishRelease({ integrationPath: r.integ, commit: r.release }), /not an ancestor/)
  assert.equal(git(r.integ, 'rev-parse', 'HEAD'), diverged)
  assert.notEqual(before, r.release)

  const plain = join(r.root, 'plain'); mkdirSync(plain)
  assert.throws(() => finishRelease({ integrationPath: plain, commit: r.release }), /no git integration checkout/i)
  assert.throws(() => finishRelease({ integrationPath: undefined, commit: r.release }), /no git integration checkout/i)
})

test('readiness waits on a working Builder, an unintegrated Completed card and a running integration', t => {
  const root = mkdtempSync(join(tmpdir(), 'release-ready-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tasksDir = join(root, 'TASKS')
  assert.deepEqual(releaseWaiting({ tasksDir, agents: [], herdrUp: true, integrating: false }), [])
  assert.match(releaseWaiting({ tasksDir, agents: [], herdrUp: false }).join(), /herdr/)
  assert.match(releaseWaiting({ tasksDir, agents: [], herdrUp: true, integrating: true }).join(), /integrat/)

  const building = createCard(tasksDir, { title: 'building', brief: 'b' })
  moveCard(tasksDir, building.id, 'working')
  bind(tasksDir, building.id, { pane_id: 'p1' })
  assert.match(releaseWaiting({ tasksDir, agents: [{ pane_id: 'p1', agent_status: 'working' }], herdrUp: true }).join(), new RegExp(building.id))
  // An idle bound Builder is not building; the drain poll routes it.
  assert.deepEqual(releaseWaiting({ tasksDir, agents: [{ pane_id: 'p1', agent_status: 'idle' }], herdrUp: true }), [])

  const done = createCard(tasksDir, { title: 'done', brief: 'd' })
  writeFileSync(done.path, readFileSync(done.path, 'utf8').replace('**Trivial:** no', '**Trivial:** yes'))
  moveCard(tasksDir, done.id, 'completed')
  updateWorktree(tasksDir, done.id, { cardId: done.id, state: 'ready' })
  assert.match(releaseWaiting({ tasksDir, agents: [], herdrUp: true }).join(), new RegExp(`${done.id}.*not integrated`))
  updateWorktree(tasksDir, done.id, { state: 'integrated' })
  assert.deepEqual(releaseWaiting({ tasksDir, agents: [], herdrUp: true }), [])
})

test('release endpoints: start pauses with a marker, finish fast-forwards and unpauses, abort unpauses', async t => {
  const r = repos(t)
  const root = mkdtempSync(join(tmpdir(), 'release-server-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const p of ['Proof', 'Plain']) mkdirSync(join(root, p, 'TASKS'), { recursive: true })
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ port: 18791, projectsRoot: root, projects: ['Proof', 'Plain'], maxConcurrentAgents: 1, models: { working: 'test' }, agentPollMs: 600000,
    projectSettings: { Proof: { integrationPath: r.integ } } }))
  const child = spawn(process.execPath, [join(here, 'server.mjs')], { cwd: here, env: { ...process.env, KANBAN_CONFIG: config, HERDR_BIN_PATH: 'nonexistent-release-test-herdr' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  t.after(() => { if (child.exitCode === null) child.kill() })
  // The config port is only where server.mjs starts looking: another test run may hold it.
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server startup timeout')), 30000)
    child.stdout.on('data', bytes => { const port = String(bytes).match(/127\.0\.0\.1:(\d+)/)?.[1]; if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`) } })
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`test server exited ${code}`)) })
  })
  const post = (path, body) => fetch(`${base}/api/release/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async res => ({ status: res.status, ...await res.json() }))
  const board = p => fetch(`${base}/api/board?project=${p}`).then(res => res.json())

  const noMarker = await post('finish', { project: 'Proof', commit: r.release })
  assert.equal(noMarker.status, 400); assert.match(noMarker.error, /no release in progress/i)
  assert.equal((await post('abort', { project: 'Proof' })).status, 400)

  const started = await post('start', { project: 'Proof' })
  assert.equal(started.status, 200); assert.equal(started.ok, true); assert.equal(started.ready, false)
  assert.match(started.waiting.join(), /herdr/) // no herdr in this test: readiness cannot be confirmed
  const shown = await board('Proof')
  assert.equal(shown.control.paused, true); assert.ok(shown.release.startedAt)
  assert.equal((await post('start', { project: 'Proof' })).status, 200)
  assert.equal((await board('Proof')).release.startedAt, shown.release.startedAt)

  writeFileSync(join(r.integ, 'b.txt'), 'dirty\n')
  const dirty = await post('finish', { project: 'Proof', commit: r.release })
  assert.equal(dirty.status, 400); assert.match(dirty.error, /uncommitted changes/)
  assert.equal((await board('Proof')).control.paused, true)
  git(r.integ, 'checkout', '--', 'b.txt')

  const finished = await post('finish', { project: 'Proof', commit: r.release })
  assert.equal(finished.status, 200); assert.equal(finished.integration, git(r.integ, 'rev-parse', '--short', 'HEAD'))
  assert.equal(git(r.integ, 'rev-parse', 'HEAD'), r.release)
  const after = await board('Proof')
  assert.equal(after.control.paused, false); assert.equal(after.release, null)

  await post('start', { project: 'Plain' })
  const plain = await post('finish', { project: 'Plain', commit: r.release })
  assert.equal(plain.status, 400); assert.match(plain.error, /no git integration checkout/i)
  const aborted = await post('abort', { project: 'Plain' })
  assert.equal(aborted.status, 200); assert.equal(aborted.control.paused, false)
  assert.equal((await board('Plain')).release, null)
})

test('a plain Pause keeps an active release marker; Start clears it', t => {
  const root = mkdtempSync(join(tmpdir(), 'release-control-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, 'board.config.json')
  writeFileSync(config, JSON.stringify({ projects: ['Proof'], maxConcurrentAgents: 1 }))
  setProjectPaused('Proof', true, config, { release: { startedAt: 'then' } })
  setProjectPaused('Proof', true, config)
  assert.equal(controlState('Proof', config).release.startedAt, 'then')
  setProjectPaused('Proof', false, config)
  assert.equal(controlState('Proof', config).release, undefined)
})
