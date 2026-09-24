import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCard, validatePlan } from './lib/cards.mjs'
import { runCardPlanner } from './lib/card-planner.mjs'
import { historyPath } from './lib/card-history.mjs'

// Healthypets T-01..03: a legacy card in Planning is converted to the card-owned
// template in place and gets a Planner; before this it sat until Owner.
const dir = mkdtempSync(join(tmpdir(), 'legacy-convert-'))
try {
  mkdirSync(join(dir, 'planning')); mkdirSync(join(dir, 'issues'))
  const legacy = `# T-01 — Site has only one demo article

**Priority** 8/10 · **Status:** open · **Surface:** both

## Goal

Write the articles.

## Files

content/**, lib/images.ts

## Acceptance criteria

1. All 31 articles exist.


---

**Build attempt** 2026-09-12T12:39:37.409Z


---

**Kicked back** 2026-09-15T21:33:22.935Z

card not ready — no exact files listed.


## Current feedback
Needs you: stale question.
`
  const path = join(dir, 'planning', 'T-01-legacy.md')
  writeFileSync(path, legacy)
  writeFileSync(join(dir, 'issues', 'T-02-legacy.md'), '# T-02 — Legacy in Issues\n\n## Goal\n\nUntouched.\n')
  let delivered = [], agents = []
  const io = {
    agentList: async () => agents, agentWorkspaceOr: async () => 'workspace',
    tabCreate: async () => ({ root_pane: { pane_id: 'pane-1' } }), waitForPrompt: async () => {},
    agentStart: async ({ name, paneId }) => { agents = [{ name, pane_id: paneId, agent_status: 'idle' }] },
    deliver: async (paneId) => { delivered.push(paneId) }, recordUsageStart: () => {}, recordUsageFinish: async () => {},
    paneClose: async () => {}, paneRead: async () => '',
  }
  const result = await runCardPlanner({ project: 'Legacy', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'm', io })
  assert.deepEqual(result?.cards, ['T-01']); assert.deepEqual(delivered, ['pane-1'])

  const card = findCard(dir, 'T-01')
  const text = readFileSync(card.path, 'utf8')
  assert.equal(card.path, path, 'converted in place')
  assert.equal(card.cardOwned, true)
  assert.equal(card.title, 'Site has only one demo article')
  assert.equal(card.priority, 8)
  assert.match(text, /^# T-01 — Site has only one demo article$/m)
  assert.match(text, /^\*\*Workflow version:\*\* 2$/m)
  const brief = text.match(/^## Approved brief\r?\n([\s\S]*?)(?=^## )/m)[1]
  assert.match(brief, /^### Goal$/m); assert.match(brief, /Write the articles\./); assert.match(brief, /1\. All 31 articles exist\./)
  assert.doesNotMatch(brief, /Build attempt|Kicked back|stale question/, 'board chronology stays in history, not the brief')
  assert.equal(text.match(/^## Files$/gm).length, 1, 'no duplicate template headings')
  assert.throws(() => validatePlan(text), /fill ## Files/, 'the Planner still has to plan it')
  // Original text saved to history first.
  const saved = readFileSync(historyPath(dir, 'T-01'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(saved[0].event, 'legacy-conversion-source'); assert.equal(saved[0].text, legacy)
  assert.match(brief, new RegExp(`entry ${saved[0].id}`))
  // Only Planning cards are converted.
  assert.equal(findCard(dir, 'T-02').cardOwned, false)
  // Idempotent: a second pass does not convert again.
  await runCardPlanner({ project: 'Legacy', projectPath: dir, tasksDir: dir, boardRoot: dir, model: 'm', io })
  assert.equal(readFileSync(historyPath(dir, 'T-01'), 'utf8').trim().split('\n').filter(l => l.includes('legacy-conversion-source')).length, 1)
  console.log('Legacy card conversion passed')
} finally { rmSync(dir, { recursive: true, force: true }) }
