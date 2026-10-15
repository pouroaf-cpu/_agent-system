import { execFile } from 'node:child_process'

// A value that costs a process start (PowerShell, git on a large repo) is read in the background.
// The caller gets the last answer at once: `known` is false until a load has succeeded, so a caller
// must treat an unknown value as "no answer yet" (never break a lock or show a number on doubt).
// A failed load is retried after the ttl. Keeps the board's event loop off the process start.
const entries = new Map()

export function cachedAsync(key, load, { ttl = 60000 } = {}) {
  const entry = entries.get(key) ?? { value: undefined, known: false, at: 0, pending: false }
  if (!entry.pending && Date.now() - entry.at > ttl) {
    entries.set(key, { ...entry, pending: true })
    Promise.resolve().then(load).then(
      value => entries.set(key, { value, known: true, at: Date.now(), pending: false }),
      () => entries.set(key, { value: undefined, known: false, at: Date.now(), pending: false }),
    )
  }
  return entries.get(key) ?? entry
}

export function execText(file, args, options = {}) {
  return new Promise((done, fail) => {
    execFile(file, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options }, (err, stdout) => {
      if (err) fail(err)
      else done(String(stdout))
    })
  })
}

// Test hook: forget every cached value.
export function clearCachedAsync() {
  entries.clear()
}
