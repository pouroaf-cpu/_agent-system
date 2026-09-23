// node --test test-lan-access.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function freePort() {
  const s = createServer()
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = s.address().port
  await new Promise((resolve) => s.close(resolve))
  return port
}

async function waitFor(url, child) {
  let last
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`)
    try {
      const r = await fetch(url)
      if (r.ok) return
      last = new Error(`${url} -> ${r.status}`)
    } catch (err) {
      last = err
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw last
}

test('loopback and opt-in LAN listener work, and bad-origin writes are refused', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-lan-'))
  const project = join(root, 'Proj')
  const tasks = join(project, 'TASKS')
  mkdirSync(join(tasks, 'queue'), { recursive: true })
  mkdirSync(join(tasks, 'working'), { recursive: true })
  writeFileSync(join(tasks, 'queue', 'T-01-lan.md'), '# T-01 - LAN check\n\n**Priority** 1/10\n')

  const port = await freePort()
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port,
    mode: 'auto',
    projectsRoot: root.replace(/\\/g, '/'),
    projects: ['Proj'],
    maxConcurrentAgents: 0,
    stallSeconds: 300,
    agentPollMs: 3600000,
    engine: { kind: 'codex' },
    models: { working: 'test', review: 'test', issues: 'test' },
  }))

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: {
      ...process.env,
      KANBAN_CONFIG: configPath,
      KANBAN_LAN_HOST: '127.0.0.2',
      HERDR_BIN_PATH: 'missing-herdr-for-lan-test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  try {
    await waitFor(`http://127.0.0.1:${port}/api/board?project=Proj`, child)
    await waitFor(`http://127.0.0.2:${port}/api/board?project=Proj`, child)

    const rejected = await fetch(`http://127.0.0.1:${port}/api/move`, {
      method: 'POST',
      headers: { Origin: 'http://example.test', 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: 'Proj', id: 'T-01', to: 'working' }),
    })
    assert.equal(rejected.status, 403)

    const board = await (await fetch(`http://127.0.0.1:${port}/api/board?project=Proj`)).json()
    assert.deepEqual(board.board.queue.map((c) => c.id), ['T-01'])
    assert.deepEqual(board.board.working, [])
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
