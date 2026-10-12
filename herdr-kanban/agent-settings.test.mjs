import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assignmentFor, globalSettings, setCardOverride, STAGES, SUPPORTED, validateSettingsPatch } from './lib/agent-settings.mjs'
import { findCard } from './lib/cards.mjs'

const config = {
  engine: { kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="high"'] },
  engines: { trivial: { kind: 'codex', reasoningArgs: ['-c', 'model_reasoning_effort="low"'] } },
  models: { planning: 'gpt-5.6-luna', working: 'gpt-5.6-luna', review: 'gpt-5.6-luna', issues: 'gpt-5.6-luna', trivial: 'gpt-5.6-luna' },
}

test('settings validate supported combinations and preserve legacy defaults', () => {
  // Codex legacy fields are never read: every role resolves to Claude.
  assert.equal(globalSettings(config).working.model, 'claude-sonnet-5-5')
  assert.equal(globalSettings(config).working.engine, 'claude')
  assert.equal(globalSettings(config)['builder-easy'].reasoning, 'medium')
  assert.equal(validateSettingsPatch(config, { working: { engine: 'claude', model: 'claude-haiku-4-5', reasoning: 'high' } }).working.engine, 'claude')
  assert.throws(() => validateSettingsPatch(config, { review: { engine: 'claude', model: 'gpt-5.6-luna', reasoning: 'high' } }), /not supported/i)
  assert.throws(() => validateSettingsPatch(config, { review: { engine: 'codex', model: 'gpt-5.6-luna', reasoning: 'bogus' } }), /reasoning/i)
})

test('card override persists and wins only for the selected stage', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-settings-')), tasks = join(root, 'TASKS'), planning = join(tasks, 'planning')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(planning, { recursive: true })
  writeFileSync(join(planning, 'T-1.md'), '# T-1 — settings\n**Workflow:** card-owned\n## Files\n- `app.mjs`\n')
  const card = findCard(tasks, 'T-1')
  const next = setCardOverride(tasks, card.id, 'working', { engine: 'claude', model: 'claude-haiku-4-5', reasoning: 'high' }, config)
  assert.equal(next.agentSettings.working.model, 'claude-haiku-4-5')
  assert.match(readFileSync(next.path, 'utf8'), /\*\*Builder model:\*\* claude-haiku-4-5/)
  assert.equal(assignmentFor(config, next, 'working').engine, 'claude')
  assert.equal(assignmentFor(config, next, 'review').engine, 'claude')
})

test('settings refuse a model the launch guard would reject, so it cannot fail at agent start (I229)', () => {
  assert.throws(() => validateSettingsPatch(config, { working: { engine: 'claude', model: 'claude-sonnet-4-6', reasoning: 'low' } }), /not approved for board launches/)
  const haiku = { engine: 'claude', model: 'claude-haiku-4-5', reasoning: 'low' }
  const next = validateSettingsPatch(config, { planning: haiku, working: haiku, review: haiku, issues: haiku, trivial: haiku })
  assert.equal(next.working.model, 'claude-haiku-4-5')
})

test('AC1: no default names Codex or carries a fallback, even when the legacy fields say codex', () => {
  for (const cfg of [{}, config]) {
    const settings = globalSettings(cfg)
    for (const stage of STAGES) {
      assert.equal(settings[stage].engine, 'claude', stage)
      assert.ok(!SUPPORTED.codex.models.includes(settings[stage].model), stage)
      assert.equal('fallback' in settings[stage], false, stage)
    }
    for (const difficulty of ['tiny', 'easy', 'medium', 'hard']) {
      const assigned = assignmentFor(cfg, { difficulty }, 'working')
      assert.equal(assigned.engine, 'claude', difficulty)
      assert.equal('fallback' in assigned, false, difficulty)
    }
  }
})

test('AC2: an absent or null fallback stays none after a config write and re-read', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-defaults-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'board.config.json')
  const save = (cfg, patch) => {
    writeFileSync(file, JSON.stringify({ ...cfg, agentSettings: { global: validateSettingsPatch(cfg, patch) } }))
    return JSON.parse(readFileSync(file, 'utf8'))
  }
  const primary = { engine: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' }
  let reread = save({}, { 'builder-easy': primary })
  assert.equal(globalSettings(reread)['builder-easy'].fallback, undefined)
  assert.equal(globalSettings(reread)['builder-easy'].reasoning, 'high')

  // A same-model Claude fallback (the live workaround) is accepted and kept.
  reread = save(reread, { 'builder-easy': { ...primary, fallback: primary } })
  assert.deepEqual(globalSettings(reread)['builder-easy'].fallback, primary)

  reread = save(reread, { 'builder-easy': { fallback: null } })
  assert.equal(globalSettings(reread)['builder-easy'].fallback, undefined)
  assert.equal(globalSettings(reread)['builder-easy'].model, 'claude-sonnet-5-5')
})
