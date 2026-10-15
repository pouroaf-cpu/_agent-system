import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createCard, findCard } from './lib/cards.mjs'

// Injectbuddy I340: five fresh Builders each hit the plan's own stop rule, tagged it
// [implementation], and were re-queued; the second one on the same plan now goes to Planning.
test('a second Builder [implementation] failure on the same plan routes to Planning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'builder-repeat-'))
  try {
    mkdirSync(join(dir, 'working'))
    writeFileSync(join(dir, 'working', 'T-1.md'), '# T-1 — plan stop rule\n## Files\n- `app.mjs`\n')
    const hkb = () => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', dir, 'issue', 'T-1', '[implementation] plan stop condition hit'], { encoding: 'utf8', windowsHide: true })
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
