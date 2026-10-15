// A request that throws must answer 500 and leave the board up. /api/board for a project
// whose folder was deleted threw from an async handler and killed node (2026-09-25).
// Audit 2026-10-15 F6: a project whose Git root check fails is a project hold (200), a throw
// inside a poll or outside any handler is logged and alerted, and the next request answers.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function freePort() {
  const s = createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}

async function startServer(root, { projects, env = {} }) {
  const port = await freePort()
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port, mode: 'auto', projectsRoot: root.replace(/\\/g, '/'), projects,
    maxConcurrentAgents: 0, stallSeconds: 300, agentPollMs: 3600000,
    engine: { kind: 'codex' }, models: { working: 'test', review: 'test', issues: 'test' },
  }))
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-error-test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.on('data', () => {})
  const base = `http://127.0.0.1:${port}/api/board?project=`
  for (let i = 0; ; i++) {
    try { if ((await fetch(base + projects[0])).ok) break } catch {}
    if (i > 80 || child.exitCode !== null) throw new Error(`server did not start: ${stderr}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return { child, base, stderr: () => stderr }
}

const until = async (check, ms = 5000) => {
  for (let i = 0; i < ms / 50; i++) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

test('F6 AC2: a project whose folder is gone answers 200 with a project hold and the board stays up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-err-'))
  mkdirSync(join(root, 'Proj', 'TASKS', 'queue'), { recursive: true })
  mkdirSync(join(root, 'Plain', 'TASKS', 'queue'), { recursive: true })
  const { child, base, stderr } = await startServer(root, { projects: ['Proj', 'Gone', 'Plain'] })
  try {
    const gone = await fetch(base + 'Gone')
    assert.equal(gone.status, 200)
    const payload = await gone.json()
    assert.match(payload.projectHold, /^project held: git rev-parse failed/)
    assert.deepEqual(payload.board.queue, [])
    assert.match(stderr(), /Gone: project held: git rev-parse failed/)
    assert.equal(stderr().match(/Gone: project held/g).length, 1, 'the hold is logged once, not per request')
    // A folder without git is an ordinary non-Git project, not a hold.
    const plain = await (await fetch(base + 'Plain')).json()
    assert.equal(plain.projectHold, null)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(child.exitCode, null)
    assert.equal((await fetch(base + 'Proj')).status, 200)
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test('F6 AC3: a throw inside a poll, an uncaught exception and an unhandled rejection are logged, alerted, and the server answers the next request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-err-'))
  mkdirSync(join(root, 'Proj', 'TASKS', 'queue'), { recursive: true })
  const inbox = join(root, 'inbox', 'KANBAN_MANAGER-INBOX.md')
  const { child, base, stderr } = await startServer(root, { projects: ['Proj'], env: { KANBAN_FAULT: 'poll,uncaught,unhandled', KANBAN_ALERT_INBOX: inbox } })
  try {
    assert.ok(await until(() => /Proj: poll failed — injected poll fault/.test(stderr())), `poll fault not logged: ${stderr()}`)
    assert.ok(await until(() => /uncaught exception: Error: injected uncaught fault/.test(stderr())), `uncaught fault not logged: ${stderr()}`)
    assert.ok(await until(() => /unhandled rejection: Error: injected unhandled rejection/.test(stderr())), `unhandled rejection not logged: ${stderr()}`)
    assert.ok(await until(() => existsSync(inbox) && /uncaught fault/.test(readFileSync(inbox, 'utf8')) && /unhandled rejection/.test(readFileSync(inbox, 'utf8'))), 'inbox alert missing')
    const lines = readFileSync(inbox, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2, 'one inbox line per fault kind')
    assert.match(lines.find(l => /uncaught/.test(l)), /Board uncaught exception: Error: injected uncaught fault/)
    assert.equal(child.exitCode, null, 'the process is still up')
    const after = await fetch(base + 'Proj')
    assert.equal(after.status, 200)
    assert.equal((await after.json()).project, 'Proj')
    assert.doesNotMatch(readFileSync(join(root, 'Proj', 'TASKS', 'activity.log'), 'utf8'), /uncaught/, 'process faults are not card activity')
    assert.match(readFileSync(join(root, 'Proj', 'TASKS', 'activity.log'), 'utf8'), /poll-error.*injected poll fault/)
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
