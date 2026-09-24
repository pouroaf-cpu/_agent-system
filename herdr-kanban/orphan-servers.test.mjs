import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopServersIn } from './lib/orphan-servers.mjs'

test('servers left running in a card worktree are stopped; others are not (Tradeflow TF66 port 3100)', () => {
  const list = () => [
    { pid: 1, cmd: 'node C:/Work/.kanban-worktrees/Tradeflow/tf63-x/tradesflow-website/node_modules/.bin/../next/dist/bin/next start -p 3100' },
    { pid: 2, cmd: 'node C:\\Work\\.kanban-worktrees\\Tradeflow\\tf66-y\\node_modules\\next\\dist\\bin\\next dev' },
    { pid: 3, cmd: 'node C:\\Users\\me\\AppData\\npx\\chrome-devtools-mcp' },
  ]
  const killed = []
  assert.deepEqual(stopServersIn('C:\\Work\\.kanban-worktrees\\Tradeflow\\tf63-x', { list, kill: pid => killed.push(pid) }), [1])
  assert.deepEqual(killed, [1])
})
