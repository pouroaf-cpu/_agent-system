import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

const projects = new Map()
const tags = ['planning', 'implementation', 'evidence', 'operational', 'untagged']
const empty = () => ({ integrated: new Set(), archived: new Set(), kickBacks: Object.fromEntries(tags.map(tag => [tag, 0])), builderDeliveryFailed: 0, builderNoHandoff: 0, plannerFailures: 0, stalls: 0, ownerEscalations: 0 })

function count(state, line, kind, card) {
  let e
  if (kind === 'history') {
    try { e = JSON.parse(line) } catch { return } // malformed/torn records are not events
  } else if (kind === 'activity') {
    const match = line.match(/^(\S+) project=\S+ card=(\S+) event=(\S+) message=(.*)$/)
    if (!match) return
    e = { at: match[1], card: match[2], event: match[3], message: match[4] }
  } else {
    const fields = line.split('\t')
    if (fields.length < 5) return
    e = { at: fields[0] }
  }
  const time = Date.parse(e.at)
  if (!Number.isFinite(time)) return
  const day = new Date(time).toISOString().slice(0, 10)
  if (kind === 'history') {
    const event = e.event === 'failure' && e.stage === 'working' ? 'builder-kick-back'
      : e.event === 'plan-check' && e.verdict === 'FAIL' ? 'plan-check-fail'
      : ['builder-delivery-failed', 'builder-no-handoff'].includes(e.event) ? e.event : null
    if (event) state.failures.push({ time, card, event })
  }
  const row = state.rows.get(day) || empty()
  state.rows.set(day, row)
  if (kind === 'stalls') { row.stalls++; return }
  if (kind === 'activity') {
    if (e.event === 'integrated' && e.card !== '-') row.integrated.add(e.card.toUpperCase())
    // Other activity entries mirror history (including planner-failure and stall).
    // Start errors that happen before a history record can be written live here only.
    if (e.event === 'failure' && /^planner: /i.test(e.message)) state.plannerErrors.push({ day, card: e.card.toUpperCase(), time, reason: e.message.slice(9) })
    return
  }
  if (e.event === 'transition') {
    if (e.to === 'archive' && e.from !== 'archive') row.archived.add(card)
    if (['owner', 'pou'].includes(e.to) && !['owner', 'pou'].includes(e.from)) row.ownerEscalations++
  }
  if (e.event === 'failure' && e.stage === 'working') {
    // category defaults to evidence in the writer; only an actual reason tag counts as tagged.
    const tag = String(e.note || '').match(/^\s*\[(planning|implementation|evidence|operational)\]/i)?.[1]?.toLowerCase() || 'untagged'
    row.kickBacks[tag]++
  }
  if (e.event === 'builder-delivery-failed') row.builderDeliveryFailed++
  if (e.event === 'builder-no-handoff') row.builderNoHandoff++
  if ((e.event === 'failure' && e.stage === 'planning') || ['planner-delivery-failed', 'planner-no-handoff'].includes(e.event) || (e.event === 'start-failed' && e.role === 'planner')) {
    row.plannerFailures++
    if (e.event === 'start-failed') state.plannerErrors.push({ day, card, time, reason: e.reason })
  }
}

