// Which herdr pane is running which card. Lives in <project>/TASKS/.board.json,
// gitignored, so cards themselves stay clean markdown that any agent can read.

import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { join } from 'node:path'
import { cachedAsync, execText } from './async-cache.mjs'

const file = (tasksDir) => join(tasksDir, '.board.json')
const lockFile = (tasksDir) => join(tasksDir, '.board.lock')

function valid(data) {
  return data && typeof data === 'object' && !Array.isArray(data) &&
    Object.values(data).every((binding) => binding && typeof binding === 'object' && typeof binding.pane_id === 'string')
}

// Where an unreadable state file is reported (the server routes it to the Kanban Manager
// inbox; the CLI keeps stderr). One report per file until it parses again.
let alert = (message) => console.error(message)
export function onBindingsAlert(fn) { alert = fn }
const alerted = new Set()

function parse(path) {
  const data = JSON.parse(readFileSync(path, 'utf8'))
  if (!valid(data)) throw new Error('invalid binding shape')
  return data
}

// A reader that meets the file mid-write (the writer renames a temp file, but a slow disk
// showed readers a half-written file 3 times and killed the server, audit 2026-10-15 F6)
// retries once after 50 ms. A file still unreadable then is reported once and read as empty,
// so a board payload or a lookup never takes the process down. Empty means "all slots are
// free", so the callers that decide slots or rewrite the file (liveBindings, mutate) read
// strictly and stop instead: a live Builder's claim is never guessed away or overwritten.
export function readBindings(tasksDir, { strict = false } = {}) {
  const path = file(tasksDir)
  if (!existsSync(path)) return {}
  let error
  for (const wait of [0, 50]) {
    if (wait) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait)
    try {
      const data = parse(path)
      alerted.delete(path)
      return data
    } catch (err) { error = err }
  }
  const message = `cannot read bindings at ${path}: ${error.message}`
  if (strict) throw new Error(message)
  if (!alerted.has(path)) {
    alerted.add(path)
    alert(message)
  }
  return {}
}

function write(tasksDir, data) {
  mkdirSync(tasksDir, { recursive: true })
  const path = file(tasksDir)
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, JSON.stringify(data, null, 2))
  renameSync(temp, path)
}

function alive(pid) {
  try { process.kill(Number(pid), 0); return true } catch { return false }
}

// Windows reuses PIDs quickly (after a crash or a forced restart), so a live PID does not
// prove a lock is still held. Its owner started before writing the lock; a process that
// reused the PID started after. Unreadable start time (a system process) is not an owner;
// a failed query is (never break a lock on doubt). Only called for locks past their bound.
// The start time is a PowerShell query (seconds on a loaded PC), so it is read in the background:
// until it is known the answer is undefined and the caller waits for the next attempt.
export function lockOwnerReplaced(pid, writtenAt) {
  return ownerReplaced(pid, writtenAt) === true
}

function ownerReplaced(pid, writtenAt) {
  if (process.platform !== 'win32') return false
  const { value, known } = cachedAsync(`owner-start:${Number(pid)}`, () => execText('powershell', ['-NoProfile', '-Command', `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if (!$p) { 'gone' } elseif ($p.StartTime) { ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } else { 'unreadable' }`], { timeout: 20000 }).then(out => out.trim()), { ttl: 60000 })
  if (!known) return undefined
  return value === 'gone' || value === 'unreadable' || Number(value) > writtenAt
}

function acquire(tasksDir) {
  mkdirSync(tasksDir, { recursive: true })
  const path = lockFile(tasksDir)
  const deadline = Date.now() + 5000
  let checkedOwner = false
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, 'wx')
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      return path
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      let ownerPending = false
      try {
        const pid = readFileSync(path, 'utf8').trim()
        const { mtimeMs } = statSync(path)
        let stale = (!pid || !alive(pid)) && Date.now() - mtimeMs > 1000
        // Board transactions take milliseconds; past 2 minutes, check the PID is still its owner.
        if (!stale && !checkedOwner && Date.now() - mtimeMs > 120000) {
          checkedOwner = true
          const replaced = ownerReplaced(pid, mtimeMs)
          // Start time still being read in the background: fail this attempt, the next one has the answer.
          ownerPending = replaced === undefined
          // The check takes a moment: only remove the same lock, not one another process just took.
          stale = replaced === true && statSync(path).mtimeMs === mtimeMs && readFileSync(path, 'utf8').trim() === pid
        }
        if (stale) {
          unlinkSync(path)
          continue
        }
      } catch {}
      if (ownerPending) throw new Error(`binding state is busy: ${path}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  throw new Error(`binding state is busy: ${path}`)
}

export function withBoardLock(tasksDir, change) {
  const lock = acquire(tasksDir)
  try {
    return change()
  } finally { try { unlinkSync(lock) } catch {} }
}

function mutate(tasksDir, change) {
  return withBoardLock(tasksDir, () => {
    const all = readBindings(tasksDir, { strict: true })
    const result = change(all)
    write(tasksDir, all)
    return result ?? all
  })
}

export function bind(tasksDir, cardId, binding) {
  return mutate(tasksDir, (all) => {
    all[cardId.toUpperCase()] = { ...binding, started: binding.started ?? new Date().toISOString() }
  })
}

export function unbind(tasksDir, cardId) {
  return mutate(tasksDir, (all) => { delete all[cardId.toUpperCase()] })
}

// A pane whose agent is still booting has no entry in `herdr agent list` yet, so
// it must be spared or every spawn would reap its own claim. Capped in time so a
// server that dies mid-spawn cannot leak a slot forever.
const SPAWN_GRACE_MS = 300000

const stillSpawning = (b, now) =>
  b.spawning && b.started && now - Date.parse(b.started) < SPAWN_GRACE_MS

// Bindings whose pane is genuinely still alive, per herdr's own agent list.
// A crashed pane must not hold a concurrency slot forever, so liveness is
// decided by herdr and never by this file alone.
export function liveBindings(tasksDir, agents, now = Date.now()) {
  const live = new Set(agents.map((a) => a.pane_id))
  const all = readBindings(tasksDir, { strict: true })
  return Object.fromEntries(
    Object.entries(all).filter(([, b]) => live.has(b.pane_id) || stillSpawning(b, now))
  )
}

// Drop bindings whose panes are gone. Returns the ids that were reaped.
export function reap(tasksDir, agents, now = Date.now()) {
  const panes = new Set(agents.map((agent) => agent.pane_id))
  return mutate(tasksDir, (all) => {
    const dead = Object.entries(all)
      .filter(([, binding]) => !panes.has(binding.pane_id) && !stillSpawning(binding, now))
      .map(([id]) => id)
    for (const id of dead) delete all[id]
    return dead
  })
}
