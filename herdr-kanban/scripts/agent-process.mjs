// Detached supervisor records the real exit even after the board has stopped.
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, unlinkSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { renameSync } from '../lib/fs-retry.mjs'
import { PaneProcessTrees } from '../lib/process-tree.mjs'
const file = process.argv[2]
const spec = JSON.parse(readFileSync(file, 'utf8'))
unlinkSync(file)
const child = spawn(spec.exe, spec.args, { cwd: spec.cwd, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true })
const report = message => { if (process.connected) process.send(message, () => {}) }
const finished = value => { writeFileSync(spec.exitFile + '.tmp', JSON.stringify(value)); renameSync(spec.exitFile + '.tmp', spec.exitFile) }
// Agents leave dev servers, browsers and MCP servers running after they exit (efficiency audit
// 2026-10-03; 52 stale herdr tabs the same day). Track the agent's tree while it runs and kill
// whatever is left when it exits. ponytail: 30 s snapshots; a grandchild born and orphaned
// between snapshots is missed.
const trees = new PaneProcessTrees()
const watch = () => trees.observe([{ key: 'agent', shellPid: child.pid }]).catch(() => {})
let timer, doneTimer
const cleanup = async () => { clearInterval(timer); clearInterval(doneTimer); await watch(); await trees.close('agent').catch(() => {}) }
// A finished turn whose process stays up (Codex waiting on a `next start` it launched held I683's
// integration for 7 minutes, 2026-10-03) is ended 30 s after its completion event.
const DONE = /"type":"(turn\.completed|turn\.failed|result)"/
const logStart = (() => { try { return statSync(spec.log).size } catch { return 0 } })()
let doneAt = 0
const turnDone = () => {
  if (!spec.log) return false
  let fd
  try {
    const size = statSync(spec.log).size, from = Math.max(logStart, size - 65536), buf = Buffer.alloc(size - from)
    fd = openSync(spec.log, 'r'); readSync(fd, buf, 0, buf.length, from)
    return DONE.test(buf.toString('utf8'))
  } catch { return false } finally { if (fd !== undefined) closeSync(fd) }
}
child.once('spawn', () => {
  report({ pid: child.pid }); watch(); timer = setInterval(watch, 30000)
  doneTimer = setInterval(() => {
    if (!doneAt && turnDone()) doneAt = Date.now()
    if (doneAt && Date.now() - doneAt > (spec.doneGraceMs ?? 30000)) { clearInterval(doneTimer); cleanup() } // the agent's exit then records it
  }, spec.donePollMs ?? 5000)
})
child.once('error', err => { console.error(err.message); clearInterval(timer); clearInterval(doneTimer); finished({ exitCode: 1, error: err.message }); report({ error: err.message }); process.exitCode = 1 })
child.once('exit', async (code, signal) => { await cleanup(); finished({ exitCode: code ?? 1, signal, childPid: child.pid }); process.exitCode = code ?? 1 })
