import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readCardPlanners, saveCardPlanners as save, assertPlannerAssignment } from './planner-state.mjs'
export { readCardPlanners } from './planner-state.mjs'
import { readBoard, moveCard, findCard } from './cards.mjs'
import { agentList, agentWorkspaceOr, tabCreate, waitForPrompt, agentStart, paneClose, paneRead, sessionOf } from './herdr.mjs'
import { deliver, START_TIMEOUT_MS } from './spawn.mjs'
import { agentName, issuesSweeperPrompt } from './prompt.mjs'
import { recordUsageStart, recordUsageFinish } from './request-usage.mjs'
import { recoveryState } from './recovery.mjs'
import { controlState, assertPromptAllowed } from './project-control.mjs'
import { cardRunContext, assertCardRunSelection, stopCardRun, bindCardRunAssignment } from './card-run.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'
import { operationalHold, recordOperationalFailure, updateWorkflow } from './workflow-state.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { readDelivery } from './delivery-state.mjs'
const busy = new Set()
export function correctionFingerprint(text) {
  const last = text.split(/\*\*(?:Kicked back|Spawn failed|Review feedback)\*\*[^\n]*\n/).at(-1)
  return createHash('sha256').update(last.split(/\*\*Needs you\*\*/)[0].replace(/\d{4}-\d\d-\d\dT[^\s]+/g, '').trim()).digest('hex')
}

