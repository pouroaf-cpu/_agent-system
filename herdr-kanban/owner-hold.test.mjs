// An Owner card whose latest note is "Operator hold" is waiting, not stuck or ageing (IA49, 2026-10-10).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isOperatorHold } from './lib/cards.mjs'
import { ownerAgeing } from './lib/manager-alerts.mjs'

test('latest Operator hold note holds an Owner card; a later note ends it', () => {
  const tasksDir = mkdtempSync(join(tmpdir(), 'owner-hold-')), owner = join(tasksDir, 'owner')
  mkdirSync(owner)
  const path = join(owner, 'I1-job.md')
  writeFileSync(path, '# I1: Job\n\n**Operator decision** 2026-10-10T02:15:51.414Z\n\nship later\n\n**Operator hold** 2026-10-10T02:18:25.357Z\n\nheld for the webapp\n')
  const old = new Date(Date.now() - 6 * 3600_000)
  utimesSync(path, old, old)
  assert.equal(isOperatorHold({ path }), true)
  assert.equal(ownerAgeing(tasksDir), null)
  appendFileSync(path, '\n**Operator decision** 2026-10-11T02:00:00.000Z\n\nrollout is on\n')
  utimesSync(path, old, old)
  assert.equal(isOperatorHold({ path }), false)
  assert.match(ownerAgeing(tasksDir).title, /1 Owner card waiting over 4h/)
})