async function updateFile(path, kind, previous) {
  let info
  try { info = await stat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (previous && previous.size === info.size && previous.mtime === info.mtimeMs) return previous
  // Append-only logs: keep daily aggregates, not card text. Replaced/truncated files rebuild.
  const state = previous && info.size > previous.size && info.ino === previous.ino && info.birthtimeMs === previous.birthtime
    ? previous : { size: 0, tail: Buffer.alloc(0), rows: new Map(), plannerErrors: [], failures: [] }
  const card = basename(path, '.jsonl').toUpperCase()
  if (info.size > state.size) {
    for await (const chunk of createReadStream(path, { start: state.size, end: info.size - 1 })) {
      const bytes = Buffer.concat([state.tail, chunk])
      let start = 0, end
      while ((end = bytes.indexOf(10, start)) !== -1) {
        count(state, bytes.subarray(start, end).toString('utf8').replace(/\r$/, ''), kind, card)
        start = end + 1
      }
      state.tail = Buffer.from(bytes.subarray(start)) // preserve partial UTF-8/JSON until newline
    }
  }
  return Object.assign(state, { size: info.size, mtime: info.mtimeMs, ino: info.ino, birthtime: info.birthtimeMs })
}

async function refresh(tasksDir, cache) {
  let names
  try { names = await readdir(join(tasksDir, '.history')) } catch (error) { if (error.code !== 'ENOENT') throw error; names = [] }
  const sources = names.filter(name => name.endsWith('.jsonl')).map(name => [join(tasksDir, '.history', name), 'history'])
  sources.push([join(tasksDir, 'activity.log'), 'activity'], [join(tasksDir, 'stalls.log'), 'stalls'])
  const files = new Map()
  // ponytail: sequential cold scan bounds open files; parallelize only if startup becomes slow.
  for (const [path, kind] of sources) {
    const state = await updateFile(path, kind, cache.files.get(path))
    if (state) files.set(path, state)
  }
  const rows = new Map(), starts = [], errors = []
  for (const [path, state] of files) {
    (path.endsWith('activity.log') ? errors : starts).push(...state.plannerErrors)
    for (const [day, source] of state.rows) {
      const row = rows.get(day) || empty()
      rows.set(day, row)
      for (const key of ['integrated', 'archived']) for (const id of source[key]) row[key].add(id)
      for (const tag of tags) row.kickBacks[tag] += source.kickBacks[tag]
      for (const key of ['builderDeliveryFailed', 'builderNoHandoff', 'plannerFailures', 'stalls', 'ownerEscalations']) row[key] += source[key]
    }
  }
  for (const error of errors) {
    // The server reports a recorded start failure again; count that attempt only once.
    // ponytail: matching card/reason within 5s; use shared event IDs if logs gain them.
    if (!starts.some(start => start.card === error.card && start.reason === error.reason && Math.abs(start.time - error.time) < 5000)) rows.get(error.day).plannerFailures++
  }
  cache.files = files
  cache.rows = rows
  cache.checkedAt = Date.now()
}

async function projectCache(tasksDir) {
  let cache = projects.get(tasksDir)
  if (!cache) { cache = { files: new Map(), rows: new Map(), checkedAt: 0 }; projects.set(tasksDir, cache) }
  if (!cache.pending && Date.now() - cache.checkedAt >= 5000) cache.pending = refresh(tasksDir, cache).finally(() => { cache.pending = null })
  if (cache.pending) await cache.pending
  return cache
}

export async function historyFailures(tasksDir, since, now = Date.now()) {
  const cache = await projectCache(tasksDir)
  const failures = []
  for (const state of cache.files.values()) {
    // Alert callers use a rolling window; retain compact events, never saved card text.
    state.failures = state.failures.filter(e => e.time >= since)
    failures.push(...state.failures.filter(e => e.time <= now))
  }
  return failures
}

export async function dailyMetrics(tasksDir, days = 7, now = Date.now()) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error('days must be an integer from 1 to 366')
  const cache = await projectCache(tasksDir)
  const today = Date.parse(new Date(now).toISOString().slice(0, 10))
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(today - index * 86400000).toISOString().slice(0, 10)
    const row = cache.rows.get(day) || empty()
    const finished = new Set([...row.integrated, ...row.archived]).size
    const kickBacks = { ...row.kickBacks, total: Object.values(row.kickBacks).reduce((a, b) => a + b, 0) }
    return { day, ...row, integrated: row.integrated.size, archived: row.archived.size, finished, kickBacks, kickBacksPerFinishedCard: finished ? kickBacks.total / finished : null }
  })
}
