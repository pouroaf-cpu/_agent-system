// Computes a review batch plan, fresh, on demand. Never runs on its own — no
// timer, no poll loop, no background watcher. Call it, get one snapshot back.
//
// The idea (owner's postman analogy): cards touching the same files review
// together (context reuse); unrelated cards don't get crammed into the same
// batch just because they landed in Review around the same time.

import { readFileSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readBoard, cardFiles } from './cards.mjs'
import { readBindings } from './bindings.mjs'
export { cardFiles } from './cards.mjs'

// Single tunable knobs, not scattered magic numbers.
export const REVIEW_BATCH_CAP_MINUTES = 25
export const HOLD_BACK_THRESHOLD_MINUTES = 10
export const DEFAULT_REVIEW_MINUTES = 5

export function readReviewGroups(tasksDir) {
  const path = join(tasksDir, '.review-groups.json')
  if (!existsSync(path)) return []
  const groups = JSON.parse(readFileSync(path, 'utf8'))
  const seen = new Set()
  if (!Array.isArray(groups)) throw new Error('Invalid review groups')
  for (const group of groups) {
    if (!group.name || !Array.isArray(group.cards) || !group.cards.length) throw new Error('Invalid review group')
    for (const id of group.cards) {
      if (!/^T-\d+$/.test(id) || seen.has(id)) throw new Error(`Duplicate/invalid grouped review card: ${id}`)
      seen.add(id)
    }
  }
  return groups
}
export function saveReviewGroups(tasksDir, groups) {
  const known = new Set(Object.values(readBoard(tasksDir)).flat().map(c => c.id))
  const seen = new Set()
  if (!Array.isArray(groups)) throw new Error('Review groups must be an array')
  for (const group of groups) {
    if (!group.name || !Array.isArray(group.cards) || !group.cards.length) throw new Error('Invalid review group')
    for (const id of group.cards) {
      if (!known.has(id) || seen.has(id)) throw new Error(`Unknown/duplicate grouped review card: ${id}`)
      seen.add(id)
    }
  }
  const path = join(tasksDir, '.review-groups.json')
  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(groups, null, 2))
  renameSync(`${path}.${process.pid}.tmp`, path)
  return groups
}

const EST_BUILD = /\*\*Est build:\*\*\s*(\d+)\s*m/i
const EST_REVIEW = /\*\*Est review:\*\*\s*(\d+)\s*m/i

function readHead(path, bytes = 2048) {
  const buf = readFileSync(path)
  return buf.subarray(0, bytes).toString('utf8')
}

export function cardEstimates(path) {
  const head = readHead(path)
  const build = head.match(EST_BUILD)?.[1]
  const review = head.match(EST_REVIEW)?.[1]
  return {
    build: build != null ? Number(build) : null,
    review: review != null ? Number(review) : DEFAULT_REVIEW_MINUTES,
  }
}

// Split ids into batches capped at REVIEW_BATCH_CAP_MINUTES, in the given
// order. Simple chunking — no attempt to optimise which subset lands together.
function chunk(ids, estOf, reasonFn) {
  const batches = []
  let cur = []
  let curMin = 0
  for (const id of ids) {
    const m = estOf.get(id) ?? DEFAULT_REVIEW_MINUTES
    if (cur.length && curMin + m > REVIEW_BATCH_CAP_MINUTES) {
      batches.push({ cards: cur, estMinutes: curMin, reason: reasonFn(cur) })
      cur = []
      curMin = 0
    }
    cur.push(id)
    curMin += m
  }
  if (cur.length) batches.push({ cards: cur, estMinutes: curMin, reason: reasonFn(cur) })
  return batches
}

// Simple union-find over card ids, unioned by any shared file.
function groupByFiles(cardIds, filesOf) {
  const parent = new Map(cardIds.map((id) => [id, id]))
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)))
      x = parent.get(x)
    }
    return x
  }
  const union = (a, b) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }

  const fileToCards = new Map()
  for (const id of cardIds) {
    for (const f of filesOf.get(id)) {
      if (!fileToCards.has(f)) fileToCards.set(f, [])
      fileToCards.get(f).push(id)
    }
  }
  for (const ids of fileToCards.values()) {
    for (let i = 1; i < ids.length; i++) union(ids[0], ids[i])
  }

  const groups = new Map()
  for (const id of cardIds) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }
  return [...groups.values()]
}

