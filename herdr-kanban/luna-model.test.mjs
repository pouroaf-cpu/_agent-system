import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agentStartArgs } from './lib/agent-launch.mjs'
import { assignmentFor, catalog, engineForAssignment, globalSettings, validateSettingsPatch } from './lib/agent-settings.mjs'

test('requested role defaults resolve to the right launch arguments (Claude only)', () => {
  const config = JSON.parse(readFileSync(new URL('./board.config.json', import.meta.url), 'utf8'))
  delete config.agentSettings // role defaults come from the legacy fields, not the live board's saved choice
  assert.ok(catalog().claude.models.includes('claude-opus-5-5'))
  assert.equal(catalog().codex, undefined)

  const before = globalSettings(config)
  const globals = validateSettingsPatch(config, {
    planning: { engine: 'claude', model: 'claude-opus-5-5', reasoning: 'high' },
    working: { engine: 'claude', model: 'claude-sonnet-5-5', reasoning: 'high' },
    review: { engine: 'claude', model: 'claude-haiku-4-5', reasoning: 'high' },
  })
  const saved = { ...config, agentSettings: { global: globals } }
  assert.deepEqual(globalSettings(saved).trivial, before.trivial)

  for (const [stage, name, model] of [
    ['planning', 'kb-planner-t-1-test', 'claude-opus-5-5'],
    ['working', 'kb-t-1-test', 'claude-sonnet-5-5'],
    ['review', 'kb-review-test', 'claude-haiku-4-5'],
  ]) {
    const setting = assignmentFor(saved, null, stage)
    const args = agentStartArgs({ name, paneId: 'test', model: setting.model, engine: engineForAssignment(setting) })
    assert.equal(args[args.indexOf('--kind') + 1], 'claude')
    assert.equal(args[args.indexOf('--model') + 1], model)
    assert.equal(args[args.indexOf('--name') + 1], name)
  }
  // A card override naming a GPT model is ignored; the card stays on its Claude default.
  assert.equal(assignmentFor(saved, { agentSettings: { working: { model: 'gpt-5.6-luna' } } }, 'working').model, 'claude-sonnet-5-5')
  // A saved Codex planner is ignored; the planner stays on Claude.
  const temporaryPlanner = assignmentFor({ ...saved, agentSettings: { global: { ...globals, planning: { engine: 'codex', model: 'gpt-6-sol', reasoning: 'high' } } } }, null, 'planning')
  assert.equal(temporaryPlanner.engine ?? 'claude', 'claude')
  assert.equal(temporaryPlanner.model, 'claude-sonnet-5-5')
  assert.throws(() => validateSettingsPatch(config, { planning: { engine: 'codex', model: 'gpt-6-sol', reasoning: 'high' } }), /unsupported engine codex/)
})
