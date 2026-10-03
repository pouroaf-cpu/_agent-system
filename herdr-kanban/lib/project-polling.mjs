import { mkdirSync, readFileSync, watch } from 'node:fs'
import { join, relative } from 'node:path'

// Watch durable inputs, not poll output (logs, usage accounting and heartbeats).
export function startProjectPolling({ projects, tasksDirOf, agentsDir, sessionOf, poll, agentPollMs, onBusy = () => {}, watchFs = watch, onError = console.error }) {
  const timers = new Map(), running = new Set(), pending = new Set(), watchers = new Set(), contents = new Map()
  let closed = false, registry = []
  const readRegistry = () => JSON.parse(readFileSync(join(agentsDir, 'registry.json'), 'utf8'))
  try { registry = readRegistry() } catch (err) { if (err.code !== 'ENOENT') onError(err) }

  async function run(project) {
    if (closed) return
    if (running.has(project)) { pending.add(project); onBusy(project); return }
    clearTimeout(timers.get(project)); timers.delete(project)
    running.add(project)
    try { await poll(project) } catch (err) { onError(err) }
    finally {
      running.delete(project)
      if (pending.delete(project)) soon(project)
    }
  }
  function soon(project) {
    if (closed) return
    clearTimeout(timers.get(project))
    timers.set(project, setTimeout(() => { void run(project) }, 300))
  }
  function changed(file, removed = false) {
    let text
    try { text = readFileSync(file, 'utf8') } catch (err) { if (err.code !== 'ENOENT') return false }
    if (text === undefined && !contents.has(file) && !removed) return false
    if (contents.has(file) && contents.get(file) === text) return false
    contents.set(file, text)
    return true
  }
  function watchDir(dir, callback) {
    try {
      const watcher = watchFs(dir, { recursive: true }, callback)
      watchers.add(watcher)
      watcher.on('error', err => { watcher.close(); watchers.delete(watcher); onError(err) })
    } catch (err) { onError(err) }
  }
  for (const project of projects) {
    const dir = tasksDirOf(project)
    watchDir(dir, (event, filename) => {
      const name = filename?.toString().replaceAll('\\', '/')
      if (!name) return // Safety poll covers events without a usable filename.
      // Cards only: the board rewrites its dot-file state (.card-planners.json, .workflow-state.json,
      // .board.json) on every poll, and .evidence/.history/.briefs are agent output. A poll must
      // not retrigger itself; time-based work rides the safety interval.
      if (/\.md$/i.test(name) && !/(^|\/)\./.test(name)) {
        if (changed(join(dir, name), event === 'rename')) soon(project)
      } else if (event === 'rename' && !name.includes('.')) soon(project) // lane directories
    })
  }
  try { mkdirSync(agentsDir, { recursive: true }) } catch (err) { onError(err) }
  watchDir(agentsDir, (_event, filename) => {
    const name = filename?.toString().replaceAll('\\', '/')
    if (!name || name === 'registry.json') {
      try {
        const next = readRegistry()
        for (const project of projects) {
          const rows = list => list.filter(row => row.session === sessionOf(project))
          if (JSON.stringify(rows(next)) !== JSON.stringify(rows(registry))) soon(project)
        }
        registry = next
      } catch (err) { if (err.code !== 'ENOENT') onError(err) }
    }
    if (!name || name.endsWith('.exit.json')) {
      // Read the current registry too: an exit can race the launch registry write.
      let rows = registry
      try { rows = readRegistry() } catch {}
      for (const project of projects) {
        if (rows.some(row => row.session === sessionOf(project) && row.exitFile && (name ? relative(agentsDir, row.exitFile).replaceAll('\\', '/') === name : changed(row.exitFile)))) soon(project)
      }
    }
  })
  // Explicit shorter intervals remain useful for tests; never miss time-based work
  // for more than a minute. Without working watchers retain the old fast fallback.
  const intervalMs = Math.min(agentPollMs ?? (watchers.size ? 60000 : 5000), 60000)
  const interval = setInterval(() => { for (const project of projects) void run(project) }, intervalMs)
  for (const project of projects) void run(project)
  return { intervalMs, close() {
    closed = true
    clearInterval(interval)
    for (const timer of timers.values()) clearTimeout(timer)
    for (const watcher of watchers) watcher.close()
  } }
}
