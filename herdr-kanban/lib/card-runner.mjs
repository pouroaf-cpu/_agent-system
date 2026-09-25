import { readFileSync } from 'node:fs'
import { readBoard, findCard, validatePlan, moveCard, currentReviewDecision } from './cards.mjs'
import { readBindings } from './bindings.mjs'
import { readCardPlanners, runCardPlanner } from './card-planner.mjs'
import { pendingDeliveries } from './delivery-state.mjs'
import { readWorktrees, recordedOverlapBlockers } from './worktrees.mjs'
import { readWorkflow } from './workflow-state.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'
import { autoSpawn, spawnReviewer, unmetBlockers, startHoldReason, routeReviewVerdicts } from './autospawn.mjs'
import { activeCardRun, pausedRunEnvironment, stopCardRun, withCardRunAssignment, interruptedCardRun } from './card-run.mjs'
import { sessionOf } from './herdr.mjs'
import { reviewClaimFor } from './review-claims.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { reconcileCompletedHandoffs } from './completed-handoff.mjs'

export function cardRunEligibility(options) {
  try { return eligibility(options) }
  catch (error) {
    // A filesystem handoff can move the card after the board snapshot was read.
    // Fail closed for this frame; never crash the server or dispatch stale state.
    if (error.code === 'ENOENT') return 'Card changed during inspection; refresh before running'
    throw error
  }
}
function eligibility({ project, tasksDir, projectPath, card, board = readBoard(tasksDir), agents = [], known = false }) {
  if (!pausedRunEnvironment()) return 'Requires all projects paused and global capacity zero'
  const active = activeCardRun()
  if (active) return `Explicit run active: ${active.project}/${active.cardId}`
  if (!['planning', 'planned', 'queue', 'completed', 'review'].includes(card.column) || card.audit) return 'Only approved implementation cards awaiting work or review can run'
  if (!card.cardOwned) return 'Card-owned approved workflow required'
  if (!known) return 'Agent inventory unavailable'
  if (agents.some(a => a.agent_status === 'working')) return 'Existing agent is still working; wait for its turn to finish'
  if (pendingDeliveries(sessionOf(project)).length) return 'Existing paused delivery needs reconciliation before a fresh run'
  if (Object.values(board).flat().filter(c => c.id === card.id).length !== 1) return 'Card identity is not unique'
  if (readBindings(tasksDir)[card.id]) return 'Existing Builder assignment needs reconciliation'
  const owner = readCardPlanners(tasksDir)[card.id]
  if (owner && (!owner.closedAt && (owner.submitted || agents.some(a => a.pane_id === owner.paneId && !['idle', 'done'].includes(a.agent_status))))) return 'Existing Planner assignment needs reconciliation'
  const saved = readWorkflow(tasksDir)[card.id]
  if (['completed', 'review'].includes(card.column)) {
    const root = dirname(process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url)))
    if (reviewClaimFor(root, tasksDir, card.id)) return 'Existing Reviewer assignment needs reconciliation'
    if (currentReviewDecision(readFileSync(card.path, 'utf8'))) return 'Existing verdict must be resolved before another review'
    if (saved?.completedStage !== 'working') return 'Recorded Builder completion required before review-only recovery'
  }
  if (saved?.operational) return `Operational recovery requires attention: ${saved.operational.reason}`
  const registry = readWorktrees(tasksDir)
  if (registry[card.id]?.state === 'issue' && !(card.column === 'planning' && owner?.lifecycle === 'retired' && owner.recoveryReady && owner.reconciliationHistoryId)) return `Preserved work needs recovery: ${registry[card.id].reason}`
  const blocked = [...new Set([...unmetBlockers(card, board, registry), ...recordedOverlapBlockers(card, projectPath, registry)])]
  if (blocked.length) return `Blocked by ${blocked.join(', ')}`
  const text = readFileSync(card.path, 'utf8')
  if (!text.match(/^## Approved brief\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]?.replace(/<!--[\s\S]*?-->/g, '').trim()) return 'Approved brief missing'
  if (card.column !== 'planning') { try { validatePlan(text) } catch (err) { return err.message } }
  return checkWorkflowLimits(tasksDir, card.id, card.column === 'planning' ? 'planner' : 'builder') || null
}

// Existing two-minute handoff grace, not a new retry/token budget. No retry follows it.
const idleSince = new Map()
export async function tickCardRun({ project, projectPath, tasksDir, boardRoot, reviewRoot, agents, config, gitSettings, inventory, log, io = { autoSpawn, runCardPlanner, spawnReviewer } }) {
  const run = activeCardRun(project)
  if (!run) return
  const stop = reason => stopCardRun(project, run.cardId, reason)
  try {
    if (!pausedRunEnvironment()) return stop('Pause/capacity changed; authorization revoked')
    if (interruptedCardRun(run)) return stop('Interrupted delivery/launch; inspect saved assignment before a fresh run')
    let card = findCard(tasksDir, run.cardId)
    if (run.reviewOnly && !['completed', 'review', 'archive'].includes(card.column)) return stop('Review-only recovery cannot replay Planning or Builder')
    if (run.planningRecoveryOnly && run.stages.planner && card.column !== 'planning') return stop('Planning recovery handed off; inspect preserved scope/work before authorizing implementation')
    if (['pou', 'owner', 'issues', 'archive'].includes(card.column)) return stop(`Card reached ${card.column}; authorization ended`)
    if (readWorkflow(tasksDir)[card.id]?.operational) return stop('Operational failure recorded; no automatic retry')
    const verdict = currentReviewDecision(readFileSync(card.path, 'utf8'))
    if (run.stages.reviewer && verdict) {
      routeReviewVerdicts(tasksDir, { reviewRoot, onlyIds: [card.id], log })
      return stop(`Review verdict: ${verdict.verdict}`)
    }
    const role = ['planning'].includes(card.column) ? 'planner' : ['queue', 'planned', 'working'].includes(card.column) ? 'builder' : 'reviewer'
    const stage = run.stages[role]
    if (stage) {
      if (stage.status === 'reserved') return // Same-process launch still owns its reservation.
      const agent = agents.find(a => a.pane_id === stage.paneId)
      if (!agent || agent.agent_status === 'blocked' || agent.agent_status === 'unknown') return stop('Assigned session missing or blocked; preserved for diagnosis')
      if (['done', 'idle'].includes(agent.agent_status)) {
        const since = idleSince.get(stage.assignmentId) ?? Date.now()
        idleSince.set(stage.assignmentId, since)
        if (Date.now() - since >= 120000) return stop('Agent ended without the required handoff; no retry')
      } else idleSince.delete(stage.assignmentId)
      return
    }
    const board = readBoard(tasksDir), registry = readWorktrees(tasksDir)
    const blockers = [...new Set([...unmetBlockers(card, board, registry), ...recordedOverlapBlockers(card, projectPath, registry)])]
    if (blockers.length) return stop(`Blocked by ${blockers.join(', ')}`)
    const limit = checkWorkflowLimits(tasksDir, card.id, role)
    if (limit) return stop(limit)
    const engine = r => config.engines?.[r] ?? config.engine
    const selected = stage => config.assignmentForCard?.(card, stage)
    const common = { project, projectPath, tasksDir, boardRoot }
    if (card.column === 'planning') {
      const setting = selected('planning')
      return await withCardRunAssignment(run, 'planner', () => io.runCardPlanner({ ...common, onlyIds: [card.id], model: setting?.model ?? config.models.planning ?? config.models.issues, engine: setting ? { kind: setting.engine, ...(setting.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${setting.reasoning}"`] } : {}) } : engine('planning'), assignmentForCard: config.assignmentForCard, mission: config.mission }))
    }
    if (['planned', 'queue'].includes(card.column)) {
      validatePlan(readFileSync(card.path, 'utf8'))
      const hold = startHoldReason({ card: { ...card, column: 'queue' }, board: readBoard(tasksDir), projectPath, tasksDir, mission: config.mission, gitSettings })
      if (hold) return stop(hold)
      if (card.column === 'planned') card = moveCard(tasksDir, card.id, 'queue')
      const setting = selected(card.trivial ? 'trivial' : 'working')
      return await withCardRunAssignment(run, 'builder', () => io.autoSpawn({ ...common, onlyIds: [card.id], max: 1, agents, model: setting?.model ?? config.models.working, trivialModel: setting?.model ?? config.models.trivial ?? config.models.working, engine: setting ? { kind: setting.engine, ...(setting.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${setting.reasoning}"`] } : {}) } : engine('working'), trivialEngine: engine('trivial'), assignmentForCard: config.assignmentForCard, gitSettings, mission: config.mission, log }))
    }
    if (card.column === 'completed') {
      if (gitSettings) {
        const results = await reconcileCompletedHandoffs({ tasksDir, project, onlyIds: [card.id] })
        if (results.some(r => r.status === 'waiting-builder')) return
        const failure = results.find(r => !['integrated', 'cleaned'].includes(r.status) || r.cleanupPending)
        if (failure) return stop(failure.reason || 'Integration/cleanup incomplete; preserved for diagnosis')
        if (readWorktrees(tasksDir)[card.id]?.state !== 'integrated') return stop('Integration receipt unavailable')
      }
      if (!run.autoReview) return stopCardRun(project, card.id, 'Ready for review; Auto-review was off when authorized', 'ready-review')
    }
    if (['completed', 'review'].includes(card.column)) {
      if (!run.autoReview) return stopCardRun(project, card.id, 'Ready for review; no Reviewer authorized', 'ready-review')
      const setting = selected('review')
      return await withCardRunAssignment(run, 'reviewer', () => io.spawnReviewer({ ...common, cardIds: [card.id], reviewRoot, model: setting?.model ?? config.models.review, engine: setting ? { kind: setting.engine, ...(setting.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${setting.reasoning}"`] } : {}) } : engine('review'), assignmentForCard: config.assignmentForCard, inventory }))
    }
    stop(`Unexpected stage ${card.column}; no dispatch`)
  } catch (err) { stop(err.message); log?.(`${run.cardId}: explicit run stopped — ${err.message}`) }
}
