#!/usr/bin/env node
// Kanban Manager waiter. Run it with Bash run_in_background: it costs no tokens while
// it waits, and exits with one line when the Manager has something to do:
//   OWNER/POU <file>  a card landed in Owner or Pou
//   INBOX <line>      KANBAN_MANAGER-INBOX.md got a line (alerts, FOUND --board)
//   STUCK <project>   a project's stuck count went up
//   RE-ARM            12 h passed quietly (a lifetime cap, so an orphan cannot outlive
//                     its chat the way `tail -F` did under Monitor)
// Re-run it after every wake.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.KM_ROOT || 'C:/Users/PFrew/KanbanProjects'
const INBOX = process.env.KM_INBOX || 'C:/Users/PFrew/Projects/_roles/KANBAN_MANAGER-INBOX.md'
const BOARD = 'http://127.0.0.1:7777/api/summary'
const LIFETIME_MS = 12 * 3600e3

const cards = () => readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d =>
  ['owner', 'pou'].flatMap(lane => {
    const dir = join(ROOT, d.name, 'TASKS', lane)
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => `${d.name}/${lane}/${f}`) : []
  }))
const inboxLines = () => { try { return readFileSync(INBOX, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const stuck = async () => {
  try {
    const { projects } = await (await fetch(BOARD, { signal: AbortSignal.timeout(30000) })).json()
    return Object.fromEntries(projects.map(p => [p.project, p.stuck || 0]))
  } catch { return null } // board down: the watchdog writes that to the inbox
}

const done = line => { console.log(line); process.exit(0) }
const seen = new Set(cards())
const lines = inboxLines().length
let stuckBefore = await stuck() ?? {}
const started = Date.now()

for (let tick = 0; ; tick++) {
  await new Promise(r => setTimeout(r, 10000))
  const added = cards().filter(c => !seen.has(c))
  if (added.length) done(`OWNER/POU ${added.join(', ')}`)
  const inbox = inboxLines()
  if (inbox.length > lines) done(`INBOX ${inbox.slice(lines).join('\n')}`)
  if (tick % 6 === 5) {
    const now = await stuck()
    if (now) {
      const worse = Object.keys(now).filter(p => now[p] > (stuckBefore[p] || 0))
      if (worse.length) done(`STUCK ${worse.map(p => `${p}=${now[p]}`).join(', ')}`)
      stuckBefore = now
    }
  }
  if (Date.now() - started > LIFETIME_MS) done('RE-ARM')
}
