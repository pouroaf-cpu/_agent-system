import { readCardPlanners, requestPlannerCorrection } from './card-planner.mjs'
import { assertPromptAllowed, controlState, projectEnvironment } from './project-control.mjs'
import { cardRunContext, assertCardRunSelection, bindCardRunAssignment } from './card-run.mjs'
import { operationalHold, recordOperationalFailure, updateWorkflow, readWorkflow, failureCategory, failureDestination, evidenceFingerprint } from './workflow-state.mjs'
import { appendHistory } from './card-history.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'
// The spawner. Watches one column — Queue — and nothing else.
//
// You put a card in Queue; that is the consent. Everything here is about not
// doing anything you did not ask for: it never pulls from another column, never
// exceeds the concurrency cap, and never retries a card that failed to start.

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { readBoard, moveCard, findCard, isParked, appendBuildAttempt, currentReviewDecision, currentDirtyMatchesSnapshot, setAutoReview, hasBuilderPass, canArchive } from './cards.mjs'
import { bind, unbind, liveBindings, readBindings } from './bindings.mjs'
import { spawnForCard, deliver, START_TIMEOUT_MS } from './spawn.mjs'
import { reviewerPrompt, issuesSweeperPrompt, agentName, isBoardAgent, reviewLabel, sweepLabel } from './prompt.mjs'
import { CARD_ID, agentRole, isReviewerAgent, isSweeperAgent } from './ids.mjs'
import { tabCreate, agentStart, agentList, agentsForProject, paneClose, paneRead, agentWorkspaceOr, waitForPrompt, isSpawning, beginSpawn, endSpawn, herdrLog, sessionOf } from './herdr.mjs'
import { coolingDown, clearRetries } from './retries.mjs'
import { computeReviewPlan, readReviewGroups } from './review-plan.mjs'
import { readUsage, recordUsageFinish, recordUsageStart } from './request-usage.mjs'
import { overlapHoldReason, readWorktrees, integrationStartHoldReason } from './worktrees.mjs'
import { recordSpawnFailure } from './breaker.mjs'
import { auditMcpEngine, auditPreflightBlocked } from './audit-mcp.mjs'
import { syncReviewClaims, reserveReview, updateReviewClaim, failReviewClaim, prepareReviewSnapshot, assertReviewInputs, snapshotContains } from './review-claims.mjs'
import { recoveryState } from './recovery.mjs'

// A Builder that disappears or ends without hkb done/issue leaves Working
// stuck. Route it to Issues while retaining the binding, workflow assignment,
// counters and worktree for inspection and recovery.
export function routeBuilderNoHandoff({ tasksDir, cardId, reason, evidence = '', workspace, gitSettings }) {
  const card = findCard(tasksDir, cardId)
  if (card.column !== 'working') return card
  const detail = `${String(reason || 'Builder ended without a valid handoff').trim()}${evidence ? `; evidence: ${String(evidence).trim().slice(-4000)}` : ''}`
  const moved = moveCard(tasksDir, card.id, 'issues')
  appendFileSync(moved.path, `\n\n**Builder fallback** ${new Date().toISOString()}\n\n${detail}. Worktree, assignment and prior output are preserved for recovery; inspect this evidence before requeueing.\n`)
  appendHistory(tasksDir, card.id, { event: 'builder-no-handoff', stage: 'working', reason: detail, evidence })
  recordOperationalFailure(tasksDir, moved, detail, workspace, gitSettings)
  return moved
}

