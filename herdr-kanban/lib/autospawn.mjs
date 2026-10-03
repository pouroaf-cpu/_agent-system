import { builderDifficulty } from './difficulty.mjs'
import { engineForAssignment } from './agent-settings.mjs'
import { recordBuilderAttempt, recordBuilderReturn } from './workflow-state.mjs'
import { formatNZTime } from './nz-time.mjs'
import { readCardPlanners, requestPlannerCorrection } from './card-planner.mjs'
import { assertPromptAllowed, controlState, projectEnvironment } from './project-control.mjs'
import { cardRunContext, assertCardRunSelection, bindCardRunAssignment } from './card-run.mjs'
import { operationalHold, recordOperationalFailure, updateWorkflow, readWorkflow, failureCategory, failureDestination, evidenceFingerprint } from './workflow-state.mjs'
import { appendHistory, writeCurrentFeedback, builderIssue, builderHandedOff } from './card-history.mjs'
import { looksLikeAQuestion, lastAgentMessage } from './agent-question.mjs'
import { activityLog } from './activity.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'
// The spawner. Watches one column — Queue — and nothing else.
//
// You put a card in Queue; that is the consent. Everything here is about not
// doing anything you did not ask for: it never pulls from another column, never
// exceeds the concurrency cap, and never retries a card that failed to start.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readBoard, moveCard, findCard, needsBrowser, isParked, appendBuildAttempt, currentReviewDecision, currentDirtyMatchesSnapshot, setAutoReview, hasBuilderPass, canArchive, unmetBlockers, cycleFor } from './cards.mjs'
import { bind, unbind, liveBindings, readBindings } from './bindings.mjs'
import { spawnForCard, deliver, unsubmittedDelivery, confirmLateDeliveries, START_TIMEOUT_MS, startFailed, recordStartFailure, startRetryHold, recordPlanCheckRetry } from './spawn.mjs'
import { isRetryHold } from './transient.mjs'
import { usageLimit, blockEngine, selectQuotaAssignment, engineKind, quotaKey } from './quota.mjs'
import { readDelivery, saveDelivery } from './delivery-state.mjs'
import { reviewerPrompt, planCheckerPrompt, agentName, isBoardAgent, reviewLabel } from './prompt.mjs'
import { CARD_ID, agentRole, isReviewerAgent } from './ids.mjs'
import { tabCreate, agentStart, agentList, paneClose, paneRead, agentWorkspaceOr, waitForPrompt, isSpawning, beginSpawn, endSpawn, herdrLog, sessionOf } from './herdr.mjs'
import { backendFor } from './agent-backend.mjs'
import { isHeadless } from './headless.mjs'
import { coolingDown, clearRetries } from './retries.mjs'
import { computeReviewPlan, readReviewGroups } from './review-plan.mjs'
import { readUsage, recordUsageFinish, recordUsageStart } from './request-usage.mjs'
import { overlapHoldReason, readWorktrees, prepareCardWorktree, semanticDirtyFiles, integrationStartHoldReason, dependencyInstallHold, startDependencyInstall } from './worktrees.mjs'
import { recordSpawnFailure } from './breaker.mjs'
import { auditMcpEngine, auditPreflightBlocked } from './audit-mcp.mjs'
import { syncReviewClaims, readReviewClaims, reserveReview, updateReviewClaim, failReviewClaim, prepareReviewSnapshot, assertReviewInputs, reviewClaimFor, snapshotContains } from './review-claims.mjs'

// A Builder that disappears or ends without hkb done/issue leaves Working stuck.
// Its card goes to Planning for a fresh Planner (Issues is retired, 2026-09-25); the
// workflow assignment, counters and worktree stay for inspection and recovery.
export function routeBuilderNoHandoff({ tasksDir, cardId, reason, evidence = '', boardRoot, engine, model, session, io = { readDelivery, saveDelivery }, now = Date.now() }) {
  const card = findCard(tasksDir, cardId)
  if (card.column !== 'working') return card
  const binding = readBindings(tasksDir)[card.id]
  if (binding?.pane_id && isSpawning(binding.pane_id)) return card
  // The engine (or just its model) ran out of usage: block it board-wide and wait in Queue,
  // where a fresh Builder continues in the same worktree once it resets. Not a failed build.
  const limit = boardRoot && usageLimit(evidence, now)
  if (limit) {
    const key = quotaKey(engineKind(engine), limit.modelCap && model)
    blockEngine(boardRoot, key, limit.until, now)
    appendHistory(tasksDir, card.id, { event: 'engine-usage-limit', stage: 'working', engine: key, until: new Date(limit.until).toISOString(), evidence })
    unbind(tasksDir, card.id)
    return moveCard(tasksDir, card.id, 'queue')
  }
  // The Builder's prompt never landed: nothing ran, so this is a failed start for a fresh
  // Builder, not a failed build (Tradeflow T-36; I157, TF50: machine load, not a strike).
  const paneId = readBindings(tasksDir)[card.id]?.pane_id || readWorkflow(tasksDir)[card.id]?.builder?.pane_id
  const delivery = paneId && io.readDelivery(session, paneId)
  // I653: board restart lost the async launch, leaving a shell, not a Builder.
  if (binding?.spawning && !delivery && /is missing/.test(reason)) {
    unbind(tasksDir, card.id)
    const moved = moveCard(tasksDir, card.id, 'queue')
    appendHistory(tasksDir, card.id, { event: 'builder-start-interrupted', paneId, reason })
    recordStartFailure(tasksDir, card.id, 'builder', 'Builder startup interrupted before prompt delivery')
    return moved
  }
  if (delivery?.status === 'failed' || (isHeadless(paneId) && delivery?.status === 'launching') || (!isHeadless(paneId) && (delivery?.status === 'uncertain' || unsubmittedDelivery(evidence)))) {
    if (delivery) io.saveDelivery(session, paneId, { ...delivery, status: 'failed', reason: 'Uncertain or unsubmitted delivery resolved as failed; a fresh Builder takes over' })
    unbind(tasksDir, card.id)
    const moved = moveCard(tasksDir, card.id, 'queue')
    appendHistory(tasksDir, card.id, { event: 'builder-delivery-failed', paneId, deliveryAt: delivery?.at || null })
    recordStartFailure(tasksDir, card.id, 'builder', 'Builder prompt was never submitted')
    return moved
  }
  // Its prompt was held by a Pause and the pane is gone: the Builder never ran, so a fresh one
  // starts from Queue after Start. Not a plan gap (Injectbuddy I559, 2026-10-02).
  const op = readWorkflow(tasksDir)[card.id]?.operational
  if (op?.stage === 'working' && /is paused; assignment retained pending Start/.test(op.reason)) {
    unbind(tasksDir, card.id)
    updateWorkflow(tasksDir, card.id, { operational: null })
    appendHistory(tasksDir, card.id, { event: 'builder-paused-start-lost', paneId, reason })
    return moveCard(tasksDir, card.id, 'queue')
  }
  // I519: a Builder that filed hkb issue and then exited did hand off. Kick back with its own
  // note, or three different causes all read as one repeated "session missing" failure.
  const issue = builderIssue(tasksDir, card.id, (readBindings(tasksDir)[card.id] || readWorkflow(tasksDir)[card.id]?.builder)?.started)
  if (issue) { reason = `Builder reported: ${issue.note}`; evidence = '' }
  const detail = `${String(reason || 'Builder ended without a valid handoff').trim()}${evidence ? `; evidence: ${String(evidence).trim().slice(-4000)}` : ''}`
  unbind(tasksDir, card.id)
  recordBuilderReturn(tasksDir, card, detail)
  const moved = moveCard(tasksDir, card.id, 'planning')
  // Nobody reads a stopped Builder's pane, so a question or blocker left there as plain
  // text otherwise just gets requeued/replanned into the same silence (38 of the last 100
  // bounces, 2026-09-27). Hold it for a person instead of kicking it back to a fresh Planner.
  // Judge only the agent's own last message, not tool output in the pane (I385 was held on
  // a skill file's text). A [planning]/[implementation] tag is a plan gap for the Planner.
  const said = lastAgentMessage(evidence)
  if (looksLikeAQuestion(said) && !/^\[(planning|implementation)\]/i.test(said)) {
    const question = said.slice(-2000)
    updateWorkflow(tasksDir, moved.id, { waitFor: { cards: [], files: [], decision: true, why: question, since: new Date(now).toISOString() } })
    writeCurrentFeedback(tasksDir, moved, 'Needs you', `${question}\n\nRecord the answer on the card, then move it to Planning (or Planned).\n`)
    appendHistory(tasksDir, card.id, { event: 'agent-question-captured', stage: 'working', reason: detail, evidence })
    activityLog({ tasksDir, project: basename(dirname(tasksDir)), cardId: card.id, event: 'agent-question-captured', message: question })
    return moved
  }
  appendFileSync(moved.path, `\n\n**Kicked back** ${formatNZTime(now)}\n\n[planning] Builder fallback: ${detail}. Worktree, commits and prior output are preserved; resolve why the Builder stopped before requeueing.\n`)
  appendHistory(tasksDir, card.id, { event: 'builder-no-handoff', stage: 'working', reason: detail, evidence })
  requestPlannerCorrection(tasksDir, card.id, { failure: true })
  return moved
}

