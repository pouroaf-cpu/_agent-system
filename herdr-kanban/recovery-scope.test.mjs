import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { agentStartArgs } from './lib/herdr.mjs'
import { failureCategory, failureDestination } from './lib/workflow-state.mjs'
import { deliverWith } from './lib/spawn.mjs'

test('Builder actual Codex context is isolated; incidental notes cannot request failure routing', () => {
  const args = agentStartArgs({ name: 'proof', paneId: 'p', engine: 'codex', workspacePath: 'C:/isolated/card' })
  assert.equal(args[args.indexOf('--cd') + 1], 'C:/isolated/card')
  const source = readFileSync(new URL('./lib/spawn.mjs', import.meta.url), 'utf8')
  assert.match(source, /agentStart\(\{[^\n]*workspacePath: prepared.workspacePath/)
  assert.equal(failureCategory('[incidental] existing unrelated issue'), 'incidental')
  assert.equal(failureDestination('incidental', 'working'), 'working')
  assert.equal(failureDestination('planning', 'working'), 'planning')
  assert.match(readFileSync(new URL('./hkb.mjs', import.meta.url), 'utf8'), /category === 'incidental'\) fail/)
})

test('successful transport with staged paste sends only Enter, not a duplicate prompt', async () => {
  let prompts = 0, enters = 0
  await deliverWith({ paneId: 'p', text: 'one task', prompt: async () => { prompts++ },
    list: async () => [{ pane_id: 'p', agent_status: enters ? 'working' : 'idle' }],
    read: async () => '› [Pasted Content 200 chars]', sendKeys: async () => { enters++ }, confirmMs: 10 })
  assert.equal(prompts, 1); assert.equal(enters, 1)
})
