import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CHECK_SLOTS, CHECK_WORKERS, takeCheckSlot, busyCheckSlots, releaseCheckSlot, waitForCheckSlot } from './lib/check-slots.mjs'
import { runRecord } from './lib/test-handoff-runner.mjs'
import { runShell } from './lib/completed-handoff.mjs'

const sleep = ms => new Promise(done => setTimeout(done, ms))
const slotDir = () => join(mkdtempSync(join(tmpdir(), 'check-slots-')), 'check-slots')
const DEAD_PID = 999999 // no such process on this PC

test('two checks run at once board-wide; a third finds no free slot until one releases', () => {
  const dir = slotDir()
  assert.deepEqual([CHECK_SLOTS, CHECK_WORKERS], [2, 2])
  const first = takeCheckSlot(dir, process.pid)
  const second = takeCheckSlot(dir, process.pid)
  assert.ok(first && second && first !== second)
  assert.equal(busyCheckSlots(dir), 2)
  assert.equal(takeCheckSlot(dir, process.pid), null)
  releaseCheckSlot(first)
  assert.equal(busyCheckSlots(dir), 1)
  assert.ok(takeCheckSlot(dir, process.pid))
})

test('a slot held by a dead process is reclaimed', () => {
  const dir = slotDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'slot-0.json'), JSON.stringify({ pid: DEAD_PID, since: new Date().toISOString() }))
  writeFileSync(join(dir, 'slot-1.json'), JSON.stringify({ pid: process.pid, since: new Date().toISOString() }))
  assert.equal(busyCheckSlots(dir), 1)
  assert.equal(takeCheckSlot(dir, process.pid), join(dir, 'slot-0.json'))
  assert.equal(busyCheckSlots(dir), 2)
})

test('waitForCheckSlot logs one line and takes the slot once one is released', async () => {
  const dir = slotDir()
  const held = [takeCheckSlot(dir, process.pid), takeCheckSlot(dir, process.pid)]
  const lines = []
  const waiting = waitForCheckSlot({ dir, name: 'check T-9', pollMs: 10, announce: line => lines.push(line) })
  await sleep(60)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^check T-9 waiting for a slot: 2 of 2 board checks running/)
  releaseCheckSlot(held[0])
  const got = await waiting
  assert.equal(got, held[0])
  assert.equal(lines.length, 1)
})

test('runRecord passes PW_WORKERS=2, holds a slot while it runs and frees it when done', async () => {
  const root = mkdtempSync(join(tmpdir(), 'check-run-'))
  const dir = join(root, 'check-slots'), recordPath = join(root, 'rec.json'), log = join(root, 'run.log')
  writeFileSync(recordPath, JSON.stringify({ name: 'T-1', command: 'node -e "console.log(\'workers=\' + process.env.PW_WORKERS)"', cwd: root, log, timeoutSeconds: 60, state: 'running' }))
  await runRecord(recordPath, { slotDir: dir, pollMs: 10 })
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.equal(record.state, 'finished')
  assert.equal(record.exitCode, 0)
  assert.match(readFileSync(log, 'utf8'), /workers=2/)
  assert.equal(busyCheckSlots(dir), 0)
  assert.equal(readdirSync(dir).length, 0)
})

test('runRecord waits for a free slot, logs one line, then runs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'check-wait-'))
  const dir = join(root, 'check-slots'), recordPath = join(root, 'rec.json'), log = join(root, 'run.log')
  writeFileSync(recordPath, JSON.stringify({ name: 'T-2', command: 'node -e "console.log(\'ran\')"', cwd: root, log, timeoutSeconds: 60, state: 'running' }))
  const held = [takeCheckSlot(dir, process.pid), takeCheckSlot(dir, process.pid)]
  const running = runRecord(recordPath, { slotDir: dir, pollMs: 10 })
  await sleep(80)
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).state, 'running')
  releaseCheckSlot(held[1])
  await running
  const text = readFileSync(log, 'utf8')
  assert.equal(text.match(/waiting for a slot/g).length, 1)
  assert.match(text, /check T-2 waiting for a slot: 2 of 2 board checks running/)
  assert.match(text, /ran/)
  assert.equal(JSON.parse(readFileSync(recordPath, 'utf8')).state, 'finished')
})

test('runShell gives the command PW_WORKERS=2', async () => {
  const result = await runShell('node -e "console.log(\'workers=\' + process.env.PW_WORKERS)"', tmpdir(), 60000)
  assert.equal(result.ok, true)
  assert.match(result.output, /workers=2/)
})
