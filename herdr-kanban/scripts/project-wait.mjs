#!/usr/bin/env node
// Project chat waiter, modelled on km-wait.mjs. Re-arm after handling its one line.
// Polling costs no tokens; integrated events never wake the chat. ASK/FOUND lines never wake it
// either: each wake is a BOARD EVENT on the operator's phone (Remote Control), so they wait in the
// inbox and the hourly re-arm reports only their count (operator via Injectbuddy work, 2026-10-09).
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIFETIME_MS = 58 * 60e3 // operator 2026-10-05: wake hourly-ish, not every 30 min (Bash default timeout) or 12 h
const lines = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }

// Planners file ASK/FOUND lines in bursts (7 in 8 min on 2026-10-09 20:01) and each wake was
// its own BOARD EVENT on the operator's phone: wait for 2 quiet minutes (10 at most) and send
// the burst as one.
export async function settled(read, from, quietMs = 120e3, capMs = 600e3, tickMs = 10e3) {
  const start = Date.now()
  let seen = read().length, quietSince = Date.now()
  while (Date.now() - quietSince < quietMs && Date.now() - start < capMs) {
    await new Promise(r => setTimeout(r, tickMs))
    const n = read().length
    if (n !== seen) { seen = n; quietSince = Date.now() }
  }
  return read().slice(from)
}

export const digest = (before, now, file) => now > before ? `INBOX ${now - before} new ASK/FOUND line(s) in ${file}: read and handle them` : 'RE-ARM'

export function wakeDecision(before, now) {
  const added = now.cards.filter(c => !before.cards.includes(c))
  if (added.length) return `OWNER/POU ${added.join(', ')}`
  if (now.stuck != null && before.stuck != null && now.stuck > before.stuck) return `STUCK ${now.project}=${now.stuck}`
  return null
}

async function main() {
  const [flag, project, ...extra] = process.argv.slice(2)
  if (flag !== '--project' || !project || extra.length || /[\\/]|^\.{1,2}$/.test(project)) {
    console.error('Usage: project-wait.mjs --project <name>')
    process.exit(1)
  }
  const root = process.env.KM_ROOT || 'C:/Users/PFrew/KanbanProjects'
  const inbox = process.env.KM_INBOX || `C:/Users/PFrew/Projects/_roles/inbox/${project}-INBOX.md`
  const tasks = join(root, project, 'TASKS')
  const cards = () => ['owner', 'pou'].flatMap(lane => {
    const dir = join(tasks, lane)
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => `${project}/${lane}/${f}`) : []
  })
  const stuck = async () => {
    try {
      const { projects } = await (await fetch('http://127.0.0.1:7777/api/summary', { signal: AbortSignal.timeout(30000) })).json()
      const held = JSON.parse(readFileSync(new URL('../board.config.json', import.meta.url), 'utf8')).maxConcurrentAgents === 0
      const p = projects.find(p => p.project === project)
      return p ? held || p.paused ? 0 : p.stuck || 0 : null
    } catch { return null } // board down: the watchdog writes that to the inbox
  }
  const snapshot = stuck => ({ project, cards: cards(), inbox: lines(inbox), stuck })
  const started = Date.now(), inboxAtStart = lines(inbox).length
  let before = snapshot(null)
  before.stuck = await stuck()
  for (let tick = 0; ; tick++) {
    await new Promise(r => setTimeout(r, 10000))
    const now = snapshot(tick % 6 === 5 ? await stuck() : before.stuck)
    const wake = wakeDecision(before, now)
    if (wake) { console.log(wake); return }
    if (now.stuck == null) now.stuck = before.stuck
    before = now // after a trim or a card leaving, its next arrival must still wake
    if (Date.now() - started > LIFETIME_MS) { console.log(digest(inboxAtStart, lines(inbox).length, inbox)); return }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
