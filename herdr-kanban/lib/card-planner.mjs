import { existsSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { readCardPlanners, saveCardPlanners as save, assertPlannerAssignment } from './planner-state.mjs'
export { readCardPlanners } from './planner-state.mjs'
import { readBoard, moveCard, findCard, needsBrowser, awaitsOperatorApproval, askForApproval, convertLegacyCard, waitingOnPrerequisites } from './cards.mjs'
import { readWorktrees } from './worktrees.mjs'
import { agentList, agentWorkspaceOr, tabCreate, waitForPrompt, agentStart, paneClose, paneRead, paneSendKeys, sessionOf } from './herdr.mjs'
import { deliver, START_TIMEOUT_MS, startFailed, recordStartFailure, startRetryHold, stagedInput, submitStaged } from './spawn.mjs'
import { agentName, issuesSweeperPrompt } from './prompt.mjs'
import { agentRole } from './ids.mjs'
import { recordUsageStart, recordUsageFinish } from './request-usage.mjs'
import { recoveryState } from './recovery.mjs'
import { controlState, assertPromptAllowed } from './project-control.mjs'
import { cardRunContext, assertCardRunSelection, stopCardRun, bindCardRunAssignment } from './card-run.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'
import { operationalHold, recordOperationalFailure, updateWorkflow, readWorkflow } from './workflow-state.mjs'
import { appendHistory, writeCurrentFeedback, laneBeforeOwner } from './card-history.mjs'
import { readDelivery, saveDelivery } from './delivery-state.mjs'
import { usageLimit, blockEngine, quotaHold, engineKind } from './quota.mjs'
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
  delete owner.deliveryFailures
  save(dir, owners)
  return true
}
// Dragging a card out of Owner is the operator's "try again": clear the held failure,
// restart the workflow-limit counters, and give Planning/Issues a fresh Planner.
export function operatorRetry(tasksDir, cardId, to) {
  updateWorkflow(tasksDir, cardId, { operational: null, limitsResetAt: new Date().toISOString(), limitWarning: null, startFailure: null, plannerIssues: null })
  if (['planning', 'issues'].includes(to)) requestPlannerCorrection(tasksDir, cardId)
}
// Board Approve button on a Pou or Owner card: record the decision, add the operator-only
// investigation marker when that is all the plan waits on, then retry the card in
// the lane it left (Planning for investigation approvals or when history is silent).
const APPROVED = '**Investigation approved:** yes'
export function operatorApprove(tasksDir, cardId, now = new Date()) {
  const card = findCard(tasksDir, cardId)
  if (!['pou', 'owner'].includes(card.column)) throw new Error(`${card.id} is in ${card.column}; Approve works only on Pou or Owner cards`)
  let text = readFileSync(card.path, 'utf8')
  const investigation = awaitsOperatorApproval(text)
  if (investigation) {
    const head = text.split(/^## Approved brief/m)[0]
    const existing = head.match(/^\*\*Investigation approved:\*\*[^\n]*$/im)
    const readiness = head.match(/^\*\*Plan readiness:\*\*[^\n]*$/im)
    text = existing ? text.replace(existing[0], APPROVED)
      : readiness ? text.replace(readiness[0], `${readiness[0]}\n${APPROVED}`)
      : text.replace(/^## Approved brief/m, `${APPROVED}\n\n$&`)
  }
  writeFileSync(card.path, `${text}\n\n---\n\n**Operator decision** ${now.toISOString()}\n\nApproved by operator from board\n`)
  const from = laneBeforeOwner(tasksDir, card.id)
  // Working means an agent is on it; a retried build starts from Queue.
  const lane = investigation || !from || ['planning', 'owner', 'archive'].includes(from) ? 'planning' : from === 'working' ? 'queue' : from
  let moved
  // A lane gate (plan check, Builder PASS) that refuses the card sends it to Planning.
  try { moved = moveCard(tasksDir, card.id, lane) } catch (err) { if (lane === 'planning') throw err; moved = moveCard(tasksDir, card.id, 'planning') }
  operatorRetry(tasksDir, card.id, moved.column)
  return { card: moved, investigation }
}
export const busyPlanners = agents => agents.filter(a => agentRole(a.name) === 'p' && !['idle', 'done'].includes(a.agent_status)).length
const PLANNER_NO_HANDOFF = /^Planner session \S+ ended without a valid handoff/
const defaultIO = { agentList, agentWorkspaceOr, tabCreate, waitForPrompt, agentStart, paneClose, paneRead, paneSendKeys, deliver, recordUsageStart, recordUsageFinish }
export async function runCardPlanner({ project, projectPath, tasksDir, boardRoot, model, engine, mission, onlyIds, assignmentForCard, onHold, onCardError, io = defaultIO, now = Date.now(), handoffGraceMs = 120000, maxPlanners = 4 }) {
  if (cardRunContext()) assertCardRunSelection(project, onlyIds || [], 'planner')
  if (io === defaultIO && controlState(project).paused && !cardRunContext()) return null
  const { agentList, agentWorkspaceOr, tabCreate, waitForPrompt, agentStart, paneClose, paneRead: readPane = paneRead, paneSendKeys: sendKeys = paneSendKeys, deliver, recordUsageStart, recordUsageFinish } = io
  if (busy.has(project)) return null
  busy.add(project)
  try {
    const session = sessionOf(project)
    const agents = await agentList(session, { ensureSession: false })
    let launched = 0 // Planners started in this pass are not in `agents` yet
    const owners = readCardPlanners(tasksDir)
    const board = readBoard(tasksDir)
    // Save the old Planner's output, revoke its pane and close it. The card, its
    // saved correction and all counters carry over to the fresh Planner.
    const plannerEngine = card => assignmentForCard?.(card, 'planning')?.engine ?? engineKind(engine)
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
    // A failed agent start or a prompt left unsubmitted: close that pane now; the next
    // poll retries once with a fresh tab, and a second failure in a row goes to Owner.
    const failStart = async (card, owner, error) => {
      if (!error.startFailed) throw error
      await paneClose(owner.paneId, session).catch(() => {})
      owner.revokedPaneIds = [...new Set([...(owner.revokedPaneIds || []), owner.paneId])]
      owner.submitted = false
      owner.startRetry = true
      save(tasksDir, owners)
      recordStartFailure(tasksDir, card.id, 'planner', error.message)
      throw error
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
        ...(previous ? { previousPaneId: previous.paneId, correctionRequestedAt: previous.correctionRequestedAt, handoffRetried: previous.handoffRetried, correctionRounds: previous.correctionRounds, failureFingerprint: previous.failureFingerprint, sameFailureCount: previous.sameFailureCount, diagnosticUsed: previous.diagnosticUsed, diagnosticFingerprint: previous.diagnosticFingerprint, diagnosticRound: previous.diagnosticRound, noHandoffCount: previous.noHandoffCount >= 2 ? 0 : previous.noHandoffCount, noHandoffReason: previous.noHandoffReason, deliveryFailures: previous.deliveryFailures } : {}),
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
      owner.name = (await agentStart({ name: owner.name, paneId, browser: needsBrowser(card), model: owner.model, engine: selected ? { kind: selected.engine, ...(selected.engine === 'codex' ? { reasoningArgs: ['-c', `model_reasoning_effort="${selected.reasoning}"`] } : {}) } : engine, timeoutMs: START_TIMEOUT_MS, session }).catch(error => failStart(card, owner, startFailed(error))))?.name ?? owner.name
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
      await deliver(owner.paneId, issuesSweeperPrompt({ cards: [card], projectPath, boardRoot, tasksDir, plannerAssignment: owner.assignmentId }) + ' Plan only this card; do not delegate. For a returned card, resolve the recorded blocker before requeueing. If a check needs dependencies or a local server, supply a concrete setup/start command for the isolated card checkout and its port; do not assume localhost is running or substitute another checkout. Prefer a runnable check script over fragile shell quoting. Preserve the acceptance criteria. Stop after the handoff; the board closes this session and sends any correction to a fresh Planner.' + (owner.reconciliationHistoryId ? ` Recovery provenance: ${tasksDir.replaceAll('\\', '/')}/.history/${card.id}.jsonl entry ${owner.reconciliationHistoryId}. Preserve saved work, commits, locks and counters. Resolve scope decisions explicitly; do not implement, integrate, or claim acceptance. This recovery run stops after planning for inspection.` : ''), session).catch(error => failStart(card, owner, error))
      const after = (await agentList(session, { ensureSession: false })).find(a => a.pane_id === owner.paneId)
      if (agent?.state_change_seq != null && after?.state_change_seq === agent.state_change_seq && ['idle', 'done'].includes(after.agent_status)) {
        throw new Error('planner prompt produced no observed state change')
      }
      assertPlannerAssignment(tasksDir, card.id, owner)
      if (owner.deliveryFailures) { delete owner.deliveryFailures; save(tasksDir, owners) }
      updateWorkflow(tasksDir, card.id, { operational: null, startFailure: null })
      return true
    }
    // Retirement preserves the ledger and card; only the agent pane is closed. A card
    // past Planning never goes back to this session (corrections get a fresh one), and
    // each idle Codex Planner holds its MCP servers: 27 of them overloaded herdr (Tradeflow).
    for (const card of Object.entries(board).filter(([lane]) => !['planning', 'issues'].includes(lane)).flatMap(([, cards]) => cards)) {
      if (cardRunContext()) continue
      const owner = owners[card.id]
      if (!owner || owner.closedAt) continue
      const agent = agents.find(a => a.pane_id === owner.paneId)
      if (agent && !['idle', 'done'].includes(agent.agent_status)) continue
      await recordUsageFinish({ tasksDir, paneId: owner.paneId, agent, status: 'complete' })
      if (agent) await paneClose(owner.paneId, session)
      owner.closedAt = new Date().toISOString()
      owner.submitted = false
      owner.revokedPaneIds = [...new Set([...(owner.revokedPaneIds || []), owner.paneId])]
      save(tasksDir, owners)
    }
    // Owner is an explicit stop, including older technical-exhaustion cards.
    for (let card of [...board.issues, ...board.planning]) {
      try {
      if (onlyIds && !onlyIds.includes(card.id)) continue
      // Two live copies of one id hold only that card, never the whole run (Tradeflow T-42).
      try { findCard(tasksDir, card.id) } catch (err) {
        if (!err.ambiguous || cardRunContext()) throw err
        onHold?.(err)
        continue
      }
      // A legacy card in Planning has no Planner path: convert it, then plan it normally.
      if (!card.cardOwned && !card.audit) {
        if (card.column !== 'planning') continue
        card = convertLegacyCard(tasksDir, card)
      }
      // Waiting only on an operator-only approval: ask the operator, never re-prompt (T-148).
      if (awaitsOperatorApproval(readFileSync(card.path, 'utf8'))) {
        askForApproval(tasksDir, card)
        stopCardRun(project, card.id, 'Waiting for investigation approval')
        continue
      }
      let owner = owners[card.id]
      // Blocked-by prerequisites still unfinished: planning now only produces
      // "not build-ready yet" and loops to Owner (TF44). Wait without a Planner;
      // a Planner that already reported stays idle and is not a no-handoff.
      const waitingFor = card.column === 'planning' && !cardRunContext() && waitingOnPrerequisites(card, board, readWorktrees(tasksDir))
      if (waitingFor?.length) {
        const busyPlanner = owner && agents.some(a => a.pane_id === owner.paneId && !['idle', 'done'].includes(a.agent_status))
        if (owner?.submitted && !busyPlanner) {
          owner.submitted = false
          delete owner.inactiveSince
          save(tasksDir, owners)
          appendHistory(tasksDir, card.id, { event: 'planner-prerequisite-wait', stage: 'planning', waitingFor })
        }
        continue
      }
      // An uncertain delivery never resolves by waiting (T-41). Once its pane is gone,
      // or idle past the handoff grace, it failed: retire that Planner, start a fresh one.
      const delivery = owner?.paneId && owner.lifecycle === 'active' && !cardRunContext() && readDelivery(session, owner.paneId)
      const deliveryAgent = delivery && agents.find(a => a.pane_id === owner.paneId)
      const deliveryFailed = delivery?.status === 'uncertain' && (!deliveryAgent || (['idle', 'done'].includes(deliveryAgent.agent_status) && now - Date.parse(delivery.at || 0) >= handoffGraceMs))
      if (deliveryFailed) {
        saveDelivery(session, owner.paneId, { ...delivery, status: 'failed', reason: 'Uncertain delivery resolved as failed; a fresh Planner takes over' })
        appendHistory(tasksDir, card.id, { event: 'planner-delivery-failed', stage: card.column, paneId: owner.paneId, pane: deliveryAgent || null, deliveryAt: delivery.at })
        updateWorkflow(tasksDir, card.id, { operational: null })
        owner.submitted = false
        delete owner.inactiveSince
        if (!deliveryAgent) {
          owner.revokedPaneIds = [...new Set([...(owner.revokedPaneIds || []), owner.paneId])]
          await paneClose(owner.paneId, session).catch(() => {})
        }
        owner.deliveryFailures = (owner.deliveryFailures || 0) + 1
        save(tasksDir, owners)
        // Two fresh Planners in a row never took their prompt (e.g. the agent exits at
        // start): another launch would loop, so ask the operator once.
        if (owner.deliveryFailures >= 2) {
          const moved = moveCard(tasksDir, card.id, 'owner')
          writeCurrentFeedback(tasksDir, moved, 'Needs you', `Two Planner sessions in a row for ${card.id} never accepted their prompt (last: ${owner.paneId}, agent ${deliveryAgent ? deliveryAgent.agent_status : 'not running'}). The agent may be exiting at start in this project; check that pane's output. Drag the card back to Planning to try again.`)
          continue
        }
      }
      const held = !deliveryFailed && operationalHold(tasksDir, card, projectPath)
      // A Planner that stopped without a handoff is not a reason to park the card
      // in Issues (older boards did; T-8, 2026-09-24): lift that hold and recover.
      const plannerHold = !!held && card.column === 'issues' && !!owner && PLANNER_NO_HANDOFF.test(held) && !cardRunContext()
      if (held && !plannerHold) continue
      if (checkWorkflowLimits(tasksDir, card.id, 'planner')) continue
      if (startRetryHold(readWorkflow(tasksDir)[card.id], 'planner', now)) continue // a transient start failure backs off
      if (mission?.id && card.mission !== mission.id) continue
      if (plannerHold) {
        updateWorkflow(tasksDir, card.id, { operational: null })
        owner.noHandoffCount = (owner.noHandoffCount || 0) + 1
        owner.noHandoffReason ||= held
        save(tasksDir, owners)
        if (owner.noHandoffCount >= 2) { askOwnerAfterNoHandoffs(card, owner); continue }
      }
      let fresh = plannerHold || deliveryFailed || !!owner?.startRetry
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
        if (['pou', 'owner'].includes(card.column)) continue
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
      // A Planner asking an interactive question (Codex shows "blocked") waits for an
      // answer nobody gives: past the grace it is the operator's question, so the card
      // goes to Owner with it (Injectbuddy I176/I181 sat blocked overnight).
      if (agent?.agent_status === 'blocked' && owner?.submitted) {
        owner.blockedSince ??= new Date(now).toISOString()
        save(tasksDir, owners)
        if (now - Date.parse(owner.blockedSince) >= handoffGraceMs) {
          const question = String(await readPane(owner.paneId, session).catch(() => '')).trim().slice(-1500)
          await retire(card, owner, agent, 'Planner asked an interactive question')
          owner.submitted = false
          delete owner.blockedSince
          save(tasksDir, owners)
          const moved = moveCard(tasksDir, card.id, 'owner')
          writeCurrentFeedback(tasksDir, moved, 'Needs you', `The Planner for ${card.id} stopped to ask a question instead of handing off. Its last screen:\n\n${question}\n\nAnswer on the card, then drag it back to Planning.`)
        }
        continue
      }
      if (agent && !['idle', 'done'].includes(agent.agent_status)) {
        if (owner.inactiveSince) { delete owner.inactiveSince; save(tasksDir, owners) }
        if (owner.blockedSince) { delete owner.blockedSince; save(tasksDir, owners) }
        continue
      }
      if (card.column === 'planning' && owner?.submitted) {
        owner.inactiveSince ??= new Date(now).toISOString()
        save(tasksDir, owners)
        if (now - Date.parse(owner.inactiveSince) < handoffGraceMs) continue
        const evidence = readPane ? String(await readPane(owner.paneId, session).catch(() => '')).trim().slice(-4000) : ''
        // The prompt still on the input line was never submitted: finish the delivery,
        // never count a no-handoff (Injectbuddy I149 went to Owner this way).
        const prompt = readDelivery(session, owner.paneId)?.text
        if (agent && stagedInput(evidence, prompt)) {
          const result = await submitStaged(owner.paneId, prompt, session, { read: readPane, sendKeys, list: agentList, confirmMs: 10000 })
          if (result === 'staged') await failStart(card, owner, startFailed(new Error(`Planner prompt stayed unsubmitted in ${owner.paneId} after 3 Enter presses`)))
          delete owner.inactiveSince
          save(tasksDir, owners)
          continue
        }
        // The engine ran out of usage: block it board-wide and wait in Planning. Not a
        // no-handoff; a fresh Planner starts once the limit resets.
        const limit = usageLimit(evidence, now)
        if (limit) {
          const kind = owner.engine || plannerEngine(card)
          blockEngine(boardRoot, kind, limit.until, now)
          appendHistory(tasksDir, card.id, { event: 'engine-usage-limit', stage: 'planning', engine: kind, until: new Date(limit.until).toISOString(), evidence })
          await retire(card, owner, agent, `${kind} usage limit`)
          owner.submitted = false
          owner.closedAt = new Date(now).toISOString()
          delete owner.inactiveSince
          owners[card.id] = owner // the save above swapped in a fresh copy; no launch follows to carry these
          save(tasksDir, owners)
          continue
        }
        if (cardRunContext()) throw new Error('Planner ended without handoff; explicit run stopped')
        // A prompt ending is not a handoff. Save the evidence, then retry once with
        // a fresh Planner; a second no-handoff asks the operator (Owner).
        const reason = `Planner session ${owner.paneId} ended without a valid handoff after ${handoffGraceMs}ms; observed status=${agent?.agent_status || 'missing'}, state_change_seq=${agent?.state_change_seq ?? 'unknown'}`
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
      if (['pou', 'owner'].includes(card.column)) continue
      let spawnedNewAgent = false
      // Corrections and retries go to a fresh session, never back into an idle
      // (possibly day-old) one. An uncertain delivery keeps its pane for inspection.
      const pending = owner && agent && readDelivery(session, owner.paneId)
      if (owner && agent && (!pending || ['confirmed', 'cancelled', 'failed'].includes(pending.status))) {
        await retire(card, owner, agent, deliveryFailed ? 'Planner prompt delivery failed' : fresh ? 'Planner ended without a handoff' : 'Correction goes to a fresh Planner')
        agent = null
        fresh = true
      }
      // Concurrent Planners per project are capped: 28 audit cards started 11 Codex Planners
      // at once and pinned the CPU (Injectbuddy, 2026-09-25). The rest wait for a later poll.
      if ((!owner || !agent) && !cardRunContext() && busyPlanners(agents) + launched >= maxPlanners) continue
      if ((!owner || !agent) && quotaHold(boardRoot, plannerEngine(card), now)) continue // its engine is out of usage
      if (!owner || !agent) {
        const previous = owner
        // A Planner the board closed after its handoff is not a missing replacement.
        if (previous?.closedAt) fresh = true
        if (previous && !fresh && previous.replacementAttempts >= 1) {
          escalate(new Error('Replacement planner is missing'))
          continue
        }
        try {
          ;({ owner, agent } = await launch(card, previous, { fresh }))
          spawnedNewAgent = true
          launched++
        } catch (error) {
          if (error.paused || error.startFailed) throw error
          recordOperationalFailure(tasksDir, card, error.message, projectPath)
          escalate(error)
          throw error
        }
      }
      try {
        await submit(card, owner, agent)
      } catch (error) {
        if (error.paused || error.startFailed) throw error // failStart already closed the pane and counted it
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
          if (!replacementError.startFailed) escalate(replacementError)
          throw replacementError
        }
      }
      return { cards: [card.id], pane_id: owner.paneId, spawnedNewAgent }
      } catch (error) {
        // One card's failure must not end the pass: it handles one card per poll, so a card
        // that keeps failing starved every card after it (Injectbuddy I192/I193 went to Owner
        // with no Planner ever started). Explicit runs and pause still stop here.
        if (error.paused || cardRunContext() || !onCardError) throw error
        onCardError(card, error)
        continue
      }
    }
    return null
  } finally { busy.delete(project) }
}