// A process exit is definitive: no pane-idle grace or Enter recovery applies.
// Keep the existing routing and counters, including an interrupted hkb handoff.
export async function reconcileBuilderExits({ tasksDir, project, agents, boardRoot, now = Date.now() }) {
  const results = [], session = sessionOf(project)
  confirmLateDeliveries({ tasksDir, session, agents })
  for (const [cardId, binding] of Object.entries(readBindings(tasksDir))) {
    if (!isHeadless(binding.pane_id) || isSpawning(binding.pane_id)) continue
    if (binding.spawning && now - Date.parse(binding.started) < 300000) continue
    const agent = agents.find(a => a.pane_id === binding.pane_id)
    if (!agent || agent.agent_status !== 'done') continue
    try {
      const card = findCard(tasksDir, cardId)
      if (card.column !== 'working') continue
      const evidence = await paneRead(binding.pane_id, session)
      const handedOff = builderHandedOff(tasksDir, cardId)
      await recordUsageFinish({ tasksDir, paneId: binding.pane_id, binding, agent, status: handedOff ? 'complete' : 'ambiguous' }).catch(() => {})
      let routed
      if (handedOff) {
        routed = moveCard(tasksDir, cardId, 'completed')
        updateWorkflow(tasksDir, cardId, { completedStage: 'working', completedAt: new Date(now).toISOString() })
        unbind(tasksDir, cardId)
      } else {
        routed = routeBuilderNoHandoff({ tasksDir, cardId, reason: `Session ${binding.pane_id} exited with code=${agent.exitCode ?? 'unknown'} without a valid Builder handoff from Working`, evidence, boardRoot, engine: binding.engine, model: binding.model, session, now })
      }
      if (routed.column === 'queue') await paneClose(binding.pane_id, session).catch(() => {})
      results.push({ id: cardId, to: routed.column })
    } catch (err) { results.push({ id: cardId, status: 'held', reason: err.message }) }
  }
  return results
}

// A spawn blocks for ~55s. Without this, every 2s agent poll would start another.
const busy = new Set()

export function slotsFree({ tasksDir, agents, max, now = Date.now() }) {
  return Math.max(0, max - Object.keys(liveBindings(tasksDir, agents, now)).length)
}

// Hard gate: a card naming prerequisites (**Blocked by:** T-08, T-09) is not
// spawned until every one of them has landed — reached Completed (a builder
// finished it) or Archive (a superset: everything archived passed through
// Completed first). Exported standalone so it can be tested without going
// anywhere near a real spawn. Replaces the old behaviour of spawning the card
// anyway and paying for a builder to boot, read the card, and immediately
// kick itself back — cards stalled on the same unmet dependency, repeatedly,
// before this gate existed.
// Lives in cards.mjs so the Planner can use it without an import cycle.
export { unmetBlockers }

const liveCards = (board) => Object.keys(board).filter(key => key !== 'archive').flatMap(key => board[key])

function duplicateLiveId(card, board) {
  const hits = liveCards(board).filter((c) => c.id === card.id)
  return hits.length > 1 ? hits.map((c) => `${c.column}/${c.file}`).join(', ') : null
}

function duplicateIssueKey(card, board) {
  if (!card.issueKey) return null
  const hits = liveCards(board).filter((c) => c.issueKey && c.issueKey === card.issueKey)
  return hits.length > 1 ? hits.map((c) => `${c.id} in ${c.column}`).join(', ') : null
}

function missionBuilds(board, mission) {
  if (!mission?.id) return 0
  return Object.values(board).flat()
    .filter((c) => c.mission === mission.id)
    .reduce((n, c) => n + (c.buildAttempts || 0), 0)
}

export function startHoldReason({ card, board, projectPath, tasksDir, mission, log, gitSettings, now = Date.now() }) {
  if (card.column !== 'queue') return 'only Queue cards can start'
  const dupId = duplicateLiveId(card, board)
  if (dupId) return `duplicate live card id ${card.id}: ${dupId}`
  const dupKey = duplicateIssueKey(card, board)
  if (dupKey) return `duplicate issue key ${card.issueKey}: ${dupKey}`
  if (mission?.id) {
    const project = projectPath.split(/[\\/]/).pop()
    if (mission.project && project !== mission.project) return `mission ${mission.id} is active for ${mission.project}`
    if (card.mission !== mission.id) return `mission ${mission.id} only starts cards marked **Mission:** ${mission.id}`
    if ((card.buildAttempts || 0) >= (mission.maxBuildsPerCard ?? 3)) return `mission build budget exhausted for ${card.id}`
    if (missionBuilds(board, mission) >= (mission.maxBuilds ?? 9)) return `mission build budget exhausted (${mission.maxBuilds ?? 9} total)`
  }
  if (cycleFor(card, board)) return 'dependency cycle detected'
  if (coolingDown(tasksDir, card.id, now)) return 'cooling down after failed spawn'
  const backoff = tasksDir && startRetryHold(readWorkflow(tasksDir)[card.id], 'builder', now)
  if (backoff) return backoff
  const unmet = unmetBlockers(card, board, tasksDir ? readWorktrees(tasksDir) : {})
  if (unmet.length) return `waiting for unique integrated or archived prerequisite ${unmet.join(', ')}`
  const overlap = gitSettings && overlapHoldReason({ tasksDir, card, projectPath, board, parallelFiles: gitSettings.parallelFiles })
  if (overlap) return overlap
  if (gitSettings?.integrationPath) {
    try {
      const reason = integrationStartHoldReason({ repoRoot: gitSettings.integrationPath, workspace: join(gitSettings.integrationPath, card.workspace || '.'), card })
      if (reason) return reason
    } catch (err) { return `integration check failed: ${err.message}` }
  }
  const dirty = preflightBlocks({ projectPath, card, log, gitSettings })
  if (dirty) {
    const running = holderOf(board)
    const who = dirty.kind === 'files busy' && running.length ? `, likely held by ${running.join(', ')}` : ''
    return `${dirty.kind}${who} — ${dirty.detail}`
  }
  return null
}

