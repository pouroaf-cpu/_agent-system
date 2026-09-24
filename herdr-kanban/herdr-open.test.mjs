import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { openProjectSession, sessionOf } from './lib/herdr.mjs'

test('opens only a running project session and focuses its agents workspace', async () => {
  const calls = []
  const cli = async (args, options) => {
    calls.push({ args, options })
    if (args[1] === 'list' && args[0] === 'agent') return { agents: [] }
    if (args[1] === 'list' && args[0] === 'workspace') return { workspaces: [{ label: 'agents', workspace_id: 'w1' }] }
    return {}
  }
  let spawned
  const child = new EventEmitter()
  child.unref = () => { child.unrefed = true }

  await openProjectSession(sessionOf('My Project'), (...args) => { spawned = args; return child }, cli)

  assert.deepEqual(calls.map(({ args }) => args), [
    ['agent', 'list'], ['workspace', 'list'], ['workspace', 'focus', 'w1'],
  ])
  assert.ok(calls.every(({ options }) => options.session === 'my-project' && options.ensureSession === false))
  assert.deepEqual(spawned, [process.env.HERDR_BIN_PATH || 'herdr', ['session', 'attach', 'my-project'], { detached: true, stdio: 'ignore', windowsHide: false }])
  assert.equal(child.unrefed, true)
})

test('a stopped session reports unavailable without spawning a client', async () => {
  let spawns = 0
  await assert.rejects(openProjectSession('stopped', () => { spawns++ }, async () => { throw new Error('server_not_running') }), /session stopped is unavailable/)
  assert.equal(spawns, 0)
})

test('POST route validates projects and returns a stopped-session error', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'herdr-open-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const port = await new Promise((resolvePort, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(error => error ? reject(error) : resolvePort(address.port))
    })
  })
  const configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ port, projectsRoot: root, projects: ['herdr-kanban'], maxConcurrentAgents: 0, agentPollMs: 60000, agentWorkspace: 'agents' }))
  const workspace = import.meta.dirname
  const child = spawn(process.execPath, [join(workspace, 'server.mjs')], {
    cwd: workspace,
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: join(root, 'missing-herdr.exe') },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode !== null) return
    child.kill()
    await once(child, 'exit')
  })
  const output = createInterface({ input: child.stdout })
  await new Promise((resolveReady, reject) => {
    output.on('line', line => { if (line.includes(`127.0.0.1:${port}`)) resolveReady() })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`server exited before listening (${code})`)))
  })

  const post = project => fetch(`http://127.0.0.1:${port}/api/herdr-open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }),
  })
  const invalid = await post('other-project')
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error, 'Unknown project')
  const stopped = await post('herdr-kanban')
  assert.equal(stopped.status, 400)
  assert.match((await stopped.json()).error, /session herdr-kanban is unavailable/)

  const html = await readFile(join(workspace, 'public/index.html'), 'utf8')
  const board = await readFile(join(workspace, 'public/board.js'), 'utf8')
  assert.match(html, /id="herdr-open"[^>]*type="button"[^>]*>Open herdr/)
  assert.match(board, /getElementById\('herdr-open'\)\.addEventListener\('click'/)
  assert.match(board, /fetch\('\/api\/herdr-open'/)
  assert.match(board, /catch \(error\) \{ toast\(error\.message\); \}\s*finally \{ button\.disabled = false; \}/)
})
