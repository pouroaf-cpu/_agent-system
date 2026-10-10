#!/usr/bin/env node
// Project chat waiter, modelled on km-wait.mjs. Re-arm after handling its one line.
// Polling costs no tokens; integrated events never wake the chat. FOUND lines never wake it
// either: each wake is a BOARD EVENT on the operator's phone (Remote Control), so they wait in the
// inbox and the hourly re-arm reports only their count (operator via Injectbuddy work, 2026-10-09).
// ASK lines do wake it: a Planner question sat unanswered for up to an hour (operator, 2026-10-10).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIFETIME_MS = 58 * 60e3 // operator 2026-10-05: wake hourly-ish, not every 30 min (Bash default timeout) or 12 h
const lines = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }

export function planFails(root, sinceMs) {
  const fails = []
  try {
    for (const project of readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
      const dir = join(root, project.name, 'TASKS', '.history')
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl'))) {
        const path = join(dir, file)
        if (statSync(path).mtimeMs <= sinceMs) continue
        for (const line of lines(path)) {
          let event
          try { event = JSON.parse(line) } catch { continue }
          if (event.event !== 'plan-check' || event.verdict !== 'FAIL' || !(Date.parse(event.at) > sinceMs)) continue
          const reason = (event.reason || '').replace(/^Plan check: /, '').replace(/\s+/g, ' ').trim().slice(0, 300)
          fails.push(`${project.name} ${file.replace(/\.jsonl$/, '')}: ${reason}`)
        }
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return fails
}

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

// A STUCK wake names each card, its lane, how long and why, so the chat starts on the card
// instead of looking it up (operator, 2026-10-10: "STUCK Injectbuddy=1" alone was useless).
export const stuckCards = cards => cards.map(c => `${c.id} ${c.lane} ${c.minutes}m: ${c.reason || 'no reason given'}`).join('; ')
export async function stuckDetail(projects) {
  try {
    const { cards } = await (await fetch('http://127.0.0.1:7777/api/stuck?minutes=60', { signal: AbortSignal.timeout(30000) })).json()
    const listed = stuckCards(cards.filter(c => projects.includes(c.project)))
    return listed ? ` (${listed})` : ''
  } catch { return '' }
}

// Every 15 min, only while the project has cards that could move (no agent on them, not waiting on
// a decision, card, file or slot): the manager checks them. Pou is the operator's and Completed
// waits for a release, so neither counts (operator, 2026-10-10: "things are moving too slow").
export const CHECK_MS = 15 * 60e3
export const movable = cards => cards.filter(c => c.lane !== 'pou' && c.lane !== 'completed')
// Night stop (cap 0) or a paused project: no agent starts, so no card is stuck or could move.
// CHECK skipped this and woke the Injectbuddy chat every 15 min through the night stop (2026-10-10).
export const boardOff = (config, p) => config.maxConcurrentAgents === 0 || !!p?.paused
export const isAsk = line => / ASK \S+ \S+ \(/.test(line)
async function checkCards(project) {
  try {
    const { cards } = await (await fetch(`http://127.0.0.1:7777/api/stuck?minutes=15&project=${encodeURIComponent(project)}`, { signal: AbortSignal.timeout(30000) })).json()
    const list = movable(cards)
    return list.length ? `CHECK ${project}: ${list.length} card(s) could move, push each on (answer, approve, retry or card a fix): ${stuckCards(list)}` : null
  } catch { return null }
}

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
  let off = false
  const stuck = async () => {
    try {
      const { projects } = await (await fetch('http://127.0.0.1:7777/api/summary', { signal: AbortSignal.timeout(30000) })).json()
      const p = projects.find(p => p.project === project)
      off = boardOff(JSON.parse(readFileSync(new URL('../board.config.json', import.meta.url), 'utf8')), p)
      return p ? off ? 0 : p.stuck || 0 : null
    } catch { return null } // board down: the watchdog writes that to the inbox
  }
  const snapshot = stuck => ({ project, cards: cards(), inbox: lines(inbox), stuck })
  const started = Date.now(), inboxAtStart = lines(inbox).length
  // Compare lines, not counts: the chat trims handled lines while this waits.
  const seenAsks = new Set(lines(inbox).filter(isAsk)), newAsks = () => lines(inbox).filter(l => isAsk(l) && !seenAsks.has(l))
  let nextCheck = started + CHECK_MS
  let before = snapshot(null)
  before.stuck = await stuck()
  for (let tick = 0; ; tick++) {
    await new Promise(r => setTimeout(r, 10000))
    const now = snapshot(tick % 6 === 5 ? await stuck() : before.stuck)
    const wake = wakeDecision(before, now)
    if (wake) { console.log(wake.startsWith('STUCK') ? wake + await stuckDetail([project]) : wake); return }
    if (newAsks().length) {
      const added = await settled(newAsks, 0)
      console.log(`ASK ${added.length} new question(s) in ${inbox}: answer each now, or ask the operator in chat if only they can`)
      return
    }
    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + CHECK_MS
      const check = off ? null : await checkCards(project)
      if (check) { console.log(check); return }
    }
    if (now.stuck == null) now.stuck = before.stuck
    before = now // after a trim or a card leaving, its next arrival must still wake
    if (Date.now() - started > LIFETIME_MS) { console.log(digest(inboxAtStart, lines(inbox).length, inbox)); return }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