// Optional per-repo check: <project>/scripts/preflight.mjs <path-to-card.md>,
// run from the project root before a card leaves Queue — the contract (path,
// not id) is preflight.mjs's own, documented at its top; do not change it here
// without changing it there too. Most repos will not have this script — no
// script means no check, not a block.
//
// exit 0  clean, spawn it. exit 1  the card's own ## Files are dirty right
// now (another agent mid-edit); hold it in Queue, same as an unmet
// Blocked-by — costs nothing, versus a builder discovering the same thing
// itself ~30 minutes in. exit 2  the card itself could not be read or is
// malformed — preflight.mjs's own contract warns that conflating this with
// "dirty" silently skips a broken card forever, so this also holds the card
// but logs distinctly, so a human notices instead of it just never spawning.
export function preflightBlocks({ projectPath, card, gitSettings }) {
  const script = join(projectPath, 'scripts', 'preflight.mjs')
  if (!existsSync(script)) return false
  const result = spawnSync('node', [script, card.path], { cwd: projectPath, timeout: 10000, encoding: 'utf8' })
  if (result.status === 0) return false
  // The documented exit-1 contract is dirty named files. For isolated builds,
  // recheck that signal semantically rather than inheriting raw status/EOL noise.
  if (result.status === 1 && gitSettings?.integrationPath) {
    try {
      const reason = integrationStartHoldReason({ repoRoot: gitSettings.integrationPath, workspace: join(gitSettings.integrationPath, card.workspace || '.'), card })
      return reason ? { kind: 'files busy', detail: reason } : false
    } catch (err) { return { kind: 'files busy', detail: `integration check failed: ${err.message}` } }
  }
  if (result.status === 1 && card.cardOwned && currentDirtyMatchesSnapshot(card, projectPath)) return false
  // exit 2 is the card's own fault, not a busy tree — saying "files busy" about a
  // card with no ## Files section sends whoever reads it hunting for an agent
  // that does not exist.
  const kind = result.status === 2 ? 'card not ready' : 'files busy'
  return { kind, detail: `${(result.stdout || result.stderr || 'preflight failed').trim()}` }
}

// Why each queued card did not start this tick, so a card sitting still says so
// on the board instead of looking identical to one nobody has got to yet. Kept in
// memory rather than on disk: it is recomputed every tick and is worthless stale.
const holds = new Map() // project -> { cardId: reason }

// Planned cards whose plan check waits on a file lock (TF136 sat 21 min with "no hold recorded", 2026-10-03).
const planHolds = new Map() // project -> { cardId: reason }
export const holdsFor = (project) => ({ ...planHolds.get(project), ...holds.get(project) })

const HELD_BY = new RegExp(String.raw`held by (${CARD_ID})`)
export function routeMutualHolds(tasksDir, held, log) {
  const routed = []
  for (const [id, reason] of Object.entries(held)) {
    const other = reason.match(HELD_BY)?.[1]
    if (!other || !held[other]?.includes(`held by ${id}`) || routed.includes(id)) continue
    // Preserved edits need attribution; never resolve a lock cycle by deleting
    // a worktree or allowing overlapping Builders to start.
    for (const cardId of [id, other]) {
      const moved = moveCard(tasksDir, cardId, 'planning')
      appendFileSync(moved.path, `\n\n**Kicked back** ${formatNZTime()}\n\n[planning] Mutual file hold between ${id} and ${other}: ${held[cardId]}. Reconcile declared scope and preserved commits with the other card before requeueing; do not discard work or bypass file locks.\n`)
      requestPlannerCorrection(tasksDir, cardId, { failure: true })
      routed.push(cardId)
      log?.(`${cardId}: mutual file hold returned to Planner for preserved-work attribution`)
    }
  }
  return routed
}

// Which running card most likely owns the dirty files — with one card at a time
// there is usually exactly one, and naming it is the difference between "held"
// and "held by T-29".
const holderOf = (board) => [...board.working, ...board.review].map((c) => c.id)