export function requestPlannerCorrection(dir, cardId) {
  const owners = readCardPlanners(dir)
  const owner = owners[String(cardId).toUpperCase()]
  if (!owner || ['retired', 'retiring'].includes(owner.lifecycle)) return false
  owner.submitted = false
  owner.replacementAttempts = 0
  owner.correctionRequestedAt = new Date().toISOString()
  delete owner.error
  delete owner.handoffRetried
  delete owner.inactiveSince
  delete owner.noHandoffCount
  save(dir, owners)
  return true
}
const PLANNER_NO_HANDOFF = /^Planner session \S+ ended without a valid handoff/
const defaultIO = { agentList, agentWorkspaceOr, tabCreate, waitForPrompt, agentStart, paneClose, paneRead, deliver, recordUsageStart, recordUsageFinish }
export async function runCardPlanner({ project, projectPath, tasksDir, boardRoot, model, engine, mission, onlyIds, assignmentForCard, io = defaultIO, now = Date.now(), handoffGraceMs = 120000 }) {
  if (cardRunContext()) assertCardRunSelection(project, onlyIds || [], 'planner')
  if (io === defaultIO && controlState(project).paused && !cardRunContext()) return null
  const { agentList, agentWorkspaceOr, tabCreate, waitForPrompt, agentStart, paneClose, paneRead: readPane = paneRead, deliver, recordUsageStart, recordUsageFinish } = io
  if (busy.has(project)) return null
  busy.add(project)
  try {
    const session = sessionOf(project)
    const agents = await agentList(session, { ensureSession: false })
    const owners = readCardPlanners(tasksDir)
    const board = readBoard(tasksDir)
    // Save the old Planner's output, revoke its pane and close it. The card, its
    // saved correction and all counters carry over to the fresh Planner.
    const retire = async (card, owner, agent, reason) => {
      const output = readPane ? String(await readPane(owner.paneId, session).catch(() => '')).slice(-4000) : ''
      appendHistory(tasksDir, card.id, { event: 'planner-retired', stage: 'planning', reason, assignment: owner, pane: agent || null, output })
      await recordUsageFinish({ tasksDir, paneId: owner.paneId, agent, status: 'complete' })
      owner.revokedPaneIds = [...new Set([...(owner.revokedPaneIds || []), owner.paneId])]
      if (agent) await paneClose(owner.paneId, session).catch(() => {})
    }
    // Two Planners in a row stopped without a handoff: stop retrying and ask once.
    const askOwnerAfterNoHandoffs = (card, owner) => {
      const moved = moveCard(tasksDir, card.id, 'owner')
      writeCurrentFeedback(tasksDir, moved, 'Needs you', `Two Planner sessions in a row stopped without handing off ${card.id} (last: ${String(owner.noHandoffReason || 'no handoff').split('; pane evidence')[0]}). Their output is saved in the card history. Should the board try planning it again (drag it back to Planning), or do you want to change or cancel the brief?`)
    }
    // fresh: a deliberate new session for a correction or no-handoff retry, not a
    // replacement for a failed launch, so it does not use up the replacement.
    const launch = async (card, previous = null, { fresh = false } = {}) => {
      assertCardRunSelection(project, [card.id], 'planner')
      if (io === defaultIO) assertPromptAllowed(project)
      const workspace = await agentWorkspaceOr(projectPath, session)
      const created = await tabCreate({ cwd: projectPath, label: `${card.id} Planner`, focus: false, workspace, session })
      const paneId = created?.root_pane?.pane_id
      if (!paneId) throw new Error('Planner launch returned no pane')
      const owner = owners[card.id] = {
        assignmentId: randomUUID(), lifecycle: 'active',
        revokedPaneIds: previous?.revokedPaneIds || [],
        reconciliationHistoryId: previous?.reconciliationHistoryId,
        paneId,
        name: agentName('planner', card.id),
        createdAt: new Date().toISOString(),
        submitted: false,
        replacementAttempts: (previous?.replacementAttempts || 0) + (previous && !previous.recoveryReady && !fresh ? 1 : 0),
        // Two no-handoffs already sent the card to Owner; a new run means the operator returned it.
        ...(previous ? { previousPaneId: previous.paneId, correctionRequestedAt: previous.correctionRequestedAt, handoffRetried: previous.handoffRetried, correctionRounds: previous.correctionRounds, failureFingerprint: previous.failureFingerprint, sameFailureCount: previous.sameFailureCount, diagnosticUsed: previous.diagnosticUsed, diagnosticFingerprint: previous.diagnosticFingerprint, diagnosticRound: previous.diagnosticRound, noHandoffCount: previous.noHandoffCount >= 2 ? 0 : previous.noHandoffCount, noHandoffReason: previous.noHandoffReason } : {}),
      }
      save(tasksDir, owners)
      await waitForPrompt(paneId, { session })
      assertPlannerAssignment(tasksDir, card.id, owner)
      bindCardRunAssignment(project, [card.id], 'planner', paneId)
      const selected = assignmentForCard?.(card, 'planning')
      owner.model = selected?.model ?? model
      owner.engine = selected?.engine ?? (typeof engine === 'string' ? engine : engine?.kind)
      owner.reasoning = selected?.reasoning
      save(tasksDir, owners)
      owner.name = (await agentStart({ name: owner.name, paneId, model: owner.model, engine: selected ? { kind: selected.engine, ...(selected.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${selected.reasoning}"`] } : {}) } : engine, timeoutMs: START_TIMEOUT_MS, session }))?.name ?? owner.name
      return { owner, agent: (await agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId) }
    }
    const submit = async (card, owner, agent) => {
      assertCardRunSelection(project, [card.id], 'planner')
      assertPlannerAssignment(tasksDir, card.id, owner)
      // Launch can take a minute; an operator may have moved the card meanwhile.
      if (findCard(tasksDir, card.id).column !== 'planning') return false
      bindCardRunAssignment(project, [card.id], 'planner', owner.paneId)
      await recordUsageFinish({ tasksDir, paneId: owner.paneId, agent, status: 'complete' })
      recordUsageStart({ tasksDir, project, requestId: card.id, cardIds: [card.id], role: 'planner', paneId: owner.paneId, name: owner.name, model: owner.model || model, agentSession: agent?.agent_session })
      owner.submitted = true
      owner.submittedAt = new Date(now).toISOString()
      delete owner.inactiveSince
      save(tasksDir, owners)
      assertPlannerAssignment(tasksDir, card.id, owner)
      await deliver(owner.paneId, issuesSweeperPrompt({ cards: [card], projectPath, boardRoot, tasksDir, plannerAssignment: owner.assignmentId }) + ' Plan only this card; do not delegate. For a returned card, resolve the recorded blocker before requeueing. If a check needs dependencies or a local server, supply a concrete setup/start command for the isolated card checkout and its port; do not assume localhost is running or substitute another checkout. Prefer a runnable check script over fragile shell quoting. Preserve the acceptance criteria. Remain idle after the plan. The board will return corrections to this session and retire it on archive.' + (owner.reconciliationHistoryId ? ` Recovery provenance: ${tasksDir.replaceAll('\\', '/')}/.history/${card.id}.jsonl entry ${owner.reconciliationHistoryId}. Preserve saved work, commits, locks and counters. Resolve scope decisions explicitly; do not implement, integrate, or claim acceptance. This recovery run stops after planning for inspection.` : ''), session)
      const after = (await agentList(session, { ensureSession: false })).find(a => a.pane_id === owner.paneId)
      if (agent?.state_change_seq != null && after?.state_change_seq === agent.state_change_seq && ['idle', 'done'].includes(after.agent_status)) {
        throw new Error('planner prompt produced no observed state change')
      }
      assertPlannerAssignment(tasksDir, card.id, owner)
      updateWorkflow(tasksDir, card.id, { operational: null })
      return true
    }
    // Retirement preserves the ledger and card; only the agent pane is closed.
    for (const card of board.archive) {
      if (cardRunContext()) continue
      const owner = owners[card.id]
      if (!owner || owner.closedAt) continue
      const agent = agents.find(a => a.pane_id === owner.paneId)
      if (agent && !['idle', 'done'].includes(agent.agent_status)) continue
      await recordUsageFinish({ tasksDir, paneId: owner.paneId, agent, status: 'complete' })
      if (agent) await paneClose(owner.paneId, session)
      owner.closedAt = new Date().toISOString()
      save(tasksDir, owners)
    }
    // Owner is an explicit stop, including older technical-exhaustion cards.
    for (let card of [...board.issues, ...board.planning]) {
      if (onlyIds && !onlyIds.includes(card.id)) continue
      if (!card.cardOwned && !card.audit) continue
      let owner = owners[card.id]
      const held = operationalHold(tasksDir, card, projectPath)
      // A Planner that stopped without a handoff is not a reason to park the card
      // in Issues (older boards did; T-8, 2026-09-24): lift that hold and recover.
      const plannerHold = !!held && card.column === 'issues' && !!owner && PLANNER_NO_HANDOFF.test(held) && !cardRunContext()
      if (held && !plannerHold) continue
      if (checkWorkflowLimits(tasksDir, card.id, 'planner')) continue
      if (mission?.id && card.mission !== mission.id) continue
      if (plannerHold) {
        updateWorkflow(tasksDir, card.id, { operational: null })
        owner.noHandoffCount = (owner.noHandoffCount || 0) + 1
        owner.noHandoffReason ||= held
        save(tasksDir, owners)
        if (owner.noHandoffCount >= 2) { askOwnerAfterNoHandoffs(card, owner); continue }
      }
      let fresh = plannerHold
      if (owner?.lifecycle === 'retiring') continue
      if (owner?.lifecycle === 'retired') {
        if (!owner.recoveryReady || !cardRunContext()) continue
        const recovered = await launch(card, owner)
        await submit(card, recovered.owner, recovered.agent)
        return { cards: [card.id], pane_id: recovered.owner.paneId, spawnedNewAgent: true }
      }
      // Every fresh Issues transition starts the same bounded correction cycle.
      if (card.column === 'issues' && owner) {
        owner.correctionRounds = (owner.correctionRounds || 0) + 1
        const fingerprint = correctionFingerprint(readFileSync(card.path, 'utf8'))
        owner.sameFailureCount = owner.failureFingerprint === fingerprint ? (owner.sameFailureCount || 0) + 1 : 1
        owner.failureFingerprint = fingerprint
        owner.submitted = false
        owner.replacementAttempts = 0
        owner.correctionRequestedAt = new Date(now).toISOString()
        delete owner.error
        delete owner.inactiveSince
        delete owner.handoffRetried
        if (!plannerHold) delete owner.noHandoffCount // a new correction round
        save(tasksDir, owners)
        // A Planner going quiet is operational, not a failed plan: no failed return.
        card = moveCard(tasksDir, card.id, 'planning', { intake: plannerHold })
        if (card.column === 'owner') continue
      }
      const escalate = (error) => {
        if (cardRunContext()) { stopCardRun(project, card.id, error.message); throw error }
        if (error.paused) return
        const current = owners[card.id] || (owners[card.id] = { submitted: false })
        current.error = error.message
        current.retryAfter = now + 15 * 60 * 1000
        current.submitted = false
        save(tasksDir, owners)
        const moved = moveCard(tasksDir, card.id, 'planning')
        appendFileSync(moved.path, `\n\n**Technical recovery** ${new Date(now).toISOString()}\n\n${error.message}. Card and worktree preserved. Planner recovery retries after a 15-minute cooldown; diagnose the failure before another build, do not repeat the same plan.\n`)
      }
      if (owner?.error) {
        if (now < (owner.retryAfter || 0)) continue
        owner.replacementAttempts = 0
        owner.submitted = false
        delete owner.error
        delete owner.handoffRetried
        delete owner.inactiveSince
        save(tasksDir, owners)
      }
      if ((owner?.sameFailureCount >= 3 && owner.diagnosticFingerprint !== owner.failureFingerprint) || (owner?.correctionRounds >= 12 && (owner.diagnosticRound || 0) < owner.correctionRounds - 11)) {
        owner.diagnosticFingerprint = owner.failureFingerprint
        owner.diagnosticRound = owner.correctionRounds
        appendFileSync(card.path, '\n\n**Diagnostic recovery** Repeated failure: investigate the root cause across previous attempts, record why they failed and a materially changed approach before requeueing. Do not weaken acceptance criteria or transfer a technical failure to Owner.\n')
        save(tasksDir, owners)
      }
      let agent = owner && agents.find(a => a.pane_id === owner.paneId)
      if (agent && !['idle', 'done'].includes(agent.agent_status)) {
        if (owner.inactiveSince) { delete owner.inactiveSince; save(tasksDir, owners) }
        continue
      }
      if (card.column === 'planning' && owner?.submitted) {
        owner.inactiveSince ??= new Date(now).toISOString()
        save(tasksDir, owners)
        if (now - Date.parse(owner.inactiveSince) < handoffGraceMs) continue
        if (cardRunContext()) throw new Error('Planner ended without handoff; explicit run stopped')
        // A prompt ending is not a handoff. Save the evidence, then retry once with
        // a fresh Planner; a second no-handoff asks the operator (Owner).
        const reason = `Planner session ${owner.paneId} ended without a valid handoff after ${handoffGraceMs}ms; observed status=${agent?.agent_status || 'missing'}, state_change_seq=${agent?.state_change_seq ?? 'unknown'}`
        const evidence = readPane ? String(await readPane(owner.paneId, session).catch(() => '')).trim().slice(-4000) : ''
        const detail = evidence ? `${reason}; pane evidence: ${evidence}` : `${reason}; pane evidence unavailable`
        appendHistory(tasksDir, card.id, { event: 'planner-no-handoff', stage: 'planning', reason: detail, assignment: owner, pane: agent || null, evidence })
        owner.submitted = false
        owner.noHandoffAt = new Date(now).toISOString()
        owner.noHandoffReason = reason
        owner.noHandoffCount = (owner.noHandoffCount || 0) + 1
        delete owner.inactiveSince
        save(tasksDir, owners)
        if (owner.noHandoffCount >= 2) { askOwnerAfterNoHandoffs(card, owner); continue }
        appendFileSync(card.path, `\n\n**Planner fallback** ${new Date(now).toISOString()}\n\n${reason}. A fresh Planner is taking over this card; the previous session's output is saved in the card history.\n`)
        fresh = true
      }
      if (card.column === 'issues') card = moveCard(tasksDir, card.id, 'planning')
      if (card.column === 'owner') continue
      let spawnedNewAgent = false
      // Corrections and retries go to a fresh session, never back into an idle
      // (possibly day-old) one. An uncertain delivery keeps its pane for inspection.
      const pending = owner && agent && readDelivery(session, owner.paneId)
      if (owner && agent && (!pending || ['confirmed', 'cancelled'].includes(pending.status))) {
        await retire(card, owner, agent, fresh ? 'Planner ended without a handoff' : 'Correction goes to a fresh Planner')
        agent = null
        fresh = true
      }
      if (!owner || !agent) {
        const previous = owner
        if (previous && !fresh && previous.replacementAttempts >= 1) {
          escalate(new Error('Replacement planner is missing'))
          continue
        }
        try {
          ;({ owner, agent } = await launch(card, previous, { fresh }))
          spawnedNewAgent = true
        } catch (error) {
          if (error.paused) throw error
          recordOperationalFailure(tasksDir, card, error.message, projectPath)
          escalate(error)
          throw error
        }
      }
      try {
        await submit(card, owner, agent)
      } catch (error) {
        if (error.paused) throw error
        if (cardRunContext()) { stopCardRun(project, card.id, error.message); throw error }
        if (error.preservePane) {
          recordOperationalFailure(tasksDir, card, error.message, projectPath)
          throw error
        }
        if (owner.replacementAttempts >= 1) {
          escalate(error)
          throw error
        }
        await paneClose(owner.paneId, session).catch(() => {})
        const previous = owner
        try {
          ;({ owner, agent } = await launch(card, previous))
          spawnedNewAgent = true
          await submit(card, owner, agent)
        } catch (replacementError) {
          escalate(replacementError)
          throw replacementError
        }
      }
      return { cards: [card.id], pane_id: owner.paneId, spawnedNewAgent }
    }
    return null
  } finally { busy.delete(project) }
}