function reasonForGroup(ids, filesOf) {
  const counts = new Map()
  for (const id of ids) for (const f of filesOf.get(id)) counts.set(f, (counts.get(f) || 0) + 1)
  const shared = [...counts].filter(([, n]) => n > 1).map(([f]) => f)
  return shared.length ? `shares ${shared.join(', ')}` : 'grouped by shared files'
}

// One computation, one snapshot. Returns { batches, heldBack }.
export function computeReviewPlan({ tasksDir, now = Date.now(), claimedIds = [] }) {
  const board = readBoard(tasksDir)
  const explicit = readReviewGroups(tasksDir)
  const grouped = new Set(explicit.flatMap(g => g.cards))
  const claimed = new Set(claimedIds)
  const explicitBatches = explicit.filter(g => g.cards.every(id => !claimed.has(id) && [...board.review, ...board.completed, ...board.archive].some(c => c.id === id)))
    .map(g => ({ cards: g.cards.filter(id => [...board.review, ...board.completed].some(c => c.id === id)), reason: g.name, explicit: true })).filter(g => g.cards.length)
  const auditCards = board.review.filter((c) => c.audit && !grouped.has(c.id) && !claimed.has(c.id))
  const reviewCards = board.review.filter((c) => !c.audit && !grouped.has(c.id) && !claimed.has(c.id))
  const workingCards = board.working
  const bindings = readBindings(tasksDir)

  const filesOf = new Map(reviewCards.map((c) => [c.id, cardFiles(c.path)]))
  const estOf = new Map(reviewCards.map((c) => [c.id, cardEstimates(c.path).review]))

  // Working cards close enough to done (< HOLD_BACK_THRESHOLD_MINUTES remaining)
  // hold back any Review card sharing a file with them. No **Est build:** means
  // "not waiting" — never hold anything back for a card with no estimate.
  const holders = []
  for (const w of workingCards) {
    const est = cardEstimates(w.path).build
    if (est == null) continue
    const binding = bindings[w.id]
    if (!binding?.started) continue
    const elapsedMin = (now - Date.parse(binding.started)) / 60000
    const remaining = est - elapsedMin
    if (remaining < HOLD_BACK_THRESHOLD_MINUTES) holders.push({ id: w.id, files: cardFiles(w.path) })
  }

  const heldBack = []
  const active = []
  for (const c of reviewCards) {
    const files = filesOf.get(c.id)
    const holder = holders.find((h) => h.files.some((f) => files.includes(f)))
    if (holder) {
      heldBack.push({
        card: c.id,
        waitingOn: holder.id,
        reason: `${holder.id} shares files and is close to done (< ${HOLD_BACK_THRESHOLD_MINUTES}m remaining)`,
      })
    } else {
      active.push(c)
    }
  }

  const groups = groupByFiles(active.map((c) => c.id), filesOf)
  const batches = []
  const solos = []
  for (const ids of groups) {
    if (ids.length > 1) {
      const ordered = active.filter((c) => ids.includes(c.id)).map((c) => c.id)
      batches.push(...chunk(ordered, estOf, (cur) => reasonForGroup(cur, filesOf)))
    } else {
      solos.push(ids[0])
    }
  }
  if (solos.length) {
    const ordered = active.filter((c) => solos.includes(c.id)).map((c) => c.id)
    batches.push(...chunk(ordered, estOf, () => 'no shared files, bundled to fill the batch'))
  }

  return {
    batches: [...explicitBatches, ...auditCards.map((c) => ({ cards: [c.id], estMinutes: estOf.get(c.id) ?? DEFAULT_REVIEW_MINUTES, reason: `${c.audit} audit` })), ...batches],
    heldBack,
  }
}