// Returns the ids it started. Safe to call on every board change and agent poll.
export async function autoSpawn({ project, projectPath, tasksDir, boardRoot, model, engine, max, agents, onChange, log, mission, onlyIds, gitSettings, assignmentForCard, stallSeconds = 300, now = Date.now(), spawn = spawnForCard }) {
  if (cardRunContext()) assertCardRunSelection(project, onlyIds || [], 'builder')
  if (spawn === spawnForCard && controlState(project).paused && !cardRunContext()) return []
  // Zero capacity (breaker tripped, builders switched off) is an operator pause, not a card hold.
  if (max <= 0 || busy.has(project)) return []

  let slots = slotsFree({ tasksDir, agents, max })

  const board = readBoard(tasksDir)
  const only = onlyIds?.length ? new Set(onlyIds.map((id) => id.toUpperCase())) : null
  const queued = only ? board.queue.filter((c) => only.has(c.id)) : board.queue
  if (!queued.length) { holds.set(project, {}); return [] }

  busy.add(project)
  const started = []
  const held = {}
  // One board read per pass, again only after a move: a read per queued card cost about
  // 100 reads per Injectbuddy poll and starved the event loop (audit 2026-09-26).
  let fresh = board
  try {
    for (const card of queued) {
      fresh ??= readBoard(tasksDir)
      const freshCard = fresh.queue.find((c) => c.path === card.path)
      if (!freshCard) continue
      const primary = assignmentForCard?.(freshCard, 'working')
      const choice = selectQuotaAssignment(boardRoot, primary ?? { engine: engineKind(engine), model }, now)
      const selected = primary ? choice.assignment : null
      const selectedModel = selected?.model ?? model
      const selectedEngine = selected?.engine ? engineForAssignment(selected) : engine
      const limit = checkWorkflowLimits(tasksDir, freshCard.id, 'builder')
      let operational = operationalHold(tasksDir, freshCard, projectPath, gitSettings)
      // A Builder prompt lost on a slow start (pane never went working, card back in Queue) is a
      // failed start, not an operator decision: retry with a fresh tab like any start failure,
      // Owner only after the second (Injectbuddy I553 on Claude Sonnet, 2026-10-02).
      if (operational?.startsWith('Delivery unconfirmed')) {
        const lost = operational
        updateWorkflow(tasksDir, freshCard.id, { operational: null })
        operational = null
        if (recordStartFailure(tasksDir, freshCard.id, 'builder', lost, now)) { fresh = null; onChange?.(); continue }
        const wait = startRetryHold(readWorkflow(tasksDir)[freshCard.id], 'builder', now)
        if (wait) { held[freshCard.id] = wait; continue }
      }
      const hold = limit || (operational && `Operational recovery held: ${operational}`)
        || choice.hold
        || startHoldReason({ card: freshCard, board: fresh, projectPath, tasksDir, mission, log, gitSettings, now })
        || (slots <= 0 ? 'slots full' : null)
        || dependencyInstallHold({ card: freshCard, projectPath, tasksDir, gitSettings })
      if (hold) {
        const dupId = duplicateLiveId(freshCard, fresh)
        const dupKey = duplicateIssueKey(freshCard, fresh)
        const cycle = cycleFor(freshCard, fresh)
        const unmet = unmetBlockers(freshCard, fresh, readWorktrees(tasksDir))
        // Only unfinished prerequisites count: an archived one has no live copy, and counting it
        // made Injectbuddy I195's wait on I244 look broken once I243 landed (card went to Owner).
        const prerequisites = (freshCard.blockedBy || []).filter(id => unmet.includes(id)).map(id => [id, liveCards(fresh).filter(c => c.id === id)])
        const allowedDependencyWait = hold.startsWith('waiting for unique integrated or archived prerequisite')
          && unmet.length > 0
          && prerequisites.every(([, hits]) => hits.length === 1 && ['pou', 'owner', 'planning', 'planned', 'queue', 'working', 'review', 'completed'].includes(hits[0].column))
        const cardProblem = !!(dupId || dupKey || cycle || hold.startsWith('card not ready') || (unmet.length && !allowedDependencyWait))
        // Waiting on another live card's files is allowed in any lane, Owner included:
        // only the holder is escalated, never the cards queued behind it (Tradeflow T-35).
        const fileHolder = hold.match(new RegExp(String.raw`^files busy, (?:likely )?held by (${CARD_ID})`))?.[1]
        const allowedFileWait = !!fileHolder && fileHolder !== freshCard.id && liveCards(fresh).some(c => c.id === fileHolder)
        // Waiting for a free Builder slot is not the card's fault: no expiry clock. Expiring it sent
        // Injectbuddy I389 back to Planning as its fifth failed return, then to Owner (2026-09-28, cap 5).
        const slotWait = hold === 'slots full'
        const transient = hold === 'cooling down after failed spawn'
        const workflow = readWorkflow(tasksDir)[freshCard.id] || {}
        if (allowedDependencyWait || allowedFileWait || slotWait || hold.startsWith('installing dependencies in ') || isRetryHold(hold)) {
          held[freshCard.id] = hold
          delete workflow.queueHoldSince
          updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: null })
          continue
        }
        if (transient) {
          const since = workflow.queueHoldSince || now
          const elapsed = now - since
          held[freshCard.id] = hold
          if (elapsed > 3 * stallSeconds * 1000) {
            const moved = moveCard(tasksDir, freshCard.id, 'planning')
            fresh = null
            appendFileSync(moved.path, `\n\n**Kicked back** ${formatNZTime(now)}\n\n[planning] Queue hold expired: ${hold}; continuously held for ${Math.round(elapsed / 1000)} seconds. Preserved work remains available for recovery.\n`)
            updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: null })
            requestPlannerCorrection(tasksDir, freshCard.id, { failure: true })
            delete held[freshCard.id]
            onChange?.()
          } else updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: since })
          continue
        }
        const to = cardProblem ? 'planning' : 'owner'
        const moved = moveCard(tasksDir, freshCard.id, to, dupId ? { sourcePath: freshCard.path } : {})
        fresh = null
        const reason = dupId || dupKey || hold
        const note = cardProblem
          ? `**Kicked back** ${formatNZTime(now)}\n\n[planning] ${reason}. Planner: correct the card/dependency before requeueing. Preserved work remains available.`
          : `**Needs you** ${formatNZTime(now)}\n\n${reason}. Decision needed: resolve this hold or authorize a recovery path before requeueing.`
        appendFileSync(moved.path, `\n\n---\n\n${note}\n`)
        // Handed to the Planner, the hold is recorded on the card; kept in workflow it made
        // the Planner skip the card forever (Tradeflow T-36 sat in Planning with none).
        updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: null, ...(cardProblem ? { operational: null } : {}) })
        if (cardProblem) requestPlannerCorrection(tasksDir, moved.id)
        delete held[freshCard.id]
        log?.(`${moved.id}: routed to ${to} — ${reason}`)
        onChange?.()
        continue
      }

      if (readWorkflow(tasksDir)[freshCard.id]?.queueHoldSince) updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: null })
      // Move first so the card is visibly in Working for the ~55s the spawn takes.
      appendBuildAttempt(freshCard)
      const moved = moveCard(tasksDir, freshCard.id, 'working')
      const plannedDifficulty = builderDifficulty(freshCard, readWorkflow(tasksDir)[freshCard.id])
      const difficulty = primary?.difficulty || plannedDifficulty
      recordBuilderAttempt(tasksDir, moved, difficulty)
      fresh = null
      try {
        const result = await spawn({
          project, projectPath, tasksDir, boardRoot, card: moved, model: selectedModel, engine: selectedEngine, gitSettings,
          onPane: (provisional) => {
            bind(tasksDir, moved.id, { ...provisional, engine: engineKind(selectedEngine), model: selectedModel })
            try {
              recordUsageStart({
                tasksDir, project, requestId: moved.id, cardIds: [moved.id], role: 'builder',
                paneId: provisional.pane_id, tabId: provisional.tab_id, model: selectedModel, name: provisional.name, difficulty,
                agentSession: provisional.agent_session,
              })
            } catch {}
            onChange?.()
          },
        })
        const binding = { ...result, engine: engineKind(selectedEngine), model: selectedModel }
        bind(tasksDir, moved.id, binding)
        updateWorkflow(tasksDir, moved.id, { builder: binding, operational: null, startFailure: null })
        if (choice.message) activityLog({ tasksDir, project, cardId: moved.id, event: 'builder-start', message: choice.message, now })
        clearRetries(tasksDir, moved.id)
        herdrLog(`${moved.id} → working (auto-spawn)`)
        started.push(moved.id)
        slots--
      } catch (err) {
        // Paused between the poll and the start: nothing ran, so the card waits in Queue. Left in
        // Working, its empty pane read as a missing session and cost a Planning return (I496).
        if (err.paused) {
          const paneId = readBindings(tasksDir)[moved.id]?.pane_id
          unbind(tasksDir, moved.id)
          if (paneId) await paneClose(paneId, sessionOf(project)).catch(() => {})
          moveCard(tasksDir, moved.id, 'queue')
          held[moved.id] = err.message
          onChange?.()
          continue
        }
        // Someone else moved the card during the boot: leave it where they put it.
        if (err.movedAway) { unbind(tasksDir, moved.id); log?.(err.message); onChange?.(); continue }
        // Dependency drift in the card workspace: install there in the background and wait.
        const installing = err.installIn && startDependencyInstall({ folder: err.installIn, tasksDir })
        if (installing && !installing.startsWith('installing dependencies in ')) err.message = installing // low disk or two failures: Owner
        else if (installing) {
          moveCard(tasksDir, moved.id, 'queue')
          held[moved.id] = installing
          log?.(`${moved.id}: ${err.message}`)
          onChange?.()
          continue
        }
        if (!err.startFailed) recordOperationalFailure(tasksDir, moved, err.message, projectPath, gitSettings)
        recordSpawnFailure({ project, cap: max, reason: err.message })
        if (err.preservePane) {
          log?.(`${moved.id}: ${err.message}`)
          held[moved.id] = err.message
          slots--
          continue
        }
        unbind(tasksDir, moved.id)   // the provisional claim dies with the pane
        moveCard(tasksDir, moved.id, 'queue')
        if (!err.startFailed) held[moved.id] = `Operational recovery held: ${err.message}`
        else if (!recordStartFailure(tasksDir, moved.id, 'builder', err.message, now)) held[moved.id] = startRetryHold(readWorkflow(tasksDir)[moved.id], 'builder', now) || `Builder start failed; retrying once with a fresh tab: ${err.message}`
        onChange?.()
        continue
      }
      onChange?.()
    }
    const queueNow = (fresh ?? readBoard(tasksDir)).queue
    for (const card of queued) if (!started.includes(card.id) && !held[card.id] && queueNow.some(c => c.id === card.id)) {
      held[card.id] = 'waiting for available slot'
    }
    if (routeMutualHolds(tasksDir, held, log).length) onChange?.()
  } finally {
    busy.delete(project)
    holds.set(project, held)
  }
  return started
}

