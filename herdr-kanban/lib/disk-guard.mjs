// Free-space floor for the drive the board writes to (C: on this PC). Card checkouts with their
// node_modules and Next caches, dependency installs, Builder evidence and headless run logs all land
// there. C: reached 0.1 GB free and ENOSPC on 2026-10-15 02:00 NZ and ran out again on 2026-10-16
// around 05:00 NZ; the old 10-minute sample under 3 GB saw neither fall. Under DISK_LOW_GB no new
// agent, card worktree or install starts, and above DISK_RESUME_GB they resume (hysteresis).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'

export const DISK_SAMPLE_MS = 60000
export const DISK_LOW_GB = 6
export const DISK_RESUME_GB = 8
// Headless run logs and exit files older than this, and not held by a running agent, are deleted.
export const AGENT_LOG_KEEP_MS = 7 * 24 * 60 * 60000

// npm cache folder: the npm_config_cache variable, else the cache= line of the user .npmrc, else npm's default.
export function npmCacheDir({ env = process.env, home = homedir(), platform = process.platform } = {}) {
  if (env.npm_config_cache) return env.npm_config_cache
  try {
    const line = readFileSync(join(home, '.npmrc'), 'utf8').split(/\r?\n/).map(l => l.match(/^\s*cache\s*=\s*(.+?)\s*$/)).find(Boolean)
    if (line) return line[1].replace(/^["']|["']$/g, '')
  } catch { /* no user .npmrc: npm's default folder */ }
  return platform === 'win32' ? join(home, 'AppData', 'Local', 'npm-cache') : join(home, '.npm')
}

// Drive roots the board writes to: the projects root, the drive its junction points to (after the
// KanbanProjects move to F: the path stays on C: but the data does not), and the npm cache drive.
// Each root is listed once. Roots are checked with freeGb, so a folder that does not exist yet still counts.
export function diskWatchRoots(projectsRoot, options = {}) {
  const paths = [projectsRoot, npmCacheDir(options)]
  try { paths.push(realpathSync(projectsRoot)) } catch { /* projects root missing: its plain path stands */ }
  return [...new Set(paths.filter(Boolean).map(path => parse(resolve(path)).root))]
}

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
