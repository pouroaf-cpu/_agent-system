import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { join } from 'node:path'

const HOME = process.env.USERPROFILE || process.env.HOME || ''
const CODEX_HOME = process.env.CODEX_HOME || join(HOME, '.codex')
const CLAUDE_PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'), 'projects')
const ZERO = { input: 0, cachedInput: 0, uncachedInput: 0, output: 0, reasoningOutput: 0, total: 0 }

const file = (tasksDir) => join(tasksDir, '.request-usage.json')

export function readUsage(tasksDir) {
  const path = file(tasksDir)
  if (!existsSync(path)) return { version: 1, runs: {} }
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'))
    return { version: 1, runs: data.runs || {} }
  } catch {
    return { version: 1, runs: {} }
  }
}

function write(tasksDir, data) {
  mkdirSync(tasksDir, { recursive: true })
  const temp = file(tasksDir) + '.tmp'
  writeFileSync(temp, JSON.stringify(data, null, 2) + '\n')
  renameSync(temp, file(tasksDir))
}

export function agentSessionId(agentOrSession) {
  if (!agentOrSession) return null
  if (typeof agentOrSession === 'string') return agentOrSession
  const s = agentOrSession.agent_session || agentOrSession.session || agentOrSession
  return ['codex', 'claude'].includes(s?.agent) || ['herdr:codex', 'herdr:claude'].includes(s?.source) ? s.value || null : null
}

// `root` (tests) holds both layouts; live, Claude and Codex keep their own homes.
const sessionPaths = new Map()
// Every poll asks for every unfinished run. A miss (a session killed before it wrote a file)
// walked all 1,454 Codex session files each time and pinned the CPU, so the watchdog saw the
// board as down (2026-09-26). Misses are remembered for a minute.
const sessionMisses = new Map() // cacheKey -> checkedAt
function sessionFile(sessionId, root) {
  const cacheKey = `${root}:${sessionId}`
  if (sessionPaths.has(cacheKey) && existsSync(sessionPaths.get(cacheKey))) return sessionPaths.get(cacheKey)
  if (!sessionId) return null
  if (Date.now() - (sessionMisses.get(cacheKey) ?? -Infinity) < 60000) return null
  sessionMisses.set(cacheKey, Date.now())
  // Claude: <projects>/<slug of the working folder>/<sessionId>.jsonl
  const claude = root || CLAUDE_PROJECTS
  if (existsSync(claude)) for (const e of readdirSync(claude, { withFileTypes: true })) {
    const p = join(claude, e.name, `${sessionId}.jsonl`)
    if (e.isDirectory() && existsSync(p)) { sessionPaths.set(cacheKey, p); sessionMisses.delete(cacheKey); return p }
  }
  const codex = root || CODEX_HOME
  if (!existsSync(codex)) return null
  const stack = [existsSync(join(codex, 'sessions')) ? join(codex, 'sessions') : codex]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('.jsonl') && e.name.includes(sessionId)) { sessionPaths.set(cacheKey, p); sessionMisses.delete(cacheKey); return p }
    }
  }
  return null
}

const countersFrom = (u = {}) => ({
  input: Number(u.input_tokens) || 0,
  cachedInput: Number(u.cached_input_tokens) || 0,
  uncachedInput: Math.max(0, (Number(u.input_tokens) || 0) - (Number(u.cached_input_tokens) || 0)),
  output: Number(u.output_tokens) || 0,
  reasoningOutput: Number(u.reasoning_output_tokens) || 0,
  total: Number(u.total_tokens) || 0,
})

// Claude logs per-message usage; cache reads and writes are input on top of input_tokens.
const claudeCounters = (u) => {
  const cachedInput = Number(u.cache_read_input_tokens) || 0
  const input = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + cachedInput
  const output = Number(u.output_tokens) || 0
  return { input, cachedInput, uncachedInput: input - cachedInput, output, reasoningOutput: Number(u.output_tokens_details?.thinking_tokens) || 0, total: input + output }
}

