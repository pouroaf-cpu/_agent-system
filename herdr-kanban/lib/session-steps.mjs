import { readFileSync, statSync } from 'node:fs'
import { readUsage } from './request-usage.mjs'
import { readBoard } from './cards.mjs'
import { nzDay } from './nz-time.mjs'

const ROLES = ['planner', 'builder']
const SPLIT_LINE = /^\*\*Split from:\*\*[ \t]*(\S+)/im
const DAY_MS = 86400000

// Sorted-array statistics; null (never 0) when there is nothing to measure.
export const median = sorted => !sorted.length ? null
  : sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
export const percentile = (sorted, p) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null

const byValue = (a, b) => a - b
const stats = runs => {
  // Steps come from run.steps (runSteps); shared, null and undefined are unknown, never 0.
  const steps = [], tokens = []
  for (const run of runs) {
    if (!run.shared && Number.isFinite(run.steps)) steps.push(run.steps)
    if (!run.shared && Number.isFinite(run.delta?.total)) tokens.push(run.delta.total)
  }
  steps.sort(byValue)
  tokens.sort(byValue)
  return { sessions: runs.length, unknown: runs.length - steps.length, medianSteps: median(steps), p90Steps: percentile(steps, 0.9), medianTokens: median(tokens) }
}

// runs: usage runs; children/parents: Sets of upper-case card IDs. Planner and Builder runs
// that have finished, grouped by the NZ day they finished.
export function sessionRollup(runs, { children = new Set(), parents = new Set() } = {}, { days = 7, now = Date.now() } = {}) {
  // 00:00 UTC is 12:00-13:00 NZ the same date, so stepping whole days never crosses a DST edge.
  const midday = Date.parse(nzDay(now) + 'T00:00:00Z')
  const rows = Array.from({ length: days }, (_, i) => ({ day: nzDay(midday - i * DAY_MS), buckets: {} }))
  const byDay = new Map(rows.map(row => [row.day, row]))
  for (const run of runs) {
    if (!ROLES.includes(run.role) || run.duplicateOf) continue
    const finished = Date.parse(run.finish?.at)
    if (!Number.isFinite(finished)) continue
    const row = byDay.get(nzDay(finished))
    if (!row) continue
    const ids = (run.cardIds || []).map(id => String(id).toUpperCase())
    const group = ids.some(id => children.has(id)) ? 'child' : ids.some(id => parents.has(id)) ? 'parent' : 'notSplit'
    for (const key of [`${run.role}.all`, `${run.role}.${group}`]) (row.buckets[key] ||= []).push(run)
  }
  return rows.map(({ day, buckets }) => ({ day, ...Object.fromEntries(ROLES.map(role =>
    [role, Object.fromEntries(['all', 'child', 'notSplit', 'parent'].map(g => [g, stats(buckets[`${role}.${g}`] || [])]))])) }))
}

const splitFrom = new Map() // path -> { mtimeMs, size, parent }
function splitParentOf(card) {
  const info = statSync(card.path)
  const hit = splitFrom.get(card.path)
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.parent
  const parent = readFileSync(card.path, 'utf8').match(SPLIT_LINE)?.[1]?.replace(/[^A-Za-z0-9_-]/g, '').toUpperCase() || null
  splitFrom.set(card.path, { mtimeMs: info.mtimeMs, size: info.size, parent })
  return parent
}

const memo = new Map() // `${tasksDir}|${days}` -> { at, value }
export function projectSessionRollup(tasksDir, days = 7, now = Date.now()) {
  const key = `${tasksDir}|${days}|${nzDay(now)}`
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < 5000) return hit.value
  const children = new Set(), parents = new Set()
  for (const card of Object.values(readBoard(tasksDir)).flat()) {
    let parent
    try { parent = splitParentOf(card) } catch { continue } // a card moved mid-read
    if (!parent) continue
    children.add(String(card.id).toUpperCase())
    parents.add(parent)
  }
  const value = sessionRollup(Object.values(readUsage(tasksDir).runs), { children, parents }, { days, now })
  memo.set(key, { at: Date.now(), value })
  return value
}
