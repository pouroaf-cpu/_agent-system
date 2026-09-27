import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkStalls } from './lib/stall-watchdog.mjs'

// Injectbuddy I352 (2026-09-27): it waited hours in Planning behind I348, which landed at
// 09:00:55; 28 s later the watchdog called it idle for 20 minutes and moved it to Owner.
// The stall clock now starts when the last blocker landed.
test('a Planning card whose blocker just landed is not a stall', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stall-landed-'))
  try {
    for (const lane of ['planning', 'archive']) mkdirSync(join(dir, lane))
    const now = Date.now(), hours = t => new Date(now - t * 3600e3), card = join(dir, 'planning', 'T-2-waits.md'), blocker = join(dir, 'archive', 'T-1-prereq.md')
    writeFileSync(card, '# T-2 — waits on T-1\n**Workflow:** card-owned\n**Blocked by:** T-1\n\n## Approved brief\nx\n')
    writeFileSync(blocker, '# T-1 — prerequisite\n\n## Approved brief\nx\n')
    utimesSync(card, hours(3), hours(3))
    utimesSync(blocker, new Date(now - 60000), new Date(now - 60000))
    assert.deepEqual(checkStalls({ tasksDir: dir, agents: [], now }), [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
