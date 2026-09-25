import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { findCard } from './lib/cards.mjs'

const hkb = (tasks, ...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./hkb.mjs', import.meta.url)), '--tasks', tasks, ...args], { encoding: 'utf8' })

test('an investigation that finds several issues is split: the card stops for the orchestrator to re-card', t => {
  const root = mkdtempSync(join(tmpdir(), 'split-')), tasks = join(root, 'TASKS')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(tasks, 'working'), { recursive: true })
  writeFileSync(join(tasks, 'working', 'T-1.md'), '# T-1 — investigate slow pages\n**Workflow:** card-owned\n')
  assert.notEqual(hkb(tasks, 'split', 'T-1', 'several things are wrong').status, 0, 'findings must be a numbered list')
  const result = hkb(tasks, 'split', 'T-1', '1. Fonts block render (evidence: a.log)\n2. Hero image is 2 MB (evidence: b.png)')
  assert.equal(result.status, 0, result.stderr)
  const card = findCard(tasks, 'T-1')
  assert.equal(card.column, 'owner')
  assert.match(readFileSync(card.path, 'utf8'), /^Split needed: 1\. Fonts block render/m)
})
