import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { EVENT_KINDS } from './lib/event-id.mjs'

const HELPER = 'C:/Users/PFrew/Projects/_roles/board-event-id.mjs'
const run = promisify(execFile)
const cli = (counter, code) => run(process.execPath, [HELPER, code], { env: { ...process.env, BOARD_EVENT_COUNTER: counter } })
const temp = () => join(mkdtempSync(join(tmpdir(), 'event-id-')), 'board-event-id.json')

test('AC2: eight parallel runs give eight unique contiguous numbers from 12334 and leave no lock', async () => {
  const counter = temp()
  const out = await Promise.all(Array.from({ length: 8 }, () => cli(counter, 'BE')))
  const numbers = out.map(r => r.stdout.trim()).map(id => { assert.match(id, /^BE \d+$/); return Number(id.slice(3)) }).sort((a, b) => a - b)
  assert.deepEqual(numbers, Array.from({ length: 8 }, (_, i) => 12334 + i))
  assert.equal(existsSync(`${counter}.lock`), false)
  assert.equal(JSON.parse(readFileSync(counter, 'utf8')).next, 12342)
})

test('AC2: an unknown code gets a GE ID', async () => {
  const { stdout } = await cli(temp(), 'ZZ')
  assert.match(stdout.trim(), /^GE 12334$/)
})

test('AC2: a corrupt counter file exits non-zero and is left unchanged', async () => {
  const counter = temp()
  writeFileSync(counter, '{not json')
  await assert.rejects(cli(counter, 'BE'), err => err.code !== 0)
  assert.equal(readFileSync(counter, 'utf8'), '{not json')
  assert.equal(existsSync(`${counter}.lock`), false)
})

test('the repo shim exports the helper kinds', async () => {
  const helper = await import(`file:///${HELPER}`)
  assert.deepEqual(Object.keys(EVENT_KINDS), Object.keys(helper.EVENT_KINDS))
})