// Close panes the board spawned that have finished and reported back.
//
// Two conditions, both required. A board name (b-i149, or an older kb-*) means
// we spawned it, so a window you opened by hand is never touched. Unbound means hkb already ran — an agent that
// exited WITHOUT reporting keeps its pane open, because that is exactly the case
// you need to look at.
//
// idle-counts-as-finished is right for a BUILDER: unbound only ever happens after
// hkb ran, so idle really does mean done. It is WRONG for the reviewer/sweeper —
// they are unbound for their entire multi-card run by design (owning the whole
// column, not one card's slot), so an ordinary idle blip between tool calls reads
// identically to "finished" and got reaped mid-review — a real incident, not a
// hypothetical: a reviewer vanished twice, review count unchanged, before this
// fix. For reviewers/auditors/sweepers (r-, a-, i-; older kb-review-/kb-plan-)
// only a genuine `done` status counts as finished; idle does not.
// ...and `done` alone is still not enough for them either. `done` is what herdr
// reports for ANY pause: before the agent's first thought, and again every time it
// finishes a turn and waits. A multi-card reviewer pauses between cards by nature,
// so an instant reap on `done` kills it at the first gap — which is exactly what
// happened twice on 2026-08-17: a 7-card reviewer died having archived nothing,
// silently, because the pane it would have explained itself in was closed.
//
// So `done` has to be SUSTAINED to count. A pause between cards lasts seconds; a
// genuinely finished agent stays done forever. Two minutes tells them apart, and
// costs only a slightly later pane close in the ordinary case.
const reviewOrSweep = (agent) => ['r', 'a', 'i'].includes(agentRole(agent.name))
const DONE_GRACE_MS = 2 * 60 * 1000
const doneSince = new Map() // pane_id -> timestamp it most recently went done
const inactiveSince = new Map() // pane_id -> timestamp a builder first looked finished

function doneLongEnough(agent, now) {
  if (agent.agent_status !== 'done') {
    doneSince.delete(agent.pane_id)
    return false
  }
  const since = doneSince.get(agent.pane_id) ?? now
  doneSince.set(agent.pane_id, since)
  return now - since >= DONE_GRACE_MS
}

function inactiveLongEnough(agent, now) {
  if (agent.agent_status !== 'done' && agent.agent_status !== 'idle') {
    inactiveSince.delete(agent.pane_id)
    return false
  }
  const since = inactiveSince.get(agent.pane_id) ?? now
  inactiveSince.set(agent.pane_id, since)
  return now - since >= DONE_GRACE_MS
}

export async function closeFinished({ tasksDir, agents, project, now = Date.now(), retire = true }) {
  const bound = new Set([...Object.values(readBindings(tasksDir)).map((b) => b.pane_id), ...Object.values(readCardPlanners(tasksDir)).filter(p => !p.closedAt).map(p => p.paneId)])
  // A card's Builder pane matters only while it can still hand off, be recovered or be
  // retired after integration. Back in Planning/Queue the next build is a fresh Builder,
  // and the old idle one held its worktree's files (Tradeflow TF51: npm ci lock).
  const builderLanes = ['working', 'completed', 'review']
  const board = readBoard(tasksDir)
  const liveCards = new Set(builderLanes.flatMap(column => board[column].map(c => c.id)))
  for (const [id, saved] of Object.entries(readWorkflow(tasksDir))) if (liveCards.has(id) && saved.builder) bound.add(saved.builder.pane_id)
  for (const a of agents) {
    if (isBoardAgent(a) && !bound.has(a.pane_id) && !isSpawning(a.pane_id)) continue
    doneSince.delete(a.pane_id)
    inactiveSince.delete(a.pane_id)
  }
  let spent = agents.filter((a) => {
    if (!isBoardAgent(a) || bound.has(a.pane_id) || isSpawning(a.pane_id)) return false
    // Must run on EVERY poll, not only the done ones — a non-done poll is what
    // clears the timer, and && would short-circuit past it.
    if (reviewOrSweep(a)) return doneLongEnough(a, now)
    return inactiveLongEnough(a, now)
  })
  if (!retire && spent.length) {
    const owned = new Set(Object.values(readBoard(tasksDir)).flat().filter(c => c.cardOwned).map(c => c.id))
    const panes = new Set(Object.values(readUsage(tasksDir).runs).filter(r => r.cardIds?.length && r.cardIds.every(id => owned.has(id))).map(r => r.paneId))
    spent = spent.filter(a => panes.has(a.pane_id))
  }
  for (const a of spent) doneSince.delete(a.pane_id)
  for (const a of spent) inactiveSince.delete(a.pane_id)
  for (const a of spent) {
    try { await recordUsageFinish({ tasksDir, paneId: a.pane_id, agent: a, status: 'complete', now: new Date(now) }) } catch {}
    const runs = Object.values(readUsage(tasksDir).runs).filter(run => run.paneId === a.pane_id)
    const ids = [...new Set(runs.flatMap(run => run.cardIds || []))]
    if (ids.length) {
      try {
        const output = await paneRead(a.pane_id, sessionOf(project))
        for (const id of ids) appendHistory(tasksDir, id, { event: 'finished-output', agent: a.name, run: a.agent_session, output })
      } catch { continue } // Keep the pane until its output can be preserved.
    }
    await paneClose(a.pane_id, sessionOf(project)).catch(() => {})
    herdrLog(`${a.name || a.pane_id} finished, pane closed`)
    // No Builder is left on these cards: stop any server it left running in their worktrees.
    for (const id of ids) {
      const worktree = readWorktrees(tasksDir)[id]?.worktreePath
      let column = ''
      try { column = findCard(tasksDir, id).column } catch {}
      if (!worktree || readBindings(tasksDir)[id] || column === 'working') continue
      const pids = stopServersIn(worktree)
      if (pids.length) herdrLog(`${id}: stopped server(s) ${pids.join(', ')} left running in ${worktree}`)
    }
  }
  return spent.map((a) => a.pane_id)
}