// Every poll reads every open run's session; a file is parsed again only once it changes.
// ponytail: never evicted, one small entry per session file the board process has read.
const parsed = new Map()
function sessionEvents(sessionId, { root } = {}) {
  const path = sessionFile(sessionId, root)
  if (!path) return []
  const { size, mtimeMs } = statSync(path)
  const hit = parsed.get(path)
  if (hit?.size === size && hit.mtimeMs === mtimeMs) return hit.rows
  const rows = []
  let sequence = 0
  let firstAt = null
  let claude = null // { messages: id -> counters, sum }; a streamed message repeats its id with growing usage
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      const ordinal = Number.isFinite(Number(row.ordinal)) ? Number(row.ordinal) : sequence
      sequence++
      firstAt ??= row.timestamp ?? null
      const type = row.payload?.type || row.type
      if (row.type === 'assistant' && row.message?.usage) {
        claude ??= { messages: new Map(), sum: { ...ZERO } }
        const id = row.message.id ?? row.uuid
        const next = claudeCounters(row.message.usage), prev = claude.messages.get(id)
        for (const k of Object.keys(ZERO)) claude.sum[k] += next[k] - (prev?.[k] ?? 0)
        claude.messages.set(id, next)
        rows.push({ kind: 'token_count', file: path, timestamp: row.timestamp, ordinal, counters: { ...claude.sum } })
      } else if (row.type === 'user' && !row.toolUseResult && !row.isMeta) {
        rows.push({ kind: 'user', timestamp: row.timestamp, ordinal })
      } else if (type === 'token_count') {
        const usage = row.payload?.info?.total_token_usage
        if (usage) rows.push({ kind: 'token_count', file: path, timestamp: row.timestamp, ordinal, counters: countersFrom(usage) })
      } else if (row.type === 'session_meta') {
        rows.push({ kind: 'session_meta', file: path, timestamp: row.timestamp, ordinal })
      } else if (row.type === 'turn_context') {
        rows.push({ kind: 'context', model: row.payload?.model, timestamp: row.timestamp, ordinal })
      } else if (row.type === 'response_item' && row.payload?.role === 'user') {
        rows.push({ kind: 'user', timestamp: row.timestamp, ordinal })
      } else if (type === 'task_complete') {
        rows.push({ kind: 'task_complete', file: path, timestamp: row.timestamp, ordinal })
      }
    } catch {}
  }
  // Ordinal -1 keeps it first: callers test events[0]?.claude.
  if (claude) rows.push({ kind: 'session_meta', claude: true, file: path, timestamp: firstAt, ordinal: -1 })
  rows.sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))
  parsed.set(path, { size, mtimeMs, rows })
  return rows
}

export function tokenSnapshots(sessionId, { root } = {}) {
  return sessionEvents(sessionId, { root }).filter((r) => r.kind === 'token_count')
}

export function latestTokenSnapshot(sessionId, { root, beforeOrdinal = Infinity } = {}) {
  const rows = tokenSnapshots(sessionId, { root }).filter((r) => (r.ordinal ?? 0) <= beforeOrdinal)
  return rows.at(-1) ?? { file: sessionFile(sessionId, root), timestamp: null, ordinal: null, counters: null, missing: true }
}

function latestEventOrdinal(sessionId, { root } = {}) {
  return sessionEvents(sessionId, { root }).at(-1)?.ordinal ?? null
}

function completionSnapshot(sessionId, startOrdinal, { root } = {}) {
  const events = sessionEvents(sessionId, { root })
  const boundary = events.find((r) => r.kind === 'task_complete' && (r.ordinal ?? 0) > (startOrdinal ?? -1))
  if (!boundary) return null
  const tokens = events.filter((r) => r.kind === 'token_count' && (r.ordinal ?? 0) <= boundary.ordinal).at(-1)
  return tokens
    ? { ...tokens, complete: { timestamp: boundary.timestamp, ordinal: boundary.ordinal } }
    : { file: sessionFile(sessionId, root), timestamp: boundary.timestamp, ordinal: boundary.ordinal, counters: null, missing: true, complete: { timestamp: boundary.timestamp, ordinal: boundary.ordinal } }
}

export function usageDelta(start, finish) {
  if (start?.missing || finish?.missing || !start?.counters || !finish?.counters) return { status: 'unknown_usage', counters: null }
  const delta = {}
  for (const key of Object.keys(ZERO)) {
    const n = (finish?.counters?.[key] ?? 0) - (start?.counters?.[key] ?? 0)
    if (n < 0) return { status: 'counter_reset', counters: null }
    delta[key] = n
  }
  return { status: 'ok', counters: delta }
}

const safe = (s) => String(s || 'unknown').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'unknown'
const makeRunId = ({ sessionId, requestId, role, paneId, at }) =>
  [safe(requestId), safe(role), safe(paneId), sessionId || 'unknown-session', Date.parse(at) || Date.now()].join(':')

const requestRef = /\bREQ-\d{8}-\d{3}\b/g

function cardFile(tasksDir, cardId) {
  if (!cardId || !existsSync(tasksDir)) return null
  const stack = [tasksDir]
  while (stack.length) {
    const dir = stack.pop()
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.name.endsWith('.md') && e.name.toLowerCase().startsWith(`${String(cardId).toLowerCase()}-`)) return p
    }
  }
  return null
}

