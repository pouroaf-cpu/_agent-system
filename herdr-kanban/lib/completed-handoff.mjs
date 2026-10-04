// Release only a positively identified, finished Builder before Git cleanup.
// Its Codex --cd holds the checkout on Windows even with a stable parent shell.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { findCard, moveCard, appendReviewPass } from './cards.mjs'
import { readBindings, unbind } from './bindings.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { readUsage, recordUsageFinish, agentSessionId } from './request-usage.mjs'
import { readDelivery } from './delivery-state.mjs'
import { isHeadless } from './headless.mjs'
import { appendHistory, writeCurrentFeedback, builderHandedOff } from './card-history.mjs'
import { agentList, paneRead, paneClose, sessionOf } from './herdr.mjs'
import { readWorktrees, reconcileCompletedWorktrees, updateWorktree, rebaseCompletedOntoIntegration } from './worktrees.mjs'
import { isTransient, nextRetry, retryHold, killTree } from './transient.mjs'

// The Builder's recorded check (## Evidence "Check:"), re-run in the card's
// rebased worktree before integration. Anything unrunnable counts as a failure.
export function runRecordedCheck(card, entry) {
  const evidence = readFileSync(card.path, 'utf8').replaceAll('**', '').match(/^## Evidence\s*\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || ''
  const command = evidence.match(/^Check:\s*(.+)$/mi)?.[1]?.trim().replace(/^`+|`+$/g, '')
  if (!command) return Promise.resolve({ ok: false, output: 'no recorded Check: command on the card' })
  return runShell(command, entry.workspacePath, 600000).then(r => ({ ok: r.ok, timedOut: r.timedOut, output: r.output.slice(-3000) }))
}

// Runs a shell command; on timeout the whole process tree is killed (Windows
// test runners spawn grandchildren that would otherwise hold the pipes open).
export function runShell(command, cwd, timeout) {
  const [shell, args] = process.platform === 'win32' ? ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]] : ['sh', ['-c', command]]
  return new Promise(done => {
    let timedOut = false
    const child = execFile(shell, args, { cwd, windowsHide: true, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      clearTimeout(timer)
      done({ ok: !err && !timedOut, timedOut, output: `${command}\n${stdout}${stderr}${timedOut ? `\ntimed out after ${timeout / 1000}s` : err && !stdout && !stderr ? err.message : ''}` })
    })
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid) }, timeout)
  })
}

// A check that ran out of time under load is retried with backoff, never returned to the
// Builder as a failure to fix. Null once the budget is spent: the caller fails it as today.
function checkTimedOut(tasksDir, cardId, what, now) {
  const retry = nextRetry(readWorkflow(tasksDir)[cardId]?.integrationRetry, now)
  if (retry.exhausted) return null
  const reason = retryHold(`${what} timed out (machine under load?)`, retry.nextAt)
  updateWorkflow(tasksDir, cardId, { integrationRetry: { since: retry.since, tries: retry.tries, nextAt: retry.nextAt, reason } })
  return { id: cardId, status: 'held', reason }
}

