// Safety net. A live card whose lane and file have not changed for `minutes`,
// with no agent working on it and no allowed wait, gets one automatic recovery;
// if that does not move it, it goes to Owner with one plain-language question.
// Every detection is one line in TASKS/stalls.log so new stall types show up.
// It never deletes or resets work: it only lifts a hold, asks for a fresh
// Planner, or moves the card to Owner.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { readBoard, moveCard, columnByKey, waitingOnPrerequisites } from './cards.mjs'
import { readBindings } from './bindings.mjs'
import { readCardPlanners, requestPlannerCorrection } from './card-planner.mjs'
import { plannersStarting } from './planner-state.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { appendHistory, writeCurrentFeedback, laneEnteredAt, lastBlockerLanded } from './card-history.mjs'
import { readUsage } from './request-usage.mjs'
import { readDelivery } from './delivery-state.mjs'
import { sessionOf } from './herdr.mjs'
import { readWorktrees } from './worktrees.mjs'
import { unmetBlockers } from './autospawn.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'
import { CARD_ID } from './ids.mjs'
import { isRetryHold, inBackoff } from './transient.mjs'

const oneLine = (s, max = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)
const ms = at => Date.parse(at || '') || 0
const ROLE = { planning: 'planner', issues: 'planner', queue: 'builder', working: 'builder', review: 'reviewer' }

// Live agents bound to a card, busiest first: its Planner, Builder and Reviewer panes.
function boundAgents(id, { agents, bindings, planners, workflow, claims }) {
  const panes = [['planner', planners[id]?.paneId], ['builder', bindings[id]?.pane_id], ['builder', workflow[id]?.builder?.pane_id],
    ...claims.filter(c => c.cards.includes(id)).map(c => ['reviewer', c.paneId])]
  return panes.flatMap(([role, pane]) => agents.filter(a => pane && a.pane_id === pane).map(agent => ({ role, agent })))
    .sort((a, b) => (b.agent.agent_status === 'working') - (a.agent.agent_status === 'working'))
}
const openClaims = (claims, tasksDir) => claims.filter(c => !c.closedAt && resolve(c.tasksDir) === resolve(tasksDir))

// Lane timer data for the board: when each card entered its lane (history, else file
// mtime) and whether a live agent bound to it is working right now.
export function laneTimes({ tasksDir, board, agents = [], claims = [], planners = readCardPlanners(tasksDir), workflow = readWorkflow(tasksDir), bindings = readBindings(tasksDir) }) {
  const ctx = { agents, bindings, planners, workflow, claims: openClaims(claims, tasksDir) }
  const result = {}
  for (const card of ['planning', 'queue', 'working', 'review', 'completed'].flatMap(column => board[column] || [])) {
    const [bound] = boundAgents(card.id, ctx)
    result[card.id] = {
      since: new Date(laneEnteredAt(tasksDir, card.id, card.column) ?? card.mtime).toISOString(),
      agentActive: bound?.agent.agent_status === 'working',
      agentRole: bound?.role ?? null,
      agentName: bound?.agent.name ?? null,
    }
  }
  return result
}

// Durable heartbeat of the last poll that could act (herdr up, not paused, agents allowed,
// breaker closed). Returns when the latest gap in it ended: herdr down, host asleep, board
// down or a global pause left no such poll, and that time is not a stall (audit 2026-09-26 F3).
const GAP_MS = 2 * 60000
export function recordHealthyPoll(tasksDir, now = Date.now()) {
  const file = join(tasksDir, '.board-heartbeat.json')
  let prev = {}
  try { prev = JSON.parse(readFileSync(file, 'utf8')) } catch { /* first poll: no gap known */ }
  const gapEndedAt = prev.at && now - ms(prev.at) > GAP_MS ? new Date(now).toISOString() : prev.gapEndedAt
  writeFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), gapEndedAt }))
  return gapEndedAt
}

