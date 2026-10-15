import { formatNZTime } from './nz-time.mjs'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameSync } from './fs-retry.mjs'
import { historyFailures } from './metrics.mjs'
import { postInbox } from './inbox.mjs'
import { nextEventId } from './event-id.mjs'
import { failedTests, readTestRuns } from './test-runs.mjs'

export const ALERT_THRESHOLDS = {
  cardWindowMs: 24 * 60 * 60 * 1000, cardFailures: 3,
  burstWindowMs: 60 * 60 * 1000, kickBacks: 5, deliveryFailed: 3, noHandoff: 3,
  nightlyRuns: 2,
  // An alert is one message per condition: it stays quiet while its condition holds (a burst that
  // persists, a card that keeps failing) and re-arms only after the condition has been false for
  // rearmMs. A flap or a sliding window inside that time does not send it again (operator, 2026-10-16).
  rearmMs: 6 * 60 * 60 * 1000,
}
const INBOX = 'C:/Users/PFrew/Projects/_roles/KANBAN_MANAGER-INBOX.md'

function runFailures(run) {
  // The runner's summary caps names at 50; use the full report when available.
  if (run.report) {
    try { return failedTests(JSON.parse(readFileSync(run.report, 'utf8'))) } catch {}
  }
  return run.failures || []
}

// Board problems go to the Kanban Manager's inbox only; the operator's phone gets questions, not
// board alerts (operator, 2026-10-09).
export async function checkBoardAlerts({ project, tasksDir, now = Date.now(), inboxPath = INBOX, send = async () => {}, append = postInbox }) {
  const limits = ALERT_THRESHOLDS
  const events = await historyFailures(tasksDir, now - limits.cardWindowMs, now)
  const triggers = []
  // A stuck card or test alerts once a day; a burst can recur hourly.
  const add = (kind, subject, message) => triggers.push({ key: JSON.stringify([project, kind, subject]), message })
  for (const kind of ['builder-kick-back', 'plan-check-fail']) {
    const cards = new Map()
    for (const e of events.filter(e => e.event === kind)) cards.set(e.card, (cards.get(e.card) || 0) + 1)
    // A card that has since finished needs nobody (I565 went live after its kick-backs).
    const archived = id => { try { return readdirSync(join(tasksDir, 'archive')).some(n => n.toUpperCase().startsWith(`${id}-`) || n.toUpperCase() === `${id}.MD`) } catch { return false } }
    for (const [card, count] of cards) if (count >= limits.cardFailures && !archived(card)) add(kind, card, `${kind}: ${count} in 24h; cards ${card}`)
  }
  for (const [kind, threshold] of [['builder-kick-back', limits.kickBacks], ['builder-delivery-failed', limits.deliveryFailed], ['builder-no-handoff', limits.noHandoff]]) {
    const burst = events.filter(e => e.event === kind && e.time >= now - limits.burstWindowMs)
    if (burst.length >= threshold) add('burst-' + kind, '', `${kind} burst: ${burst.length} in 60m; cards ${[...new Set(burst.map(e => e.card))].join(', ')}`)
  }
  const nightly = readTestRuns(tasksDir, { limit: Infinity }).runs.filter(run => run.type === 'nightly').slice(0, limits.nightlyRuns)
  if (nightly.length === limits.nightlyRuns) {
    const failures = nightly.map(run => new Set(runFailures(run)))
    for (const name of failures[0]) {
      if (failures.every(names => names.has(name))) add('nightly-test', name, `e2e test ${name} failed in ${nightly.length} consecutive nightly runs`)
    }
  }
  const path = join(tasksDir, '.board-alerted.json')
  let previous = {}
  try { previous = JSON.parse(readFileSync(path, 'utf8')) } catch (err) { if (err.code !== 'ENOENT') throw err }
  // Records: { sent, seen }, where seen is the last time the condition held. Older state (a bare time) reads as both.
  const active = new Set(triggers.map(t => t.key))
  const next = {}
  for (const [key, raw] of Object.entries(previous)) {
    const rec = typeof raw === 'number' ? { sent: raw, seen: raw } : raw
    if (!rec || typeof rec.sent !== 'number' || typeof rec.seen !== 'number') continue
    if (now - rec.seen >= limits.rearmMs) continue // quiet for rearmMs: the next occurrence is news
    next[key] = active.has(key) ? { sent: rec.sent, seen: now } : rec
  }
  const fresh = triggers.filter(({ key }) => next[key] === undefined)
  for (const { key } of fresh) next[key] = { sent: now, seen: now }
  if (fresh.length || JSON.stringify(next) !== JSON.stringify(previous)) {
    // Persist before side effects, like owner alerts: an ambiguous timeout must not repeat a push.
    writeFileSync(path + '.tmp', JSON.stringify(next, null, 2))
    renameSync(path + '.tmp', path)
  }
  if (!fresh.length) return []
  const errors = []
  for (const { message } of fresh) {
    const eventId = nextEventId('BE')
    const line = `- ${eventId} ${formatNZTime(now)} ALERT ${project} ${message.replace(/[\r\n]+/g, ' ')}\n`
    try { await append(inboxPath, line) } catch (err) { errors.push(err) }
    try { await send(`${eventId} Board alert: ${project}`, message) } catch (err) { errors.push(err) }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(err => err.message).join('; '))
  return fresh.map(({ key }) => key)
}
