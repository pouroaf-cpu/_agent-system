import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyDiskReading, pruneAgentLogs, DISK_LOW_GB, DISK_RESUME_GB, AGENT_LOG_KEEP_MS } from './lib/disk-guard.mjs'
import { sweepCleanedCaches } from './lib/worktrees.mjs'

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
