// Spawn-attempt counters, so a card that fails to start gets a few more goes
// before it lands on someone's desk.
//
// Runtime state, not card state: it lives beside .board.json, is gitignored, and
// is thrown away the moment the card actually starts.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const file = (tasksDir) => join(tasksDir, '.board-retries.json')

// Give the thing that failed a moment to recover rather than burning all three
// attempts inside six seconds of polling.
const BACKOFF_MS = [15000, 45000]

export function readRetries(tasksDir) {
  const path = file(tasksDir)
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function write(tasksDir, data) {
  mkdirSync(tasksDir, { recursive: true })
  writeFileSync(file(tasksDir), JSON.stringify(data, null, 2))
}

export const attemptsFor = (tasksDir, cardId) => readRetries(tasksDir)[cardId.toUpperCase()]?.attempts ?? 0

// True while a failed card is still serving its backoff.
export function coolingDown(tasksDir, cardId, now = Date.now()) {
  const entry = readRetries(tasksDir)[cardId.toUpperCase()]
  return !!entry?.nextAt && now < entry.nextAt
}

// Record a failure. Returns the new attempt count and when it may be tried again.
export function recordFailure(tasksDir, cardId, now = Date.now()) {
  const all = readRetries(tasksDir)
  const id = cardId.toUpperCase()
  const attempts = (all[id]?.attempts ?? 0) + 1
  const wait = BACKOFF_MS[attempts - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]
  all[id] = { attempts, nextAt: now + wait }
  write(tasksDir, all)
  return { attempts, nextAt: all[id].nextAt }
}

export function clearRetries(tasksDir, cardId) {
  const all = readRetries(tasksDir)
  delete all[cardId.toUpperCase()]
  write(tasksDir, all)
}