export async function recoverBuilderNoHandoff({ tasksDir, cardId, agents, io = { paneRead, deliver }, session, workspace, gitSettings, graceMs = 120000, now = Date.now() }) {
  const card = findCard(tasksDir, cardId)
  const workflow = readWorkflow(tasksDir)[card.id] || {}
  const marker = workflow.builderRecovery
  const attempt = recoveryState(readFileSync(card.path, 'utf8')).attempt
  const binding = readBindings(tasksDir)[card.id]
  const paneId = binding?.pane_id || workflow.builder?.pane_id
  const agent = agents.find(item => item.pane_id === paneId)
  const operational = workflow.operational
  const hold = operationalHold(tasksDir, card, workspace, gitSettings)

  const routeToPlanner = async (cause, output) => {
    const prior = readWorkflow(tasksDir)[card.id]?.builderRecovery || {}
    const failures = prior.cause === cause ? (prior.failures || 0) + 1 : 1
    const detail = `Builder recovery failed (${cause}); original hold: ${operational?.reason || 'Builder stopped without a handoff'}. Pane output: ${String(output || '(unavailable)').slice(-4000)}`
    unbind(tasksDir, card.id)
    const to = failures >= 2 ? 'owner' : 'planning'
    const moved = moveCard(tasksDir, card.id, to)
    if (to === 'planning') {
      appendFileSync(moved.path, `\n\n**Kicked back** ${new Date(now).toISOString()}\n\n[planning] ${detail}. Worktree, commits, and dirty files remain preserved.\n`)
      requestPlannerCorrection(tasksDir, card.id)
    } else {
      appendFileSync(moved.path, `\n\n**Needs you**\nThe Builder recovery failed twice for the same reason (${cause}). Should the Planner change the recovery plan before this card is requeued?\n\n${detail}\n`)
    }
    appendHistory(tasksDir, card.id, { event: 'builder-recovery-failed', cause, failures, paneId, output: String(output || '').slice(-4000), operationalReason: operational?.reason || null })
    updateWorkflow(tasksDir, card.id, { operational: null, builderRecovery: { attempt, cause, failures, status: to, paneId, at: new Date(now).toISOString() } })
    return true
  }

  if (card.column === 'working' && marker?.status === 'nudged' && marker.attempt === attempt) {
    if (now - Date.parse(marker.at) < graceMs) return true
    if (agent && !['idle', 'done'].includes(agent.agent_status)) return false
    const output = agent ? await io.paneRead(paneId, session).catch(() => '') : ''
    return routeToPlanner(marker.cause || 'idle-no-handoff', output)
  }
  if (card.column !== 'issues' || !hold || !/Builder fallback|without a valid Builder handoff from Working/i.test(hold)) return false
  const cause = !agent ? 'missing-pane' : 'idle-no-handoff'
  if (!agent) return routeToPlanner(cause, '')
  if (!['idle', 'done'].includes(agent.agent_status)) return false
  if (marker?.attempt === attempt && marker.status) return false
  const output = await io.paneRead(paneId, session)
  updateWorkflow(tasksDir, card.id, { builderRecovery: { attempt, cause, paneId, status: 'claimed', at: new Date(now).toISOString() } })
  const moved = moveCard(tasksDir, card.id, 'working')
  const nudge = `Finish ${card.id} within the approved card scope, do not ask questions, then report with exactly one of hkb done, hkb issue, or hkb owner.`
  appendHistory(tasksDir, card.id, { event: 'builder-recovery-nudge', cause, paneId, output: String(output).slice(-4000), attempt })
  try {
    await io.deliver(paneId, nudge, session)
  } catch (err) {
    updateWorkflow(tasksDir, card.id, { builderRecovery: { attempt, cause, paneId, status: 'uncertain', at: new Date(now).toISOString(), error: err.message } })
    throw err
  }
  updateWorkflow(tasksDir, card.id, { builderRecovery: { attempt, cause, paneId, status: 'nudged', at: new Date(now).toISOString() } })
  return !!moved
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
export function unmetBlockers(card, board, integrated = {}) {
  return (card.blockedBy || []).filter((id) => {
    const live = liveCards(board).filter((c) => c.id === id)
    const archived = board.archive.filter((c) => c.id === id)
    if (!live.length && archived.length === 1) return false
    return !(live.length === 1 && archived.length === 0 && live[0].column === 'completed' && integrated[id]?.state === 'integrated')
  })
}

const liveCards = (board) => Object.entries(board).filter(([key]) => key !== 'archive').flatMap(([, cards]) => cards)

function duplicateLiveId(card, board) {
  const hits = liveCards(board).filter((c) => c.id === card.id)
  return hits.length > 1 ? hits.map((c) => `${c.column}/${c.file}`).join(', ') : null
}

function duplicateIssueKey(card, board) {
  if (!card.issueKey) return null
  const hits = liveCards(board).filter((c) => c.issueKey && c.issueKey === card.issueKey)
  return hits.length > 1 ? hits.map((c) => `${c.id} in ${c.column}`).join(', ') : null
}

function cycleFor(card, board) {
  const byId = new Map()
  for (const c of liveCards(board)) {
    if (!byId.has(c.id)) byId.set(c.id, c)
    else byId.set(c.id, null)
  }
  const seen = new Set()
  const visit = (id) => {
    if (id === card.id) return true
    if (seen.has(id)) return false
    seen.add(id)
    const next = byId.get(id)
    return !!next && (next.blockedBy || []).some(visit)
  }
  return (card.blockedBy || []).some(visit)
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
  const unmet = unmetBlockers(card, board, tasksDir ? readWorktrees(tasksDir) : {})
  if (unmet.length) return `waiting for unique integrated or archived prerequisite ${unmet.join(', ')}`
  const overlap = gitSettings && overlapHoldReason({ tasksDir, card, projectPath })
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

export const holdsFor = (project) => holds.get(project) ?? {}

const HELD_BY = new RegExp(String.raw`held by (${CARD_ID})`)
export function routeMutualHolds(tasksDir, held, log) {
  const routed = []
  for (const [id, reason] of Object.entries(held)) {
    const other = reason.match(HELD_BY)?.[1]
    if (!other || !held[other]?.includes(`held by ${id}`) || routed.includes(id)) continue
    // Preserved edits need attribution; never resolve a lock cycle by deleting
    // a worktree or allowing overlapping Builders to start.
    for (const cardId of [id, other]) {
      const moved = moveCard(tasksDir, cardId, 'issues')
      appendFileSync(moved.path, `\n\n**Kicked back** ${new Date().toISOString()}\n\nMutual file hold between ${id} and ${other}: ${held[cardId]}. Reconcile declared scope and preserved commits with the other card before requeueing; do not discard work or bypass file locks.\n`)
      requestPlannerCorrection(tasksDir, cardId)
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
export async function autoSpawn({ project, projectPath, tasksDir, boardRoot, model, engine, trivialModel = model, trivialEngine = engine, max, agents, onChange, log, mission, onlyIds, gitSettings, assignmentForCard, stallSeconds = 300, now = Date.now(), spawn = spawnForCard }) {
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
  try {
    for (const card of queued) {
      const fresh = readBoard(tasksDir)
      const freshCard = fresh.queue.find((c) => c.path === card.path)
      if (!freshCard) continue
      const selected = assignmentForCard?.(freshCard, freshCard.trivial ? 'trivial' : 'working')
      const selectedModel = selected?.model ?? (freshCard.trivial ? trivialModel : model)
      const selectedEngine = selected?.engine ? { kind: selected.engine, ...(selected.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${selected.reasoning}"`] } : {}) } : (freshCard.trivial ? trivialEngine : engine)
      const limit = checkWorkflowLimits(tasksDir, freshCard.id, 'builder')
      const operational = operationalHold(tasksDir, freshCard, projectPath, gitSettings)
      const hold = limit || (operational && `Operational recovery held: ${operational}`)
        || startHoldReason({ card: freshCard, board: fresh, projectPath, tasksDir, mission, log, gitSettings })
        || (slots <= 0 ? 'slots full' : null)
      if (hold) {
        const dupId = duplicateLiveId(freshCard, fresh)
        const dupKey = duplicateIssueKey(freshCard, fresh)
        const cycle = cycleFor(freshCard, fresh)
        const unmet = unmetBlockers(freshCard, fresh, readWorktrees(tasksDir))
        const prerequisites = (freshCard.blockedBy || []).map(id => [id, liveCards(fresh).filter(c => c.id === id)])
        const blockedByIssue = prerequisites.find(([, hits]) => hits.length === 1 && hits[0].column === 'issues')
        const allowedDependencyWait = hold.startsWith('waiting for unique integrated or archived prerequisite')
          && !blockedByIssue && unmet.length > 0
          && prerequisites.every(([, hits]) => hits.length === 1 && ['owner', 'planning', 'planned', 'queue', 'working', 'review', 'completed'].includes(hits[0].column))
        const cardProblem = !!(dupId || dupKey || cycle || hold.startsWith('card not ready') || (unmet.length && !allowedDependencyWait && !blockedByIssue))
        const fileHolder = hold.match(/files busy(?:, likely held by|, held by) ([A-Z]+-\d+)/i)?.[1]
        const transient = ['slots full', 'cooling down after failed spawn'].includes(hold)
          || hold.startsWith('files busy') && fileHolder && holderOf(fresh).includes(fileHolder)
        const workflow = readWorkflow(tasksDir)[freshCard.id] || {}
        if (allowedDependencyWait) {
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
            const moved = moveCard(tasksDir, freshCard.id, 'issues')
            appendFileSync(moved.path, `\n\n---\n\n**Queue hold expired** ${new Date(now).toISOString()}\n\n${hold}; continuously held for ${Math.round(elapsed / 1000)} seconds. Preserved work remains available for recovery.\n`)
            updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: null })
            delete held[freshCard.id]
            onChange?.()
          } else updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: since })
          continue
        }
        const to = cardProblem ? 'planning' : 'owner'
        const moved = moveCard(tasksDir, freshCard.id, to, dupId ? { sourcePath: freshCard.path } : {})
        const reason = dupId || dupKey || hold
        const note = cardProblem
          ? `**Kicked back** ${new Date(now).toISOString()}\n\n[planning] ${reason}. Planner: correct the card/dependency before requeueing. Preserved work remains available.`
          : `**Needs you** ${new Date(now).toISOString()}\n\n${reason}. Decision needed: resolve this hold or authorize a recovery path before requeueing.`
        appendFileSync(moved.path, `\n\n---\n\n${note}\n`)
        updateWorkflow(tasksDir, freshCard.id, { queueHoldSince: null })
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
      try {
        const result = await spawn({
          project, projectPath, tasksDir, boardRoot, card: moved, model: selectedModel, engine: selectedEngine, gitSettings,
          onPane: (provisional) => {
            bind(tasksDir, moved.id, provisional)
            try {
              recordUsageStart({
                tasksDir, project, requestId: moved.id, cardIds: [moved.id], role: 'builder',
                paneId: provisional.pane_id, tabId: provisional.tab_id, model: selectedModel, name: provisional.name,
                agentSession: provisional.agent_session,
              })
            } catch {}
            onChange?.()
          },
        })
        bind(tasksDir, moved.id, result)
        updateWorkflow(tasksDir, moved.id, { builder: result, operational: null })
        clearRetries(tasksDir, moved.id)
        herdrLog(`${moved.id} → working (auto-spawn)`)
        started.push(moved.id)
        slots--
      } catch (err) {
        if (err.paused) { held[moved.id] = err.message; continue }
        recordOperationalFailure(tasksDir, moved, err.message, projectPath, gitSettings)
        recordSpawnFailure({ project, cap: max, reason: err.message })
        if (err.preservePane) {
          log?.(`${moved.id}: ${err.message}`)
          held[moved.id] = err.message
          slots--
          continue
        }
        unbind(tasksDir, moved.id)   // the provisional claim dies with the pane
        moveCard(tasksDir, moved.id, 'queue')
        held[moved.id] = `Operational recovery held: ${err.message}`
        onChange?.()
        continue
      }
      onChange?.()
    }
    for (const card of queued) if (!started.includes(card.id) && !held[card.id] && readBoard(tasksDir).queue.some(c => c.id === card.id)) {
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
  const liveCards = new Set(Object.entries(readBoard(tasksDir)).filter(([column]) => column !== 'archive').flatMap(([, cards]) => cards.map(c => c.id)))
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
  if (!retire) {
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
  const worktrees = readWorktrees(tasksDir)
  const board = readBoard(tasksDir)
  const archived = [], skipped = []
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
        appendFileSync(moved.path, `\n\n---\n\n**${heading}** ${new Date().toISOString()}\n\n${brief}`)
        updateWorkflow(tasksDir, card.id, { correction: { category, note: decision.evidence } })
        routed.push({ id: card.id, to: moved.column, verdict: decision.verdict })
      }
    } catch (err) {
      log?.(`${card.id}: review verdict routing skipped — ${err.message}`)
    }
  }
  return routed
}

export function promotePlanned(tasksDir, { mission, project } = {}) {
  const promoted = []
  const board = readBoard(tasksDir)
  for (const card of board.planned) {
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
export async function spawnReviewer({ project, projectPath, tasksDir, boardRoot, reviewRoot = boardRoot, model, engine, cardIds, inventory, assignmentForCard }) {
  assertCardRunSelection(project, cardIds || [], 'reviewer')
  assertPromptAllowed(project)
  // A cross-process reservation follows fresh global inventory, before launch.
  let claim, paneId, assignedCards = []
  try {
    const session = sessionOf(project)

    const board = readBoard(tasksDir)
    let cards = cardIds?.length ? [...board.review, ...board.completed] : board.review
    if (cardIds?.length) {
      const wanted = new Set(cardIds.map((id) => id.toUpperCase()))
      cards = cards.filter((c) => wanted.has(c.id))
    }
    if (cards.some((c) => c.audit)) cards = [cards.find((c) => c.audit)]
    if (!cards.length) throw new Error('nothing in Review')
    assignedCards = cards
    assertCardRunSelection(project, cards.map(c => c.id), 'reviewer')
    for (const card of cards) {
      const limit = checkWorkflowLimits(tasksDir, card.id, 'reviewer')
      if (limit) throw Object.assign(new Error(limit), { busy: true })
      const held = operationalHold(tasksDir, card, projectPath)
      if (held) throw Object.assign(new Error(`Review recovery held: ${held}`), { busy: true })
    }
    for (const group of readReviewGroups(tasksDir).filter(g => g.cards.some(id => cards.some(c => c.id === id)))) {
      const remaining = group.cards.filter(id => !board.archive.some(c => c.id === id))
      if (remaining.length !== cards.length || remaining.some(id => !cards.some(c => c.id === id))) throw new Error(`Review explicit group together: ${group.name}`)
    }
    if (cardIds?.length && (new Set(cardIds).size !== cardIds.length || cards.length !== cardIds.length)) throw new Error('Review group contains duplicate or unavailable cards')
    if (!inventory) throw new Error('Global reviewer inventory required')
    const integrated = readWorktrees(tasksDir)
    // Reviewers review integrated code; an isolated card commit must be integrated first.
    for (const card of cards.filter(c => c.column === 'completed' || integrated[c.id])) {
      if (integrated[card.id]?.state !== 'integrated') throw new Error(`${card.id}: integration receipt required before review`)
    }
    claim = reserveReview(reviewRoot, { project, tasksDir, cards: cards.map(c => c.id), inventory: await inventory() })
    cards = cards.map(card => card.column === 'completed' ? moveCard(tasksDir, card.id, 'review') : card)

    for (const card of cards) {
      if (!auditPreflightBlocked(card)) continue
      throw new Error(`${card.id}: audit prerequisite BLOCKED; restore required tools/auth/render setup before retrying Review`)
    }

    const selected = assignmentForCard?.(cards[0], 'review')
    const selectedModel = selected?.model ?? model
    const selectedEngine = selected ? { kind: selected.engine, ...(selected.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${selected.reasoning}"`] } : {}) } : engine
    const reviewerEngine = auditMcpEngine(selectedEngine, cards, tasksDir)
    const environment = projectEnvironment(project)
    const snapshot = prepareReviewSnapshot(reviewRoot, projectPath, claim.id)
    for (const card of cards) {
      const commit = integrated[card.id]?.commit
      if (snapshot.head && commit && !snapshotContains(snapshot.path, commit)) throw new Error(`${card.id}: review snapshot ${snapshot.head} does not contain integrated commit ${commit}`)
    }
    updateReviewClaim(reviewRoot, claim.id, { snapshot, environment, integrationPath: projectPath, inputFingerprints: Object.fromEntries(cards.map(card => [card.id, evidenceFingerprint(card, snapshot.path)])) })

    const workspace = await agentWorkspaceOr(projectPath, session)
    const created = await tabCreate({
      cwd: snapshot.path, label: reviewLabel(cards.length), focus: false, workspace, session,
    })
    paneId = created?.root_pane?.pane_id
    if (!paneId) throw new Error(`tab create returned no pane id: ${JSON.stringify(created)}`)
    updateReviewClaim(reviewRoot, claim.id, { paneId })
    bindCardRunAssignment(project, cards.map(c => c.id), 'reviewer', paneId)

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
      name = (await agentStart({ name, paneId, model: selectedModel, engine: reviewerEngine, timeoutMs: START_TIMEOUT_MS, session }))?.name ?? name
      const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
      try {
        recordUsageStart({
          tasksDir, project, requestId: `review:${cards.map((c) => c.id).join(',')}`, cardIds: cards.map((c) => c.id),
          role: 'reviewer', paneId, tabId: created?.tab?.tab_id, model: selectedModel, name, agentSession: agent?.agent_session,
        })
      } catch {}
      await deliver(paneId, reviewerPrompt({ cards, projectPath: snapshot.path, boardRoot, reviewRoot, tasksDir, reviewClaim: claim.id, reportOnly: snapshot.reportOnly, envFile: environment?.path }), session)
      updateReviewClaim(reviewRoot, claim.id, { phase: 'running', submittedAt: Date.now() })
      for (const card of cards) updateWorkflow(tasksDir, card.id, { operational: null })
    } catch (err) {
      if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
      throw Object.assign(new Error(`reviewer spawn failed: ${err.message}`), { paused: err.paused, preservePane: err.preservePane })
    } finally {
      endSpawn(paneId)
    }

    // Reviewer ownership is in the separate global claim ledger, never Builder slots.
    return { pane_id: paneId, tab_id: created?.tab?.tab_id, model, name, cards: cards.map((c) => c.id) }
  } catch (err) {
    if (!err.paused && !err.busy) for (const card of assignedCards) recordOperationalFailure(tasksDir, card, err.message, projectPath)
    if (claim && paneId) updateReviewClaim(reviewRoot, claim.id, { phase: 'uncertain', error: err.message })
    else if (claim) failReviewClaim(reviewRoot, claim.id, err.message)
    throw err
  }
}

export const sweeperRunning = (agents) => agents.some(isSweeperAgent)

// Same one-in-flight guard as spawnReviewer, held here for the same reason:
// herdr does not register an agent until it has booted.
const sweeping = new Set()

// Move mission-matching Issues into Planning before a Lead Planner starts, so
// ownership is explicit and a restart cannot spawn a duplicate planner for the
// same cards.
export function missionIssueHandoff(tasksDir, mission, { all = false } = {}) {
  const moved = []
  if (!all && !mission?.id) return moved
  const issues = readBoard(tasksDir).issues.filter((c) => !c.cardOwned && (all || c.mission === mission.id))
  for (const card of issues) {
    const next = moveCard(tasksDir, card.id, 'planning')
    appendFileSync(next.path,
      `\n\n---\n\n**Planner handoff** ${new Date().toISOString()}\n\n` +
      `Lead Planner accepted ownership of this Issue. Await a builder-ready plan in Planned; do not rewrite or requeue directly.\n`)
    moved.push(next.id)
  }
  return moved
}

export async function spawnIssuesSweeper({ project, projectPath, tasksDir, boardRoot, model, engine, manager = false, mission, assignmentForCard }) {
  if (cardRunContext()) throw new Error('Multi-card Planner sweeps are not permitted by explicit card runs')
  assertPromptAllowed(project)
  if (sweeping.has(project)) throw busyError()
  sweeping.add(project)
  try {
    const session = sessionOf(project)
    if (sweeperRunning(await agentsForProject(projectPath, session))) throw busyError()

    const accepted = missionIssueHandoff(tasksDir, mission, { all: !mission?.id })
    const wanted = new Set(accepted)
    const cards = readBoard(tasksDir).planning.filter((c) => wanted.has(c.id))

    if (!cards.length) throw new Error('nothing in Issues')

    const workspace = await agentWorkspaceOr(projectPath, session)
    const created = await tabCreate({
      cwd: projectPath, label: sweepLabel(cards.length), focus: false, workspace, session,
    })
    const paneId = created?.root_pane?.pane_id
    if (!paneId) throw new Error(`tab create returned no pane id: ${JSON.stringify(created)}`)

    await waitForPrompt(paneId, { session })
    let name = agentName('issues', cards[0].id)
    // Same reasoning as spawnReviewer: unbound, so isSpawning() must stay true
    // through deliver(), not just agentStart().
    beginSpawn(paneId)
    try {
      const selected = assignmentForCard?.(cards[0], 'issues')
      const selectedEngine = selected ? { kind: selected.engine, ...(selected.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${selected.reasoning}"`] } : {}) } : engine
      name = (await agentStart({ name, paneId, model: selected?.model ?? model, engine: selectedEngine, timeoutMs: START_TIMEOUT_MS, session }))?.name ?? name
      const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
      try {
        recordUsageStart({
          tasksDir, project, requestId: `plan:${cards.map((c) => c.id).join(',')}`, cardIds: cards.map((c) => c.id),
          role: 'planner', paneId, tabId: created?.tab?.tab_id, model, name, agentSession: agent?.agent_session,
        })
      } catch {}
      await deliver(paneId, issuesSweeperPrompt({ cards, projectPath, boardRoot, tasksDir, manager }), session)
    } catch (err) {
      if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
      throw new Error(`issues sweeper spawn failed: ${err.message}`)
    } finally {
      endSpawn(paneId)
    }

    // Deliberately not bound to a card, same reasoning as the reviewer.
    return { pane_id: paneId, tab_id: created?.tab?.tab_id, model, name, cards: cards.map((c) => c.id) }
  } finally {
    sweeping.delete(project)
  }
}
