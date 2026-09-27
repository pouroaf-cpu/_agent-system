import assert from 'node:assert/strict'
import { agentStartArgs } from './lib/herdr.mjs'
const key = String.raw`'C:\Users\PFrew\.codex\hooks.json:user_prompt_submit:0:0'={enabled=false}`
const hooks = args => args.find(arg => arg.startsWith('hooks.state=')) ?? ''
for (const name of ['kb-planner-t-93', 'kb-builder-t-93', 'kb-review-t-93', 'kanban-observer']) {
  const args = agentStartArgs({ name, paneId: 'test', model: 'gpt-5.6-luna', engine: 'codex' })
  assert.ok(hooks(args).includes(key), name)
  assert.ok(!args.includes('features.hooks=false'))
  assert.ok(!args.some(arg => arg.includes('AGENT-CONTEXT.md')), name)
}
assert.ok(!hooks(agentStartArgs({ name: 'orchestrator', paneId: 'test', model: 'gpt-5.6-luna', engine: 'codex' })).includes(key))
console.log('PASS: managed agents disable Grill Me; orchestrator retains it')
