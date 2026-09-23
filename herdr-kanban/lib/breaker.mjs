// Repeated failed starts trip a project; healthy launches never do. A successful
// launch resets the consecutive-failure window, and a trip cools down by itself.
const WINDOW_MS = 10 * 60 * 1000
const failures = new Map() // project -> [{ at, reason }], oldest first
const tripped = new Map() // project -> { reason, at, count, resetsAt }

function expire(project, now) {
  const state = tripped.get(project)
  if (state && now >= state.resetsAt) {
    tripped.delete(project)
    failures.delete(project)
  }
}

// Compatibility name used at successful spawn call sites.
export function recordSpawn({ project, now = Date.now() }) {
  if (!project) throw new Error('project is required')
  expire(project, now)
  if (!tripped.has(project)) failures.delete(project)
}

export function recordSpawnFailure({ project, cap = 1, now = Date.now(), reason = 'agent start failed' }) {
  if (!project) throw new Error('project is required')
  expire(project, now)
  if (tripped.has(project)) return breakerState(project, now)
  const recent = (failures.get(project) ?? []).filter((entry) => now - entry.at < WINDOW_MS)
  recent.push({ at: now, reason })
  failures.set(project, recent)
  const threshold = Math.max(3, Number(cap) || 1)
  if (recent.length >= threshold) {
    tripped.set(project, {
      reason: `${recent.length} consecutive spawn failures: ${reason}`,
      at: now,
      count: recent.length,
      resetsAt: now + WINDOW_MS,
    })
  }
  return breakerState(project, now)
}

export function breakerState(project, now = Date.now()) {
  expire(project, now)
  const state = tripped.get(project)
  return state ? { breakerTripped: true, ...state } : { breakerTripped: false }
}

export function resetBreaker(project) {
  if (project) {
    tripped.delete(project)
    failures.delete(project)
  } else {
    tripped.clear()
    failures.clear()
  }
}