function parentRequestResolution(tasksDir, cardIds = []) {
  if (!cardIds.length) return { parents: [], complete: false }
  const ids = []
  for (const cardId of cardIds) {
    const path = cardFile(tasksDir, cardId)
    if (!path) return { parents: [], complete: false }
    const content = readFileSync(path, 'utf8')
    const explicit = content.match(/^\s*(?:\*\*)?Usage request:(?:\*\*)?\s*(REQ-\d{8}-\d{3})\s*$/im)?.[1]
    const matches = explicit ? [explicit] : [...content.matchAll(requestRef)].map((m) => m[0])
    const unique = [...new Set(matches)]
    if (unique.length !== 1) return { parents: [], complete: false }
    ids.push(unique[0])
  }
  const parents = [...new Set(ids)].sort()
  return { parents, complete: true }
}

export function recordUsageStart({ tasksDir, project, requestId, cardIds, role, paneId, tabId, model, name, agentSession, now = new Date(), root }) {
  const sessionId = agentSessionId(agentSession)
  const at = now.toISOString()
  const all = readUsage(tasksDir)
  const parentResolution = /^REQ-\d{8}-\d{3}$/.test(requestId || '')
    ? { parents: [requestId], complete: true }
    : parentRequestResolution(tasksDir, cardIds || [])
  const parents = parentResolution.parents
  const resolvedRequestId = parentResolution.complete && parents.length === 1 ? parents[0] : requestId
  // Boot reports the same assignment twice: provisional pane, then session identity.
  const existing = Object.values(all.runs).find(r => !r.finish && r.paneId === paneId && paneId && r.role === role && r.requestId === resolvedRequestId)
  if (existing) return existing
  const unresolvedBatch = !parentResolution.complete && (cardIds || []).length > 1
  const crossRequestBatch = unresolvedBatch || parents.length > 1
  const overlapping = !!sessionId && Object.values(all.runs).some((r) => !r.finish && r.sessionId === sessionId)
  for (const run of Object.values(all.runs)) {
    if (!run.finish && run.sessionId && run.sessionId === sessionId) run.shared = true
  }
  const runId = makeRunId({ sessionId, requestId: resolvedRequestId, role, paneId, at })
  if (!all.runs[runId]) {
    all.runs[runId] = {
      runId, sessionId, project, requestId: resolvedRequestId, sourceRequestId: requestId, parentRequestIds: parents,
      cardIds: cardIds || (requestId ? [requestId] : []), role,
      paneId, tabId, model, name, status: sessionId ? 'running' : 'unknown_session',
      shared: overlapping || crossRequestBatch,
      sharedReason: crossRequestBatch ? (parents.length > 1 ? 'cross_request_batch' : 'unknown_parent_batch') : (overlapping ? 'overlapping_session' : null),
      start: { at, cursorOrdinal: sessionId ? latestEventOrdinal(sessionId, { root }) : null, ...(sessionId ? latestTokenSnapshot(sessionId, { root }) : { counters: null, missing: true }) },
    }
  }
  write(tasksDir, all)
  return all.runs[runId]
}

function activeMatches(all, { runId, paneId, sessionId }) {
  const active = Object.values(all.runs).filter((r) => !r.finish)
  return runId ? active.filter((r) => r.runId === runId)
    : paneId ? active.filter((r) => r.paneId === paneId)
      : sessionId ? active.filter((r) => r.sessionId === sessionId)
        : []
}

function closeRun(run, finish, status, at) {
  const delta = usageDelta(run.start, finish)
  Object.assign(run, {
    status: delta.status === 'ok' ? status : delta.status,
    finish: { at, ...finish },
    delta: delta.counters,
  })
  delete run.pendingFinish
  return run
}

function tryCompleteRun(run, { root, now = new Date() } = {}) {
  const finishSession = run.sessionId
  if (!finishSession) return closeRun(run, { counters: null, missing: true }, run.status || 'unknown_session', now.toISOString())
  // Claude logs no end-of-task marker: the board's finish is the end, and the session
  // may only have been learned now.
  const events = sessionEvents(finishSession, { root })
  if (events[0]?.claude) {
    if (!run.start?.counters || run.start.missing) run.start = startBefore(run.start.at, events)
    return closeRun(run, events.filter((e) => e.kind === 'token_count').at(-1), 'complete', now.toISOString())
  }
  const finish = completionSnapshot(finishSession, run.start?.cursorOrdinal ?? run.start?.ordinal, { root })
  if (!finish) {
    run.status = 'pending_final'
    run.pendingFinish = { at: now.toISOString(), reason: 'waiting_for_task_complete' }
    return null
  }
  return closeRun(run, finish, 'complete', now.toISOString())
}

