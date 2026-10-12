// An engine account out of usage is not the card's fault. Injectbuddy 2026-09-26: every
// Codex Planner printed "You've hit your usage limit", went idle, and was counted as a
// no-handoff, so I191, I221 and I240 reached Owner in minutes. A usage limit blocks that
// engine on every project until it resets; its cards wait in their lanes.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameSync } from './fs-retry.mjs'
import { retryHold } from './transient.mjs'

const HOUR = 3600000
const LIMIT = /hit your (?:usage |session )?limit|usage limit reached|limit will reset|limit reached\W+resets/i
// A model's own cap ("Opus weekly limit reached"), unlike the shared 5-hour session limit.
const MODEL_CAP = /\b(?:opus|sonnet|haiku|weekly|7-day)\b[^.|]{0,20}\blimit\b/i
const CAPACITY = /model is at capacity/i
const CAPACITY_WAIT_MS = 15 * 60000
// The engine's own sign-in ran out: no agent of it can start until someone signs in again,
// and that is not the card's fault. Injectbuddy 2026-10-12 08:00Z: the Claude CLI sign-in
// expired, every Builder exited in seconds and 13 cards were kicked back to Planning with
// their difficulty stepped up. Try one start again every 15 minutes.
const AUTH = /"error":"authentication_failed"|Failed to authenticate[:.] (?:OAuth|API Error: 401)|OAuth session expired/i
const AUTH_WAIT_MS = 15 * 60000
export const SIGN_IN = 'sign-in expired'
// The engine rejected the request because it will not serve this model. Injectbuddy
// 2026-10-12 20:38Z: Codex answered every start with HTTP 400 "The 'gpt-6-sol' model is not
// supported when using Codex with a ChatGPT account", each counted as a no-handoff (I1197,
// I1200, I1204, I1206, I1207, I1208). It does not clear by itself: hold that model for an hour.
// `\W{1,8}` spans both `":"` and the backslash-escaped `\":\"` of a wrapped JSON event.
const REJECTED = /invalid_request_error\W{1,8}message\W{1,8}[^"\\]{0,100}\bmodel is not supported\b/i
const REJECTED_WAIT_MS = 60 * 60000
export const MODEL_REJECTED = 'model rejected'
const MONTHS =['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const h24 = (h, ap) => (Number(h) % 12) + (/p/i.test(ap) ? 12 : 0)

// The reset time an engine printed, read as local time, or null.
function resetAt(text, now) {
  // Claude: "Claude AI usage limit reached|1759302000"; headless: {"status":"rejected","resetsAt":1791032400}
  const epoch = text.match(/limit reached\|(\d{10})\b/i) || text.match(/"status":"rejected","resetsAt":(\d{10})\b/)
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
// null; `modelCap` when only that agent's model is capped or rejected by the engine. Only the last lines count: a
// card about usage limits must not block its engine.
export function usageLimit(screen, now = Date.now()) {
  const tail = String(screen || '').trimEnd().split(/\r?\n/).slice(-20).join(' ').replace(/\s+/g, ' ')
  // Codex "Selected model is at capacity": the model's servers are busy, not our usage
  // (I534, 2026-09-30, sent a passing Builder back to Planning). Wait a short while on that model.
  if (CAPACITY.test(tail)) return { until: now + CAPACITY_WAIT_MS, modelCap: true }
  if (AUTH.test(tail)) return { until: now + AUTH_WAIT_MS, why: SIGN_IN }
  if (REJECTED.test(tail)) return { until: now + REJECTED_WAIT_MS, why: MODEL_REJECTED, modelCap: true }
  if (!LIMIT.test(tail)) return null
  const at = resetAt(tail, now)
  return { until: at > now ? at : now + HOUR, ...(MODEL_CAP.test(tail) && { modelCap: true }) }
}

export const engineKind = engine => (typeof engine === 'string' ? engine : engine?.kind) || 'claude'
// A block is keyed by engine ("claude", every agent of it) or engine:model (one model's cap).
export const quotaKey = (kind, model) => model ? `${kind}:${model}` : kind
const label = key => key[0].toUpperCase() + key.slice(1).replace(':', ' ')
// Beside the config the server runs with: a test board (KANBAN_CONFIG in a temp dir) must not
// inherit the live board's block, or its agents never start.
const quotaPath = boardRoot => join(process.env.KANBAN_CONFIG ? dirname(process.env.KANBAN_CONFIG) : boardRoot, '.engine-quota.json')

export function readQuota(boardRoot) {
  try { return boardRoot ? JSON.parse(readFileSync(quotaPath(boardRoot), 'utf8')) : {} } catch { return {} }
}

// Block one engine kind (or quotaKey) until `until`; a later block is never shortened.
// `why` names a block that is not a usage limit (SIGN_IN).
export function blockEngine(boardRoot, kind, until, now = Date.now(), why) {
  const quota = readQuota(boardRoot)
  if (quota[kind]?.until >= until) return quota[kind]
  quota[kind] = { until, since: quota[kind]?.until > now ? quota[kind].since : new Date(now).toISOString(), ...(why && { why }) }
  writeFileSync(quotaPath(boardRoot) + '.tmp', JSON.stringify(quota, null, 2) + '\n')
  renameSync(quotaPath(boardRoot) + '.tmp', quotaPath(boardRoot))
  return quota[kind]
}

// Hold info for `key` (or its bare engine kind), with the numeric reset time so callers
// can compare two holds, or null once the later of the two has passed.
function holdInfo(quota, key, now) {
  const hit = [key.split(':')[0], key].filter(k => quota[k]?.until > now).sort((a, b) => quota[b].until - quota[a].until)[0]
  return hit ? { until: quota[hit].until, text: retryHold(`${label(hit)} ${quota[hit].why || 'usage limit'}`, quota[hit].until) } : null
}

// The visible hold while an engine, or `key`'s model of it, is blocked (an allowed wait for
// the stall watchdog), or null once its reset time has passed.
export function quotaHold(boardRoot, key, now = Date.now(), quota = readQuota(boardRoot)) {
  return holdInfo(quota, key, now)?.text ?? null
}

// Select only at launch: saved settings stay primary, so the next launch returns to it after reset.
export function selectQuotaAssignment(boardRoot, primary, now = Date.now()) {
  const quota = readQuota(boardRoot)
  const hold = holdInfo(quota, quotaKey(primary.engine, primary.model), now)
  const fallback = primary.fallback
  if (!hold) return { assignment: primary, hold: null }
  if (!fallback) return { assignment: primary, hold: hold.text }
  const fallbackHold = holdInfo(quota, quotaKey(fallback.engine, fallback.model), now)
  if (!fallbackHold) return { assignment: fallback, hold: null,
    message: `started on fallback ${fallback.model}: ${primary.model} usage limit until ${hold.text.split('retrying at ')[1]}` }
  // Both blocked: the card waits only for whichever engine resets first, named for that one —
  // not always primary's (possibly much later) reset (Injectbuddy I1051/I1054, 2026-10-11:
  // Codex blocked for weeks, its Claude fallback hit a 2-hour limit, the card's hold still
  // named Codex's far-future reset).
  return fallbackHold.until < hold.until ? { assignment: fallback, hold: fallbackHold.text } : { assignment: primary, hold: hold.text }
}

// The blocks still in force, for the board header and the manager alert.
export function activeQuota(boardRoot, now = Date.now()) {
  return Object.fromEntries(Object.entries(readQuota(boardRoot)).filter(([, block]) => block.until > now))
}

// Holds for every card waiting on a blocked engine: Planning/Issues (Planner), Queue
// (Builder), Review (Reviewer). `engineOf(card, stage)` is the card's quotaKey.
const STAGES = { planning: 'planning', issues: 'planning', queue: 'working', review: 'review' }
export function quotaHolds(boardRoot, board, engineOf, now = Date.now()) {
  const quota = readQuota(boardRoot), holds = {}
  if (!Object.values(quota).some(q => q.until > now)) return holds
  for (const [lane, stage] of Object.entries(STAGES)) for (const card of board[lane] || []) {
    let kind
    try { kind = engineOf(card, stage) } catch { continue }
    const hold = quotaHold(boardRoot, kind, now, quota)
    if (hold) holds[card.id] = hold
  }
  return holds
}
