import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { cachedAsync, clearCachedAsync } from './lib/async-cache.mjs'

// The board's event loop serves HTTP. A synchronous process or git call on it stalls every
// request for as long as the call takes (seconds on a loaded PC). This is a ratchet: each
// module may hold no more synchronous process calls than recorded here. A new one fails the
// test; converting one lets the count go down, and the number here should then be lowered.
const SYNC_CALL = /\b(spawnSync|execSync|execFileSync)\(/g
const ALLOWED = {
  // Synchronous git and process work still reached from the board's loop (the worktree registry is
  // read-modify-write with no cross-thread lock, so it cannot simply move to a worker thread yet).
  'lib/worktrees.mjs': 4,      // git() helper behind reconcile and every worktree transaction; regeneration; route types; typegen
  'lib/autospawn.mjs': 3,      // preflight script; two checker rev-parse calls on the review path
  'lib/cards.mjs': 4,          // git ls-files / cat-file for card file lists
  'lib/review-claims.mjs': 3,  // checker claim git probes
  'lib/release.mjs': 2,        // integration git helper
  'lib/planner-state.mjs': 1,  // planner git helper
  'lib/locate.mjs': 1,         // git grep for the locate endpoint
  'lib/orphan-servers.mjs': 2, // taskkill and the PowerShell listing behind stopServersIn (the sync variant)
  'lib/test-handoff-runner.mjs': 1, // taskkill of a test run
}

const sources = ['server.mjs', ...readdirSync('lib').filter(f => f.endsWith('.mjs')).map(f => `lib/${f}`)]

test('no new synchronous process or git call on the board server path', () => {
  const over = []
  for (const file of sources) {
    const count = [...readFileSync(file, 'utf8').matchAll(SYNC_CALL)].length
    const allowed = ALLOWED[file] ?? 0
    if (count > allowed) over.push(`${file}: ${count} synchronous process calls, allowed ${allowed}`)
  }
  assert.deepEqual(over, [], 'move the new call to an async helper (execText, nodeProcessesAsync, stopServersInAsync, cachedAsync)')
})

test('the Get-Process owner check, the agent-close server stop and the project ahead count are not synchronous', () => {
  assert.equal([...readFileSync('lib/bindings.mjs', 'utf8').matchAll(SYNC_CALL)].length, 0)
  assert.equal([...readFileSync('lib/headless.mjs', 'utf8').matchAll(SYNC_CALL)].length, 0)
  assert.equal([...readFileSync('server.mjs', 'utf8').matchAll(SYNC_CALL)].length, 0)
})

test('a background-read value is unknown until its load succeeds, and a failed load is not a value', async () => {
  clearCachedAsync()
  const first = cachedAsync('probe', async () => 'answer', { ttl: 60000 })
  assert.equal(first.known, false, 'the first call returns at once with no value')
  await new Promise(done => setTimeout(done, 5))
  assert.deepEqual(cachedAsync('probe', async () => 'again', { ttl: 60000 }).value, 'answer')
  assert.equal(cachedAsync('probe', async () => 'again', { ttl: 60000 }).known, true)

  cachedAsync('broken', async () => { throw new Error('no powershell') }, { ttl: 0 })
  await new Promise(done => setTimeout(done, 5))
  assert.equal(cachedAsync('broken', async () => 'x', { ttl: 0 }).known, false)
  clearCachedAsync()
})