// Review runs on integrated code: an Auto-review card is surfaced in Review only
// once its commit is integrated. Trivial cards keep their focused completion path.
export function promoteAutoReview(tasksDir, { all = false } = {}) {
  const promoted = []
  const worktrees = readWorktrees(tasksDir)
  const board = readBoard(tasksDir)
  // Legacy: a card handed to Review before integration can never be reviewed
  // (the snapshot lacks its code). Send it back to Completed so it integrates.
  for (const card of board.review) {
    const entry = worktrees[card.id]
    if (!card.cardOwned || card.audit || !entry || entry.state === 'integrated' || !hasBuilderPass(card)) continue
    if (currentReviewDecision(readFileSync(card.path, 'utf8'))) continue
    moveCard(tasksDir, card.id, 'completed')
    herdrLog(`${card.id} → completed (integrate before review)`)
  }
  for (const card of board.completed) {
    if (!card.autoReview) continue
    if (card.reviewPassed) continue
    if (card.trivial) continue
    const entry = worktrees[card.id]
    if (entry && (entry.state !== 'integrated' || !entry.cleaned)) continue
    const target = 'review'
    moveCard(tasksDir, card.id, target)
    herdrLog(`${card.id} → ${target} (${card.trivial ? 'trivial deterministic check' : 'auto-review'})`)
    promoted.push(card.id)
  }
  return promoted
}

export function archiveNoReviewCards(tasksDir) {
  const board = readBoard(tasksDir)
  const archived = [], skipped = []
  if (!board.review.length && !board.completed.length) return { archived, skipped }
  const worktrees = readWorktrees(tasksDir)
  for (const card of ['review', 'completed'].flatMap(column => board[column])) {
    // Reviewed cards are archived here too, once their PASS has routed them to Completed.
    if (!card.cardOwned || card.audit || (card.autoReview && !(card.column === 'completed' && card.reviewPassed))) continue
    const worktree = worktrees[card.id]
    const reason = !hasBuilderPass(card) ? 'missing Builder PASS' : worktree?.state !== 'integrated' ? `worktree state is ${worktree?.state ?? 'missing'}, not integrated` : null
    if (reason) { skipped.push({ id: card.id, reason }); continue }
    if (!canArchive(card)) { skipped.push({ id: card.id, reason: 'archive gate rejected the card' }); continue }
    moveCard(tasksDir, card.id, 'archive')
    appendHistory(tasksDir, card.id, { event: 'note', note: card.autoReview ? 'Archived after Reviewer PASS on integrated code' : 'Archived without independent review (Auto-review: no)' })
    archived.push(card.id)
  }
  return { archived, skipped }
}

import { explicitOwnerReason } from './owner-reason.mjs'
import { stopServersIn } from './orphan-servers.mjs'

export function routeReviewVerdicts(tasksDir, { log, reviewBusy = false, busyCardIds = [], includeCompleted = false, reviewRoot, onlyIds } = {}) {
  if (reviewBusy) return []
  const routed = []
  const board = readBoard(tasksDir)
  const columns = includeCompleted ? ['review', 'completed'] : ['review']
  for (const card of columns.flatMap((column) => board[column])) {
    if (onlyIds && !onlyIds.includes(card.id)) continue
    if (busyCardIds.includes(card.id)) continue
    const decision = currentReviewDecision(readFileSync(card.path, 'utf8'))
    if (!decision) continue
    if (card.column === 'completed' && decision.verdict !== 'UNKNOWN') continue
    try {
      if (decision.verdict === 'PASS') {
        if (reviewRoot) assertReviewInputs(reviewRoot, tasksDir, card.id)
        if (card.column !== 'review') continue
        moveCard(tasksDir, card.id, 'completed')
        herdrLog(`${card.id} → completed (review verdict PASS)`)
        routed.push({ id: card.id, to: 'completed', verdict: 'PASS' })
      } else {
        const category = failureCategory(decision.evidence)
        const to = explicitOwnerReason(decision.evidence) ? 'owner' : failureDestination(category, card.column)
        if (to === card.column) {
          recordOperationalFailure(tasksDir, card, decision.evidence, dirname(tasksDir))
          continue
        }
        const moved = moveCard(tasksDir, card.id, to, { correction: category === 'implementation' })
        if (moved.column === 'planning') requestPlannerCorrection(tasksDir, card.id)
        if (moved.column !== 'owner' && !card.audit) setAutoReview(tasksDir, card.id, true)
        const heading = to === 'owner' ? 'Needs you' : 'Review feedback'
        const brief = `${decision.evidence}\n`
        appendFileSync(moved.path, `\n\n---\n\n**${heading}** ${formatNZTime()}\n\n${brief}`)
        updateWorkflow(tasksDir, card.id, { correction: { category, note: decision.evidence } })
        routed.push({ id: card.id, to: moved.column, verdict: decision.verdict })
      }
    } catch (err) {
      log?.(`${card.id}: review verdict routing skipped — ${err.message}`)
    }
  }
  return routed
}

