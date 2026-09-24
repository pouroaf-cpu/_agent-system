import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renameSync } from './lib/fs-retry.mjs'

test('a rename refused by a Windows file lock is retried, other errors are not (Tradeflow T-43)', () => {
  let calls = 0
  const locked = () => { if (++calls < 3) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }) }
  renameSync('a', 'b', { waitMs: 1, rename: locked })
  assert.equal(calls, 3)
  calls = 0
  const missing = () => { calls++; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  assert.throws(() => renameSync('a', 'b', { waitMs: 1, rename: missing }), /ENOENT/)
  assert.equal(calls, 1)
})
