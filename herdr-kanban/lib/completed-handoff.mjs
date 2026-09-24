// Release only a positively identified, finished Builder before Git cleanup.
// Its Codex --cd holds the checkout on Windows even with a stable parent shell.
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { findCard, moveCard } from './cards.mjs'
import { readBindings } from './bindings.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { readUsage, recordUsageFinish } from './request-usage.mjs'
import { readDelivery } from './delivery-state.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { agentList, paneRead, paneClose, sessionOf } from './herdr.mjs'
import { readWorktrees, reconcileCompletedWorktrees, updateWorktree } from './worktrees.mjs'

// The Builder's recorded check (## Evidence "Check:"), re-run in the card's
// rebased worktree before integration. Anything unrunnable counts as a failure.
export function runRecordedCheck(card, entry) {
  const evidence = readFileSync(card.path, 'utf8').replaceAll('**', '').match(/^## Evidence\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || ''
  const command = evidence.match(/^Check:\s*(.+)$/mi)?.[1]?.trim().replace(/^`+|`+$/g, '')
  if (!command) return Promise.resolve({ ok: false, output: 'no recorded Check: command on the card' })
  const [shell, args] = process.platform === 'win32' ? ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['sh', ['-c', command]]
  return new Promise(done => execFile(shell, args, { cwd: entry.workspacePath, timeout: 600000, windowsHide: true, maxBuffer: 16 << 20 },
    (err, stdout, stderr) => done({ ok: !err, output: `${command}\n${stdout}${stderr}${err && !stdout && !stderr ? err.message : ''}`.slice(-3000) })))
}

// A conflict goes back to a Builder once, with the files and hunks to resolve in
// its own worktree; a second failed resolution asks the operator. Never a loop.
export function returnIntegrationConflict(tasksDir, cardId, { reason, files = [], hunks = '', head }) {
  const entry = readWorktrees(tasksDir)[cardId]
  const failures = (entry.conflictFailures || 0) + 1
  const target = head || entry.rebaseTarget || entry.baseCommit
  updateWorktree(tasksDir, cardId, { state: 'conflict', conflictFailures: failures, reason, rebaseTarget: target })
  const to = failures >= 2 ? 'owner' : 'queue'
  const moved = moveCard(tasksDir, cardId, to)
  const summary = reason.split('\n')[0]
  const diff = hunks ? `\n\n\`\`\`diff\n${hunks}\n\`\`\`` : ''
  writeCurrentFeedback(tasksDir, moved, to === 'owner' ? 'Needs you' : 'Kicked back', to === 'owner'
    ? `${cardId} still does not integrate with master after ${failures} tries (${summary}). Its commit and worktree are kept at ${entry.worktreePath}. Should an agent try again with a narrower change, or will you resolve the conflict yourself?`
    : `Integration conflict with master: ${summary}. Resolve it in your own worktree ${entry.worktreePath}: git rebase --onto ${target} ${entry.baseCommit}, fix ${files.join(', ') || 'the conflicting files'}, keep exactly one card commit, re-run your check, then hkb done.${diff}`)
  // Not an 'implementation' correction: that would demand the retired Builder pane back.
  updateWorkflow(tasksDir, cardId, { correction: { category: 'integration', note: summary }, operational: null })
  return { id: cardId, status: 'returned', to, reason: summary }
}

export async function reconcileCompletedHandoffs({ tasksDir, project, onlyIds,
  io = { agentList, paneRead, paneClose, recordUsageFinish, reconcile: reconcileCompletedWorktrees, runCheck: runRecordedCheck } }) {
  const results = [], session = sessionOf(project)
  for (const entry of Object.values(readWorktrees(tasksDir))) {
    // One card's problem must never freeze the whole project poll.
    try {
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
      if (!['done', 'idle'].includes(agent.agent_status)) throw new Error(`${card.id}: Builder is not confirmed done; preserve checkout`)
      if (saved.completedStage !== 'working' || Object.values(readBindings(tasksDir)).some(b => b.pane_id === paneId)) throw new Error(`${card.id}: Builder handoff is not complete`)
      const delivery = readDelivery(session, paneId)
      if (delivery && !['confirmed', 'cancelled'].includes(delivery.status)) throw new Error(`${card.id}: unresolved Builder delivery; preserve checkout`)
      const output = await io.paneRead(paneId, session)
      if (!String(output).trim()) throw new Error(`${card.id}: cannot preserve finished output`)
      await io.recordUsageFinish({ tasksDir, paneId, agent, status: 'complete' })
      const history = appendHistory(tasksDir, card.id, { event: 'completed-builder-retirement', builder, sessionId: identity, worktree: entry, card: readFileSync(card.path, 'utf8'), output })
      const current = (await io.agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId)
      if (!matches(current) || !['done', 'idle'].includes(current.agent_status) || !['completed', 'review'].includes(findCard(tasksDir, card.id).column)) throw new Error(`${card.id}: Builder changed before retirement; preserve checkout`)
      await io.paneClose(paneId, session)
      updateWorkflow(tasksDir, card.id, { builderRetired: { paneId, started: builder.started, sessionId: identity, historyId: history.id, at: history.at } })
    }
    const retired = readWorkflow(tasksDir)[card.id]?.builderRetired
    if (retired && (await io.agentList(session, { ensureSession: false })).some(a => a.pane_id === retired.paneId)) {
      results.push({ id: card.id, status: 'waiting-builder', reason: 'Waiting for retired Builder pane to close' }); continue
    }
    const batch = readWorktrees(tasksDir)[card.id]?.state === 'rebased' ? [{ id: card.id, status: 'rebased' }] : io.reconcile({ tasksDir, onlyIds: [card.id] })
    for (const result of batch) {
      if (result.status === 'conflict') { results.push(returnIntegrationConflict(tasksDir, card.id, result)); continue }
      if (result.status !== 'rebased') { results.push(result); continue }
      const check = await (io.runCheck ?? runRecordedCheck)(card, readWorktrees(tasksDir)[card.id])
      appendHistory(tasksDir, card.id, { event: 'rebase-check', ok: check.ok, output: check.output })
      if (!check.ok) { results.push(returnIntegrationConflict(tasksDir, card.id, { reason: `rebased cleanly onto master, but the recorded check failed: ${check.output}` })); continue }
      updateWorktree(tasksDir, card.id, { state: 'ready', reason: null })
      results.push(...io.reconcile({ tasksDir, onlyIds: [card.id] }))
    }
    } catch (err) { results.push({ id: entry.cardId, status: 'held', reason: err.message }) }
  }
  return results
}
