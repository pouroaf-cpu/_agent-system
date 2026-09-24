import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopServersIn, stopRunawayTsservers } from './lib/orphan-servers.mjs'

test('a tsserver spinning for hours on a board project is stopped; a fresh one or one elsewhere is not', () => {
  const list = () => [
    { pid: 1, cpuSeconds: 36222, cmd: 'node c:\\Users\\me\\KanbanProjects\\Injectbuddy\\node_modules\\typescript\\lib\\tsserver.js --useNodeIpc' },
    { pid: 2, cpuSeconds: 60, cmd: 'node c:\\Users\\me\\KanbanProjects\\Tradeflow\\node_modules\\typescript\\lib\\tsserver.js' },
    { pid: 3, cpuSeconds: 36222, cmd: 'node c:\\Users\\me\\Projects\\Injectbuddy\\node_modules\\typescript\\lib\\tsserver.js' },
    { pid: 4, cpuSeconds: 36222, cmd: 'node C:\\Users\\me\\KanbanProjects\\Injectbuddy\\node_modules\\next\\dist\\bin\\next dev' },
  ]
  assert.deepEqual(stopRunawayTsservers('C:\\Users\\me\\KanbanProjects', { list, kill: () => {} }), [1])
})

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
