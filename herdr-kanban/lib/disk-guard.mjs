// Free-space floor for the drive the board writes to (C: on this PC). Card checkouts with their
// node_modules and Next caches, dependency installs, Builder evidence and headless run logs all land
// there. C: reached 0.1 GB free and ENOSPC on 2026-10-15 02:00 NZ and ran out again on 2026-10-16
// around 05:00 NZ; the old 10-minute sample under 3 GB saw neither fall. Under DISK_LOW_GB no new
// agent, card worktree or install starts, and above DISK_RESUME_GB they resume (hysteresis).
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const DISK_SAMPLE_MS = 60000
export const DISK_LOW_GB = 6
export const DISK_RESUME_GB = 8
// Headless run logs and exit files older than this, and not held by a running agent, are deleted.
export const AGENT_LOG_KEEP_MS = 7 * 24 * 60 * 60000

// state: { low }. event is 'low', 'resume' or 'none'.
export function applyDiskReading({ low = false }, gb) {
  if (!low && gb < DISK_LOW_GB) return { low: true, event: 'low' }
  if (low && gb > DISK_RESUME_GB) return { low: false, event: 'resume' }
  return { low, event: 'none' }
}

// Deletes old headless-* logs and exit files in the headless root (.agents beside the board). Files
// a row with no endedAt (still running) points at are kept. A registry that will not parse means the
// live logs are unknown, so nothing is deleted.
export function pruneAgentLogs({ root, now = Date.now(), maxAgeMs = AGENT_LOG_KEEP_MS }) {
  const registry = join(root, 'registry.json')
  let rows = []
  if (existsSync(registry)) {
    try { rows = JSON.parse(readFileSync(registry, 'utf8')) } catch { return { skipped: true, removed: 0, bytes: 0 } }
    if (!Array.isArray(rows)) return { skipped: true, removed: 0, bytes: 0 }
  }
  const held = new Set(rows.filter(row => !row.endedAt).flatMap(row => [row.log, row.exitFile]).filter(Boolean).map(path => resolve(path)))
  let removed = 0, bytes = 0
  for (const name of readdirSync(root)) {
    if (!name.startsWith('headless-')) continue
    const path = join(root, name)
    if (held.has(resolve(path))) continue
    let info
    try { info = statSync(path) } catch { continue }
    if (!info.isFile() || now - info.mtimeMs < maxAgeMs) continue
    try { unlinkSync(path); removed++; bytes += info.size } catch { /* in use: the next sweep retries */ }
  }
  return { skipped: false, removed, bytes }
}
