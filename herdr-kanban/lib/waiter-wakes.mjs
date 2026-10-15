// Wake memory for the board waiters (scripts/project-wait.mjs, scripts/km-wait.mjs). A waiter exits
// with one line and its chat re-arms it, so an in-memory "already woke for this" dies with each
// respawn and the same unchanged condition woke the Injectbuddy chat again and again overnight
// 15-16 Oct 2026 (STUCK I1322 six times, CK I1339 three times). This ledger keeps one time per
// condition key: the last time a waiter saw it holding. A key is news only when it was not seen in
// the last WAKE_REARM_MS, the same rule as lib/board-alerts.mjs (operator, 2026-10-16).
import { readFileSync, writeFileSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'

export const WAKE_REARM_MS = 6 * 60 * 60e3
const SAVE_EVERY_MS = 60e3

function read(file) {
  try {
    const seen = JSON.parse(readFileSync(file, 'utf8'))
    return seen && typeof seen === 'object' && !Array.isArray(seen) ? seen : {}
  } catch { return {} }
}

// One ledger per waiter file. `observe` records what is holding; `flush` persists it. Callers flush
// before a waiter prints its wake line, so a respawned waiter reads the wake it is answering.
export function wakeLedger(file) {
  const seen = read(file)
  let saved = JSON.stringify(seen), savedKeys = Object.keys(seen).sort().join('\n'), savedAt = 0
  return {
    isNews(key, now) {
      return !(typeof seen[key] === 'number' && now - seen[key] < WAKE_REARM_MS)
    },
    observe(keys, now) {
      for (const key of keys) seen[key] = now
      for (const [key, at] of Object.entries(seen)) if (now - at >= WAKE_REARM_MS) delete seen[key]
    },
    flush(now, { force = false } = {}) {
      const json = JSON.stringify(seen)
      if (json === saved) return
      const keys = Object.keys(seen).sort().join('\n')
      // Routine refreshes of held keys are written once a minute; a key appearing or going is written at once.
      if (!force && keys === savedKeys && now - savedAt < SAVE_EVERY_MS) return
      // A ledger that cannot be written must not stop the waiter: the wake still prints, only its memory is lost.
      try {
        writeFileSync(file + '.tmp', json)
        renameSync(file + '.tmp', file)
        saved = json; savedKeys = keys; savedAt = now
      } catch { savedAt = now }
    },
  }
}
