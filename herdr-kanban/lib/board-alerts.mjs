import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renameSync } from './fs-retry.mjs'
import { historyFailures } from './metrics.mjs'
import { pushover } from './owner-alerts.mjs'
import { failedTests, readTestRuns } from './test-runs.mjs'

export const ALERT_THRESHOLDS = {
  cardWindowMs: 24 * 60 * 60 * 1000, cardFailures: 3,
  burstWindowMs: 60 * 60 * 1000, kickBacks: 5, deliveryFailed: 3, noHandoff: 3,
  nightlyRuns: 2, dedupeMs: 60 * 60 * 1000,
}
const INBOX = 'C:/Users/PFrew/Projects/_roles/KANBAN_MANAGER-INBOX.md'

function runFailures(run) {
  // The runner's summary caps names at 50; use the full report when available.
  if (run.report) {
    try { return failedTests(JSON.parse(readFileSync(run.report, 'utf8'))) } catch {}
  }
  return run.failures || []
}

export async function checkBoardAlerts({ project, tasksDir, now = Date.now(), inboxPath = INBOX, send = pushover, append = appendFileSync }) {
  const limits = ALERT_THRESHOLDS
  const events = await historyFailures(tasksDir, now - limits.cardWindowMs, now)
  const triggers = []
  // A stuck card or test alerts once a day; a burst can recur hourly.
  const add = (kind, subject, message) => triggers.push({ key: JSON.stringify([project, kind, subject]), message, quietMs: kind.startsWith('burst-') ? limits.dedupeMs : limits.cardWindowMs })
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
  const fresh = triggers.filter(({ key, quietMs }) => previous[key] === undefined || now - previous[key] >= quietMs)
  if (!fresh.length) return []
  const next = Object.fromEntries(Object.entries(previous).filter(([, time]) => now - time < limits.cardWindowMs))
  for (const { key } of fresh) next[key] = now
  // Persist before side effects, like owner alerts: an ambiguous timeout must not repeat a push.
  writeFileSync(path + '.tmp', JSON.stringify(next, null, 2))
  renameSync(path + '.tmp', path)
  const errors = []
  for (const { message } of fresh) {
    const line = `- ${new Date(now).toISOString()} ALERT ${project} ${message.replace(/[\r\n]+/g, ' ')}\n`
    try { await append(inboxPath, line) } catch (err) { errors.push(err) }
    try { await send(`Board alert: ${project}`, message) } catch (err) { errors.push(err) }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(err => err.message).join('; '))
  return fresh.map(({ key }) => key)
}
