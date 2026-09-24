import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readUsage } from './request-usage.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { appendHistory } from './card-history.mjs'

export function workflowLimits() {
  const config = JSON.parse(readFileSync(process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url)), 'utf8'))
  return config.workflowLimits || {}
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
    }
    if (reason) return reason
  }
  return null
}
