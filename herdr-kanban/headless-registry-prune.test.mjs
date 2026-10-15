import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadless, CLOSED_ROW_KEEP_MS } from './lib/headless.mjs'

// Registry shaped like the live one (2026-10-16 audit F4): closed rows pile up with their log and exit files.
// The registry is written compact on purpose: save() writes it indented, so any rewrite shows up as a text change.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'headless-prune-'))
  const hour = 60 * 60000
  const now = Date.parse('2026-10-16T12:00:00Z')
  const row = (id, extra) => {
    const log = join(root, `${id}.log`)
    writeFileSync(log, 'log line\n')
    return { id, name: `r-${id}`, pid: 999990, childPid: null, log, startedAt: new Date(now - 5 * hour).toISOString(), exitCode: null, engine: 'claude', sessionId: `s-${id}`, session: 'p', options: {}, closedAt: null, ...extra }
  }
  return { root, now, hour, row }
}

const registryOf = root => JSON.parse(readFileSync(join(root, 'registry.json'), 'utf8'))

test('pruneClosed drops old closed rows with their files and keeps live and recent rows', () => {
  const { root, now, hour, row } = fixture()
  try {
    const oldExit = join(root, 'headless-old.launch.json.exit.json')
    writeFileSync(oldExit, JSON.stringify({ exitCode: 0, endedAt: new Date(now - 3 * hour).toISOString() }))
    const oldRow = row('headless-old', { exitFile: oldExit, exitCode: 0, closedAt: new Date(now - 3 * hour).toISOString() })
    const recentRow = row('headless-recent', { closedAt: new Date(now - 10 * 60000).toISOString(), exitCode: 0 })
    const liveRow = row('headless-live', { pid: process.pid })
    const closedButAlive = row('headless-alive', { pid: process.pid, closedAt: new Date(now - 3 * hour).toISOString() })
    const plainLive = row('headless-plain')
    writeFileSync(join(root, 'registry.json'), JSON.stringify([oldRow, recentRow, liveRow, closedButAlive, plainLive]))
    const api = createHeadless({ root, command: () => ['node'] })

    const result = api.pruneClosed({ now })

    assert.deepEqual(result, { rows: 1, files: 2 })
    assert.deepEqual(registryOf(root).map(r => r.id), ['headless-recent', 'headless-live', 'headless-alive', 'headless-plain'])
    assert.ok(!existsSync(join(root, 'headless-old.log')))
    assert.ok(!existsSync(oldExit))
    assert.ok(existsSync(join(root, 'headless-recent.log')))
    assert.ok(existsSync(join(root, 'headless-live.log')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneClosed keeps a closed row until the keep window has passed', () => {
  const { root, now, row } = fixture()
  try {
    const closedAt = new Date(now - CLOSED_ROW_KEEP_MS + 60000).toISOString()
    writeFileSync(join(root, 'registry.json'), JSON.stringify([row('headless-young', { closedAt, exitCode: 0 })]))
    const api = createHeadless({ root, command: () => ['node'] })
    assert.deepEqual(api.pruneClosed({ now }), { rows: 0, files: 0 })
    assert.equal(registryOf(root).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agentList on an idle registry does not rewrite it', async () => {
  const { root, now, row } = fixture()
  try {
    const live = row('headless-live', { pid: process.pid })
    const closed = row('headless-closed', { closedAt: new Date(now - 60000).toISOString(), exitCode: 0 })
    const text = JSON.stringify([live, closed])
    writeFileSync(join(root, 'registry.json'), text)
    const api = createHeadless({ root, command: () => ['node'] })

    const listed = await api.agentList('p')
    assert.deepEqual(listed.map(a => a.id), ['headless-live'])
    assert.equal(readFileSync(join(root, 'registry.json'), 'utf8'), text)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agentList does not re-read the exit file of a settled row', async () => {
  const { root, now, row } = fixture()
  try {
    // Garbage in the exit file: a read would throw a JSON parse error. A settled row must never be read.
    const settledExit = join(root, 'headless-settled.launch.json.exit.json')
    writeFileSync(settledExit, '{not json')
    const settled = row('headless-settled', { exitFile: settledExit, exitCode: 3, closedAt: null })
    const running = row('headless-running', { pid: process.pid })
    writeFileSync(join(root, 'registry.json'), JSON.stringify([settled, running]))
    const api = createHeadless({ root, command: () => ['node'] })

    const listed = await api.agentList('p')
    assert.deepEqual(listed.map(a => a.id), ['headless-settled', 'headless-running'])
    assert.equal(listed[0].agent_status, 'done')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('agentList still reads the exit file of a running row and writes the change back', async () => {
  const { root, row } = fixture()
  try {
    const exitFile = join(root, 'headless-finishing.launch.json.exit.json')
    writeFileSync(exitFile, JSON.stringify({ exitCode: 0 }))
    const finishing = row('headless-finishing', { exitFile, exitCode: null })
    writeFileSync(join(root, 'registry.json'), JSON.stringify([finishing]))
    const api = createHeadless({ root, command: () => ['node'] })

    const listed = await api.agentList('p')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].agent_status, 'done')
    const stored = registryOf(root)
    assert.equal(stored[0].exitCode, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
