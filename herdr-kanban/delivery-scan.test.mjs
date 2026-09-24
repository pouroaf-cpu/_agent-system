import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pendingDeliveries, saveDelivery } from './lib/delivery-state.mjs'

test('pending deliveries are re-read only when the folder changes (the board polled 605 records per project)', t => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-scan-'))
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  writeFileSync(process.env.KANBAN_CONFIG, '{}')
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  saveDelivery('proof', 'p1', { status: 'paused' })
  saveDelivery('proof', 'p2', { status: 'confirmed' })
  assert.equal(pendingDeliveries('proof').length, 1)
  // An in-place write leaves the folder's mtime alone, so a cached scan never reads it.
  const dir = join(root, '.deliveries')
  for (const name of readdirSync(dir)) writeFileSync(join(dir, name), 'not json')
  assert.equal(pendingDeliveries('proof').length, 1)
  assert.equal(pendingDeliveries('other').length, 0)
  saveDelivery('proof', 'p3', { status: 'paused' })
})
