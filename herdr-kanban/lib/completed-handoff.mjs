// Release only a positively identified, finished Builder before Git cleanup.
// Its Codex --cd holds the checkout on Windows even with a stable parent shell.
import { readFileSync } from 'node:fs'
import { findCard } from './cards.mjs'
import { readBindings } from './bindings.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { readUsage, recordUsageFinish } from './request-usage.mjs'
import { readDelivery } from './delivery-state.mjs'
import { appendHistory } from './card-history.mjs'
import { agentList, paneRead, paneClose, sessionOf } from './herdr.mjs'
import { readWorktrees, reconcileCompletedWorktrees } from './worktrees.mjs'

export async function reconcileCompletedHandoffs({ tasksDir, project, onlyIds,
  io = { agentList, paneRead, paneClose, recordUsageFinish, reconcile: reconcileCompletedWorktrees } }) {
  const results = [], session = sessionOf(project)
  for (const entry of Object.values(readWorktrees(tasksDir))) {
    if (entry.cleaned || (onlyIds && !onlyIds.includes(entry.cardId))) continue
    const card = findCard(tasksDir, entry.cardId)
    if (!['completed', 'review'].includes(card.column)) continue
    const saved = readWorkflow(tasksDir)[card.id], builder = saved?.builder
    if (builder?.pane_id && (saved.builderRetired?.paneId !== builder.pane_id || saved.builderRetired?.started !== builder.started)) {
      const paneId = builder.pane_id
      const identity = Object.values(readUsage(tasksDir).runs).findLast(r => r.paneId === paneId && r.role === 'builder' && r.cardIds?.length === 1 && r.cardIds[0] === card.id && r.sessionId)?.sessionId
      const matches = a => a?.pane_id === paneId && a.name === builder.name && a.agent_session?.value === identity
      const inventory = await io.agentList(session, { ensureSession: false })
      const agent = inventory.find(a => a.pane_id === paneId)
      if (!identity || !matches(agent)) throw new Error(`${card.id}: finished Builder identity unavailable; preserve checkout`)
      if (agent.agent_status === 'working') { results.push({ id: card.id, status: 'waiting-builder', reason: 'Waiting for Builder handoff turn to finish' }); continue }
      if (agent.agent_status !== 'done') throw new Error(`${card.id}: Builder is not confirmed done; preserve checkout`)
      if (saved.completedStage !== 'working' || Object.values(readBindings(tasksDir)).some(b => b.pane_id === paneId)) throw new Error(`${card.id}: Builder handoff is not complete`)
      const delivery = readDelivery(session, paneId)
      if (delivery && !['confirmed', 'cancelled'].includes(delivery.status)) throw new Error(`${card.id}: unresolved Builder delivery; preserve checkout`)
      const output = await io.paneRead(paneId, session)
      if (!String(output).trim()) throw new Error(`${card.id}: cannot preserve finished output`)
      await io.recordUsageFinish({ tasksDir, paneId, agent, status: 'complete' })
      const history = appendHistory(tasksDir, card.id, { event: 'completed-builder-retirement', builder, sessionId: identity, worktree: entry, card: readFileSync(card.path, 'utf8'), output })
      const current = (await io.agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId)
      if (!matches(current) || current.agent_status !== 'done' || !['completed', 'review'].includes(findCard(tasksDir, card.id).column)) throw new Error(`${card.id}: Builder changed before retirement; preserve checkout`)
      await io.paneClose(paneId, session)
      updateWorkflow(tasksDir, card.id, { builderRetired: { paneId, started: builder.started, sessionId: identity, historyId: history.id, at: history.at } })
    }
    const retired = readWorkflow(tasksDir)[card.id]?.builderRetired
    if (retired && (await io.agentList(session, { ensureSession: false })).some(a => a.pane_id === retired.paneId)) {
      results.push({ id: card.id, status: 'waiting-builder', reason: 'Waiting for retired Builder pane to close' }); continue
    }
    results.push(...io.reconcile({ tasksDir, onlyIds: [card.id] }))
  }
  return results
}
