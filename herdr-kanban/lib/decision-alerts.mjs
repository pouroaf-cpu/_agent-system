import { formatNZTime, formatNZText } from './nz-time.mjs'
import { readBoard } from './cards.mjs'
import { appendHistory, managerInbox } from './card-history.mjs'
import { postInbox } from './inbox.mjs'
import { readWorkflow, updateWorkflowWhen } from './workflow-state.mjs'

// A Planner's decision wait (an `[decision]` issue, an open owner ask) was asked of the manager chat
// once when it was set (askManager). Nobody answering it left it silent for hours (I1318 sat 9 h in
// Planning, 2026-10-15), so it is asked again every few hours, up to a cap. The manager chat only:
// no phone page for a decision wait (operator, 2026-10-10). `board` waits go to the Kanban Manager and
// `finder` holds are a different hold, so neither repeats here.
export const DECISION_REALERT = { everyMs: 3 * 60 * 60 * 1000, cap: 4 }

const due = (wait, now) => {
  if (!wait?.decision || wait.board || wait.finder) return false
  if ((wait.realerts ?? 0) >= DECISION_REALERT.cap) return false
  const last = Date.parse(wait.alertedAt ?? wait.since ?? '')
  return Number.isFinite(last) && now - last >= DECISION_REALERT.everyMs
}

// Returns the card ids asked again and any inbox write errors. The state is saved before the line is
// written, like board alerts: a failed write is reported and is not sent again straight away.
export function realertDecisionWaits({ tasksDir, now = Date.now(), append = postInbox }) {
  const waiting = Object.entries(readWorkflow(tasksDir)).filter(([, state]) => due(state?.waitFor, now))
  if (!waiting.length) return { ids: [], errors: [] }
  const planning = new Set((readBoard(tasksDir).planning ?? []).map(card => card.id))
  const target = managerInbox(tasksDir)
  const ids = [], errors = []
  for (const [id, state] of waiting) {
    if (!planning.has(id)) continue
    const before = state.waitFor
    const count = (before.realerts ?? 0) + 1
    // Only while this same wait still stands: an operator answer (operatorRetry) or a new wait is never overwritten.
    const saved = updateWorkflowWhen(tasksDir, id, record => record?.waitFor?.since === before.since && due(record.waitFor, now),
      { waitFor: { ...before, alertedAt: new Date(now).toISOString(), realerts: count } })
    if (!saved) continue
    const question = String(before.why ?? '').replace(/\s+/g, ' ').trim().slice(0, 400)
    appendHistory(tasksDir, id, { event: 'decision-realert', stage: 'planning', count, note: question })
    ids.push(id)
    try {
      if (!target) throw new Error('no manager inbox for this project')
      append(target.inbox, `- ${formatNZTime(now)} ASK ${target.project} ${id} (planning): still waiting on a decision (reminder ${count} of ${DECISION_REALERT.cap}): ${formatNZText(question)}\n`, now, 'AS')
    } catch (err) { errors.push(err) }
  }
  return { ids, errors }
}
