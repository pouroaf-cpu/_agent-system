// Token-efficiency audit (2026-10-12), finding 4: plannerPrompt and workerPrompt repeated
// the hkb command path many times, kept dead Codex/plan-check/"Base run" wording and
// restated every hand-in verb twice. Guards the trimmed sizes and the hand-in commands.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { plannerPrompt, workerPrompt } from './lib/prompt.mjs'

const card = { id: 'IA999', category: 'ui', column: 'approved', path: 'C:/fake/card.md', trivial: false, title: 'Sample ui card' }
const common = { cards: [card], card, projectPath: 'C:/fake/project', boardRoot: 'C:/Users/PFrew/Projects/herdr-kanban', tasksDir: null, engine: 'claude' }

test('plannerPrompt stays at or below 4,300 chars with at most two hkb.mjs mentions', () => {
  const p = plannerPrompt(common)
  assert.ok(p.length <= 4300, `plannerPrompt is ${p.length} chars, want <= 4300`)
  const count = (p.match(/hkb\.mjs/g) || []).length
  assert.ok(count <= 2, `plannerPrompt names hkb.mjs ${count} times, want <= 2`)
  for (const verb of ['move', 'issue', 'owner', 'covered', 'wait', 'split']) {
    assert.match(p, new RegExp(`\\b${verb}\\b`), `plannerPrompt lost the "${verb}" hand-in command`)
  }
})

test('workerPrompt stays at or below 5,500 chars', () => {
  const w = workerPrompt(common)
  assert.ok(w.length <= 5500, `workerPrompt is ${w.length} chars, want <= 5500`)
  for (const verb of ['unchanged', 'done', 'issue', 'owner']) {
    assert.match(w, new RegExp(`\\b${verb}\\b`), `workerPrompt lost the "${verb}" hand-in command`)
  }
})

test('neither prompt carries dead Codex/plan-check wording', () => {
  const p = plannerPrompt(common)
  const w = workerPrompt(common)
  for (const bad of ['fresh-context check', 'Codex', 'Base run']) {
    assert.ok(!p.includes(bad), `plannerPrompt still has "${bad}"`)
    assert.ok(!w.includes(bad), `workerPrompt still has "${bad}"`)
  }
})