export function refreshPendingUsage(tasksDir, { root } = {}) {
  const all = readUsage(tasksDir)
  let changed = false
  for (const run of Object.values(all.runs)) {
    if (!run.finish && run.status === 'pending_final') {
      const before = JSON.stringify(run)
      tryCompleteRun(run, { root, now: new Date(run.pendingFinish?.at || Date.now()) })
      if (JSON.stringify(run) !== before) changed = true
    }
  }
  if (changed) write(tasksDir, all)
  return all
}

export async function recordUsageFinish({ tasksDir, runId, paneId, agent, binding, status = 'complete', now = new Date(), root }) {
  const sessionId = agentSessionId(agent) || agentSessionId(binding)
  const all = readUsage(tasksDir)
  const matches = activeMatches(all, { runId, paneId, sessionId })
  if (matches.length > 1) {
    for (const r of matches) Object.assign(r, { shared: true, status: 'ambiguous' })
    write(tasksDir, all)
    return null
  }
  const run = matches[0]
  if (!run) return null
  const finishSession = sessionId || run.sessionId
  if (finishSession && finishSession !== run.sessionId) run.sessionId = finishSession
  if (status === 'complete') tryCompleteRun(run, { root, now })
  else {
    const finish = finishSession ? latestTokenSnapshot(finishSession, { root }) : { counters: null, missing: true }
    closeRun(run, finish, status, now.toISOString())
  }
  write(tasksDir, all)
  return run
}

function addCounters(target, delta) {
  const next = target || { ...ZERO }
  for (const k of Object.keys(ZERO)) next[k] += delta?.[k] || 0
  return next
}

export function usageSummary(tasksDir, { root } = {}) {
  const all = refreshPendingUsage(tasksDir, { root })
  const out = {}
  for (const run of Object.values(all.runs)) {
    if (run.duplicateOf) continue
    const keys = run.parentRequestIds?.length > 1 ? run.parentRequestIds : [run.requestId || run.role || 'unknown']
    for (const key of keys) {
      const row = out[key] ?? { requestId: key, runs: 0, active: 0, ambiguous: 0, interrupted: 0, pending: 0, shared: 0, unknown: 0, tokens: null, sharedTokens: null, agents: [] }
      const shared = !!run.shared || keys.length > 1
      row.runs++
      if (!run.finish) row.active++
      if (run.status === 'pending_final') row.pending++
      if (run.status === 'ambiguous') row.ambiguous++
      if (run.status === 'interrupted') row.interrupted++
      if (shared) row.shared++
      if (run.delta && shared) row.sharedTokens = addCounters(row.sharedTokens, run.delta)
      else if (run.delta) row.tokens = addCounters(row.tokens, run.delta)
      else row.unknown++
      row.agents.push({
        runId: run.runId, sessionId: run.sessionId, role: run.role, model: run.model, name: run.name,
        status: run.status, shared, sharedReason: run.sharedReason || (keys.length > 1 ? 'cross_request_batch' : null),
        tokens: shared ? null : (run.delta || null), sharedTokens: shared ? (run.delta || null) : null,
        sourceRequestId: run.sourceRequestId || null, parentRequestIds: run.parentRequestIds || [],
      })
      out[key] = row
    }
  }
  return Object.values(out).sort((a, b) => a.requestId.localeCompare(b.requestId))
}

// The session's usage up to the run's start is its baseline; none logged by then is zero.
function startBefore(at, events) {
  const before = events.filter(e => Date.parse(e.timestamp) <= Date.parse(at))
  const baseline = before.filter(e => e.kind === 'token_count').at(-1)
  return { at, ...(baseline || { counters: { ...ZERO }, ordinal: -1 }), cursorOrdinal: before.at(-1)?.ordinal ?? -1, recovered: true }
}

