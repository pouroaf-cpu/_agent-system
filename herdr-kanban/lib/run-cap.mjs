// Per-run token cap (HK42, gate 3 of 3). A Planner or Builder run whose own token usage reaches
// workflowLimits.maxTokensPerRun is ended by the board; its worktree is never touched. The first
// stop returns the card to Planning with an "Over run cap" note the next Planner reads; a second
// stop on the same card goes to Owner (one ASK line to the manager inbox) and starts no run.
// Check points: scripts/run-cap-hook.mjs after every tool call of a Claude run (one model turn),
// and enforceRunCaps once per poll as the backstop for Codex runs or a hook that failed open;
// there the stop is bound by the poll interval, not one step.
// Audit 2026-10-15 F4: the same stop applies to workflowLimits.maxStepsPerRun (model turns of
// one run; Claude transcripts only), and every stop is one alert line in activity.log and in
// the Token Manager inbox (TA).
import { findCard, moveCard } from './cards.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { readUsage, liveRunTokens, liveRunSteps, recordUsageFinish } from './request-usage.mjs'
import { maxTokensPerRun, maxStepsPerRun, boardConfig, projectOf } from './workflow-limits.mjs'
import { tokenAlertSettings } from './token-alert.mjs'
import { activityLog } from './activity.mjs'
import { postInbox } from './inbox.mjs'
import { formatNZTime } from './nz-time.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { readCardPlanners, saveCardPlanners } from './planner-state.mjs'
import { unbind } from './bindings.mjs'
import { stopCardRun } from './card-run.mjs'

const ROLES = { planner: 'Planner', builder: 'Builder' }
const LANE = { planner: 'planning', builder: 'working' }
const n = (x) => Number(x).toLocaleString('en-US')

const KEY = { tokens: 'maxTokensPerRun', steps: 'maxStepsPerRun' }

export const overCapNote = (role, id, tokens, limit, unit = 'tokens') =>
  `Over run cap: the ${ROLES[role]} run for ${id} was stopped by the board after ${n(tokens)} ${unit} (cap ${n(limit)} ${unit === 'steps' ? 'steps ' : ''}per run). Its worktree and uncommitted changes are kept. Do not plan this card whole again: split it with hkb split into cards that each fit one run, or narrow its scope and Files so that one run fits. A second cap stop on this card asks the project manager instead of starting another run.`

const secondStopNote = (role, id, tokens, limit, unit = 'tokens') =>
  `Run over the ${unit === 'steps' ? 'step' : 'token'} cap twice: the ${ROLES[role]} run for ${id} was stopped at ${n(tokens)} ${unit} (cap ${n(limit)}) after an earlier run on this card was stopped the same way and the card was sent back to be split. The board started no new run. Its worktree and uncommitted work are kept. Should the card be split by hand, its scope cut, or workflowLimits.${KEY[unit]} raised for it?`

// One line per stop: activity.log (and the board log) plus the Token Manager inbox when one is
// set up (the default inbox is skipped under KANBAN_TEST so temp boards never write there).
function announceStop({ tasksDir, project, id, role, tokens, limit, unit, stopNumber }) {
  const message = `${ROLES[role]} run stopped at ${n(tokens)} ${unit} (cap ${n(limit)} ${KEY[unit]}), stop ${stopNumber} on this card`
  activityLog({ tasksDir, project, cardId: id, event: 'run-cap', message, level: 'warn' })
  let inbox = null
  try { inbox = process.env.KANBAN_TEST && !boardConfig().tokenManager?.inbox ? null : tokenAlertSettings().inbox } catch { /* no config: no inbox */ }
  if (!inbox) return
  try { postInbox(inbox, `- ${formatNZTime()} RUN CAP ${project} ${id} ${role} ${message}\n`, undefined, 'TA') } catch { /* alert is best effort; the stop stands */ }
}

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

