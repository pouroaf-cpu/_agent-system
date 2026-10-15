// Board-wide cap on check runs (audit 2026-10-16 F3 and F7). One card check with its dev server
// and browsers costs 2-3 GB and about six threads, and two checks at once tripped the low-memory
// hold that stopped Builders. So at most CHECK_SLOTS checks run at once across every project, and
// each check runs with CHECK_WORKERS Playwright workers (PW_WORKERS, read by the project's config).
// A check that finds every slot held by a live process waits and logs one line. A slot is a file
// in the check-slots folder holding the pid of its check, so a check that dies frees its slot.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CHECK_SLOTS = 2
export const CHECK_WORKERS = 2
const WAIT_POLL_MS = 5000
// A slot file with no readable pid yet is still being written by the check that took it.
const WRITING_MS = 10000

// The board's .agents folder beside its config, as lib/headless.mjs does: a test run's temp config
// keeps its checks out of the live board's slots.
export const checkSlotDir = () => process.env.KANBAN_CONFIG
  ? join(dirname(process.env.KANBAN_CONFIG), '.agents', 'check-slots')
  : fileURLToPath(new URL('../.agents/check-slots', import.meta.url))

const alive = pid => { try { process.kill(pid, 0); return true } catch (err) { return err.code === 'EPERM' } }

// { pid, live } for a slot file that exists; null when it is gone.
function holderOf(file, now) {
  let text, mtimeMs
  try { text = readFileSync(file, 'utf8'); mtimeMs = statSync(file).mtimeMs } catch { return null }
  let pid = 0
  try { pid = Number(JSON.parse(text).pid) || 0 } catch { /* still being written */ }
  const live = pid ? alive(pid) : now - mtimeMs < WRITING_MS
  return { pid, live }
}

// Takes a free slot for pid and returns its file; null when every slot is held by a live check.
// Stale slots (dead pid) are removed. 'wx' makes creating a slot atomic across processes.
export function takeCheckSlot(dir, pid, { slots = CHECK_SLOTS, now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true })
  for (let i = 0; i < slots; i++) {
    const file = join(dir, `slot-${i}.json`)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(file, JSON.stringify({ pid, since: new Date(now).toISOString() }), { flag: 'wx' })
        return file
      } catch (err) { if (err.code !== 'EEXIST') throw err }
      const holder = holderOf(file, now)
      if (holder?.live) break
      rmSync(file, { force: true })
    }
  }
  return null
}

// Number of slots held by live checks.
export function busyCheckSlots(dir, { slots = CHECK_SLOTS, now = Date.now() } = {}) {
  let busy = 0
  for (let i = 0; i < slots; i++) if (holderOf(join(dir, `slot-${i}.json`), now)?.live) busy++
  return busy
}

export const releaseCheckSlot = file => { if (file) rmSync(file, { force: true }) }

// Resolves with a slot file once one is free. `announce` gets one line when the wait starts.
export async function waitForCheckSlot({ dir = checkSlotDir(), pid = process.pid, name = 'check', slots = CHECK_SLOTS, pollMs = WAIT_POLL_MS, announce = () => {} } = {}) {
  let announced = false
  for (;;) {
    const file = takeCheckSlot(dir, pid, { slots })
    if (file) return file
    if (!announced) {
      announced = true
      announce(`${name} waiting for a slot: ${busyCheckSlots(dir, { slots })} of ${slots} board checks running; it starts when one finishes`)
    }
    await new Promise(done => setTimeout(done, pollMs))
  }
}
