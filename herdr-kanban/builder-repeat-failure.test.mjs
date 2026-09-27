import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { findCard } from './lib/cards.mjs'

// Injectbuddy I340: five fresh Builders each hit the plan's own stop rule, tagged it
// [implementation], and were re-queued; the second one on the same plan now goes to Planning.
test('a second Builder [implementation] failure on the same plan routes to Planning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-repeat-'))
  try {
    mkdirSync(join(dir, 'working'))
    writeFileSync(join(dir, 'working', 'T-1.md'), '# T-1 — plan stop rule\n## Files\n- `app.mjs`\n')
    const hkb = () => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, 'issue', 'T-1', '[implementation] plan stop condition hit'], { encoding: 'utf8' })
    let run = hkb()
    assert.equal(run.status, 0, run.stderr)
    const queued = findCard(dir, 'T-1')
    assert.equal(queued.column, 'queue', 'first failure retries a Builder')
    renameSync(queued.path, join(dir, 'working', 'T-1.md'))
    run = hkb()
    assert.equal(run.status, 0, run.stderr)
    assert.equal(findCard(dir, 'T-1').column, 'planning', 'second failure on the same plan goes to the Planner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
