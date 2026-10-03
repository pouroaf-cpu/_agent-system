import { formatNZTime, formatNZText } from './nz-time.mjs'
// Board exceptions for the Kanban Manager: a Pushover plus a line in the Manager's inbox
// file. Neither needs herdr, so a herdr outage can be reported (audit 2026-09-26 F4: the
// alerts went to a herdr agent that no longer existed). One send attempt per key per
// cooldown, persisted before sending like watchdog-alert.ps1, so an ambiguous timeout
// never repeats a push.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { herdrLog } from './herdr.mjs'
import { pushover } from './owner-alerts.mjs'
import { readBoard } from './cards.mjs'
import { laneEnteredAt } from './card-history.mjs'

const COOLDOWN_MS = 4 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000

function readState(file) {
  try {
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { alerts: {} }
  } catch {
    return { alerts: {} }
  }
}

function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
}

export function alertStatePath(boardRoot) {
  return join(boardRoot, '.manager-alerts.json')
}

export async function notifyManagerException({
  boardRoot,
  key,
  title,
  detail,
  now = Date.now(),
  cooldownMs = COOLDOWN_MS,
  send = pushover,
  inbox = join(boardRoot, '..', '_roles', 'KANBAN_MANAGER-INBOX.md'),
  log = herdrLog,
}) {
  const file = alertStatePath(boardRoot)
  const state = readState(file)
  state.alerts ||= {}
  const body = `${title}: ${detail}`.replace(/\s+/g, ' ').trim()
  const last = state.alerts[key]?.sentAt
  if (last != null && now - last < cooldownMs) return { sent: false, reason: 'cooldown' }

  state.alerts[key] = { sentAt: now, body }
  writeState(file, state)
  mkdirSync(dirname(inbox), { recursive: true })
  appendFileSync(inbox, `- ${formatNZTime(now)} ${formatNZText(body)}\n`)
  try {
    await send(title, formatNZText(body).slice(0, 1000))
    log?.(`manager alerted: ${title}`, 'error')
    return { sent: true }
  } catch (err) {
    state.alerts[key].lastError = err.message
    writeState(file, state)
    log?.(`manager push failed: ${title} — ${err.message}`, 'error')
    return { sent: false, reason: 'failed', error: err.message }
  }
}

// The condition is over (herdr answers again): the next occurrence alerts at once.
export function resolveManagerException(boardRoot, key) {
  const file = alertStatePath(boardRoot)
  const state = readState(file)
  if (!state.alerts?.[key]) return
  delete state.alerts[key]
  writeState(file, state)
}

// Owner is the Kanban Manager's lane and does not push on arrival. Report it when a card
// has waited there `hours`, or `burst` cards arrived within an hour, naming what waits behind them.
export function ownerAgeing(tasksDir, { now = Date.now(), hours = 4, burst = 3 } = {}) {
  const board = readBoard(tasksDir)
  const age = card => now - (laneEnteredAt(tasksDir, card.id, 'owner') ?? card.mtime)
  const old = board.owner.filter(c => age(c) >= hours * HOUR)
  const recent = board.owner.filter(c => age(c) < HOUR)
  if (!old.length && recent.length < burst) return null
  const owner = new Set(board.owner.map(c => c.id))
  const blocked = Object.entries(board).filter(([k]) => !['owner', 'archive'].includes(k)).flatMap(([, cards]) => cards)
    .filter(c => c.blockedBy?.some(id => owner.has(id))).map(c => c.id)
  return {
    title: old.length ? `${old.length} Owner card${old.length > 1 ? 's' : ''} waiting over ${hours}h` : `${recent.length} cards reached Owner within an hour`,
    detail: `Owner: ${board.owner.map(c => c.id).join(', ')}. Blocked behind them: ${blocked.join(', ') || 'none'}.`,
  }
}

export function isHardHold(reason) {
  return /duplicate live card id|duplicate issue key|dependency cycle detected|card not ready|mission build budget exhausted/i.test(reason || '')
}
