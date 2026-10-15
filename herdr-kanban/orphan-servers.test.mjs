import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { statSync } from 'node:fs'
import { stopServersIn, stopServersInAsync, stopRunawayTsservers, stopOrphanWebKit, stopAgentLeftovers, stopDeadParentLeftovers, startLineReader, freeCommitGb, stopFreeCommitReader, procCwdDll, listNodeCwdScript, PROC_CWD_DLL } from './lib/orphan-servers.mjs'

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

// Agent leftovers (2026-10-16): the supervisor ends what the agent started when its turn ends. The rows
// stand for processes whose BOARD_AGENT_ID matches. Test runs and operator tools are kept.
test('the leftovers of a finished agent are ended; its test run, operator tools and the supervisor are not', async () => {
  const list = async id => { assert.equal(id, 'b-ab12'); return [
    { pid: 10, ppid: 900, cmd: 'node C:/Users/PFrew/KanbanProjects/Injectbuddy/node_modules/.bin/next dev' },
    { pid: 11, ppid: 10, cmd: 'node playwright worker' },
    { pid: 12, ppid: 900, cmd: 'node C:/Users/PFrew/Projects/herdr-kanban/lib/test-handoff-runner.mjs C:/rec.json' },
    { pid: 13, ppid: 12, cmd: 'node playwright worker' },
    { pid: 14, ppid: 900, cmd: 'bash -c "npx expo start"' },
    { pid: 15, ppid: 900, cmd: 'python -m basic_memory mcp' },
    { pid: process.pid, ppid: 900, cmd: 'node scripts/agent-process.mjs spec.json' },
  ] }
  const killed = []
  assert.deepEqual(await stopAgentLeftovers('b-ab12', { list, kill: async pid => killed.push(pid) }), [10, 11])
  assert.deepEqual(killed, [10, 11])
})

test('an agent id that is not a plain token lists nothing', async () => {
  const killed = []
  assert.deepEqual(await stopAgentLeftovers('x; rm -rf /', { list: async () => [{ pid: 1, cmd: 'node x' }], kill: async pid => killed.push(pid) }), [])
  assert.deepEqual(killed, [])
})

// The 2 h `find /` with no parent (2026-10-16): its parent is gone and it is older than 10 min, so it is ended.
test('dead-parent find, python, bash and board-path node leftovers older than 10 min are ended; the rest are not', async () => {
  const now = 1e12, old = now - 3600e3, young = now - 60e3
  let procs = [
    { pid: 1, ppid: 900, name: 'find.exe', cmd: 'find / -name "*.md"', created: old },
    { pid: 2, ppid: 901, name: 'python.exe', cmd: 'python -m basic_memory mcp', created: old },
    { pid: 3, ppid: 902, name: 'bash.exe', cmd: 'bash -c "npx expo start"', created: old },
    { pid: 4, ppid: 903, name: 'node.exe', cmd: 'node C:\\Users\\PFrew\\Projects\\Injectbuddy\\node_modules\\next\\dist\\bin\\next dev', created: old },
    { pid: 5, ppid: 904, name: 'node.exe', cmd: 'node C:\\Users\\PFrew\\KanbanProjects\\Injectbuddy\\stray.js', created: old },
    { pid: 6, ppid: 7, name: 'find.exe', cmd: 'find .', created: old - 1000 },
    { pid: 7, ppid: 1, name: 'explorer.exe', cmd: 'explorer', created: old - 5000 },
    { pid: 8, ppid: 900, name: 'find.exe', cmd: 'find . -name x', created: young },
    { pid: 9, ppid: 8, name: 'python.exe', cmd: 'python worker.py', created: old },
    { pid: 10, ppid: 905, name: 'chrome.exe', cmd: 'chrome', created: old },
    { pid: 20, ppid: 906, name: 'node.exe', cmd: 'node C:/Users/PFrew/Projects/herdr-kanban/lib/test-handoff-runner.mjs', created: old },
    { pid: 21, ppid: 20, name: 'find.exe', cmd: 'find . -name y', created: old },
  ]
  const list = async () => procs, killed = []
  // pid 9's parent (pid 8) is younger than pid 9, so pid 9 is an orphan by pid reuse. This mock keeps pid 9 alive,
  // so it is killed but not reported.
  const stopped = await stopDeadParentLeftovers({ now, list, kill: async pid => { killed.push(pid); if (pid !== 9) procs = procs.filter(p => p.pid !== pid) } })
  assert.deepEqual(stopped, [{ pid: 1, name: 'find.exe', cmd: 'find / -name "*.md"' }, { pid: 5, name: 'node.exe', cmd: 'node C:\\Users\\PFrew\\KanbanProjects\\Injectbuddy\\stray.js' }])
  assert.deepEqual(killed, [1, 5, 9])
})

test('a dead-parent leftover is reported only once it is gone after the kill', async () => {
  const now = 1e12, old = now - 3600e3
  assert.deepEqual(await stopDeadParentLeftovers({ now, list: async () => [{ pid: 1, ppid: 900, name: 'find.exe', cmd: 'find /', created: old }], kill: async () => {} }), [])
})

// 2026-10-16 speed audit: the memory gate asked PowerShell for free commit every 10 s, and the sweep
// compiled its C# on every listing. Both now keep one child (or one DLL) and reuse it.
test('the line reader answers each ask from one child, and a dead or stopped child resolves asks null', async () => {
  const echo = "process.stdin.on('data', d => { for (let i = 0; i < String(d).split('\\n').length - 1; i++) process.stdout.write('6291456\\n') })"
  const r = startLineReader(process.execPath, ['-e', echo])
  assert.deepEqual([await r.ask(), await r.ask(), await r.ask()], ['6291456', '6291456', '6291456'])
  assert.equal(r.alive(), true)
  r.stop()
  assert.equal(r.alive(), false)
  assert.equal(await r.ask(), null)
  const gone = startLineReader(process.execPath, ['-e', 'process.exit(0)'])
  assert.equal(await gone.ask(), null)
})

test('freeCommitGb reads free commit in GB on each call', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  try {
    const first = await freeCommitGb(), second = await freeCommitGb()
    assert.ok(first > 0 && second > 0, `${first} ${second}`)
  } finally { stopFreeCommitReader() }
})

test('the sweep C# is built once into a DLL under .agents, and the listing loads it instead of compiling', { skip: process.platform !== 'win32', timeout: 180000 }, async () => {
  const dll = await procCwdDll()
  assert.equal(dll, PROC_CWD_DLL)
  const built = statSync(dll).mtimeMs
  assert.equal(await procCwdDll(), dll)
  assert.equal(statSync(dll).mtimeMs, built, 'the second call does not compile again')
  assert.match(listNodeCwdScript(dll), /^Add-Type -LiteralPath '.*\.dll'\r?\n/)
  assert.doesNotMatch(listNodeCwdScript(dll), /TypeDefinition/)
  assert.match(listNodeCwdScript(null), /^Add-Type -TypeDefinition @'/, 'no DLL: compile inline, as before')
  // Runs the listing as the sweep does and checks this node process is listed with its working directory.
  const out = await new Promise((done, fail) => execFile('powershell', ['-NoProfile', '-Command', listNodeCwdScript(dll)], { encoding: 'utf8', timeout: 60000, windowsHide: true }, (err, o) => (err ? fail(err) : done(o))))
  const me = [JSON.parse(out)].flat().find(p => p.ProcessId === process.pid)
  assert.ok(me, 'this node process is listed')
  const norm = s => String(s).replace(/[\\/]+$/, '').toLowerCase()
  assert.equal(norm(me.Cwd), norm(process.cwd()))
})
