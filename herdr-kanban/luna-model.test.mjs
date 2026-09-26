import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agentStartArgs } from './lib/herdr.mjs'
import { assignmentFor, catalog, engineForAssignment, globalSettings, validateSettingsPatch } from './lib/agent-settings.mjs'

test('requested role defaults resolve to the right launch arguments', () => {
  const config = JSON.parse(readFileSync(new URL('./board.config.json', import.meta.url), 'utf8'))
  delete config.agentSettings // role defaults come from the legacy fields, not the live board's saved choice
  assert.ok(catalog().claude.models.includes('claude-opus-5-5'))
  assert.ok(catalog().codex.models.includes('gpt-6-luna'))
  assert.ok(catalog().codex.models.includes('gpt-6-sol'))

  const before = globalSettings(config)
  const globals = validateSettingsPatch(config, {
    planning: { engine: 'claude', model: 'claude-opus-5-5', reasoning: 'high' },
    working: { engine: 'codex', model: 'gpt-6-luna', reasoning: 'high' },
    review: { engine: 'codex', model: 'gpt-6-luna', reasoning: 'high' },
  })
  const saved = { ...config, agentSettings: { global: globals } }
  assert.deepEqual(globalSettings(saved).issues, before.issues)
  assert.deepEqual(globalSettings(saved).trivial, before.trivial)

  for (const [stage, name, kind, model] of [
    ['planning', 'kb-planner-t-1-test', 'claude', 'claude-opus-5-5'],
    ['working', 'kb-t-1-test', 'codex', 'gpt-6-luna'],
    ['review', 'kb-review-test', 'codex', 'gpt-6-luna'],
    ['issues', 'kb-plan-test', 'codex', 'gpt-5.6-luna'],
  ]) {
    const setting = assignmentFor(saved, null, stage)
    const args = agentStartArgs({ name, paneId: 'test', model: setting.model, engine: engineForAssignment(setting) })
    assert.equal(args[args.indexOf('--kind') + 1], kind)
    assert.equal(args[args.indexOf('--model') + 1], model)
    if (kind === 'claude') assert.equal(args[args.indexOf('--name') + 1], name)
    assert.throws(() => agentStartArgs({ name, paneId: 'test', model: 'gpt-6-astra', engine: 'codex' }), /must use model/)
  }
  assert.equal(assignmentFor(saved, { agentSettings: { working: { model: 'gpt-5.6-luna' } } }, 'working').model, 'gpt-5.6-luna')
  const temporaryPlanner = assignmentFor({ ...saved, agentSettings: { global: { ...globals, planning: { engine: 'codex', model: 'gpt-6-sol', reasoning: 'high' } } } }, null, 'planning')
  const plannerArgs = agentStartArgs({ name: 'kb-planner-t-7-test', paneId: 'test', model: temporaryPlanner.model, engine: engineForAssignment(temporaryPlanner) })
  assert.equal(plannerArgs[plannerArgs.indexOf('--kind') + 1], 'codex')
  assert.equal(plannerArgs[plannerArgs.indexOf('--model') + 1], 'gpt-6-sol')
})
