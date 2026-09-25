// A request that throws must answer 500 and leave the board up. /api/board for a project
// whose folder was deleted threw from an async handler and killed node (2026-09-25).
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

test('a project with no folder gets a 500 and the board stays up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hkb-err-'))
  mkdirSync(join(root, 'Proj', 'TASKS', 'queue'), { recursive: true })
  const port = await freePort()
  const configPath = join(root, 'board.config.json')
  writeFileSync(configPath, JSON.stringify({
    port, mode: 'auto', projectsRoot: root.replace(/\\/g, '/'), projects: ['Proj', 'Gone'],
    maxConcurrentAgents: 0, stallSeconds: 300, agentPollMs: 3600000,
    engine: { kind: 'codex' }, models: { working: 'test', review: 'test', issues: 'test' },
  }))
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('.', import.meta.url),
    env: { ...process.env, KANBAN_CONFIG: configPath, HERDR_BIN_PATH: 'missing-herdr-for-error-test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}/api/board?project=`
  try {
    for (let i = 0; ; i++) {
      try { if ((await fetch(base + 'Proj')).ok) break } catch {}
      if (i > 80 || child.exitCode !== null) throw new Error('server did not start')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal((await fetch(base + 'Gone')).status, 500)
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(child.exitCode, null)
    assert.equal((await fetch(base + 'Proj')).status, 200)
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})
