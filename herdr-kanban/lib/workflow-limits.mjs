import { readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readUsage } from './request-usage.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { appendHistory } from './card-history.mjs'
import { activityLog } from './activity.mjs'
import { postInbox } from './inbox.mjs'
import { formatNZTime, formatNZText } from './nz-time.mjs'

export const configPath = () => process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))
export function boardConfig() {
  return JSON.parse(readFileSync(configPath(), 'utf8'))
}
export function workflowLimits() {
  return boardConfig().workflowLimits || {}
}
// Per-run step cap (audit 2026-10-15 F4): model turns one Planner or Builder run may take.
// Off unless configured (absent, null or <= 0): Codex transcripts carry no step count.
export function maxStepsPerRun(limits = workflowLimits()) {
  const value = limits.maxStepsPerRun
  return Number.isFinite(value) && value > 0 ? value : null
}
// The project a TASKS folder belongs to, by the config's projects list, else its folder name.
export function projectOf(tasksDir, config = boardConfig()) {
  const folder = resolve(dirname(tasksDir)).toLowerCase()
  return config.projects?.find(p => resolve(config.projectsRoot || '.', p).toLowerCase() === folder) || basename(dirname(tasksDir))
}
// The project's manager inbox, else the Kanban Manager's. Tests (KANBAN_TEST) with no inbox
// configured get null, so no temp board ever writes into the real inbox.
export function managerInboxOf(tasksDir, config = boardConfig()) {
  const configured = config.projectSettings?.[projectOf(tasksDir, config)]?.manager?.inbox || process.env.KANBAN_MANAGER_INBOX
  if (configured) return configured
  return process.env.KANBAN_TEST ? null : join(dirname(configPath()), '..', '_roles', 'KANBAN_MANAGER-INBOX.md')
}
// Audit 2026-10-15 F4 AC1: a card held at a workflow limit is told to the manager once (one
// activity line and one inbox line, HO), at the moment the hold is recorded. Before this the
// hold was silent on a Planning card (card-planner skips it) and only the server's hard-hold
// alert covered Queue; 26 cards passed 12M tokens with no cap and nothing in any inbox.
function announceHold(tasksDir, id, role, reason) {
  let config = {}
  try { config = boardConfig() } catch { /* the hold itself does not need the config */ }
  const project = projectOf(tasksDir, config)
  activityLog({ tasksDir, project, cardId: id, event: 'hold', message: reason, level: 'warn' })
  const inbox = managerInboxOf(tasksDir, config)
  if (!inbox) return
  try { postInbox(inbox, `- ${formatNZTime()} HOLD ${project} ${id} (${role}): ${formatNZText(reason)}. Dispatch is held until the card is moved out of Owner or retried; a drag out of Owner resets the count.\n`, undefined, 'HO') } catch { /* alert is best effort; the hold stands */ }
}
// Per-run token cap (HK42): a Planner or Builder run past it is stopped by the board. A missing
// key means the default; only an explicit null turns the cap off.
export const DEFAULT_MAX_TOKENS_PER_RUN = 4000000
export function maxTokensPerRun(limits = workflowLimits()) {
  const value = limits.maxTokensPerRun
  if (value === null && 'maxTokensPerRun' in limits) return null
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_TOKENS_PER_RUN
}
export function checkWorkflowLimits(tasksDir, id, role, now = Date.now()) {
  const limits = workflowLimits()
  // Only runs since the operator's last retry count (limitsResetAt, set when a card is
  // dragged out of Owner); otherwise a card like T-148 stays held forever.
  const since = Date.parse(readWorkflow(tasksDir)[id]?.limitsResetAt) || 0
  const runs = Object.values(readUsage(tasksDir).runs).filter(run => !run.duplicateOf && run.cardIds?.includes(id) && (Date.parse(run.start?.at) || 0) >= since)
  const stage = runs.filter(run => run.role === role)
  const unknown = runs.some(run => !run.delta || run.shared || run.cardIds.length !== 1)
  const metrics = [
    ['maxRunsPerStage', stage.length],
    ['maxTokensPerCard', runs.reduce((sum, run) => sum + (run.delta?.total || 0), 0)],
    ['maxElapsedMsPerStage', stage.reduce((sum, run) => sum + Math.max(0, (Date.parse(run.finish?.at) || now) - (Date.parse(run.start?.at) || now)), 0)],
  ]
  for (const [key, value] of metrics) {
    const cap = limits[key]
    if (cap == null) continue
    if (!Number.isFinite(cap) || cap <= 0) return `Invalid configured ${key}; dispatch held`
    const reason = key === 'maxTokensPerCard' && unknown ? 'Token cap cannot be established: unknown/shared usage requires reconciliation' : value >= cap ? `${key} reached (${value}/${cap}); dispatch held` : null
    const warning = reason || (limits.warningFraction > 0 && limits.warningFraction < 1 && value >= cap * limits.warningFraction ? `${key} approaching (${value}/${cap})` : null)
    if (warning && readWorkflow(tasksDir)[id]?.limitWarning !== warning) {
      appendHistory(tasksDir, id, { event: reason ? 'usage-limit' : 'usage-warning', stage: role, reason: warning })
      updateWorkflow(tasksDir, id, { limitWarning: warning })
      if (reason) announceHold(tasksDir, id, role, reason)
    }
    if (reason) return reason
  }
  return null
}

// Audit 2026-10-12 finding 10: maxTokensPerCard holds the card once reached (stall-watchdog
// routes a workflow-limit hold straight to Owner), which the audit says a size warning must
// not do. This is a separate, warning-only read: it never feeds checkWorkflowLimits or any
// hold, so it cannot move, hold or kick back a card. The caller (server.mjs) sends the result
// through notifyManagerException, whose own cooldown state makes each card's alert one-time.
// liveIds: only cards still on the board. Without it every archived card is named too
// (616 inbox lines in one poll, 2026-10-12).
export function tokenWarnings(tasksDir, liveIds) {
  const threshold = workflowLimits().warnTokensPerCard
  if (!Number.isFinite(threshold) || threshold <= 0) return []
  const totals = new Map()
  for (const run of Object.values(readUsage(tasksDir).runs)) {
    if (run.duplicateOf) continue
    for (const id of run.cardIds || []) totals.set(id, (totals.get(id) || 0) + (run.delta?.total || 0))
  }
  return [...totals].filter(([id, total]) => total >= threshold && (!liveIds || liveIds.has(id))).map(([id, total]) => ({ id, total, threshold }))
}
