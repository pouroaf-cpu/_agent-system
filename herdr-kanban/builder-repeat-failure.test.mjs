import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'
import { recoveryTransition } from './lib/recovery.mjs'

// Injectbuddy I340: five fresh Builders each hit the plan's own stop rule, tagged it
// [implementation], and were re-queued. Audit 2026-10-16 F3: the second Builder return on a
// card goes to the owner, not to a third Planner run (I1319: 3 returns, 4 Planner runs).
test('a second Builder [implementation] failure on the same plan goes to the owner, with the note on the card', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-repeat-'))
  try {
    mkdirSync(join(dir, 'working'))
    writeFileSync(join(dir, 'working', 'T-1.md'), '# T-1 — plan stop rule\n## Files\n- `app.mjs`\n')
    const hkb = () => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, 'issue', 'T-1', '[implementation] plan stop condition hit'], { encoding: 'utf8', windowsHide: true })
    let run = hkb()
    assert.equal(run.status, 0, run.stderr)
    const queued = findCard(dir, 'T-1')
    assert.equal(queued.column, 'queue', 'first failure retries a Builder')
    // The next Builder starts: queue -> working mints a new attempt, so its return is counted.
    writeFileSync(queued.path, recoveryTransition(readFileSync(queued.path, 'utf8'), 'queue', 'working').text)
    renameSync(queued.path, join(dir, 'working', 'T-1.md'))
    run = hkb()
    assert.equal(run.status, 0, run.stderr)
    assert.equal(findCard(dir, 'T-1').column, 'owner', 'second return goes to the owner, not a third Planner run')
    assert.equal(readFileSync(join(dir, '.history', 'T-1.jsonl'), 'utf8').split('\n').filter(l => l.includes('"event":"builder-return"')).length, 2)
    assert.match(readFileSync(findCard(dir, 'T-1').path, 'utf8'), /came back from a Builder twice[\s\S]*plan stop condition hit/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Audit 2026-10-16 F3: the first Builder return still goes back to Queue for a retry.
test('a first Builder [implementation] return still goes back to Queue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-first-return-'))
  try {
    mkdirSync(join(dir, 'working'))
    writeFileSync(join(dir, 'working', 'T-1.md'), '# T-1 — first return\n## Files\n- `app.mjs`\n')
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, 'issue', 'T-1', '[implementation] one wrong step'], { encoding: 'utf8', windowsHide: true })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(findCard(dir, 'T-1').column, 'queue')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// Audit 2026-10-15 F9: a card dragged into Working without a plan could not be handed back by
// its Builder, since Queue refuses planless cards; the issue now routes it to Planning.
test('a Builder [implementation] issue on a card-owned card with no plan goes to Planning instead of being refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-planless-'))
  try {
    const card = createCard(dir, { title: 'Dragged in', brief: 'x' })
    mkdirSync(join(dir, 'working'), { recursive: true })
    renameSync(card.path, join(dir, 'working', card.path.split(/[\\/]/).pop()))
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, 'issue', card.id, '[implementation] the card has no plan to build from'], { encoding: 'utf8', windowsHide: true })
    assert.equal(run.status, 0, run.stderr)
    assert.equal(findCard(dir, card.id).column, 'planning')
    assert.match(run.stdout, new RegExp(`^${card.id} -> planning`))
    assert.match(readFileSync(join(dir, '.history', `${card.id}.jsonl`), 'utf8'), /"routed":"planning: the card has no plan that passes the plan check/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
