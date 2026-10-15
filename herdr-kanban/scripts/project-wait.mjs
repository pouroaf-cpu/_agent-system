#!/usr/bin/env node
// Project chat waiter, modelled on km-wait.mjs. Re-arm after handling its one line.
// Polling costs no tokens; integrated events never wake the chat. FOUND lines never wake it
// either: each wake is a BOARD EVENT on the operator's phone (Remote Control), so they wait in the
// inbox and the hourly re-arm reports only their count (operator via Injectbuddy work, 2026-10-09).
// ASK lines do wake it: a Planner question sat unanswered for up to an hour (operator, 2026-10-10).
// --wake-inbox makes every new inbox line wake it at once (Token Manager: its HK43 alerts are plain lines).
// A respawned waiter starts with no memory of a STUCK or CHECK card it already woke for, so those are
// also kept in a wake ledger (lib/waiter-wakes.mjs): the same unchanged card is silent for 6 h
// (operator, 2026-10-16: STUCK I1322 woke the Injectbuddy chat six times overnight).
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inboxLog } from '../lib/inbox.mjs'
import { nextEventId } from '../lib/event-id.mjs'
import { wakeLedger } from '../lib/waiter-wakes.mjs'

// One board event ID per printed wake (HK57); RE-ARM and anything unlisted print unchanged.
const WAKE_KIND = { 'OWNER/POU': 'CL', STUCK: 'SK', CHECK: 'CK', PLANFAIL: 'PF', INBOX: 'IW', ASK: 'IW' }
export function withEventId(text) {
  const kind = WAKE_KIND[text.split(/[ \n]/)[0]]
  return kind ? `${nextEventId(kind)} ${text}` : text
}

const LIFETIME_MS = 58 * 60e3 // operator 2026-10-05: wake hourly-ish, not every 30 min (Bash default timeout) or 12 h
const lines = file => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }

export function planSinceFrom(savedText, now) {
  const saved = Number(savedText)
  if (!savedText?.trim() || !Number.isFinite(saved) || saved > now) return now
  return Math.max(saved, now - 2 * 60 * 60e3)
}

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
// A chat that clears handled lines mid-wait must not lose the lines that woke us (HK18 FOUND,
// 13 Oct 2026): keep every line first seen past `from`, then add later ones, each once.
export async function settled(read, from, quietMs = 120e3, capMs = 600e3, tickMs = 10e3) {
  const start = Date.now()
  const first = read()
  const older = new Set(first.slice(0, from)), got = [...new Set(first.slice(from))]
  const take = list => { for (const l of list) if (!older.has(l) && !got.includes(l)) got.push(l) }
  let seen = first.length, quietSince = Date.now()
  while (Date.now() - quietSince < quietMs && Date.now() - start < capMs) {
    await new Promise(r => setTimeout(r, tickMs))
    const now = read()
    take(now)
    if (now.length !== seen) { seen = now.length; quietSince = Date.now() }
  }
  take(read())
  return got
}

// Never a bare INBOX / "ASK 0": when the .md was emptied, the new lines come from its .log.
const nothing = file => `the inbox changed but holds nothing to read (${file} was emptied; ${inboxLog(file)} has no new line)`
export const inboxWake = (added, logged, file) => `INBOX ${(added.length ? added : logged.length ? logged : [nothing(file)]).join('\n')}`
export function askWake(added, logged, file) {
  const got = added.length ? added : logged
  if (!got.length) return `ASK the inbox ${file} changed with nothing to read (see ${inboxLog(file)})`
  return `ASK ${got.length} new question(s) in ${file}: answer each now, or ask the operator in chat if only they can` + (added.length ? '' : `\n${got.join('\n')}`)
}

export const digest = (before, now, file) => now > before ? `INBOX ${now - before} new ASK/FOUND line(s) in ${file}: read and handle them` : 'RE-ARM'

