// An engine account out of usage is not the card's fault. Injectbuddy 2026-09-26: every
// Codex Planner printed "You've hit your usage limit", went idle, and was counted as a
// no-handoff, so I191, I221 and I240 reached Owner in minutes. A usage limit blocks that
// engine on every project until it resets; its cards wait in their lanes.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameSync } from './fs-retry.mjs'
import { retryHold } from './transient.mjs'

const HOUR = 3600000
const LIMIT = /hit your (?:usage )?limit|usage limit reached|limit will reset|limit reached\W+resets/i
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const h24 = (h, ap) => (Number(h) % 12) + (/p/i.test(ap) ? 12 : 0)

// The reset time an engine printed, read as local time, or null.
function resetAt(text, now) {
  const epoch = text.match(/limit reached\|(\d{10})\b/i) // Claude: "Claude AI usage limit reached|1759302000"
  if (epoch) return epoch[1] * 1000
  // Codex: "try again at Oct 1st, 2026 10:36 AM"; Claude: "resets Oct 3, 10am"
  const date = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?,?(?: (\d{4}),?)?(?: at)? (\d{1,2})(?::(\d\d))? ?([ap])\.?m\b/i)
  if (date) return new Date(date[3] ?? new Date(now).getFullYear(), MONTHS.indexOf(date[1].toLowerCase()), date[2], h24(date[4], date[6]), date[5] || 0).getTime()
  // Claude: "resets 5pm", "will reset at 3:30pm (Europe/London)": the next such time.
  // ponytail: the printed time zone is ignored (local assumed); parse it if boards run elsewhere.
  const time = text.match(/\b(?:resets?|try again)(?: at)? (\d{1,2})(?::(\d\d))? ?([ap])\.?m\b/i)
  if (!time) return null
  const at = new Date(now)
  at.setHours(h24(time[1], time[3]), time[2] || 0, 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  return at.getTime()
}

// { until } when the end of an agent's screen shows an engine usage or rate limit, else
// null. Only the last lines count: a card about usage limits must not block its engine.
export function usageLimit(screen, now = Date.now()) {
  const tail = String(screen || '').trimEnd().split(/\r?\n/).slice(-20).join(' ').replace(/\s+/g, ' ')
  if (!LIMIT.test(tail)) return null
  const at = resetAt(tail, now)
  return { until: at > now ? at : now + HOUR }
}

export const engineKind = engine => (typeof engine === 'string' ? engine : engine?.kind) || 'claude'
const label = kind => kind[0].toUpperCase() + kind.slice(1)
// Beside the config the server runs with: a test board (KANBAN_CONFIG in a temp dir) must not
// inherit the live board's block, or its agents never start.
const quotaPath = boardRoot => join(process.env.KANBAN_CONFIG ? dirname(process.env.KANBAN_CONFIG) : boardRoot, '.engine-quota.json')

export function readQuota(boardRoot) {
  try { return boardRoot ? JSON.parse(readFileSync(quotaPath(boardRoot), 'utf8')) : {} } catch { return {} }
}

// Block one engine kind until `until`; a later block is never shortened.
export function blockEngine(boardRoot, kind, until, now = Date.now()) {
  const quota = readQuota(boardRoot)
  if (quota[kind]?.until >= until) return quota[kind]
  quota[kind] = { until, since: quota[kind]?.until > now ? quota[kind].since : new Date(now).toISOString() }
  writeFileSync(quotaPath(boardRoot) + '.tmp', JSON.stringify(quota, null, 2) + '\n')
  renameSync(quotaPath(boardRoot) + '.tmp', quotaPath(boardRoot))
  return quota[kind]
}

// The visible hold while an engine is blocked (an allowed wait for the stall watchdog),
// or null once its reset time has passed.
export function quotaHold(boardRoot, kind, now = Date.now(), quota = readQuota(boardRoot)) {
  const until = quota[kind]?.until
  return until > now ? retryHold(`${label(kind)} usage limit`, until) : null
}

// Holds for every card waiting on a blocked engine: Planning/Issues (Planner), Queue
// (Builder), Review (Reviewer). `engineOf(card, stage)` is the card's assigned engine kind.
const STAGES = { planning: 'planning', issues: 'planning', queue: 'working', review: 'review' }
export function quotaHolds(boardRoot, board, engineOf, now = Date.now()) {
  const quota = readQuota(boardRoot), holds = {}
  if (!Object.values(quota).some(q => q.until > now)) return holds
  for (const [lane, stage] of Object.entries(STAGES)) for (const card of board[lane] || []) {
    let kind
    try { kind = engineOf(card, stage === 'working' && card.trivial ? 'trivial' : stage) } catch { continue }
    const hold = quotaHold(boardRoot, kind, now, quota)
    if (hold) holds[card.id] = hold
  }
  return holds
}
