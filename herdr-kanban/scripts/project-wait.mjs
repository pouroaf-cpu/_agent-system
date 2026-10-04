#!/usr/bin/env node
// Project chat waiter, modelled on km-wait.mjs. Re-arm after handling its one line.
// Polling costs no tokens; integrated events never wake the chat.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIFETIME_MS = 12 * 3600e3
const lines = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }

export function wakeDecision(before, now) {
  const added = now.cards.filter(c => !before.cards.includes(c))
  if (added.length) return `OWNER/POU ${added.join(', ')}`
  if (now.inbox.length > before.inbox.length) return `INBOX ${now.inbox.slice(before.inbox.length).join(' | ')}`
  const found = now.activity.slice(before.activity.length).find(line => !/\bevent=integrated\b/.test(line) && /\bFOUND\b|\bevent=found\b/.test(line))
  if (found) return `FOUND ${found}`
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
  const snapshot = stuck => ({ project, cards: cards(), inbox: lines(inbox), activity: lines(join(tasks, 'activity.log')), stuck })
  const started = Date.now()
  let before = snapshot(null)
  before.stuck = await stuck()
  for (let tick = 0; ; tick++) {
    await new Promise(r => setTimeout(r, 10000))
    const now = snapshot(tick % 6 === 5 ? await stuck() : before.stuck)
    const wake = wakeDecision(before, now)
    if (wake) { console.log(wake); return }
    if (now.stuck == null) now.stuck = before.stuck
    before = now // after a trim or a card leaving, its next arrival must still wake
    if (Date.now() - started > LIFETIME_MS) { console.log('RE-ARM'); return }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
