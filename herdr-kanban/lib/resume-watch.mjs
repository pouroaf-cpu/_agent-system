// Resume watch: after a stoppage ends, work must start again on its own. A stoppage is a usage-limit
// block, a low-disk or low-memory pause, or a board restart (a relaunch or a code update is one, too).
// Once its cause is gone, a free Builder slot and a queued card that no hold stops should start a
// Builder within RESUME_BOUND_MS. If nothing starts, the Kanban Manager gets one inbox line for that
// project, naming the card and the stoppage. Each stoppage alerts at most once; a start closes it.
// Only the readiness check reads the board; the rest is a small JSON file in the board root.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { formatNZTime } from './nz-time.mjs'

export const RESUME_BOUND_MS = 10 * 60 * 1000
const KEEP_MS = 3 * 24 * 60 * 60 * 1000
export const STOPPAGE_LABEL = {
  quota: 'a usage-limit reset',
  disk: 'low disk recovering',
  memory: 'low memory recovering',
  cpu: 'CPU use recovering',
  restart: 'a board restart',
}

export const watchPath = boardRoot => join(boardRoot, '.resume-watch.json')

function readWatch(boardRoot) {
  try { return JSON.parse(readFileSync(watchPath(boardRoot), 'utf8')) } catch { return {} }
}

function saveWatch(boardRoot, state) {
  const file = watchPath(boardRoot)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(state, null, 2) + '\n')
}

const open = rec => rec.resumedAt == null && rec.alertedAt == null

// Drop anything older than KEEP_MS so the file stays small.
function pruned(state, now) {
  for (const [key, rec] of Object.entries(state)) if (now - rec.startedAt > KEEP_MS) delete state[key]
  return state
}

// A stoppage is on (clearedAt null) or its cause cleared at clearedAt (ms). Recording the same
// stoppage again changes nothing; a stoppage that already alerted or resumed is never reopened.
export function beginStoppage(boardRoot, { id, projects, kind, clearedAt = null, now = Date.now() }) {
  const state = readWatch(boardRoot)
  let changed = false
  for (const project of projects) {
    const key = `${project}|${id}`
    const rec = state[key]
    if (!rec) {
      state[key] = { id, project, kind, startedAt: now, clearedAt, readySince: null, resumedAt: null, alertedAt: null }
      changed = true
    } else if (open(rec) && rec.clearedAt !== clearedAt) {
      state[key] = { ...rec, clearedAt, readySince: null }
      changed = true
    }
  }
  if (changed) saveWatch(boardRoot, pruned(state, now))
}

// The cause of every open stoppage of this kind is gone now (disk above 8 GB, memory above 6 GB).
export function clearStoppage(boardRoot, { kind, projects, now = Date.now() }) {
  const state = readWatch(boardRoot)
  let changed = false
  for (const rec of Object.values(state)) {
    if (rec.kind !== kind || !open(rec) || rec.clearedAt != null || !projects.includes(rec.project)) continue
    rec.clearedAt = now
    changed = true
  }
  if (changed) saveWatch(boardRoot, state)
}

// Forget open stoppages of these kinds. Used at boot: the pause state is read again from the
// first sample, so a still-low disk opens a fresh stoppage and a clear one opens none.
export function dropStoppages(boardRoot, kinds) {
  const state = readWatch(boardRoot)
  let changed = false
  for (const [key, rec] of Object.entries(state)) {
    if (kinds.includes(rec.kind) && open(rec)) { delete state[key]; changed = true }
  }
  if (changed) saveWatch(boardRoot, state)
}

// A Builder started for this project: every stoppage whose cause is gone is resumed.
export function noteStart(boardRoot, { project, now = Date.now() }) {
  const state = readWatch(boardRoot)
  let changed = false
  for (const rec of Object.values(state)) {
    if (rec.project !== project || !open(rec) || rec.clearedAt == null || rec.clearedAt > now) continue
    rec.resumedAt = now
    rec.readySince = null
    changed = true
  }
  if (changed) saveWatch(boardRoot, state)
}

// The first queued card that no hold stops, when a Builder slot is free and nothing pauses the board.
export function readyCard({ queue = [], holds = {}, slotsFree = 0, paused = false }) {
  if (paused || slotsFree <= 0) return null
  return queue.find(card => !holds[card.id]) ?? null
}

// Called once per project poll. `ready` is true when readyCard found a card. Returns the stoppage to
// alert about (once), or null. The clock only runs while a card is ready, so a pause or a usage
// block never counts against the bound.
export function checkResume(boardRoot, { project, ready, now = Date.now(), bound = RESUME_BOUND_MS }) {
  const state = readWatch(boardRoot)
  const due = []
  let changed = false
  for (const rec of Object.values(state)) {
    if (rec.project !== project || !open(rec) || rec.clearedAt == null || rec.clearedAt > now) continue
    if (!ready) {
      if (rec.readySince != null) { rec.readySince = null; changed = true }
      continue
    }
    if (rec.readySince == null) { rec.readySince = now; changed = true }
    if (now - rec.readySince >= bound) due.push(rec)
  }
  if (!due.length) {
    if (changed) saveWatch(boardRoot, state)
    return null
  }
  for (const rec of due) rec.alertedAt = now
  saveWatch(boardRoot, state)
  return due.sort((a, b) => a.startedAt - b.startedAt)[0]
}

// The inbox line for a stoppage that did not resume. The alert key is per project and stoppage.
export function resumeAlert(record, { cardId, now = Date.now() }) {
  const label = STOPPAGE_LABEL[record.kind] ?? record.kind
  const since = record.clearedAt == null ? 'the stoppage' : `${label} at ${formatNZTime(record.clearedAt)}`
  const minutes = Math.round((now - record.readySince) / 60000)
  return {
    key: `resume:${record.project}:${record.id}`,
    title: `${record.project} ${cardId}: work has not resumed after ${label}`,
    detail: `${cardId} is queued with no hold and a Builder slot is free, but no Builder has started in ${minutes} minutes since ${since}. `
      + 'No hold reason is recorded for it. The board keeps trying; this line is sent once for this stoppage.',
  }
}
