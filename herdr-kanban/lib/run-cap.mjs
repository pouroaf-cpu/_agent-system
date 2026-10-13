// Per-run token cap (HK42, gate 3 of 3). A Planner or Builder run whose own token usage reaches
// workflowLimits.maxTokensPerRun is ended by the board; its worktree is never touched. The first
// stop returns the card to Planning with an "Over run cap" note the next Planner reads; a second
// stop on the same card goes to Owner (one ASK line to the manager inbox) and starts no run.
// Check points: scripts/run-cap-hook.mjs after every tool call of a Claude run (one model turn),
// and enforceRunCaps once per poll as the backstop for Codex runs or a hook that failed open;
// there the stop is bound by the poll interval, not one step.
import { findCard, moveCard } from './cards.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { readUsage, liveRunTokens, recordUsageFinish } from './request-usage.mjs'
import { maxTokensPerRun } from './workflow-limits.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { readCardPlanners, saveCardPlanners } from './planner-state.mjs'
import { unbind } from './bindings.mjs'
import { stopCardRun } from './card-run.mjs'

const ROLES = { planner: 'Planner', builder: 'Builder' }
const LANE = { planner: 'planning', builder: 'working' }
const n = (x) => Number(x).toLocaleString('en-US')

export const overCapNote = (role, id, tokens, limit) =>
  `Over run cap: the ${ROLES[role]} run for ${id} was stopped by the board after ${n(tokens)} tokens (cap ${n(limit)} per run). Its worktree and uncommitted changes are kept. Do not plan this card whole again: split it with hkb split into cards that each fit one run, or narrow its scope and Files so that one run fits. A second cap stop on this card asks the project manager instead of starting another run.`

const secondStopNote = (role, id, tokens, limit) =>
  `Run over the token cap twice: the ${ROLES[role]} run for ${id} was stopped at ${n(tokens)} tokens (cap ${n(limit)}) after an earlier run on this card was stopped the same way and the card was sent back to be split. The board started no new run. Its worktree and uncommitted work are kept. Should the card be split by hand, its scope cut, or workflowLimits.maxTokensPerRun raised for it?`

// Next Planner pass launches a fresh Planner, never a resume of the over-cap session.
function resetPlannerOwner(tasksDir, id, paneId) {
  for (let attempt = 0; ; attempt++) {
    const owners = readCardPlanners(tasksDir), owner = owners[id]
    if (!owner || ['retiring', 'retired'].includes(owner.lifecycle)) return
    Object.assign(owner, { submitted: false, startRetry: true, replacementAttempts: 0, revokedPaneIds: [...new Set([...(owner.revokedPaneIds || []), owner.paneId, paneId].filter(Boolean))] })
    for (const k of ['inactiveSince', 'noHandoffCount', 'error', 'handoffRetried']) delete owner[k]
    try { return saveCardPlanners(tasksDir, owners) } catch (err) {
      if (attempt || !/stale callback refused/.test(err.message)) throw err
    }
  }
}

export async function capStopRun({ tasksDir, project, run, tokens, limit, now = new Date(), root }) {
  const id = run.cardIds[0], role = run.role
  let card
  try { card = findCard(tasksDir, id) } catch { return { stopped: false } }
  if (card.column !== LANE[role]) return { stopped: false }
  const stops = readWorkflow(tasksDir)[id]?.runCapStops || []
  if (stops.length && Date.parse(stops.at(-1)) >= Date.parse(run.start?.at)) return { stopped: true, repeated: true, tokens, limit }
  const since = Date.parse(readWorkflow(tasksDir)[id]?.limitsResetAt) || 0
  const stopNumber = stops.filter(at => Date.parse(at) >= since).length + 1
  updateWorkflow(tasksDir, id, { runCapStops: [...stops, now.toISOString()] })
  appendHistory(tasksDir, id, { event: 'run-cap-stop', stage: role, runId: run.runId, tokens, limit, stopNumber })
  await recordUsageFinish({ tasksDir, runId: run.runId, status: 'complete', root })
  if (role === 'builder') {
    unbind(tasksDir, id)
    updateWorkflow(tasksDir, id, { noHandoffStreak: 0, operational: null })
  }
  resetPlannerOwner(tasksDir, id, run.paneId)
  if (stopNumber > 1) {
    writeCurrentFeedback(tasksDir, moveCard(tasksDir, id, 'owner'), 'Needs you', secondStopNote(role, id, tokens, limit))
  } else {
    const current = role === 'builder' ? moveCard(tasksDir, id, 'planning') : card
    writeCurrentFeedback(tasksDir, current, 'Over run cap', overCapNote(role, id, tokens, limit))
  }
  stopCardRun(project, id, 'Run token cap reached; authorization ended')
  return { stopped: true, tokens, limit, stopNumber }
}

export async function checkRunCap({ tasksDir, project, run, sessionId, session, closePane, root, now }) {
  const limit = maxTokensPerRun()
  if (limit == null || run.finish || run.duplicateOf || !ROLES[run.role] || run.cardIds?.length !== 1) return { stopped: false }
  const tokens = liveRunTokens(run, { sessionId, root })
  if (tokens == null || tokens < limit) return { stopped: false }
  const result = await capStopRun({ tasksDir, project, run, tokens, limit, now, root })
  if (result.stopped && closePane && run.paneId) try { await closePane(run.paneId, session) } catch { /* the run is already closed in usage */ }
  return result
}

export async function enforceRunCaps({ tasksDir, project, session, closePane, root, log = () => {}, now }) {
  if (maxTokensPerRun() == null) return
  for (const run of Object.values(readUsage(tasksDir).runs)) {
    if (run.finish) continue
    try {
      const result = await checkRunCap({ tasksDir, project, run, session, closePane, root, now })
      if (result.stopped && !result.repeated) log(`${run.cardIds[0]} ${run.role} run stopped at ${result.tokens} tokens (cap ${result.limit})`)
    } catch (err) { log(`${run.cardIds?.[0] ?? '-'} run cap check failed: ${err.message}`) }
  }
}