export async function capStopRun({ tasksDir, project, run, tokens, limit, unit = 'tokens', now = new Date(), root }) {
  const id = run.cardIds[0], role = run.role
  project ||= projectOf(tasksDir)
  let card
  try { card = findCard(tasksDir, id) } catch { return { stopped: false } }
  if (card.column !== LANE[role]) return { stopped: false }
  const stops = readWorkflow(tasksDir)[id]?.runCapStops || []
  if (stops.length && Date.parse(stops.at(-1)) >= Date.parse(run.start?.at)) return { stopped: true, repeated: true, tokens, limit }
  const since = Date.parse(readWorkflow(tasksDir)[id]?.limitsResetAt) || 0
  const stopNumber = stops.filter(at => Date.parse(at) >= since).length + 1
  updateWorkflow(tasksDir, id, { runCapStops: [...stops, now.toISOString()] })
  appendHistory(tasksDir, id, { event: 'run-cap-stop', stage: role, runId: run.runId, tokens, limit, unit, stopNumber })
  announceStop({ tasksDir, project, id, role, tokens, limit, unit, stopNumber })
  await recordUsageFinish({ tasksDir, runId: run.runId, status: 'complete', root })
  if (role === 'builder') {
    unbind(tasksDir, id)
    updateWorkflow(tasksDir, id, { noHandoffStreak: 0, operational: null })
  }
  resetPlannerOwner(tasksDir, id, run.paneId)
  if (stopNumber > 1) {
    writeCurrentFeedback(tasksDir, moveCard(tasksDir, id, 'owner'), 'Needs you', secondStopNote(role, id, tokens, limit, unit))
  } else {
    const current = role === 'builder' ? moveCard(tasksDir, id, 'planning') : card
    writeCurrentFeedback(tasksDir, current, 'Over run cap', overCapNote(role, id, tokens, limit, unit))
  }
  stopCardRun(project, id, `Run ${unit === 'steps' ? 'step' : 'token'} cap reached; authorization ended`)
  return { stopped: true, tokens, limit, unit, stopNumber }
}

// The first cap the run has reached: tokens, then steps; null when under both or unknown.
export function runOverCap(run, { sessionId, root, tokenLimit = maxTokensPerRun(), stepLimit = maxStepsPerRun() } = {}) {
  if (tokenLimit != null) {
    const tokens = liveRunTokens(run, { sessionId, root })
    if (tokens != null && tokens >= tokenLimit) return { tokens, limit: tokenLimit, unit: 'tokens' }
  }
  if (stepLimit != null) {
    const steps = liveRunSteps(run, { sessionId, root })
    if (steps != null && steps >= stepLimit) return { tokens: steps, limit: stepLimit, unit: 'steps' }
  }
  return null
}

export async function checkRunCap({ tasksDir, project, run, sessionId, session, closePane, root, now }) {
  if (run.finish || run.duplicateOf || !ROLES[run.role] || run.cardIds?.length !== 1) return { stopped: false }
  const over = runOverCap(run, { sessionId, root })
  if (!over) return { stopped: false }
  const result = await capStopRun({ tasksDir, project, run, ...over, now, root })
  if (result.stopped && closePane && run.paneId) try { await closePane(run.paneId, session) } catch { /* the run is already closed in usage */ }
  return result
}

export async function enforceRunCaps({ tasksDir, project, session, closePane, root, log = () => {}, now }) {
  if (maxTokensPerRun() == null && maxStepsPerRun() == null) return
  for (const run of Object.values(readUsage(tasksDir).runs)) {
    if (run.finish) continue
    try {
      const result = await checkRunCap({ tasksDir, project, run, session, closePane, root, now })
      if (result.stopped && !result.repeated) log(`${run.cardIds[0]} ${run.role} run stopped at ${result.tokens} ${result.unit || 'tokens'} (cap ${result.limit})`)
    } catch (err) { log(`${run.cardIds?.[0] ?? '-'} run cap check failed: ${err.message}`) }
  }
}
