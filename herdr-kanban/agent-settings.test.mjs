import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignmentFor, globalSettings, setCardOverride, validateSettingsPatch } from './lib/agent-settings.mjs'
import { findCard } from './lib/cards.mjs'

const config = {
  engine: { kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="high"'] },
  engines: { trivial: { kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="low"'] } },
  models: { planning: 'gpt-5.6-luna', working: 'gpt-5.6-luna', review: 'gpt-5.6-luna', issues: 'gpt-5.6-luna', trivial: 'gpt-5.6-luna' },
}

test('settings validate supported combinations and preserve legacy defaults', () => {
  assert.equal(globalSettings(config).working.model, 'gpt-5.6-luna')
  assert.equal(globalSettings(config).trivial.reasoning, 'low')
  assert.equal(validateSettingsPatch(config, { working: { engine: 'claude', model: 'claude-opus-4-6', reasoning: 'high' } }).working.engine, 'claude')
  assert.throws(() => validateSettingsPatch(config, { review: { engine: 'claude', model: 'gpt-5.6-luna', reasoning: 'high' } }), /not supported/i)
  assert.throws(() => validateSettingsPatch(config, { review: { engine: 'codex', model: 'gpt-5.6-luna', reasoning: 'bogus' } }), /reasoning/i)
})

test('card override persists and wins only for the selected stage', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-settings-')), tasks = join(root, 'TASKS'), planning = join(tasks, 'planning')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(planning, { recursive: true })
  writeFileSync(join(planning, 'T-1.md'), '# T-1 — settings\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n')
  const card = findCard(tasks, 'T-1')
  const next = setCardOverride(tasks, card.id, 'working', { engine: 'claude', model: 'claude-opus-4-6', reasoning: 'high' }, config)
  assert.equal(next.agentSettings.working.model, 'claude-opus-4-6')
  assert.match(readFileSync(next.path, 'utf8'), /\*\*Builder model:\*\* claude-opus-4-6/)
  assert.equal(assignmentFor(config, next, 'working').engine, 'claude')
  assert.equal(assignmentFor(config, next, 'review').engine, 'codex')
})
