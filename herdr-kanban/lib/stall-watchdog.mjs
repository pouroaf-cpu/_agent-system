// Safety net. A live card whose lane and file have not changed for `minutes`,
// with no agent working on it and no allowed wait, gets one automatic recovery;
// if that does not move it, it goes to Owner with one plain-language question.
// Every detection is one line in TASKS/stalls.log so new stall types show up.
// It never deletes or resets work: it only lifts a hold, asks for a fresh
// Planner, or moves the card to Owner.
import { appendFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readBoard, moveCard, columnByKey } from './cards.mjs'
import { readBindings } from './bindings.mjs'
import { readCardPlanners, requestPlannerCorrection } from './card-planner.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { readWorktrees } from './worktrees.mjs'
import { unmetBlockers } from './autospawn.mjs'
import { checkWorkflowLimits } from './workflow-limits.mjs'

// ponytail: in-memory clock, so a restart gives every card a fresh window.
const seen = new Map() // `${tasksDir}|${id}` -> { column, mtime, since }

const oneLine = (s, max = 300) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max)

export function checkStalls({ tasksDir, agents = [], claims = [], holds = {}, minutes = 20, builderSlotsFree = 1, reviewerSlotsFree = 1, now = Date.now() }) {
  const board = readBoard(tasksDir)
  const bindings = readBindings(tasksDir), planners = readCardPlanners(tasksDir), workflow = readWorkflow(tasksDir), registry = readWorktrees(tasksDir)
  const mine = claims.filter(c => !c.closedAt && resolve(c.tasksDir) === resolve(tasksDir))
  const working = new Set(agents.filter(a => a.agent_status === 'working').map(a => a.pane_id))
  const busy = id => !!bindings[id]?.spawning || mine.some(c => c.cards.includes(id) && c.phase === 'starting') ||
    [bindings[id]?.pane_id, planners[id]?.paneId, workflow[id]?.builder?.pane_id, ...mine.filter(c => c.cards.includes(id)).map(c => c.paneId)].some(p => p && working.has(p))

  const byId = new Map(Object.entries(board).filter(([k]) => k !== 'archive').flatMap(([, cards]) => cards).map(c => [c.id, c]))
  const idle = new Map()
  for (const card of byId.values()) {
    if (card.column === 'owner') continue
    const key = `${tasksDir}|${card.id}`, prev = seen.get(key)
    const since = !prev || prev.column !== card.column || prev.mtime !== card.mtime || busy(card.id) ? now : prev.since
    seen.set(key, { column: card.column, mtime: card.mtime, since })
    if (now - since >= minutes * 60000) idle.set(card.id, card)
  }

  // Allowed waits: capacity, an unfinished prerequisite, or files held by another live
  // card. Only the stuck prerequisite is escalated, never the cards queued behind it.
  const allowedWait = (card) => {
    if (card.column === 'queue') {
      if (builderSlotsFree <= 0) return true
      const blockers = unmetBlockers(card, board, registry)
      if (blockers.length) return blockers.every(id => byId.has(id)) // a missing prerequisite can never finish
      return /held by [A-Z]+-?\d+/i.test(String(holds[card.id] || ''))
    }
    // Legacy Completed cards with no board worktree wait for the operator's disposition by design.
    if (card.column === 'completed' && !registry[card.id]) return true
    return card.column === 'review' && reviewerSlotsFree <= 0 && !workflow[card.id]?.operational
  }

  const stalls = []
  for (const card of idle.values()) {
    const entry = seen.get(`${tasksDir}|${card.id}`)
    if (allowedWait(card)) { entry.since = now; continue }
    const at = new Date(now).toISOString(), mins = Math.round((now - entry.since) / 60000)
    const lane = columnByKey(card.column).label
    // One retry per lane visit: a card file that changed since the retry is a new visit.
    const last = workflow[card.id]?.stallRecovery
    const tried = last?.column === card.column && last.mtime === card.mtime
    // A workflow-limit hold never clears by retrying, so it goes straight to Owner with its reason.
    const role = { planning: 'planner', issues: 'planner', queue: 'builder', working: 'builder', review: 'reviewer' }[card.column]
    const limit = role && checkWorkflowLimits(tasksDir, card.id, role)
    const hold = oneLine(limit || workflow[card.id]?.operational?.reason || holds[card.id] || registry[card.id]?.reason || (tried && last.hold))
    const reason = `no change for ${mins}m and no agent working${hold ? `; last hold: ${hold}` : ''}`
    let action = tried || limit ? '' : recover(tasksDir, card, workflow[card.id])
    if (action) {
      updateWorkflow(tasksDir, card.id, { stallRecovery: { column: card.column, mtime: card.mtime, at, action, hold } })
      appendHistory(tasksDir, card.id, { event: 'stall-recovery', stage: card.column, reason, action })
      entry.since = now // give the recovery a full window
    } else {
      action = 'moved to Owner'
      const moved = moveCard(tasksDir, card.id, 'owner')
      writeCurrentFeedback(tasksDir, moved, 'Needs you', `${card.id} sat in ${lane} for ${mins} minutes with no agent working on it. Last hold/error: ${hold || 'none recorded'}. ${limit ? 'Dragging it back resets its workflow-limit counters.' : tried ? 'The automatic retry already ran and did not move it.' : 'No automatic recovery applies.'} All work is preserved. Should the board try again (drag it back to ${lane}), or do you want to change or cancel it?`)
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