// A STUCK wake names each card, its lane, how long and why, so the chat starts on the card
// instead of looking it up (operator, 2026-10-10: "STUCK Injectbuddy=1" alone was useless).
export const stuckCards = cards => cards.map(c => `${c.id} ${c.lane} ${c.minutes}m: ${c.reason || 'no reason given'}`).join('; ')
// Cards stuck at 60 min: every project's, or one project's when given.
export async function stuckList(project) {
  const only = project ? `&project=${encodeURIComponent(project)}` : ''
  const { cards } = await (await fetch(`http://127.0.0.1:7777/api/stuck?minutes=60${only}`, { signal: AbortSignal.timeout(30000) })).json()
  return cards
}
export async function stuckDetail(projects) {
  try {
    const listed = stuckCards((await stuckList()).filter(c => projects.includes(c.project)))
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
async function checkList(project) {
  try {
    const { cards } = await (await fetch(`http://127.0.0.1:7777/api/stuck?minutes=15&project=${encodeURIComponent(project)}`, { signal: AbortSignal.timeout(30000) })).json()
    return movable(cards)
  } catch { return null }
}

// Wake conditions the ledger remembers (lib/waiter-wakes.mjs): stuck and check cards only, keyed by
// id and reason, so a new card or a new reason is news and the same card with the same reason is not.
// OWNER/POU arrivals and inbox lines are not kept: a card that leaves and comes back is new work.
export const stuckKey = c => `stuck:${c.project}:${c.id}:${c.reason || ''}`
export const checkKey = c => `check:${c.id}:${c.reason || ''}`
export const checkWake = (project, list) => list.length ? `CHECK ${project}: ${list.length} card(s) could move, push each on (answer, approve, retry or card a fix): ${stuckCards(list)}` : null

// wakeDecision with the ledger applied to STUCK. A stuck card the ledger saw within its re-arm window
// does not count as news, so a respawn whose baseline count dipped to 0 stays quiet. `now.stuckCards` is
// the stuck list read on this tick; without one, or empty while the count rose, the count alone decides.
export function ledgerDecision(before, now, ledger, at, wakeInbox = false) {
  const stuckNews = !now.stuckCards?.length || now.stuckCards.some(c => ledger.isNews(stuckKey(c), at))
  return wakeDecision(before, { ...now, stuck: stuckNews ? now.stuck : before.stuck }, wakeInbox)
}

// The 15-minute CHECK wakes only when one of its movable cards is news. Unchanged cards stay quiet.
export function checkDecision(project, list, ledger, at) {
  return list.some(c => ledger.isNews(checkKey(c), at)) ? checkWake(project, list) : null
}

export function wakeDecision(before, now, wakeInbox = false) {
  const added = now.cards.filter(c => !before.cards.includes(c))
  if (added.length) return `OWNER/POU ${added.join(', ')}`
  // Lines, not counts: the chat trims handled lines. lines() already drops blank ones.
  const fresh = wakeInbox ? now.inbox.filter(l => !before.inbox.includes(l)) : []
  if (fresh.length) return `INBOX ${fresh.join('\n')}`
  if (now.stuck != null && before.stuck != null && now.stuck > before.stuck) return `STUCK ${now.project}=${now.stuck}`
  return null
}

export function parseArgs(argv) {
  const [flag, project, ...extra] = argv
  if (flag !== '--project' || !project || /[\\/]|^\.{1,2}$/.test(project)) return null
  if (extra.length > 1 || (extra.length && extra[0] !== '--wake-inbox')) return null
  return { project, wakeInbox: extra.length === 1 }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args) {
    console.error('Usage: project-wait.mjs --project <name> [--wake-inbox]')
    process.exit(1)
  }
  const { project, wakeInbox } = args
  const root = process.env.KM_ROOT || 'C:/Users/PFrew/KanbanProjects'
  const inbox = process.env.KM_INBOX || `C:/Users/PFrew/Projects/_roles/inbox/${project}-INBOX.md`
  const tasks = join(root, project, 'TASKS')
  const cards = () => ['owner', 'pou'].flatMap(lane => {
    const dir = join(tasks, lane)
    return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'README.md').map(f => `${project}/${lane}/${f}`) : []
  })
  let off = false, listed // listed: the stuck cards read on the last check tick (undefined when unreadable)
  const stuck = async () => {
    listed = undefined
    try {
      const { projects } = await (await fetch('http://127.0.0.1:7777/api/summary', { signal: AbortSignal.timeout(30000) })).json()
      const p = projects.find(p => p.project === project)
      off = boardOff(JSON.parse(readFileSync(new URL('../board.config.json', import.meta.url), 'utf8')), p)
      const count = p ? off ? 0 : p.stuck || 0 : null
      if (count !== null) listed = count ? await stuckList(project).catch(() => undefined) : []
      return count
    } catch { return null } // board down: the watchdog writes that to the inbox
  }
  const snapshot = stuck => ({ project, cards: cards(), inbox: lines(inbox), stuck })
  // Stuck cards this waiter has seen, so a respawn stays quiet about them for the re-arm window.
  const stuckHeld = snap => (snap.stuckCards || []).map(stuckKey)
  const ledger = wakeLedger(process.env.KM_WAKES || join(tmpdir(), `project-wait-${project}.json`))
  // Records what held, persists it, then prints: a respawned waiter must read the wake it is answering.
  const finish = (line, keys) => { ledger.observe(keys, Date.now()); ledger.flush(Date.now(), { force: true }); console.log(withEventId(line)) }
  const started = Date.now(), inboxAtStart = lines(inbox).length, logFrom = lines(inboxLog(inbox)).length
  // Compare lines, not counts: the chat trims handled lines while this waits.
  const seenAsks = new Set(lines(inbox).filter(isAsk))
  const newAsks = () => lines(inbox).filter(l => isAsk(l) && !seenAsks.has(l))
  let nextCheck = started + CHECK_MS
  let before = snapshot(null)
  before.stuck = await stuck()
  before.stuckCards = listed
  ledger.observe(stuckHeld(before), Date.now())
  for (let tick = 0; ; tick++) {
    await new Promise(r => setTimeout(r, 10000))
    const checkNow = tick % 6 === 5
    const now = snapshot(checkNow ? await stuck() : before.stuck)
    if (checkNow) now.stuckCards = listed
    const wake = ledgerDecision(before, now, ledger, Date.now(), wakeInbox)
    if (wake) { finish(wake.startsWith('STUCK') ? wake + await stuckDetail([project]) : wake, stuckHeld(now)); return }
    if (newAsks().length) {
      const added = await settled(newAsks, 0)
      finish(askWake(added, lines(inboxLog(inbox)).slice(logFrom).filter(isAsk), inbox), stuckHeld(now))
      return
    }
    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + CHECK_MS
      const list = off ? null : await checkList(project)
      if (list) {
        const check = checkDecision(project, list, ledger, Date.now())
        if (check) { finish(check, [...stuckHeld(now), ...list.map(checkKey)]); return }
        ledger.observe(list.map(checkKey), Date.now())
      }
    }
    if (now.stuck == null) now.stuck = before.stuck
    ledger.observe(stuckHeld(now), Date.now())
    ledger.flush(Date.now())
    before = now // after a trim or a card leaving, its next arrival must still wake
    if (Date.now() - started > LIFETIME_MS) { finish(digest(inboxAtStart, lines(inbox).length, inbox), stuckHeld(now)); return }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