// Project integrationCheck (board.config.json projectSettings): the card commit,
// rebased onto current master in its own worktree, must pass it before the pick.
// Null means go ahead and integrate; otherwise the card went back.
async function gateIntegration(tasksDir, card, command, io, now) {
  const up = io.rebase(tasksDir, card.id)
  if (!up) return null
  if (up.status === 'conflict') return returnIntegrationConflict(tasksDir, card.id, up)
  const entry = readWorktrees(tasksDir)[card.id]
  if (entry.integrationChecked === up.commit) return null
  const check = await io.runIntegrationCheck(command, entry.workspacePath, 300000)
  mkdirSync(join(tasksDir, '.evidence'), { recursive: true })
  const evidence = join(tasksDir, '.evidence', `${card.id}-integration-check-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
  writeFileSync(evidence, `cwd: ${entry.workspacePath}\ncommit: ${up.commit}\nresult: ${check.ok ? 'PASS' : 'FAIL'}\n\n${check.output}\n`)
  appendHistory(tasksDir, card.id, { event: 'integration-check', ok: check.ok, command, commit: up.commit, evidence })
  const timedOut = !check.ok && isTransient(check) && checkTimedOut(tasksDir, card.id, `integration check ${command}`, now)
  if (timedOut) return timedOut
  if (!check.ok) return returnIntegrationConflict(tasksDir, card.id, { reason: `integration check ${command} failed on current master (full output: ${evidence})`, output: check.output.slice(-3000) })
  updateWorktree(tasksDir, card.id, { integrationChecked: up.commit })
  return null
}

// A conflict goes back to a Builder with the files and hunks to resolve in its own worktree.
// A second rebase conflict goes back once more to start fresh on the new base and re-apply
// the change (what the Injectbuddy chat did by hand for I387, I388, I390); a third asks the
// operator. A failed integration check still asks after two. Never a loop.
export function returnIntegrationConflict(tasksDir, cardId, { reason, files = [], hunks = '', head, output }) {
  const entry = readWorktrees(tasksDir)[cardId]
  const failures = (entry.conflictFailures || 0) + 1
  const target = head || entry.rebaseTarget || entry.baseCommit
  updateWorktree(tasksDir, cardId, { state: 'conflict', conflictFailures: failures, reason, rebaseTarget: target })
  const to = failures >= (output ? 2 : 3) ? 'owner' : 'queue'
  const moved = moveCard(tasksDir, cardId, to)
  const summary = reason.split('\n')[0]
  const diff = hunks ? `\n\n\`\`\`diff\n${hunks}\n\`\`\`` : ''
  const log = output ? `\n\n\`\`\`text\n${output}\n\`\`\`` : ''
  const checkoutOverride = "For this return, your worktree is expected at the card's earlier commit or base; this overrides any plan prerequisite or check requiring a clean checkout on current integration HEAD until the rebase/reset is done, then the plan's checks apply again."
  writeCurrentFeedback(tasksDir, moved, to === 'owner' ? 'Needs you' : 'Kicked back', to === 'owner'
    ? `${cardId} still does not integrate with master after ${failures} tries (${summary}). Its commit and worktree are kept at ${entry.worktreePath}. Should an agent try again with a narrower change, or will you fix it yourself?`
    : output ? `${summary}. Your worktree ${entry.worktreePath} is already rebased onto current master: fix the failures there, keep exactly one card commit, re-run the check, then hkb done.${log}`
    : failures >= 2 ? `Integration conflict with master again: ${summary}. Stop resolving it and start fresh on the new base. ${checkoutOverride} In your worktree ${entry.worktreePath}: git rebase --abort if one is in progress, git branch kanban-backup/${cardId}-${failures} HEAD, git reset --hard ${target}, then re-apply the same change by hand using git show kanban-backup/${cardId}-${failures} as the reference. In shared list files add only your own entry at the end; leave other entries and shared helpers alone unless the card needs them. Keep exactly one card commit, run your check once, then hkb done.${diff}`
    : `Integration conflict with master: ${summary}. ${checkoutOverride} Resolve it in your own worktree ${entry.worktreePath}: git rebase --onto ${target} ${entry.baseCommit}, fix ${files.join(', ') || 'the conflicting files'}, keep exactly one card commit, re-run your check, then hkb done.${diff}`)
  // Not an 'implementation' correction: that would demand the retired Builder pane back.
  updateWorkflow(tasksDir, cardId, { correction: { category: 'integration', note: summary }, operational: null, integrationRetry: null })
  return { id: cardId, status: 'returned', to, reason: summary }
}

export async function reconcileCompletedHandoffs({ tasksDir, project, onlyIds, integrationCheck, now = Date.now(),
  io = { agentList, paneRead, paneClose, recordUsageFinish, reconcile: reconcileCompletedWorktrees, runCheck: runRecordedCheck } }) {
  io = { rebase: rebaseCompletedOntoIntegration, runIntegrationCheck: runShell, ...io }
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
      const runs = Object.values(readUsage(tasksDir).runs)
      let identity = runs.findLast(r => r.paneId === paneId && r.role === 'builder' && r.cardIds?.length === 1 && r.cardIds[0] === card.id && r.sessionId)?.sessionId
      const inventory = await io.agentList(session, { ensureSession: false })
      const agent = inventory.find(a => a.pane_id === paneId)
      // A replacement Builder started in the same worktree can be recorded with the
      // previous Builder's session (herdr detects Codex sessions by working folder).
      // A recorded session that also belongs to another pane is stale: trust the live
      // agent at this board-named pane instead (Injectbuddy T-148).
      if (identity && runs.some(r => r.sessionId === identity && r.paneId !== paneId) && agent?.name === builder.name) identity = agentSessionId(agent?.agent_session?.value ?? agent?.agent_session)
      // Claude runs record no session id at start (herdr learns it later), so every Claude-built
      // card held here and went to Owner (Injectbuddy I265, 2026-09-26). Same trust as above.
      if (!identity && agent?.name === builder.name) identity = agentSessionId(agent?.agent_session?.value ?? agent?.agent_session)
      const matches = a => a?.pane_id === paneId && a.name === builder.name && agentSessionId(a?.agent_session?.value ?? a?.agent_session) === identity
      // The handoff already landed and the pane is gone (closed while the card sat in Owner,
      // Tradeflow T-38): there is nothing left to preserve or close, so it counts as retired.
      if (!agent && saved.completedStage === 'working' && !Object.values(readBindings(tasksDir)).some(b => b.pane_id === paneId)) {
        updateWorkflow(tasksDir, card.id, { builderRetired: { paneId, started: builder.started, sessionId: identity || null, at: new Date().toISOString(), note: 'pane already closed' } })
      } else {
      if (!identity || !matches(agent)) throw new Error(`${card.id}: finished Builder identity unavailable; preserve checkout`)
      if (agent.agent_status === 'working') { results.push({ id: card.id, status: 'waiting-builder', reason: 'Waiting for Builder handoff turn to finish' }); continue }
      if (!['done', 'idle'].includes(agent.agent_status)) throw new Error(`${card.id}: Builder is not confirmed done; preserve checkout`)
      if (saved.completedStage !== 'working' || Object.values(readBindings(tasksDir)).some(b => b.pane_id === paneId)) {
        // hkb done recorded its handoff but stopped before the stage and unbind (Tradeflow T-43):
        // the idle Builder is finished, so complete those steps here instead of holding for Owner.
        if (!builderHandedOff(tasksDir, card.id)) throw new Error(`${card.id}: Builder handoff is not complete`)
        updateWorkflow(tasksDir, card.id, { completedStage: 'working', ...(card.column === 'completed' ? { completedAt: new Date().toISOString() } : {}) })
        for (const [id, b] of Object.entries(readBindings(tasksDir))) if (b.pane_id === paneId) unbind(tasksDir, id)
      }
      const delivery = readDelivery(session, paneId)
      // A completed hkb done proves the prompt arrived: an 'uncertain' mark from a slow start
      // under load must not hold the merge forever (Tradeflow TF71 went to Owner).
      if (delivery && !['confirmed', 'cancelled', 'uncertain'].includes(delivery.status) && !(isHeadless(paneId) && delivery.status === 'launching' && builderHandedOff(tasksDir, card.id))) throw new Error(`${card.id}: unresolved Builder delivery; preserve checkout`)
      const output = await io.paneRead(paneId, session)
      if (!String(output).trim()) throw new Error(`${card.id}: cannot preserve finished output`)
      await io.recordUsageFinish({ tasksDir, paneId, agent, status: 'complete' })
      const history = appendHistory(tasksDir, card.id, { event: 'completed-builder-retirement', builder, sessionId: identity, worktree: entry, card: readFileSync(card.path, 'utf8'), output })
      const current = (await io.agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId)
      if (!matches(current) || !['done', 'idle'].includes(current.agent_status) || !['completed', 'review'].includes(findCard(tasksDir, card.id).column)) throw new Error(`${card.id}: Builder changed before retirement; preserve checkout`)
      await io.paneClose(paneId, session)
      updateWorkflow(tasksDir, card.id, { builderRetired: { paneId, started: builder.started, sessionId: identity, historyId: history.id, at: history.at } })
      }
    }
    const retired = readWorkflow(tasksDir)[card.id]?.builderRetired
    if (retired && (await io.agentList(session, { ensureSession: false })).some(a => a.pane_id === retired.paneId)) {
      results.push({ id: card.id, status: 'waiting-builder', reason: 'Waiting for retired Builder pane to close' }); continue
    }
    const pending = readWorkflow(tasksDir)[card.id]?.integrationRetry
    if (pending?.nextAt > now) { results.push({ id: card.id, status: 'held', reason: pending.reason }); continue }
    const gated = integrationCheck && await gateIntegration(tasksDir, card, integrationCheck, io, now)
    if (gated) { results.push(gated); continue }
    const batch = readWorktrees(tasksDir)[card.id]?.state === 'rebased' ? [{ id: card.id, status: 'rebased' }] : io.reconcile({ tasksDir, onlyIds: [card.id] })
    for (const result of batch) {
      if (result.status === 'conflict') { results.push(returnIntegrationConflict(tasksDir, card.id, result)); continue }
      if (result.status !== 'rebased') { results.push(result); continue }
      const check = await (io.runCheck ?? runRecordedCheck)(card, readWorktrees(tasksDir)[card.id])
      appendHistory(tasksDir, card.id, { event: 'rebase-check', ok: check.ok, output: check.output })
      const timedOut = !check.ok && isTransient(check) && checkTimedOut(tasksDir, card.id, 'recorded check', now)
      if (timedOut) { results.push(timedOut); continue }
      if (!check.ok) { results.push(returnIntegrationConflict(tasksDir, card.id, { reason: `rebased cleanly onto master, but the recorded check failed: ${check.output}` })); continue }
      if (pending) updateWorkflow(tasksDir, card.id, { integrationRetry: null })
      updateWorktree(tasksDir, card.id, { state: 'ready', reason: null })
      results.push(...io.reconcile({ tasksDir, onlyIds: [card.id] }))
    }
    } catch (err) { results.push({ id: entry.cardId, status: 'held', reason: err.message }) }
  }
  return results
}

