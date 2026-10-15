import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, symlinkSync } from 'node:fs'
import { join, parse, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { applyDiskReading, pruneAgentLogs, npmCacheDir, diskWatchRoots, DISK_LOW_GB, DISK_RESUME_GB, AGENT_LOG_KEEP_MS } from './lib/disk-guard.mjs'
import { sweepCleanedCaches, sweepUnregisteredFolders } from './lib/worktrees.mjs'

test('disk floor: pauses under 6 GB, resumes above 8 GB, and holds in between', () => {
  assert.equal(DISK_LOW_GB, 6)
  assert.equal(DISK_RESUME_GB, 8)
  let state = { low: false }
  state = applyDiskReading(state, 20)
  assert.deepEqual(state, { low: false, event: 'none' })
  state = applyDiskReading(state, 5.9)
  assert.deepEqual(state, { low: true, event: 'low' })
  // Once low, further samples under the resume mark raise no new alert.
  state = applyDiskReading(state, 0.1)
  assert.deepEqual(state, { low: true, event: 'none' })
  state = applyDiskReading(state, 7.5)
  assert.deepEqual(state, { low: true, event: 'none' })
  state = applyDiskReading(state, 8.5)
  assert.deepEqual(state, { low: false, event: 'resume' })
})

test('headless log prune: removes old finished logs, keeps running, recent and unrelated files', () => {
  const now = Date.parse('2026-10-16T00:00:00Z')
  const root = mkdtempSync(join(tmpdir(), 'disk-guard-agents-'))
  const old = new Date(now - AGENT_LOG_KEEP_MS - 60000), fresh = new Date(now - 60000)
  const make = (name, when) => { writeFileSync(join(root, name), 'x'.repeat(10)); utimesSync(join(root, name), when, when) }
  make('headless-done.log', old)
  make('headless-done.exit.json', old)
  make('headless-running.log', old)
  make('headless-recent.log', fresh)
  make('notes.txt', old)
  writeFileSync(join(root, 'registry.json'), JSON.stringify([
    { id: 'done', log: join(root, 'headless-done.log'), exitFile: join(root, 'headless-done.exit.json'), endedAt: '2026-10-01T00:00:00Z' },
    { id: 'running', log: join(root, 'headless-running.log'), exitFile: null, endedAt: null },
  ]))
  const result = pruneAgentLogs({ root, now })
  assert.equal(result.skipped, false)
  assert.equal(result.removed, 2)
  assert.equal(result.bytes, 20)
  assert.equal(existsSync(join(root, 'headless-done.log')), false)
  assert.equal(existsSync(join(root, 'headless-done.exit.json')), false)
  assert.equal(existsSync(join(root, 'headless-running.log')), true)
  assert.equal(existsSync(join(root, 'headless-recent.log')), true)
  assert.equal(existsSync(join(root, 'notes.txt')), true)
  assert.equal(existsSync(join(root, 'registry.json')), true)
})

test('headless log prune: a registry that will not parse deletes nothing', () => {
  const now = Date.parse('2026-10-16T00:00:00Z')
  const root = mkdtempSync(join(tmpdir(), 'disk-guard-corrupt-'))
  const old = new Date(now - AGENT_LOG_KEEP_MS - 60000)
  writeFileSync(join(root, 'headless-old.log'), 'x'); utimesSync(join(root, 'headless-old.log'), old, old)
  writeFileSync(join(root, 'registry.json'), '{ torn')
  assert.deepEqual(pruneAgentLogs({ root, now }), { skipped: true, removed: 0, bytes: 0 })
  assert.equal(existsSync(join(root, 'headless-old.log')), true)
})

test('cache sweep: deletes node_modules and .next of cleaned integrated card checkouts only', () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'disk-guard-sweep-'))
  const repo = join(tasksDir, '.worktrees', 'Proj', 'integration')
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  const card = (name) => {
    const root = join(tasksDir, '.worktrees', 'Proj', 'cards', name)
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true })
    mkdirSync(join(root, '.next', 'cache'), { recursive: true })
    writeFileSync(join(root, 'source.txt'), 'kept')
    return root
  }
  const cleaned = card('a'), live = card('b'), building = card('c'), outside = join(tasksDir, 'elsewhere')
  mkdirSync(join(outside, 'node_modules'), { recursive: true })
  const entry = (cardId, worktreePath, patch) => ({ cardId, repoRoot: repo, integrationWorkspace: repo, worktreePath, state: 'integrated', cleaned: true, ...patch })
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({
    A1: entry('A1', cleaned),
    B1: entry('B1', live, { cleaned: false }),
    C1: entry('C1', building, { state: 'building', cleaned: false }),
    D1: entry('D1', outside),
    E1: entry('E1', repo),
  }))
  const freed = sweepCleanedCaches(tasksDir)
  assert.equal(freed.length, 2)
  assert.equal(existsSync(join(cleaned, 'node_modules')), false)
  assert.equal(existsSync(join(cleaned, '.next')), false)
  assert.equal(existsSync(join(cleaned, 'source.txt')), true)
  assert.equal(existsSync(join(live, 'node_modules')), true)
  assert.equal(existsSync(join(building, 'node_modules')), true)
  assert.equal(existsSync(join(outside, 'node_modules')), true)
  assert.equal(existsSync(join(repo, 'node_modules')), true)
})

