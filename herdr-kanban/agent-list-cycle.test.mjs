import childProcess from 'node:child_process'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'

const calls = []
let fail = false
const execFile = (bin, args, options, callback) => {
  calls.push(args)
  const session = args[0] === '--session' ? args[1] : 'default'
  const command = args[0] === '--session' ? args.slice(2) : args
  let result = {}
  if (command[0] === 'agent' && command[1] === 'list') result = fail ? {} : { agents: session === 'default' ? [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent_status: 'idle' },
    { pane_id: 'w2:p1', workspace_id: 'w2', agent_status: 'working' },
  ] : [{ pane_id: 'old:p1', agent_status: 'idle' }] }
  if (command[0] === 'workspace') result = { workspaces: [{ workspace_id: 'w1', label: 'Alpha' }, { workspace_id: 'w2', label: 'Beta' }] }
  if (command[0] === 'pane' && command[1] === 'list') result = { panes: [] }
  queueMicrotask(() => callback(null, JSON.stringify({ result }), ''))
}
execFile[promisify.custom] = (...args) => new Promise((resolve, reject) => execFile(...args, (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr })))
mock.module('node:child_process', { namedExports: { ...childProcess, execFile } })
mock.module('./lib/headless.mjs', { namedExports: { headless: { agentList: async () => [] }, isHeadless: () => false } })
const { agentList, withAgentListCycle, paneSendKeys } = await import('./lib/herdr.mjs')
const lists = () => calls.filter(args => args.includes('agent') && args.includes('list'))
const sharedLists = () => lists().filter(args => args[0] !== '--session')

test('poll cycle shares default and legacy lists, preserves project identity, and refreshes next cycle', async () => {
  calls.length = 0
  await withAgentListCycle(async () => {
    const [alpha, beta] = await Promise.all([agentList('alpha', { ensureSession: false }), agentList('beta', { ensureSession: false })])
    assert.deepEqual(alpha.map(a => a.pane_id), ['old:p1', 'w1:p1@default'])
    assert.deepEqual(beta.map(a => a.pane_id), ['old:p1', 'w2:p1@default'])
    await agentList('alpha', { ensureSession: false })
    assert.equal(sharedLists().length, 1)
    assert.equal(lists().length, 3, 'one shared list and one per legacy session')
  })
  await withAgentListCycle(() => agentList('alpha', { ensureSession: false }))
  assert.equal(sharedLists().length, 2)
  await agentList('alpha', { ensureSession: false })
  assert.equal(sharedLists().length, 3, 'calls outside a cycle are fresh')
})

test('pane mutation invalidates cycle inventory and failed inventories stay fail-closed', async () => {
  calls.length = 0
  await withAgentListCycle(async () => {
    await agentList('alpha', { ensureSession: false })
    await paneSendKeys('w1:p1@default', 'hello', 'alpha')
    await agentList('alpha', { ensureSession: false })
    assert.equal(sharedLists().length, 2)
  })
  fail = true
  try {
    await assert.rejects(withAgentListCycle(() => agentList('alpha', { ensureSession: false })), /malformed response/)
  } finally { fail = false }
  await withAgentListCycle(() => agentList('alpha', { ensureSession: false }))
})

test('an integration check lasting beyond the poll interval refreshes its inventory', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  calls.length = 0
  await withAgentListCycle(async () => {
    await agentList('alpha', { ensureSession: false })
    t.mock.timers.tick(60000)
    await agentList('alpha', { ensureSession: false })
    assert.equal(sharedLists().length, 2)
  })
})

test('mutations in another request invalidate inventories in an existing poll', async () => {
  calls.length = 0
  await withAgentListCycle(async () => {
    await agentList('alpha', { ensureSession: false })
    await withAgentListCycle(() => paneSendKeys('w1:p1@default', 'hello', 'alpha'))
    await agentList('alpha', { ensureSession: false })
    assert.equal(sharedLists().length, 2)
  })
})
