import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHeadless } from './lib/headless.mjs'
import { usageLimit } from './lib/quota.mjs'

// HK32: a card agent's dev server must not outlive its session, whichever way the session ends.
// The fake agent starts the server through a short-lived intermediate node, so the server's parent
// is already dead and the process-tree snapshots never own it (the shape of the 13 Oct orphans).
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(fn, ms = 30000) { for (const end = Date.now() + ms; Date.now() < end;) { const result = await fn(); if (result) return result; await wait(100) } throw new Error('Timed out') }
const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }
const kill = pid => { try { process.kill(pid) } catch {} }
const sleeper = cwd => spawn(process.execPath, ['-e', 'setTimeout(()=>{},120000)'], { cwd, detached: true, stdio: 'ignore', windowsHide: true })
// Sits in tmp/agent.cjs; the worktree and pid folder are found from its own location.
const AGENT = `
const { spawnSync } = require('node:child_process'), path = require('node:path')
const worktree = path.join(__dirname, '.worktrees', 'Proj', 'cards', 'hk-x')
const file = path.join(__dirname, 'pids', process.env.BOARD_AGENT_ID + '.pid')
spawnSync(process.execPath, ['-e', 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},120000)"], { cwd: process.argv[1], detached: true, stdio: "ignore", windowsHide: true }); require("node:fs").writeFileSync(process.argv[2], String(c.pid)); c.unref()', worktree, file])
const mode = process.argv.at(-1)
if (mode === 'done') { console.log(JSON.stringify({ type: 'result', result: 'ok' })); process.exit(0) }
if (mode === 'limit') { console.log(JSON.stringify({ type: 'result', is_error: true, result: "You've hit your limit · resets 3pm" })); process.exit(1) }
setTimeout(() => {}, 60000)
`

async function scenario(run) {
  const tmp = mkdtempSync(join(tmpdir(), 'session-end-'))
  const worktree = join(tmp, '.worktrees', 'Proj', 'cards', 'hk-x'), sibling = join(tmp, '.worktrees', 'Proj', 'cards', 'hk-x2'), other = join(tmp, 'other')
  const app = join(worktree, 'app'), pids = join(tmp, 'pids')
  for (const dir of [app, sibling, other, pids]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(tmp, 'agent.cjs'), AGENT)
  const api = createHeadless({ root: join(tmp, 'agents'), command: () => [process.execPath, join(tmp, 'agent.cjs')] })
  const outside = [sleeper(sibling), sleeper(other)]
  const ids = []
  const start = async name => {
    const id = (await api.tabCreate({ cwd: app, label: name, session: 'project' })).root_pane.pane_id
    ids.push(id)
    await api.agentStart({ name, paneId: id, engine: 'codex', model: 'gpt-6-luna', session: 'project', browser: false, workspacePath: app, worktreePath: worktree })
    return id
  }
  const pidFile = id => join(pids, id + '.pid')
  const serverOf = id => until(() => existsSync(pidFile(id)) && readFileSync(pidFile(id), 'utf8')).then(Number)
  try {
    await run({ api, start, serverOf, assertOutsideAlive: () => outside.forEach(p => assert(alive(p.pid), `outside process ${p.pid} was stopped`)) })
  } finally {
    for (const id of ids) {
      if (existsSync(pidFile(id))) kill(Number(readFileSync(pidFile(id), 'utf8')))
      const row = api.getAgent(id)
      // Supervisor and agent only: paneClose would sweep the worktree again.
      for (const pid of [row.pid, row.childPid]) if (pid) kill(pid)
    }
    outside.forEach(p => kill(p.pid))
    await wait(500)
    try { rmSync(tmp, { recursive: true, force: true }) } catch {}
  }
}

const ended = (api, id) => until(async () => (await api.agentList('project')).find(a => a.pane_id === id)?.agent_status === 'done')

// The cases use separate worktrees, so they run side by side to fit run-tests.mjs's 60 s per file.
describe('card agent session end', { skip: process.platform !== 'win32', concurrency: true }, () => {
  let old, configDir
  before(() => {
    // A temp config keeps assertPromptAllowed away from the live board's.
    configDir = mkdtempSync(join(tmpdir(), 'session-end-config-')); writeFileSync(join(configDir, 'config.json'), '{}')
    old = process.env.KANBAN_CONFIG; process.env.KANBAN_CONFIG = join(configDir, 'config.json')
  })
  after(() => {
    if (old === undefined) delete process.env.KANBAN_CONFIG; else process.env.KANBAN_CONFIG = old
    rmSync(configDir, { recursive: true, force: true })
  })

  test('the server of a finished session is stopped, outside processes are not', () => scenario(async ({ api, start, serverOf, assertOutsideAlive }) => {
    const id = await start('b-hk-x')
    await api.agentPrompt(id, 'done', { session: 'project' })
    const server = await serverOf(id)
    await ended(api, id)
    await until(() => !alive(server))
    assertOutsideAlive()
  }))

  test('the server of a session that hit the usage limit is stopped', () => scenario(async ({ api, start, serverOf, assertOutsideAlive }) => {
    const id = await start('b-hk-x')
    await api.agentPrompt(id, 'limit', { session: 'project' })
    const server = await serverOf(id)
    await ended(api, id)
    assert(usageLimit(await api.paneRead(id)), 'the log must show the real usage-limit text')
    await until(() => !alive(server))
    assertOutsideAlive()
  }))

  test('the server of a session the board stops is stopped', () => scenario(async ({ api, start, serverOf, assertOutsideAlive }) => {
    const id = await start('b-hk-x')
    await api.agentPrompt(id, 'stay', { session: 'project' })
    const server = await serverOf(id)
    await api.paneClose(id)
    await until(() => !alive(server))
    assertOutsideAlive()
  }))

  test('closing one session leaves the server alone while another agent still works in the worktree', () => scenario(async ({ api, start, serverOf, assertOutsideAlive }) => {
    const first = await start('b-hk-x'), second = await start('r-hk-x')
    await api.agentPrompt(first, 'stay', { session: 'project' })
    await api.agentPrompt(second, 'stay', { session: 'project' })
    const [a, b] = [await serverOf(first), await serverOf(second)]
    await api.paneClose(first)
    await wait(3000)
    assert(alive(a) && alive(b), 'a sweep would have stopped the sibling agent')
    await api.paneClose(second)
    await until(() => !alive(a) && !alive(b))
    assertOutsideAlive()
  }))
})
