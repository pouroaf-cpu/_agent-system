// Detached runner for one handed-off test command (HK64): node test-handoff-runner.mjs <record.json>.
// Runs the command in the record's cwd, appends its output to the record's log, enforces the
// timeout and rewrites the record as state: 'finished'. Nothing here may end as 'running'.

import { spawn, execFileSync } from 'node:child_process'
import { openSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// Last Playwright/vitest "N passed" / "N failed", else node:test "# pass N" / "# fail N"; null when absent.
export function parseCounts(text) {
  const last = re => { const all = [...text.matchAll(re)]; return all.length ? Number(all.at(-1)[1]) : null }
  const passed = last(/(\d+) passed/g), failed = last(/(\d+) failed/g)
  if (passed !== null || failed !== null) return { passed, failed }
  return { passed: last(/^# pass (\d+)/gm), failed: last(/^# fail (\d+)/gm) }
}

// Temp file then rename, so a reader never sees half a record.
export function writeRecord(path, record) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(record, null, 2))
  renameSync(tmp, path)
}

const killTree = (pid) => {
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-pid, 'SIGKILL')
  } catch {}
}

export async function runRecord(recordPath) {
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  let finished = false
  const finish = (patch) => {
    if (finished) return
    finished = true
    let counts = { passed: null, failed: null }
    try { counts = parseCounts(readFileSync(record.log, 'utf8').slice(-200000)) } catch {}
    writeRecord(recordPath, { exitCode: null, signal: null, timedOut: false, error: null, ...record, ...counts, ...patch, state: 'finished', finishedAt: new Date().toISOString() })
  }
  try {
    writeRecord(recordPath, { ...record, pid: process.pid })
    const fd = openSync(record.log, 'a')
    let child
    try {
      child = spawn(record.command, { shell: true, cwd: record.cwd, stdio: ['ignore', fd, fd], windowsHide: true, detached: process.platform !== 'win32' })
    } finally { closeSync(fd) }
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, record.timeoutSeconds * 1000)
    await new Promise(resolve => {
      child.on('error', err => { clearTimeout(timer); finish({ error: err.message }); resolve() })
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer)
        finish({ exitCode, signal, timedOut, error: timedOut ? `timed out after ${record.timeoutSeconds} seconds` : null })
        resolve()
      })
    })
  } catch (err) { finish({ error: err.message }) }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await runRecord(process.argv[2])
}
