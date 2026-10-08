#!/usr/bin/env node
// Kanban Manager waiter. Run it with Bash run_in_background: it costs no tokens while
// it waits, and exits with one line when the Manager has something to do:
//   OWNER/POU <file>  a card landed in Owner or Pou
//   INBOX <line>      KANBAN_MANAGER-INBOX.md got a line (alerts, FOUND --board)
//   STUCK <project>   a project's stuck count went up and stayed up three minutes
//   RE-ARM            58 min passed quietly (a lifetime cap, so an orphan cannot outlive
//                     its chat the way `tail -F` did under Monitor)
// Re-run it after every wake.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.env.KM_ROOT || 'C:/Users/PFrew/KanbanProjects'
const INBOX = process.env.KM_INBOX || 'C:/Users/PFrew/Projects/_roles/KANBAN_MANAGER-INBOX.md'
const BOARD = 'http://127.0.0.1:7777/api/summary'
const LIFETIME_MS = 58 * 60e3 // operator 2026-10-05: wake hourly-ish, not every 30 min (Bash default timeout) or 12 h

const cards = () => readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).flatMap(d =>
  ['owner', 'pou'].flatMap(lane => {
    const dir = join(ROOT, d.name, 'TASKS', lane)
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => `${d.name}/${lane}/${f}`) : []
  }))
const inboxLines = () => { try { return readFileSync(INBOX, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const stuck = async () => {
  try {
    const { projects } = await (await fetch(BOARD, { signal: AbortSignal.timeout(30000) })).json()
    // An operator hold (agent cap 0, or a paused project) leaves cards waiting on purpose: not a stall to wake for.
    const held = JSON.parse(readFileSync(new URL('../board.config.json', import.meta.url), 'utf8')).maxConcurrentAgents === 0
    return Object.fromEntries(projects.map(p => [p.project, held || p.paused ? 0 : p.stuck || 0]))
  } catch { return null } // board down: the watchdog writes that to the inbox
}

const done = line => { console.log(line); process.exit(0) }
const seen = new Set(cards())
let lines = inboxLines().length
let stuckBefore = await stuck() ?? {}, rising = {}
const started = Date.now()

for (let tick = 0; ; tick++) {
  await new Promise(r => setTimeout(r, 10000))
  const added = cards().filter(c => !seen.has(c))
  if (added.length) done(`OWNER/POU ${added.join(', ')}`)
  const inbox = inboxLines()
  if (inbox.length > lines) done(`INBOX ${inbox.slice(lines).join('\n')}`)
  lines = inbox.length // after a trim, the next alert must still wake the Manager
  if (tick % 6 === 5) {
    const now = await stuck()
    if (now) {
      // A rise must hold for three minutes: a card whose blocker just landed reads "stuck"
      // until integration finishes and its Planner starts (I341 8 s, I344 68 s, 2026-09-27).
      const worse = Object.keys(now).filter(p => now[p] > (stuckBefore[p] || 0))
      for (const p of Object.keys(rising)) if (!worse.includes(p)) delete rising[p]
      for (const p of worse) rising[p] = (rising[p] || 0) + 1
      const confirmed = worse.filter(p => rising[p] >= 4)
      if (confirmed.length) done(`STUCK ${confirmed.map(p => `${p}=${now[p]}`).join(', ')}`)
      if (!worse.length) stuckBefore = now
    }
  }
  if (Date.now() - started > LIFETIME_MS) done('RE-ARM')
}
