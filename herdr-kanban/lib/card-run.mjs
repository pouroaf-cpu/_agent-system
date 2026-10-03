// One explicit card at a time; the ordinary scheduler remains paused.
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { renameSync } from './fs-retry.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { withBoardLock } from './bindings.mjs'
import { findCard } from './cards.mjs'
import { readCardPlanners } from './planner-state.mjs'
import { isCardId } from './ids.mjs'

const context = new AsyncLocalStorage()
const instance = randomUUID()
const configPath = () => process.env.KANBAN_CONFIG || fileURLToPath(new URL('../board.config.json', import.meta.url))
const root = () => join(dirname(configPath()), '.card-runs')
const key = x => String(x || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
export const readCardRuns = () => existsSync(join(root(), 'runs.json')) ? JSON.parse(readFileSync(join(root(), 'runs.json'), 'utf8')) : []
function change(fn) {
  mkdirSync(root(), { recursive: true })
  return withBoardLock(root(), () => {
    const runs = readCardRuns(), result = fn(runs)
    const file = join(root(), 'runs.json')
    writeFileSync(file + '.tmp', JSON.stringify(runs, null, 2) + '\n')
    renameSync(file + '.tmp', file)
    return result
  })
}
export const activeCardRun = project => readCardRuns().find(r => r.status === 'running' && (!project || key(r.project) === key(project)))
export function pausedRunEnvironment() {
  const c = JSON.parse(readFileSync(configPath(), 'utf8'))
  return c.maxConcurrentAgents === 0 && c.projects.every(p => c.projectControls?.[p]?.paused === true)
}
export function authorizeCardRun({ project, cardId, autoReview, requestId }) {
  const config = JSON.parse(readFileSync(configPath(), 'utf8'))
  if (!config.projects.includes(project) || !isCardId(cardId) || !/^[a-f0-9-]{36}$/i.test(requestId || '') || typeof autoReview !== 'boolean') throw new Error('Known project/card, Auto-review and unique request identity required')
  if (!pausedRunEnvironment()) throw new Error('Pause all projects and set global capacity to zero before a single-card run')
  return change(runs => {
    const duplicate = runs.find(r => r.requestId === requestId)
    if (duplicate) {
      if (duplicate.project !== project || duplicate.cardId !== cardId) throw new Error('Request identity already used')
      return duplicate
    }
    if (runs.some(r => r.status === 'running')) throw new Error('Another explicit card run is active')
    const owner = readCardPlanners(join(config.projectsRoot, project, 'TASKS'))[cardId]
    const planningRecoveryOnly = !!(owner?.lifecycle === 'retired' && owner.recoveryReady && owner.reconciliationHistoryId)
    const reviewOnly = ['completed', 'review'].includes(findCard(join(config.projectsRoot, project, 'TASKS'), cardId).column)
    const run = { project, cardId, runId: randomUUID(), requestId, autoReview, planningRecoveryOnly, reviewOnly, status: 'running', reason: planningRecoveryOnly ? 'Authorized planning recovery only; implementation requires inspection' : 'Authorized; awaiting eligible stage', createdAt: new Date().toISOString(), stages: {} }
    runs.push(run)
    return run
  })
}
export function stopCardRun(project, cardId, reason, status = 'stopped') {
  if (!activeCardRun(project)) return
  return change(runs => {
    const run = runs.find(r => r.status === 'running' && key(r.project) === key(project) && (!cardId || r.cardId === cardId))
    if (run) Object.assign(run, { status, reason, stoppedAt: new Date().toISOString() })
    return run
  })
}
export const cardRunContext = () => context.getStore()
const denied = message => Object.assign(new Error(message), { paused: true, preservePane: true })
export function assertCardRunSelection(project, ids, role) {
  const ctx = cardRunContext()
  if (!ctx) return
  const run = activeCardRun(project)
  if (!run || run.runId !== ctx.runId || key(project) !== key(ctx.project) || ids.length !== 1 || ids[0] !== ctx.cardId || role !== ctx.role || !pausedRunEnvironment()) throw denied('Explicit card authorization does not match assignment')
}
export function allowCardRunPrompt(project, { paneId, action = 'check' } = {}) {
  const ctx = cardRunContext()
  if (!ctx) return false
  assertCardRunSelection(project, [ctx.cardId], ctx.role)
  const validate = run => {
    const stage = run?.stages[ctx.role]
    const stagedEnter = ctx.enterOnly && stage?.status === 'delivered' && stage.prompted && !stage.entered
    if (ctx.enterOnly && !['check', 'enter'].includes(action)) throw denied('Staged recovery permits only Enter, never another prompt or launch')
    if (!run || run.runId !== ctx.runId || run.status !== 'running' || stage?.assignmentId !== ctx.assignmentId || stage.owner !== (ctx.assignmentOwner || instance) || (!stagedEnter && stage.status !== 'reserved')) throw denied('Explicit assignment is stale, cancelled or already delivered')
    if (paneId && stage.paneId !== paneId) throw denied('Explicit assignment pane mismatch')
    if (action !== 'check') {
      const config = JSON.parse(readFileSync(configPath(), 'utf8'))
      const card = findCard(join(config.projectsRoot, run.project, 'TASKS'), run.cardId)
      const expected = { planner: 'planning', plancheck: 'planned', builder: 'working', reviewer: 'review' }[ctx.role]
      if (!expected || card.column !== expected) throw denied('Card stage changed; prompt is no longer authorized')
    }
    return stage
  }
  if (action === 'check') { validate(activeCardRun(project)); return true }
  return change(runs => {
    const stage = validate(runs.find(r => r.runId === ctx.runId))
    if (!paneId) throw denied('Known assignment pane required')
    if (action === 'start' && stage.started) throw denied('Duplicate agent launch blocked')
    if (action === 'prompt' && stage.prompted) throw denied('Duplicate prompt blocked')
    if (action === 'enter' && (!stage.prompted || stage.entered)) throw denied('Unexpected or duplicate Enter blocked')
    if (action === 'start') stage.started = true
    if (action === 'prompt') stage.prompted = true
    if (action === 'enter') stage.entered = true
    return true
  })
}
export function bindCardRunAssignment(project, ids, role, paneId) {
  const ctx = cardRunContext()
  if (!ctx) return
  assertCardRunSelection(project, ids, role)
  change(runs => {
    const stage = runs.find(r => r.runId === ctx.runId && r.status === 'running')?.stages[role]
    if (!stage || stage.assignmentId !== ctx.assignmentId || !paneId || (stage.paneId && stage.paneId !== paneId)) throw denied('Assignment binding changed')
    stage.paneId = paneId
  })
}
export async function withCardRunAssignment(run, role, fn) {
  const assignmentId = randomUUID()
  change(runs => {
    const current = runs.find(r => r.runId === run.runId && r.status === 'running')
    if (!current || current.stages[role]) throw denied('Stage already assigned; no replay or correction loop')
    current.stages[role] = { assignmentId, owner: instance, ownerPid: process.pid, status: 'reserved', at: Date.now() }
    current.reason = `Running ${role}`
  })
  try {
    return await context.run({ ...run, role, assignmentId }, async () => {
      const result = await fn()
      change(runs => {
        const current = runs.find(r => r.runId === run.runId)
        const stage = current.stages[role]
        if (!stage.prompted) throw new Error('Stage did not confirm a prompt; stopped without retry')
        stage.status = 'delivered'
      })
      return result
    })
  } catch (error) {
    stopCardRun(run.project, run.cardId, error.message)
    throw error
  }
}
export function interruptedCardRun(run) {
  return Object.values(run.stages).some(s => {
    if (s.status !== 'reserved' || s.owner === instance) return false
    // Explicit maintenance delivery can be owned by a live CLI process. A dead
    // owner after restart still fails closed; no reservation is replayed.
    if (s.ownerPid) { try { process.kill(s.ownerPid, 0); return false } catch {} }
    return true
  })
}

// Explicit operator recovery of a proven staged submission. Never resend text or
// revive a cancelled authorization; identity and Pause are rechecked at Enter.
export async function resumeStagedCardRunEnter(project, runId, role, { requestId, io } = {}) {
  const source = readCardRuns().find(r => r.runId === runId && r.project === project), stage = source?.stages[role]
  const recoverableStop = ['Agent ended without the required handoff; no retry', 'Interrupted delivery/launch; inspect saved assignment before a fresh run'].includes(source?.reason)
  if (role !== 'reviewer' || source?.status !== 'stopped' || !recoverableStop || !['reserved', 'delivered'].includes(stage?.status) || !stage.prompted || stage.entered || !stage.paneId || !source.autoReview) throw denied('No timed-out, unsubmitted Reviewer assignment to recover')
  if (!pausedRunEnvironment() || activeCardRun()) throw denied('Pause all projects; another authorization cannot be active')
  const transport = io || await import('./herdr.mjs')
  const { sessionOf } = await import('./herdr.mjs')
  const { readDelivery, saveDelivery } = await import('./delivery-state.mjs')
  const { reviewClaimFor, assertReviewInputs, updateReviewClaim } = await import('./review-claims.mjs')
  const { readWorkflow } = await import('./workflow-state.mjs')
  const { appendHistory } = await import('./card-history.mjs')
  const config = JSON.parse(readFileSync(configPath(), 'utf8')), tasksDir = join(config.projectsRoot, project, 'TASKS')
  const card = findCard(tasksDir, source.cardId), claim = reviewClaimFor(dirname(configPath()), tasksDir, card.id)
  if (card.column !== 'review' || !card.autoReview || readWorkflow(tasksDir)[card.id]?.operational || !claim || claim.paneId !== stage.paneId || claim.cards.length !== 1) throw denied('Current single-card Reviewer ownership/prerequisites changed')
  assertReviewInputs(dirname(configPath()), tasksDir, card.id)
  const session = sessionOf(project), delivery = readDelivery(session, stage.paneId)
  if (delivery?.runId !== runId || !(delivery.status === 'confirmed' || delivery.status === 'cancelled' && delivery.staged)) throw denied('Delivery identity is uncertain')
  const agents = await transport.agentList(session, { ensureSession: false }), agent = agents.find(a => a.pane_id === stage.paneId)
  if (agents.some(a => a.agent_status === 'working') || !agent || !['idle', 'done'].includes(agent.agent_status) || !/Pasted Content/.test(String(await transport.paneRead(stage.paneId, session)))) throw denied('Existing assignment is not visibly staged and idle')
  appendHistory(tasksDir, card.id, { event: 'explicit-staged-review-recovery', sourceRun: source, claimId: claim.id, delivery, authorization: 'Explicit operator recovery; new authorization, Enter only, no task resend' })
  const run = authorizeCardRun({ project, cardId: card.id, autoReview: true, requestId })
  change(runs => {
    const current = runs.find(r => r.runId === run.runId)
    current.sourceRunId = source.runId
    current.stages.reviewer = { ...stage, status: 'delivered', assignmentId: randomUUID(), sourceAssignmentId: stage.assignmentId, owner: instance, ownerPid: process.pid }
  })
  const recovered = activeCardRun(project).stages.reviewer
  saveDelivery(session, stage.paneId, { ...delivery, sourceRunId: runId, runId: run.runId })
  updateReviewClaim(dirname(configPath()), claim.id, { doneSince: null, lastSeen: Date.now() })
  try {
    await context.run({ ...run, role, assignmentId: recovered.assignmentId, enterOnly: true }, () => transport.paneSendKeys(stage.paneId, ['enter'], session))
  } catch (error) { stopCardRun(project, card.id, `Staged recovery unconfirmed: ${error.message}`); throw error }
  return { runId: run.runId, paneId: stage.paneId, action: 'enter-only' }
}
