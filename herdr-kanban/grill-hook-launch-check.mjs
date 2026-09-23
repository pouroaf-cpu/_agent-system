import assert from 'node:assert/strict'
import { agentStartArgs } from './lib/herdr.mjs'
const key = String.raw`hooks.state.'C:\Users\PFrew\.codex\hooks.json:user_prompt_submit:0:0'.enabled=false`
for (const name of ['kb-planner-t-93', 'kb-builder-t-93', 'kb-review-t-93', 'kanban-observer']) {
  const args = agentStartArgs({ name, paneId: 'test', model: 'gpt-5.5', engine: 'codex' })
  assert.ok(args.includes(key), name)
  assert.ok(!args.includes('features.hooks=false'))
  assert.ok(!args.some(arg => arg.includes('AGENT-CONTEXT.md')), name)
}
assert.ok(!agentStartArgs({ name: 'orchestrator', paneId: 'test', model: 'gpt-5.5', engine: 'codex' }).includes(key))
console.log('PASS: managed agents disable only Grill Me; orchestrator retains it')
