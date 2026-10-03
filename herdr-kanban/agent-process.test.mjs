import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }

test('the agent supervisor kills processes the agent leaves running when it exits', { skip: process.platform !== 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-process-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const leftover = join(dir, 'leftover.pid')
  // The fake agent starts a detached 2-minute sleeper (a dev server stand-in), waits for a
  // supervisor snapshot, then exits without stopping it.
  const agent = join(dir, 'agent.mjs')
  writeFileSync(agent, `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore', windowsHide: true }); c.unref()
writeFileSync(${JSON.stringify(leftover)}, String(c.pid)); setTimeout(() => {}, 4000)`)
  const spec = join(dir, 'spec.json'), exitFile = join(dir, 'exit.json')
  writeFileSync(spec, JSON.stringify({ exe: process.execPath, args: [agent], cwd: dir, exitFile }))
  const sup = spawn(process.execPath, [join(import.meta.dirname, 'scripts', 'agent-process.mjs'), spec], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  await new Promise(resolve => sup.once('exit', resolve))
  assert.ok(existsSync(exitFile), 'exit recorded')
  const pid = Number(readFileSync(leftover, 'utf8'))
  assert.equal(alive(pid), false, `leftover ${pid} should be gone`)
})