// The stall clock is durable so a board restart never resets it: the latest of the
// card file changing, the card entering its lane, an agent starting or finishing on it
// (usage runs, bindings), the last recovery, and the last time this watchdog saw an
// agent working or an allowed wait (workflow stallResetAt, written at most once a minute).
// `resumedAt` (the project's last Pause/Start) and `gapEndedAt` (recordHealthyPoll) restart
// every clock: time the board could not act is not a stall.
export function checkStalls({ tasksDir, agents = [], claims = [], holds = {}, minutes = 20, builderSlotsFree = 1, plannerSlotsFree = 1, reviewerSlotsFree = 1, paused = false, holdsKnown = true, resumedAt, gapEndedAt, now = Date.now() }) {
  const board = readBoard(tasksDir)
  const bindings = readBindings(tasksDir), planners = readCardPlanners(tasksDir), workflow = readWorkflow(tasksDir), registry = readWorktrees(tasksDir)
  const mine = openClaims(claims, tasksDir)
  const runs = Object.values(readUsage(tasksDir).runs || {})
  const ctx = { agents, bindings, planners, workflow, claims: mine }
  const busy = id => !!bindings[id]?.spawning || mine.some(c => c.cards.includes(id) && c.phase === 'starting') ||
    boundAgents(id, ctx).some(b => b.agent.agent_status === 'working')
  const reset = id => { if (now - ms(workflow[id]?.stallResetAt) >= 60000) workflow[id] = updateWorkflow(tasksDir, id, { stallResetAt: new Date(now).toISOString() }) }
  const sinceOf = card => Math.max(card.mtime, ms(resumedAt), ms(gapEndedAt), laneEnteredAt(tasksDir, card.id, card.column) || 0, ms(bindings[card.id]?.started),
    ms(workflow[card.id]?.stallRecovery?.at), ms(workflow[card.id]?.stallResetAt),
    ...runs.filter(r => r.cardIds?.includes(card.id)).flatMap(r => [ms(r.start?.at), ms(r.finish?.at)]))

  const byId = new Map(Object.keys(board).filter(k => k !== 'archive').flatMap(key => board[key]).map(c => [c.id, c]))
  const idle = new Map()
  for (const card of byId.values()) {
    if (['pou', 'owner'].includes(card.column)) continue
    if (busy(card.id)) { reset(card.id); continue }
    const since = Math.max(sinceOf(card), lastBlockerLanded(tasksDir, card, board, registry))
    if (now - since >= minutes * 60000) idle.set(card.id, { card, since })
  }

  // Allowed waits: capacity, an unfinished prerequisite, or files held by another live
  // card. Only the stuck prerequisite is escalated, never the cards queued behind it.
  // Same rule as autospawn: the holder may sit in any live lane, Owner included.
  const heldByLiveCard = (card) => {
    const holder = String(holds[card.id] || '').match(new RegExp(String.raw`^files busy, (?:likely )?held by (${CARD_ID})`))?.[1]
    return !!holder && holder !== card.id && byId.has(holder)
  }
  const allowedWait = (card) => {
    if (paused) return true // paused (low disk, operator or release): nothing may start, so nothing is stuck (I393/I398/I401/I404 went to Owner mid-release, 2026-09-28)
    // A transient failure backing off (a start, an install, a timed-out check) waits for its retry.
    if (isRetryHold(holds[card.id]) || inBackoff(workflow[card.id]?.startFailure, now)) return true
    if (card.column === 'queue') {
      // The scheduler's own 'slots full' counts too: a slot that freed since its pass is not a
      // stall, the card starts next poll (Injectbuddy I656 went to Owner 10 s after it, 2026-10-02).
      if (builderSlotsFree <= 0 || holds[card.id] === 'slots full') return true
      // Before the first scheduler pass after a restart the file-lock holds are unknown
      // (Injectbuddy I211 went to Owner at 04:08 while waiting on public/app.js).
      if (!holdsKnown) return true
      const blockers = unmetBlockers(card, board, registry)
      if (blockers.length) return blockers.every(id => byId.has(id)) // a missing prerequisite can never finish
      return heldByLiveCard(card) || String(holds[card.id] || '').startsWith('installing dependencies in ')
    }
    // A plan check waits on the same file locks as a Builder start (Tradeflow TF136, 2026-10-03).
    if (card.column === 'planned' && heldByLiveCard(card)) return true
    // A card waits in Planning/Planned until its Blocked-by prerequisites land (TF44).
    if (['planning', 'planned'].includes(card.column) && waitingOnPrerequisites(card, board, registry).length) return true
    if (card.column === 'planned' && reviewerSlotsFree <= 0 && !workflow[card.id]?.operational) return true
    // A Planner's `hkb wait` for a file or card that does not exist yet.
    if (card.column === 'planning' && workflow[card.id]?.waitFor) return true
    // Waiting for one of the capped Planner slots (card-planner maxPlanners), or its turn while Planners keep starting.
    if (card.column === 'planning' && (plannerSlotsFree <= 0 || plannersStarting(planners, now, card.id)) && !agents.some(a => a.pane_id === planners[card.id]?.paneId)) return true
    // Legacy Completed cards with no board worktree wait for the operator's disposition by design.
    if (card.column === 'completed' && !registry[card.id]) return true
    return card.column === 'review' && reviewerSlotsFree <= 0 && !workflow[card.id]?.operational
  }

  // When nothing was recorded, say what the board can see instead of "none recorded".
  // An idle agent whose prompt never went in (e.g. a paste left unsubmitted) is a failed
  // delivery, not an agent that finished without a handoff.
  const session = sessionOf(basename(resolve(tasksDir, '..')))
  const live = p => agents.some(a => a.pane_id === p && a.agent_status !== 'done')
  const idleAs = (role, p) => ['uncertain', 'failed'].includes(readDelivery(session, p)?.status) ? `its ${role} ${p} is idle and never accepted its prompt (failed delivery)` : `its ${role} ${p} is idle without a handoff`
  const observed = (card) => {
    if (['planning', 'issues'].includes(card.column)) {
      const p = planners[card.id]?.paneId
      if (!p) return `no Planner was ever started for this card${card.cardOwned || card.audit ? '' : ' (legacy card format, not card-owned)'}`
      return live(p) ? idleAs('Planner', p) : `its Planner ${p} is no longer running and did not hand off`
    }
    if (['queue', 'working'].includes(card.column)) {
      const p = bindings[card.id]?.pane_id || workflow[card.id]?.builder?.pane_id
      if (!p) return 'no Builder was ever started for this card'
      return live(p) ? idleAs('Builder', p) : `its Builder ${p} is no longer running`
    }
    if (card.column === 'review' && !mine.some(c => c.cards.includes(card.id))) return 'no Reviewer has claimed this card'
    return 'no agent, binding or hold is recorded for this card'
  }

  const stalls = []
  for (const { card, since } of idle.values()) {
    // Never started and nothing recorded: the card is waiting its turn (priority order,
    // a hold missing from this poll's snapshot), which only the board can fix, so it gets
    // three windows before the operator is asked (Injectbuddy I182/I193 went to Owner twice).
    const started = runs.some(r => r.cardIds?.includes(card.id)) || (['planning', 'issues'].includes(card.column) ? planners[card.id]?.paneId : (bindings[card.id]?.pane_id || workflow[card.id]?.builder?.pane_id))
    if (['planning', 'queue'].includes(card.column) && !started && !card.blockedBy?.length && !workflow[card.id]?.operational && now - since < 3 * minutes * 60000) continue
    if (allowedWait(card)) { reset(card.id); continue }
    const at = new Date(now).toISOString(), mins = Math.round((now - since) / 60000)
    const lane = columnByKey(card.column).label
    // One retry per lane visit. A visit starts when the card enters the lane; an agent
    // appending to the card is not a new visit (Tradeflow T-38 looped in Review that way).
    const last = workflow[card.id]?.stallRecovery
    const enteredAt = laneEnteredAt(tasksDir, card.id, card.column) || 0
    const tried = last?.column === card.column && (last.enteredAt != null ? last.enteredAt === enteredAt : last.mtime === card.mtime)
    // A workflow-limit hold never clears by retrying, so it goes straight to Owner with its reason.
    const role = ROLE[card.column]
    const limit = role && checkWorkflowLimits(tasksDir, card.id, role)
    const hold = oneLine(limit || workflow[card.id]?.operational?.reason || holds[card.id] || registry[card.id]?.reason || (tried && last.hold))
    const reason = `no change for ${mins}m and no agent working${hold ? `; last hold: ${hold}` : ''}`
    let action = tried || limit ? '' : recover(tasksDir, card, workflow[card.id])
    if (action) {
      updateWorkflow(tasksDir, card.id, { stallRecovery: { column: card.column, mtime: card.mtime, enteredAt, at, action, hold } })
      appendHistory(tasksDir, card.id, { event: 'stall-recovery', stage: card.column, reason, action })
    } else if (card.column === 'review' && tried && !limit) {
      // A review that stalls again after its retry is a defect to diagnose, not an operator
      // question: the Planner takes it, and its own 3-blocker cap reaches Owner (Tradeflow T-38).
      action = 'sent to the Planner'
      const moved = moveCard(tasksDir, card.id, 'planning')
      requestPlannerCorrection(tasksDir, card.id)
      writeCurrentFeedback(tasksDir, moved, 'Review feedback', `The review stalled twice (${hold || 'no verdict recorded'}). Diagnose the latest Reviewer evidence on this card and plan the fix.`)
    } else {
      action = 'moved to Owner'
      const moved = moveCard(tasksDir, card.id, 'owner')
      writeCurrentFeedback(tasksDir, moved, 'Needs you', `${card.id} sat in ${lane} for ${mins} minutes with no agent working on it. Last hold/error: ${hold || `none recorded; the board observed that ${observed(card)}`}. ${limit ? 'Dragging it back resets its workflow-limit counters.' : tried ? 'The automatic retry already ran and did not move it.' : 'No automatic recovery applies.'} All work is preserved. Should the board try again (drag it back to ${lane}), or do you want to change or cancel it?`)
    }
    appendFileSync(join(tasksDir, 'stalls.log'), `${at}\t${card.id}\t${card.column}\t${reason}\t${action}\n`)
    stalls.push({ id: card.id, column: card.column, reason, action })
  }
  return stalls
}

// The matching automatic recovery, tried once per lane: lift the hold so the
// board's normal path retries, and give Planning/Issues cards a fresh Planner.
// A stopped Builder belongs to T-11's recoverBuilderNoHandoff, which already runs
// every poll; if the card is still stuck, that recovery has had its turn.
function recover(tasksDir, card, saved) {
  if (/Builder fallback|without a valid Builder handoff/i.test(saved?.operational?.reason || '')) return ''
  const actions = []
  if (saved?.operational) {
    updateWorkflow(tasksDir, card.id, { operational: null })
    actions.push('lifted the operational hold so the board retries once')
  }
  if (['planning', 'issues'].includes(card.column) && requestPlannerCorrection(tasksDir, card.id)) actions.push('asked for a fresh Planner')
  return actions.join('; ')
}
