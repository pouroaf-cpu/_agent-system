import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deliverWith, stagedInput, unsubmittedDelivery } from './lib/spawn.mjs'
import { bind } from './lib/bindings.mjs'
import { routeBuilderNoHandoff } from './lib/autospawn.mjs'
import { readWorkflow } from './lib/workflow-state.mjs'

test('I653: wait for Codex startup, submit animated staged input once, and recover an interrupted spawn', async t => {
  const text = 'Read C:/board/.deliveries/task.md and follow it exactly'
  for (const sparkle of '⠁⠂⠄⠈⠐⠠⡀⢀') {
    const screen = `›${sparkle}Read C:/board/.deliveries/task.md\n  and follow it exactly\n\n  GPT-6-Luna low`
    assert.equal(stagedInput(screen, text), true)
    assert.equal(unsubmittedDelivery(screen), true)
  }
  const { waitForAgentPrompt, isSpawning, beginSpawn, endSpawn } = await import('./lib/herdr.mjs')
  let reads = 0
  await waitForAgentPrompt('p', { everyMs: 1, timeoutMs: 1000, read: async () => {
    reads++
    return reads === 1 ? '› Ask Codex to do anything\n• Starting MCP servers (1/3)' : '› Ask Codex to do anything\n  GPT-6-Luna low'
  } })
  assert.equal(reads, 2, 'the input marker alone is not ready while MCPs start')
  await assert.rejects(waitForAgentPrompt('p', { everyMs: 1, timeoutMs: 5, read: async () => 'Starting MCP servers' }), /not ready/)

  let prompts = 0, enters = 0
  await deliverWith({ paneId: 'p', text, confirmMs: 1,
    prompt: async () => { assert.equal(isSpawning('p'), true); prompts++; throw new Error('agent_prompt_stalled: 5000 ms') },
    list: async () => [{ pane_id: 'p', agent_status: 'working' }],
    read: async () => enters ? '› Ask Codex to do anything' : `›⠂${text}`,
    sendKeys: async (_pane, keys) => { assert.equal(isSpawning('p'), true); assert.deepEqual(keys, ['enter']); enters++ },
  })
  assert.equal(prompts, 1); assert.equal(enters, 1, 'a working flash with staged input must still submit')
  assert.equal(isSpawning('p'), false)

  const root = mkdtempSync(join(tmpdir(), 'i653-delivery-')), tasks = join(root, 'TASKS')
  const prior = process.env.KANBAN_CONFIG
  process.env.KANBAN_CONFIG = join(root, 'board.config.json')
  writeFileSync(process.env.KANBAN_CONFIG, '{}')
  mkdirSync(join(tasks, 'working'), { recursive: true })
  writeFileSync(join(tasks, 'working', 'I653.md'), '# I653 — interrupted startup\n')
  t.after(() => { if (prior === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = prior; rmSync(root, { recursive: true, force: true }) })
  bind(tasks, 'I653', { pane_id: 'p', spawning: true })
  beginSpawn('p')
  try {
    assert.equal(routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'I653', reason: 'Session p is missing' }).column, 'working', 'active startup cannot be recovered by a concurrent poll')
    assert.equal(isSpawning('p'), true)
  } finally { endSpawn('p') }
  assert.equal(routeBuilderNoHandoff({ tasksDir: tasks, cardId: 'I653', reason: 'Session p is missing' }).column, 'queue')
  assert.equal(readWorkflow(tasks).I653.returns || 0, 0, 'interrupted startup is not a failed build')
})