// Board Finish button: close a Review or Completed card without losing its code.
// Review gets an operator PASS (so Auto-review archives after integration instead of
// returning to Review) and moves to Completed. A card with an unintegrated commit is
// integrated now through the poll's path, for that card only; a hold is returned,
// never forced. Only an integrated card, or one with no board worktree, is archived.
export async function operatorFinish({ tasksDir, project, cardId, integrationCheck, git = true, io, now = new Date() }) {
  let card = findCard(tasksDir, cardId)
  if (!['review', 'completed'].includes(card.column)) throw new Error(`${card.id} is in ${card.column}; Finish works only on Review and Completed cards`)
  if (card.column === 'review') {
    appendReviewPass(card, `**Operator decision** ${now.toISOString()}\n\nOperator finished from board; no independent review`, now)
    card = moveCard(tasksDir, card.id, 'completed')
  }
  let results = []
  const entry = readWorktrees(tasksDir)[card.id]
  if (entry && entry.state !== 'integrated') {
    if (git) results = await reconcileCompletedHandoffs({ tasksDir, project, onlyIds: [card.id], integrationCheck, ...(io && { io }) })
    const after = readWorktrees(tasksDir)[card.id]
    if (after?.state !== 'integrated') {
      const held = (git ? results.find(r => r.id === card.id && r.reason)?.reason : 'project has no Git integration settings') || after?.reason || `integration did not run (worktree state ${after?.state}); the board may be integrating another card, try again shortly`
      return { card: findCard(tasksDir, card.id), results, held }
    }
  }
  return { card: moveCard(tasksDir, card.id, 'archive', { operatorArchive: true }), results }
}