export function needsPlanCheck(card) {
  if (!card.cardOwned || card.audit) return false
  const plan = readFileSync(card.path, 'utf8').match(/^## Implementation plan\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || ''
  return /\bcheck(?: command)?\s*:?/i.test(plan)
}

export function finishPlanCheck({ tasksDir, cardId, reviewRoot, claimId, verdict, evidence }) {
  const card = findCard(tasksDir, cardId)
  const claim = reviewClaimFor(reviewRoot, tasksDir, card.id)
  if (!claim || claim.id !== claimId || claim.role !== 'plancheck' || card.column !== 'planned') throw new Error('Active Planned plancheck claim required')
  if (!['PASS', 'FAIL', 'RETRY'].includes(verdict) || !evidence?.trim()) throw new Error('Plan check needs PASS, FAIL or RETRY and observed evidence')
  if (verdict === 'PASS') {
    try {
      assertReviewInputs(reviewRoot, tasksDir, card.id)
      // Only the checker's own checkout must be unchanged: integration moves all the time on a
      // busy board, and comparing to it turned almost every PASS into RETRY (2026-10-03).
      const head = spawnSync('git', ['-C', claim.snapshot.path, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      if (head.status !== 0 || head.stdout.trim() !== claim.snapshot.head) throw new Error('Checker checkout moved; rerun the Check on its unchanged base')
      if (semanticDirtyFiles(claim.snapshot.path).length) throw new Error('Checker checkout contains code changes or untracked source')
    } catch (err) { verdict = 'RETRY'; evidence = err.message }
  }
  if (verdict === 'RETRY') {
    const result = recordPlanCheckRetry(tasksDir, card, evidence.trim(), claim.integrationPath, claimId)
    updateReviewClaim(reviewRoot, claim.id, { closedAt: Date.now(), closeReason: result.reason })
    return result
  }
  const reason = `Plan check: ${evidence.trim()}`
  // Planned -> Planning is a Planner correction, never a failed Builder attempt.
  const moved = moveCard(tasksDir, card.id, verdict === 'PASS' ? 'queue' : 'planning', { intake: true })
  appendHistory(tasksDir, card.id, { event: 'plan-check', stage: 'plancheck', verdict, reason, claimId })
  updateWorkflow(tasksDir, card.id, { planCheck: { verdict, reason, claimId, at: new Date().toISOString() }, operational: null, startFailure: null,
    ...(verdict === 'FAIL' ? { correction: { category: 'planning', note: reason } } : {}) })
  if (verdict === 'FAIL') {
    writeCurrentFeedback(tasksDir, moved, 'Planner correction', reason)
    requestPlannerCorrection(tasksDir, card.id)
  }
  failReviewClaim(reviewRoot, claim.id, `Plan check ${verdict}`)
  return { id: card.id, to: moved.column, verdict, reason }
}

export async function autoPlanCheck({ mission, project, tasksDir, reviewRoot, inventory, spawn = spawnReviewer, ...options }) {
  planHolds.set(project, {})
  if (!readBoard(tasksDir).planned.some(needsPlanCheck)) return null
  const claims = syncReviewClaims(reviewRoot, await inventory())
  const board = readBoard(tasksDir)
  const held = {}
  const card = board.planned.find(c => needsPlanCheck(c) && !unmetBlockers(c, board, readWorktrees(tasksDir)).length
    && (!mission?.id || (!mission.project || mission.project === project) && c.mission === mission.id)
    && !claims.some(claim => claim.project === project && (!claim.cards.length || claim.cards.includes(c.id)))
    && !operationalHold(tasksDir, c, options.projectPath)
    && !startRetryHold(readWorkflow(tasksDir)[c.id], 'plancheck')
    && !(held[c.id] = startHoldReason({ card: { ...c, column: 'queue' }, board, projectPath: options.projectPath, tasksDir, mission, gitSettings: options.gitSettings })))
  planHolds.set(project, Object.fromEntries(Object.entries(held).filter(([, reason]) => reason)))
  if (!card) return null
  return spawn({ ...options, project, tasksDir, reviewRoot, inventory, cardIds: [card.id], planCheck: true })
}

export function promotePlanned(tasksDir, { mission, project, planCheck = true } = {}) {
  const promoted = []
  const board = readBoard(tasksDir)
  for (const card of board.planned) {
    if (planCheck && needsPlanCheck(card)) continue
    if (mission?.id && (mission.project && project !== mission.project || card.mission !== mission.id)) continue
    const unmet = unmetBlockers(card, board, readWorktrees(tasksDir))
    if (unmet.length) continue
    moveCard(tasksDir, card.id, 'queue')
    promoted.push(card.id)
  }
  return promoted
}

export const reviewerRunning = (agents, now = Date.now()) =>
  agents.some((a) => isReviewerAgent(a) && !doneLongEnough(a, now))

// herdr does not register an agent until it has booted, so reviewerRunning() is
// false for the whole ~55s spawn. Held here so two explicit Review requests
// cannot start concurrently and archive or rework the same card.
const reviewing = new Set()
export const reviewerBusy = (project, agents) =>
  reviewing.has(project) || agents.some((a) => isReviewerAgent(a) && a.agent_status !== 'done')
const busyError = () => Object.assign(new Error('a reviewer is already running'), { busy: true })

// Every poll, not only when review work exists: a reviewer that vanished or never took its
// prompt frees its board-wide slot, and its idle pane is closed (an unowned reviewer pane
// holds verdict routing). This project's inventory reconciles only this project's claims.
export async function reconcileReviewers({ reviewRoot, boardRoot, project, tasksDir, agents, now = Date.now(), close = paneClose, read = paneRead }) {
  const claims = readReviewClaims(reviewRoot)
  if (!claims.some(c => !c.closedAt && c.project === project) && !agents.some(isReviewerAgent)) return []
  const open = new Set(claims.filter(c => !c.closedAt).map(c => c.id))
  syncReviewClaims(reviewRoot, [{ project, tasksDir, known: true, agents }], now)
  const retired = readReviewClaims(reviewRoot).filter(c => c.closedAt && open.has(c.id))
  for (const claim of retired) {
    const agent = agents.find(a => a.pane_id === claim.paneId)
    // A Reviewer stopped by its engine's usage limit: block that engine and lift the
    // "ended without a verdict" hold, so its cards wait in Review for the reset.
    const limit = agent && boardRoot && claim.engine && usageLimit(await read(claim.paneId, sessionOf(project)).catch(() => ''), now)
    if (limit) {
      blockEngine(boardRoot, quotaKey(claim.engine, limit.modelCap && claim.model), limit.until, now)
      for (const id of claim.cards) updateWorkflow(claim.tasksDir, id, { operational: null })
    }
    if (limit || agent?.agent_status === 'idle') await close(claim.paneId, sessionOf(project)).catch(() => {})
  }
  return retired
}

export async function autoReview({ project, projectPath, tasksDir, boardRoot, reviewRoot = boardRoot, model, engine, agents, log, inventory, assignmentForCard, plan = computeReviewPlan, spawn = spawnReviewer }) {
  if (!plan({ tasksDir }).batches.length) return null
  let claims
  try { claims = syncReviewClaims(reviewRoot, await inventory()) } catch (err) { log?.(err.message); return null }
  if (claims.length >= 4) return null
  if (claims.some(c => c.project === project && !c.cards.length)) return null
  const claimedIds = claims.filter(c => c.project === project).flatMap(c => c.cards)
  const batch = plan({ tasksDir, claimedIds }).batches[0]
  if (!batch) return null
  try {
    return await spawn({ project, projectPath, tasksDir, boardRoot, reviewRoot, model, engine, cardIds: batch.cards, inventory, assignmentForCard })
  } catch (err) {
    if (!err.busy) log?.(`auto-review skipped — ${err.message}`)
    return null
  }
}

// One reviewer for every card sitting in Review, or — when `cardIds` is given —
// just that subset (the review-plan batching). Batching is the point: a single
// context reading several related cards costs far less than several contexts.
export async function spawnReviewer({ project, projectPath, tasksDir, boardRoot, reviewRoot = boardRoot, model, engine, cardIds, inventory, assignmentForCard, planCheck = false, gitSettings, now = Date.now() }) {
  const role = planCheck ? 'plancheck' : 'reviewer'
  assertCardRunSelection(project, cardIds || [], role)
  assertPromptAllowed(project)
  // A cross-process reservation follows fresh global inventory, before launch.
  let claim, paneId, assignedCards = []
  try {
    const session = sessionOf(project)

    const board = readBoard(tasksDir)
    let cards = planCheck ? board.planned.filter(needsPlanCheck) : cardIds?.length ? [...board.review, ...board.completed] : board.review
    if (cardIds?.length) {
      const wanted = new Set(cardIds.map((id) => id.toUpperCase()))
      cards = cards.filter((c) => wanted.has(c.id))
    }
    if (cards.some((c) => c.audit)) cards = [cards.find((c) => c.audit)]
    if (!cards.length) throw new Error('nothing in Review')
    assignedCards = cards
    assertCardRunSelection(project, cards.map(c => c.id), role)
    if (planCheck && cards.length !== 1) throw new Error('Plan check requires one card')
    const primary = assignmentForCard?.(cards[0], planCheck ? 'plancheck' : 'review') ?? (planCheck ? (await import('./agent-settings.mjs')).assignmentFor({}, cards[0], 'plancheck') : null)
    const choice = selectQuotaAssignment(boardRoot, primary ?? { engine: engineKind(engine), model }, now)
    const selected = primary ? choice.assignment : null
    if (choice.hold) throw Object.assign(new Error(choice.hold), { busy: true })
    for (const card of cards) {
      const limit = checkWorkflowLimits(tasksDir, card.id, role) || startRetryHold(readWorkflow(tasksDir)[card.id], role)
      if (limit) throw Object.assign(new Error(limit), { busy: true })
      const held = operationalHold(tasksDir, card, projectPath)
      if (held) throw Object.assign(new Error(`Review recovery held: ${held}`), { busy: true })
    }
    if (planCheck) {
      const hold = startHoldReason({ card: { ...cards[0], column: 'queue' }, board, projectPath, tasksDir, gitSettings })
      if (hold) throw Object.assign(new Error(hold), { busy: true })
    }
    for (const group of readReviewGroups(tasksDir).filter(g => !planCheck && g.cards.some(id => cards.some(c => c.id === id)))) {
      const remaining = group.cards.filter(id => !board.archive.some(c => c.id === id))
      if (remaining.length !== cards.length || remaining.some(id => !cards.some(c => c.id === id))) throw new Error(`Review explicit group together: ${group.name}`)
    }
    if (cardIds?.length && (new Set(cardIds).size !== cardIds.length || cards.length !== cardIds.length)) throw new Error('Review group contains duplicate or unavailable cards')
    if (!inventory) throw new Error('Global reviewer inventory required')
    const integrated = readWorktrees(tasksDir)
    // Reviewers review integrated code; an isolated card commit must be integrated first.
    for (const card of cards.filter(c => !planCheck && (c.column === 'completed' || integrated[c.id]))) {
      if (integrated[card.id]?.state !== 'integrated') throw new Error(`${card.id}: integration receipt required before review`)
    }
    claim = reserveReview(reviewRoot, { project, tasksDir, cards: cards.map(c => c.id), inventory: await inventory() })
    if (planCheck) updateReviewClaim(reviewRoot, claim.id, { role })
    cards = cards.map(card => card.column === 'completed' ? moveCard(tasksDir, card.id, 'review') : card)

    for (const card of cards) {
      if (!auditPreflightBlocked(card)) continue
      throw new Error(`${card.id}: audit prerequisite BLOCKED; restore required tools/auth/render setup before retrying Review`)
    }

    const selectedModel = selected?.model ?? model
    const selectedEngine = selected ? { kind: selected.engine, ...(selected.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${selected.reasoning}"`] } : {}) } : engine
    // The plan checker only runs the Check; the card's audit MCP tools are for its Builder.
    const reviewerEngine = planCheck ? selectedEngine : auditMcpEngine(selectedEngine, cards, tasksDir)
    const environment = projectEnvironment(project)
    const prepared = planCheck ? prepareCardWorktree({ projectPath, tasksDir, card: cards[0], gitSettings }) : null
    if (planCheck && !prepared.git) throw new Error('Plan check requires an isolated Git card checkout')
    if (planCheck && semanticDirtyFiles(prepared.workspacePath).length) throw new Error('Plan check requires an unchanged base checkout')
    const snapshot = planCheck ? { path: prepared.workspacePath, head: prepared.entry.baseCommit } : prepareReviewSnapshot(reviewRoot, projectPath, claim.id)
    if (planCheck) {
      const head = spawnSync('git', ['-C', snapshot.path, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      if (head.status !== 0 || head.stdout.trim() !== snapshot.head) throw new Error('Card checkout contains saved implementation; an unchanged base is required')
    }
    for (const card of cards) {
      const commit = integrated[card.id]?.commit
      if (!planCheck && snapshot.head && commit && !snapshotContains(snapshot.path, commit)) throw new Error(`${card.id}: review snapshot ${snapshot.head} does not contain integrated commit ${commit}`)
    }
    updateReviewClaim(reviewRoot, claim.id, { role, engine: engineKind(reviewerEngine), model: selectedModel, snapshot, environment, integrationPath: projectPath, inputFingerprints: Object.fromEntries(cards.map(card => [card.id, evidenceFingerprint(card, snapshot.path)])) })

    const backend = backendFor(role)
    const workspace = backend === 'headless' ? null : await agentWorkspaceOr(projectPath, session)
    const created = await tabCreate({
      cwd: snapshot.path, label: reviewLabel(cards.length), focus: false, workspace, session, backend,
    })
    paneId = created?.root_pane?.pane_id
    if (!paneId) throw new Error(`tab create returned no pane id: ${JSON.stringify(created)}`)
    updateReviewClaim(reviewRoot, claim.id, { paneId })
    bindCardRunAssignment(project, cards.map(c => c.id), role, paneId)

    // r-<first card> (a- for an audit) so closeFinished and reviewerRunning can
    // both recognise it; agentStart suffixes it if that name is still live.
    await waitForPrompt(paneId, { session })
    let name = agentName(cards.every((c) => c.audit) ? 'auditor' : 'reviewer', cards[0].id)
    // Held across agentStart AND deliver: the reviewer is never bound to a card
    // (see below), so isSpawning() is its ONLY protection from the board's
    // reaper closing an idle-but-not-yet-prompted pane. agentStart alone isn't
    // enough — see the comment on beginSpawn/endSpawn in herdr.mjs.
    beginSpawn(paneId)
    try {
      // Same generous startup budget as a builder — Opus is no faster to boot.
      name = (await agentStart({ name, paneId, model: selectedModel, engine: reviewerEngine, timeoutMs: START_TIMEOUT_MS, session, browser: cards.some(needsBrowser) }).catch(err => { throw startFailed(err) }))?.name ?? name
      const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
      try {
        recordUsageStart({
          tasksDir, project, requestId: `review:${cards.map((c) => c.id).join(',')}`, cardIds: cards.map((c) => c.id),
          role, paneId, tabId: created?.tab?.tab_id, model: selectedModel, name, agentSession: agent?.agent_session,
        })
      } catch {}
      await deliver(paneId, (planCheck ? planCheckerPrompt : reviewerPrompt)({ cards, projectPath: snapshot.path, boardRoot, reviewRoot, tasksDir, reviewClaim: claim.id, reportOnly: snapshot.reportOnly, envFile: environment?.path, engine: reviewerEngine }), session, null, { engine: reviewerEngine })
      updateReviewClaim(reviewRoot, claim.id, { phase: 'running', submittedAt: Date.now() })
      for (const card of cards) updateWorkflow(tasksDir, card.id, { operational: null, ...(!planCheck ? { startFailure: null } : {}) })
      if (choice.message) for (const card of cards) activityLog({ tasksDir, project, cardId: card.id, event: planCheck ? 'plancheck-start' : 'reviewer-start', message: choice.message, now })
    } catch (err) {
      if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
      throw Object.assign(new Error(`reviewer spawn failed: ${err.message}`), { paused: err.paused, preservePane: err.preservePane, startFailed: err.startFailed })
    } finally {
      endSpawn(paneId)
    }

    // Reviewer ownership is in the separate global claim ledger, never Builder slots.
    return { pane_id: paneId, tab_id: created?.tab?.tab_id, model: selectedModel, name, cards: cards.map((c) => c.id) }
  } catch (err) {
    if (planCheck && assignedCards.length && !err.preservePane && !err.busy && !err.paused) {
      recordPlanCheckRetry(tasksDir, assignedCards[0], err.message, projectPath, claim?.id)
      if (claim) updateReviewClaim(reviewRoot, claim.id, { closedAt: Date.now(), closeReason: err.message })
      throw err
    }
    if (err.startFailed) for (const card of assignedCards) recordStartFailure(tasksDir, card.id, role, err.message)
    else if (!err.paused && !err.busy) for (const card of assignedCards) recordOperationalFailure(tasksDir, card, err.message, projectPath)
    // A start failure closed its pane, so the claim is released for the retry.
    if (claim && paneId && !err.startFailed) updateReviewClaim(reviewRoot, claim.id, { phase: 'uncertain', error: err.message })
    else if (claim) failReviewClaim(reviewRoot, claim.id, err.message)
    throw err
  }
}