// Identity may arrive after boot. Recover the baseline at assignment time, never at recovery time.
export function reconcileUsage(tasksDir, agents, { root } = {}) {
  const all = readUsage(tasksDir)
  let changed = false
  const eventCache = new Map()
  for (const run of Object.values(all.runs)) {
    if (run.delta || run.duplicateOf) continue
    const agent = agents.find(a => (run.name && a.name === run.name) || (run.paneId && a.pane_id === run.paneId))
    const id = run.sessionId || agentSessionId(agent)
    if (!id) continue
    if (!eventCache.has(id)) eventCache.set(id, sessionEvents(id, { root }))
    const events = eventCache.get(id)
    if (!events.length) continue
    const at = Date.parse(run.start.at)
    const before = events.filter(e => Date.parse(e.timestamp) <= at)
    const baseline = before.filter(e => e.kind === 'token_count').at(-1)
    const meta = events.find(e => e.kind === 'session_meta')
    const firstUser = events.find(e => e.kind === 'user')
    // A Claude run is measured when the board finishes it, and a finished run must not
    // take the session of a later agent that reuses its name.
    if (meta?.claude && run.finish) continue
    // A positively identified fresh session has a zero pre-assignment baseline. A Claude
    // transcript is one session, so usage before the run's start is an earlier run's.
    const fresh = meta?.claude || (meta && firstUser && Date.parse(firstUser.timestamp) >= at && Date.parse(meta.timestamp) <= at + 120000)
    if (run.sessionId !== id) { run.sessionId = id; changed = true }
    if (!run.model) { run.model = events.find(e => e.kind === 'context' && e.model)?.model || null; changed = true }
    if (!run.start.counters || run.start.missing) {
      if (baseline || fresh) {
        run.start = startBefore(run.start.at, events)
        delete run.finish; run.status = 'running'; changed = true
      } else continue
    }
    const user = events.find(e => e.kind === 'user' && e.ordinal > (run.start.cursorOrdinal ?? -1))
    if (user) {
      run.assignmentOrdinal = user.ordinal
      const other = Object.values(all.runs).find(r => r !== run && !r.duplicateOf && r.sessionId === id && r.assignmentOrdinal === user.ordinal && r.requestId === run.requestId)
      if (other) { run.duplicateOf = other.runId; run.status = 'duplicate'; run.delta = null; changed = true; continue }
    }
    const boundary = events.find(e => e.kind === 'task_complete' && e.ordinal > (run.start.cursorOrdinal ?? -1))
    if (boundary) { tryCompleteRun(run, { root }); changed = true }
  }
  const measured = Object.values(all.runs).filter(r => r.delta && !r.duplicateOf);
  for (let i=0; i<measured.length; i++) {
    const r=measured[i];
    for (const prior of measured.slice(0,i)) {
      if (prior.duplicateOf || prior.sessionId !== r.sessionId) continue;
      if (prior.requestId === r.requestId && prior.start.ordinal === r.start.ordinal && prior.finish.ordinal === r.finish.ordinal) {
        r.duplicateOf=prior.runId; r.status='duplicate'; r.delta=null; changed=true; break;
      }
      if (r.start.ordinal < prior.finish.ordinal && prior.start.ordinal < r.finish.ordinal) {
        r.shared=true; prior.shared=true; r.sharedReason=prior.sharedReason='overlapping_session'; changed=true;
      }
    }
  }
  if (changed) write(tasksDir, all)
  return all
}

export function mergeUsageSummaries(summaries) {
  const result = new Map()
  for (const row of summaries) {
    const target = result.get(row.requestId) || { ...row, agents: [] }
    const ids = new Set(target.agents.map(a => a.runId))
    for (const agent of row.agents) if (!ids.has(agent.runId)) { target.agents.push(agent); ids.add(agent.runId) }
    result.set(row.requestId, target)
  }
  for (const row of result.values()) {
    row.tokens = null; row.sharedTokens = null; row.runs = row.agents.length
    row.unknown = 0; row.shared = 0; row.active = 0
    for (const a of row.agents) {
      if (a.shared) row.shared++
      if (a.tokens) row.tokens = addCounters(row.tokens, a.tokens)
      else row.unknown++
      if (['running','pending_final','unknown_session'].includes(a.status)) row.active++
    }
  }
  return Object.fromEntries(result)
}

// Card totals only include runs exclusively attributable to this card.
export function cardUsageSummary(tasksDir) {
  const out = {}
  for (const run of Object.values(readUsage(tasksDir).runs)) {
    if (run.duplicateOf) continue
    const ids = [...new Set(run.cardIds || [])]
    for (const id of ids) {
      const row = out[id] ??= { tokens: null, unknown: 0, agents: [] }
      const confirmed = ids.length === 1 && !run.shared && !['ambiguous', 'interrupted'].includes(run.status) && !!run.delta
      if (confirmed) row.tokens = addCounters(row.tokens, run.delta)
      else row.unknown++
      row.agents.push({ runId: run.runId, name: run.name, role: run.role, model: run.model,
        startedAt: run.start?.at, finishedAt: run.finish?.at, status: run.status,
        tokens: confirmed ? run.delta : null, shared: !!run.shared || ids.length > 1 })
    }
  }
  return out
}