test('npm cache dir: env wins, then the user .npmrc cache line, then npm default', () => {
  const home = mkdtempSync(join(tmpdir(), 'disk-guard-npmrc-'))
  assert.equal(npmCacheDir({ env: { npm_config_cache: 'D:/env-cache' }, home, platform: 'win32' }), 'D:/env-cache')
  assert.equal(npmCacheDir({ env: {}, home, platform: 'win32' }), join(home, 'AppData', 'Local', 'npm-cache'))
  assert.equal(npmCacheDir({ env: {}, home, platform: 'linux' }), join(home, '.npm'))
  writeFileSync(join(home, '.npmrc'), 'registry=https://example.test/\r\n  cache = "F:/npm-cache"  \r\n')
  assert.equal(npmCacheDir({ env: {}, home, platform: 'win32' }), 'F:/npm-cache')
})

test('disk roots: a junction onto the same drive and a missing projects root each give one root', () => {
  const base = mkdtempSync(join(tmpdir(), 'disk-guard-roots-'))
  const home = join(base, 'home')
  mkdirSync(home)
  const target = join(base, 'target')
  mkdirSync(target)
  const projects = join(base, 'projects')
  symlinkSync(target, projects, 'junction')
  const root = parse(resolve(base)).root
  assert.deepEqual(diskWatchRoots(projects, { env: {}, home, platform: process.platform }), [root])
  assert.deepEqual(diskWatchRoots(join(base, 'missing'), { env: {}, home, platform: process.platform }), [root])
})

test('cache sweep: at most `limit` checkouts per call', () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'disk-guard-limit-'))
  const registry = {}
  for (let i = 0; i < 4; i++) {
    const root = join(tasksDir, '.worktrees', 'Proj', 'cards', `c${i}`)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    registry[`X${i}`] = { cardId: `X${i}`, repoRoot: join(tasksDir, 'repo'), worktreePath: root, state: 'integrated', cleaned: true }
  }
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify(registry))
  assert.equal(sweepCleanedCaches(tasksDir, { limit: 2 }).length, 2)
  assert.equal(sweepCleanedCaches(tasksDir, { limit: 2 }).length, 2)
})

