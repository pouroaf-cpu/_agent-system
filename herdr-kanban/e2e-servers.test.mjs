import test from 'node:test'
import assert from 'node:assert/strict'
import { stopStaleE2eServers } from './lib/orphan-servers.mjs'

test('abandoned claude-e2e dev servers over 4 h old are stopped; young ones and board servers are kept', () => {
  const now = Date.now(), killed = []
  const list = () => [
    { pid: 1, cmd: 'node node_modules/next/dist/bin/next dev -p 3471', cwd: String.raw`C:\Users\PFrew\claude-e2e-bmi`, created: now - 5 * 3600e3 },
    { pid: 2, cmd: 'node node_modules/next/dist/bin/next dev -p 3472', cwd: String.raw`C:\Users\PFrew\claude-e2e-hcg`, created: now - 3600e3 },
    { pid: 3, cmd: 'node node_modules/next/dist/bin/next dev', cwd: String.raw`C:\Users\PFrew\KanbanProjects\card`, created: now - 9 * 3600e3 },
    { pid: 4, cmd: 'node playwright test', cwd: String.raw`C:\Users\PFrew\claude-e2e-bmi`, created: now - 9 * 3600e3 },
  ]
  assert.deepEqual(stopStaleE2eServers({ now, list, kill: pid => killed.push(pid) }), [1])
  assert.deepEqual(killed, [1])
})
