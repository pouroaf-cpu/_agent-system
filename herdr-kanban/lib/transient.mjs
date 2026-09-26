// Environment and capacity failures (machine load, npm file locks, a slow agent start,
// a check that ran out of time) are not the card's fault. They back off and retry as a
// visible hold, and ask the operator only after a wall-clock budget. Product failures
// (a tsc error, a real conflict) keep their two-strike limits.
import { execFile } from 'node:child_process'

// Error codes are matched case-sensitively so "agent_pane_busy" is not read as EBUSY.
const CODES = /\b(?:ENOTEMPTY|EPERM|EBUSY|ETIMEDOUT)\b/
const WORDS = /timed out|timeout|agent_not_ready|never submitted|unsubmitted|killed|SIGTERM|SIGKILL/i

// A string, an Error, or a check result. A check result counts only by its timedOut
// flag: its output can mention "timeout" or EPERM in a genuine test failure.
export function isTransient(failure) {
  if (failure?.timedOut) return true
  const text = typeof failure === 'string' ? failure : failure?.message
  return !!text && (CODES.test(text) || WORDS.test(text))
}

const STEPS_MS = [1, 5, 15, 60].map(m => m * 60000)
export const BUDGET_MS = 3 * 60 * 60000

// The next retry after one more transient failure. `prior` is the last retry ({ since, tries }) or null.
export function nextRetry(prior, now = Date.now()) {
  const since = prior?.since ?? now, tries = (prior?.tries ?? 0) + 1
  return { since, tries, nextAt: now + STEPS_MS[Math.min(tries, STEPS_MS.length) - 1], exhausted: now - since >= BUDGET_MS }
}
export const inBackoff = (retry, now = Date.now()) => !!retry?.since && now - retry.since < BUDGET_MS

// A hold that says when the board retries is an allowed wait for the stall watchdog.
export const retryHold = (what, nextAt) => `${what}; retrying at ${new Date(nextAt).toISOString()}`
export const isRetryHold = hold => /; retrying at \d{4}-\d\d-\d\dT/.test(String(hold || ''))

// Kill a child and everything it started (Windows test runners and npm spawn grandchildren
// that would otherwise keep running and holding files).
export function killTree(pid) {
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
  else try { process.kill(pid) } catch {} // ponytail: sh grandchildren survive; use a process group if a POSIX board ever needs it
}