test('unregistered folders: removes only folders that hold nothing but caches, empty folders and a dangling pointer', () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'disk-guard-orphans-'))
  const cards = join(tasksDir, '.worktrees', 'Proj', 'cards')
  const integrationPath = join(tasksDir, '.worktrees', 'Proj', 'integration')
  const pointer = (folder, target) => writeFileSync(join(folder, '.git'), `gitdir: ${target}\n`)
  const folder = (name) => { const root = join(cards, name); mkdirSync(root, { recursive: true }); return root }
  const old = new Date(Date.now() - 5 * 60 * 60000)
  const orphan = folder('orphan-caches')
  mkdirSync(join(orphan, 'node_modules', 'pkg'), { recursive: true })
  mkdirSync(join(orphan, '.next', 'cache'), { recursive: true })
  pointer(orphan, join(tasksDir, 'missing', 'orphan'))
  const junction = folder('orphan-junction')
  const shared = join(tasksDir, 'shared-install')
  mkdirSync(join(shared, 'pkg'), { recursive: true })
  symlinkSync(shared, join(junction, 'node_modules'), 'junction')
  pointer(junction, join(tasksDir, 'missing', 'junction'))
  const empty = folder('orphan-empty')
  mkdirSync(join(empty, 'sub'), { recursive: true })
  const source = folder('orphan-source')
  mkdirSync(join(source, 'src'), { recursive: true })
  writeFileSync(join(source, 'src', 'a.ts'), 'unsaved work')
  const live = folder('live-git')
  mkdirSync(join(tasksDir, 'gitdirs', 'live'), { recursive: true })
  pointer(live, join(tasksDir, 'gitdirs', 'live'))
  const listedFolder = folder('listed')
  writeFileSync(join(listedFolder, 'x.txt'), 'listed')
  const registered = folder('registered')
  writeFileSync(join(registered, 'x.txt'), 'registered')
  writeFileSync(join(tasksDir, '.board-worktrees.json'), JSON.stringify({
    R1: { cardId: 'R1', repoRoot: integrationPath, worktreePath: registered, state: 'building' },
  }))
  for (const p of [orphan, junction, empty, source, live, listedFolder, registered]) utimesSync(p, old, old)
  const { removed, skipped } = sweepUnregisteredFolders({ tasksDir, worktreesRoot: cards, integrationPath, listed: [listedFolder] })
  const removedNames = removed.map(r => r.path.split(/[\\/]/).pop()).sort()
  assert.deepEqual(removedNames, ['orphan-caches', 'orphan-empty', 'orphan-junction'])
  assert.equal(existsSync(orphan), false)
  assert.equal(existsSync(junction), false)
  assert.equal(existsSync(empty), false)
  assert.equal(existsSync(join(shared, 'pkg')), true, 'the junction target is never followed')
  assert.equal(existsSync(join(source, 'src', 'a.ts')), true)
  assert.equal(existsSync(live), true)
  assert.equal(existsSync(listedFolder), true)
  assert.equal(existsSync(registered), true)
  const sourceSkip = skipped.find(s => s.path === source)
  assert.match(sourceSkip.reason, /src[\\/]a\.ts/)
  assert.equal(skipped.some(s => s.path === live), true)
  assert.equal(skipped.some(s => s.path === listedFolder || s.path === registered), false)
})

test('unregistered folders: a dry run deletes nothing, young folders are left alone, and the limit holds', () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'disk-guard-orphans-dry-'))
  const cards = join(tasksDir, '.worktrees', 'Proj', 'cards')
  const integrationPath = join(tasksDir, '.worktrees', 'Proj', 'integration')
  const old = new Date(Date.now() - 5 * 60 * 60000)
  for (const name of ['a', 'b', 'c']) {
    const root = join(cards, name)
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    utimesSync(root, old, old)
  }
  const young = join(cards, 'young')
  mkdirSync(join(young, 'node_modules'), { recursive: true })
  const dry = sweepUnregisteredFolders({ tasksDir, worktreesRoot: cards, integrationPath, listed: [], dryRun: true })
  assert.equal(dry.removed.length, 3)
  assert.ok(dry.removed.every(r => r.bytes >= 0))
  assert.equal(existsSync(join(cards, 'a', 'node_modules')), true)
  const limited = sweepUnregisteredFolders({ tasksDir, worktreesRoot: cards, integrationPath, listed: [], limit: 2 })
  assert.equal(limited.removed.length, 2)
  assert.equal(existsSync(young), true, 'a folder younger than an hour may still be under git worktree add')
  assert.equal(limited.skipped.some(s => s.path === young), false)
})

test('unregistered folders: refuses a root that is not a worktrees folder', () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'disk-guard-orphans-root-'))
  assert.throws(() => sweepUnregisteredFolders({ tasksDir, worktreesRoot: join(tasksDir, 'cards'), integrationPath: tasksDir, listed: [] }), /outside a worktrees folder/)
})
