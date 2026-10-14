// Free-commit gate helpers (HK62). Under 4 GB free no new agents start (above 6 GB they resume), and
// while agents are live the board samples every 10 s and stops the newest working Builder, one per
// 30 s, returning its card to Queue (worktree kept, not a failed build). Planners and Reviewers are
// never stopped here: only Builders have a binding.
import { readBindings, unbind } from './bindings.mjs'
import { findCard, moveCard } from './cards.mjs'
import { appendHistory } from './card-history.mjs'

export const MEMORY_SAMPLE_MS = 60000
export const MEMORY_SAMPLE_LIVE_MS = 10000
export const MEMORY_STOP_GAP_MS = 30000
export const MEMORY_LOW_GB = 4
export const MEMORY_RESUME_GB = 6

export const sampleDelayMs = (liveCount) => (liveCount > 0 ? MEMORY_SAMPLE_LIVE_MS : MEMORY_SAMPLE_MS)

// state: { low, minGb }. event is 'low', 'resume' or 'none'; minGb is the low-water mark so far.
export function applyReading({ low, minGb = Infinity }, gb) {
  const min = Math.min(minGb, gb)
  if (!low && gb < MEMORY_LOW_GB) return { low: true, event: 'low', minGb: min }
  if (low && gb > MEMORY_RESUME_GB) return { low: false, event: 'resume', minGb: min }
  return { low, event: 'none', minGb: min }
}

// The working agent whose binding started last; null when no bound agent is working.
export function newestBuilder(agents, bindings) {
  let best = null
  for (const [id, binding] of Object.entries(bindings)) {
    const agent = agents.find(a => a.pane_id === binding.pane_id && a.agent_status === 'working')
    if (!agent) continue
    const at = Date.parse(agent.startedAt || binding.started) || 0
    if (!best || at > best.at) best = { id, agent, binding, at }
  }
  return best
}

// entries: [{ project, tasksDir, session, agents }]. Closes the newest working Builder of all
// projects and requeues its card. `close(paneId, session)` is injected (herdr paneClose).
export async function stopNewestBuilder({ entries, close, now = Date.now(), lastStopAt = 0, gb }) {
  if (now - lastStopAt < MEMORY_STOP_GAP_MS) return { stopped: false }
  let pick = null
  for (const entry of entries) {
    const found = newestBuilder(entry.agents, readBindings(entry.tasksDir))
    if (!found) continue
    try { if (findCard(entry.tasksDir, found.id).column !== 'working') continue } catch { continue }
    if (!pick || found.at > pick.at) pick = { ...found, ...entry }
  }
  if (!pick) return { stopped: false }
  await close(pick.binding.pane_id, pick.session).catch(() => {})
  unbind(pick.tasksDir, pick.id)
  appendHistory(pick.tasksDir, pick.id, { event: 'memory-stop', stage: 'working', freeCommitGb: Number(gb.toFixed(1)), pane: pick.binding.pane_id })
  moveCard(pick.tasksDir, pick.id, 'queue')
  return { stopped: true, project: pick.project, id: pick.id, paneId: pick.binding.pane_id }
}
