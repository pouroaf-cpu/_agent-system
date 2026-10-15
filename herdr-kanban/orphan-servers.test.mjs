import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stopServersIn, stopServersInAsync, stopRunawayTsservers, stopOrphanWebKit } from './lib/orphan-servers.mjs'

test('a tsserver spinning for hours on a board project is stopped; a fresh one or one elsewhere is not', async () => {
  const list = () => [
    { pid: 1, cpuSeconds: 36222, cmd: 'node c:\\Users\\me\\KanbanProjects\\Injectbuddy\\node_modules\\typescript\\lib\\tsserver.js --useNodeIpc' },
    { pid: 2, cpuSeconds: 60, cmd: 'node c:\\Users\\me\\KanbanProjects\\Tradeflow\\node_modules\\typescript\\lib\\tsserver.js' },
    { pid: 3, cpuSeconds: 36222, cmd: 'node c:\\Users\\me\\Projects\\Injectbuddy\\node_modules\\typescript\\lib\\tsserver.js' },
    { pid: 4, cpuSeconds: 36222, cmd: 'node C:\\Users\\me\\KanbanProjects\\Injectbuddy\\node_modules\\next\\dist\\bin\\next dev' },
  ]
  assert.deepEqual(await stopRunawayTsservers('C:\\Users\\me\\KanbanProjects', { list, kill: () => {} }), [1])
})

// IA235 and IA236 (2026-10-15): the Builder's session exit swept its worktree and killed the e2e run
// (runner and Playwright worker, both with the worktree as cwd) 14-20 s after submit.
test('a test-run runner and its workers are not swept with the worktree; a stray server still is', () => {
  const wt = 'C:/Users/PFrew/KanbanProjects/InjectbuddyApp-cards/ia236-x'
  const list = () => [
    { pid: 10, ppid: 1, cmd: 'node C:/Users/PFrew/Projects/herdr-kanban/lib/test-handoff-runner.mjs C:/rec.json', cwd: wt },
    { pid: 11, ppid: 10, cmd: 'cmd.exe /d /s /c "npx playwright test"', cwd: wt },
    { pid: 12, ppid: 11, cmd: 'node playwright worker', cwd: wt },
    { pid: 13, ppid: 99, cmd: 'node next dev', cwd: wt },
  ]
  const killed = []
  assert.deepEqual(stopServersIn(wt, { list, kill: pid => killed.push(pid) }), [13])
  assert.deepEqual(killed, [13])
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

test('a relative-path next server is found by its working directory; other worktrees and the board are not (audit 2026-09-26 #9)', () => {
  const list = () => [
    { pid: 27744, cwd: 'C:\\Work\\.worktrees\\Injectbuddy\\cards\\i227-x\\', cmd: '"C:\\Program Files\\nodejs\\node.exe" --env-file=C:/Users/me/Projects/Injectbuddy/.env.local node_modules/next/dist/bin/next start -p 3107' },
    { pid: 2, cwd: 'C:\\Work\\.worktrees\\Injectbuddy\\cards\\i227-x2\\', cmd: 'node node_modules/next/dist/bin/next dev -p 3108' },
    { pid: 3, cwd: 'C:\\Users\\me', cmd: 'node C:\\Work\\.worktrees\\Injectbuddy\\cards\\i227-x2\\node_modules\\next\\dist\\bin\\next dev' },
    { pid: process.pid, cwd: 'C:\\Work\\.worktrees\\Injectbuddy\\cards\\i227-x', cmd: 'node server.mjs' },
  ]
  const killed = []
  assert.deepEqual(stopServersIn('C:/Work/.worktrees/Injectbuddy/cards/i227-x', { list, kill: pid => killed.push(pid) }), [27744])
  assert.deepEqual(killed, [27744])
})

test('a WebKit process whose browser is gone is stopped; a live run, a fresh one and other programs are not (board down 2026-10-10)', async () => {
  const now = 1e12, old = now - 3600e3
  let procs = [
    { pid: 1, ppid: 900, name: 'WebKitNetworkProcess.exe', created: old },
    { pid: 2, ppid: 50, name: 'WebKitWebProcess.exe', created: old },
    { pid: 50, ppid: 900, name: 'Playwright.exe', created: old - 1000 },
    { pid: 3, ppid: 60, name: 'WebKitNetworkProcess.exe', created: old },
    { pid: 60, ppid: 4, name: 'node.exe', created: now - 60e3 },
    { pid: 4, ppid: 901, name: 'WebKitNetworkProcess.exe', created: now - 60e3 },
    { pid: 5, ppid: 902, name: 'chrome.exe', created: old },
  ]
  const list = () => procs, killed = []
  // pid 3 survives the kill, so it is not reported as stopped.
  assert.deepEqual(await stopOrphanWebKit({ now, list, kill: pids => { killed.push(...pids); procs = procs.filter(p => p.pid !== 1) } }), [1])
  assert.deepEqual(killed, [1, 3])
})

test('the async variant used when an agent finishes stops the same servers as the sync one', async () => {
  const list = async () => [
    { pid: 1, cmd: 'node C:/Work/.kanban-worktrees/Tradeflow/tf63-x/tradesflow-website/node_modules/.bin/../next/dist/bin/next start -p 3100' },
    { pid: 2, cmd: 'node C:\\Work\\.kanban-worktrees\\Tradeflow\\tf66-y\\node_modules\\next\\dist\\bin\\next dev' },
    { pid: 27744, cwd: 'C:\\Work\\.worktrees\\Injectbuddy\\cards\\i227-x\\', cmd: 'node node_modules/next/dist/bin/next start -p 3107' },
  ]
  const killed = []
  assert.deepEqual(await stopServersInAsync('C:\\Work\\.kanban-worktrees\\Tradeflow\\tf63-x', { list, kill: async pid => killed.push(pid) }), [1])
  assert.deepEqual(killed, [1])
  assert.deepEqual(await stopServersInAsync('C:/Work/.worktrees/Injectbuddy/cards/i227-x', { list, kill: async () => {} }), [27744])
})
