// Spawn a herdr agent for one card: new tab -> agent start -> prompt.
// A half-spawned tab is worse than no tab, so any failure closes the pane it made.

import { tabCreate, agentStart, agentPrompt, paneClose, agentWorkspaceOr, waitForPrompt, sessionOf, paneRead, paneSendKeys, agentList } from './herdr.mjs'
import { workerPrompt, paneLabel, agentName } from './prompt.mjs'
import { readBindings, unbind } from './bindings.mjs'
import { readBoard, findCard, moveCard, columnByKey } from './cards.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { recordUsageFinish } from './request-usage.mjs'
import { cleanupPreparedWorktree, prepareCardWorktree } from './worktrees.mjs'
import { assertPromptAllowed } from './project-control.mjs'
import { assertCardRunSelection, cardRunContext, bindCardRunAssignment } from './card-run.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { deliveryKey, readDelivery, saveDelivery, pendingDeliveries } from './delivery-state.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { assertGuardActive, assertRestrictedRuntimeVerified } from './builder-guard.mjs'
import { activityLog } from './activity.mjs'

// A prompt that never leaves the input box is the failure this guards against, so
// the check is "did the agent start working", not "did the CLI return 0". One
// retry covers a genuine race against the agent finishing booting.
const preservePane = (message) => Object.assign(new Error(message), { preservePane: true })

async function waitPaneWorking(paneId, session, { list = agentList, timeoutMs = 10000, everyMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const agents = await list(session).catch(() => [])
    if (agents.some((a) => a.pane_id === paneId && a.agent_status === 'working')) return true
    await new Promise((r) => setTimeout(r, everyMs))
  }
  return false
}

export async function deliverWith({
  paneId, text, session, prompt = agentPrompt, read = paneRead, sendKeys = paneSendKeys, list = agentList, confirmMs = 10000,
}) {
  if (/\n/.test(text)) throw new Error('prompt contains a newline; it would submit early')
  try {
    await prompt(paneId, text, { wait: true, timeoutMs: 20000, session })
    if (!(await list(session)).some(a => a.pane_id === paneId && a.agent_status === 'working')) throw new Error('Transport succeeded without confirmed working state')
    // Codex can flash `working` while it takes the paste and then sit idle with the
    // prompt still on the input line (Injectbuddy I149): that is not a delivery.
    if (stagedInput(await read(paneId, session).catch(() => ''), text)) throw Object.assign(new Error('prompt still on the input line after a brief working state'), { stillStaged: true })
  } catch (first) {
    if (first.paused) throw first
    if (!first.stillStaged && (await list(session).catch(() => [])).some(a => a.pane_id === paneId && a.agent_status === 'working')) return
    if (stagedPrompt(await read(paneId, session).catch(() => ''), text)) {
      const result = await submitStaged(paneId, text, session, { read, sendKeys, list, confirmMs })
      if (result === 'working') return
      // Still staged after three Enters: nothing ran, so this is a failed start. An
      // explicit card run keeps the pane for its manual Enter recovery.
      if (result === 'staged' && cardRunContext()) throw preservePane(`agent prompt is staged as Pasted Content; press Enter in ${paneId} to submit it, do not resend the full task`)
      if (result === 'staged') throw startFailed(Object.assign(new Error(`agent prompt stayed unsubmitted in ${paneId} after 3 Enter presses`), { unsubmitted: true }))
    }
    throw preservePane(`Delivery unconfirmed: ${first.message}; inspect the existing session before retrying`)
  }
}

// Codex collapses a long paste into "[Pasted Content N chars]" and can swallow the Enter
// (Tradeflow T-41). The prompt is staged, not delivered, while the pane tail shows that
// placeholder or the prompt's own text on the `›` input line.
export function stagedPrompt(pane, text = '') {
  const tail = String(pane).trimEnd().split(/\r?\n/).slice(-15)
  if (tail.some(line => /Pasted Content/i.test(line))) return true
  const input = tail.findLast(line => /^[\s│|]*›/.test(line))?.replace(/^[\s│|]*›\s*/, '').replace(/[\s│|]+$/, '')
  return !!input && input.length >= 8 && text.replace(/\s+/g, ' ').includes(input.slice(0, 60))
}
// Stricter: only the current (last) `›` input line counts, so a prompt that was
// submitted and still shows in the scrollback is never read as staged.
export function stagedInput(pane, text = '') {
  const input = String(pane).split(/\r?\n/).findLast(line => /^[\s│|]*›/.test(line))
  return !!input && stagedPrompt(input, text)
}
// Press Enter up to three times, rechecking after each. 'working', 'staged' (never
// submitted) or 'unknown' (no longer staged, not working either).
export async function submitStaged(paneId, text, session, { read, sendKeys, list, confirmMs }) {
  for (let i = 0; i < 3; i++) {
    await sendKeys(paneId, ['enter'], session).catch(err => { if (err.paused) throw Object.assign(err, { staged: true }) })
    if (await waitPaneWorking(paneId, session, { list, timeoutMs: confirmMs })) return 'working'
    if (!stagedPrompt(await read(paneId, session).catch(() => ''), text)) return 'unknown'
  }
  return 'staged'
}

export async function deliver(paneId, text, session, builderGuard = null) {
  const runId = cardRunContext()?.runId
  const key = deliveryKey(text)
  const prior = readDelivery(session, paneId)
  if (prior?.key === key && prior.status === 'confirmed') return
  if (prior?.status === 'uncertain') throw preservePane('Previous delivery is uncertain; verify the existing session before redispatch')
  try {
    assertPromptAllowed(session)
    if (builderGuard) {
      const agent = (await agentList(session, { ensureSession: false })).find(a => a.pane_id === paneId)
      assertGuardActive(builderGuard, agent?.agent_session)
    }
    saveDelivery(session, paneId, { text, key, status: 'uncertain', ...(builderGuard ? { builderGuard } : {}), ...(runId ? { runId } : {}) })
    await deliverWith({ paneId, text, session })
    saveDelivery(session, paneId, { text, key, status: 'confirmed', ...(runId ? { runId } : {}) })
  } catch (err) {
    if (err.paused) saveDelivery(session, paneId, { text, key, status: runId ? 'cancelled' : 'paused', staged: !!err.staged, ...(runId ? { runId } : {}) })
    if (err.unsubmitted) saveDelivery(session, paneId, { text, key, status: 'failed', reason: err.message })
    throw err
  }
}
export async function resumeDeliveries(session) {
  for (const pending of pendingDeliveries(session)) {
    assertPromptAllowed(session)
    const briefs = [...pending.text.matchAll(/((?:[A-Za-z]:[\\/]|\/)[^()\r\n]*?\.md) \(revision ([a-f0-9]{64})\)/g)]
    if (briefs.some(([, path, revision]) => { try { return createHash('sha256').update(readFileSync(path)).digest('hex') !== revision } catch { return true } })) {
      saveDelivery(session, pending.paneId, { ...pending, status: 'uncertain', reason: 'Brief changed while paused; inspect assignment before dispatch' })
      continue
    }
    const agent = (await agentList(session, { ensureSession: false })).find(a => a.pane_id === pending.paneId)
    if (!agent || !['idle', 'done'].includes(agent.agent_status)) continue
    if (pending.builderGuard) assertGuardActive(pending.builderGuard, agent.agent_session)
    if (pending.staged) {
      if (!stagedPrompt(await paneRead(pending.paneId, session), pending.text)) continue
      const result = await submitStaged(pending.paneId, pending.text, session, { read: paneRead, sendKeys: paneSendKeys, list: agentList, confirmMs: 10000 })
      saveDelivery(session, pending.paneId, { ...pending, status: result === 'working' ? 'confirmed' : 'uncertain' })
      continue
    }
    await deliver(pending.paneId, pending.text, session, pending.builderGuard)
  }
}

// A failed `agent start` (pane busy, timeout, agent quit at once) is not a hold: the
// caller has closed that pane, and the next poll retries once with a fresh tab. A
// second failure in a row for the same card and role asks the operator. Returns the
// card moved to Owner, or null when the retry is still to come.
export const startFailed = (err) => Object.assign(err, { startFailed: !err.paused && !err.preservePane && !cardRunContext() })
export function recordStartFailure(tasksDir, cardId, role, reason) {
  const card = findCard(tasksDir, cardId)
  const prior = readWorkflow(tasksDir)[card.id]?.startFailure
  const count = prior?.role === role ? prior.count + 1 : 1
  appendHistory(tasksDir, card.id, { event: 'start-failed', stage: card.column, role, reason, count })
  updateWorkflow(tasksDir, card.id, { startFailure: { role, count, reason, at: new Date().toISOString() } })
  if (count < 2 || card.column === 'owner') return null
  const lane = columnByKey(card.column).label
  const moved = moveCard(tasksDir, card.id, 'owner')
  writeCurrentFeedback(tasksDir, moved, 'Needs you', `The ${role[0].toUpperCase() + role.slice(1)} for ${card.id} failed to start twice in a row (last error: ${String(reason).replace(/\s+/g, ' ').slice(0, 300)}). All work is preserved. Should the board try again? Drag it back to ${lane} to retry.`)
  return moved
}

// Claude Code can take minutes to reach an interactive prompt on a machine with
// many MCP servers, and longer again when several start at once. herdr caps this
// at 300s; the default here is deliberately generous because a start that is
// merely slow should not be treated as a start that failed.
export const START_TIMEOUT_MS = 240000

export async function spawnForCard({
  project, projectPath, tasksDir, boardRoot, card, model, engine,
  startTimeoutMs = START_TIMEOUT_MS, onPane, gitSettings, restrictedBuilder = false,
}) {
  // The project's session key: new tabs open in the project's workspace of the
  // shared session, and a resumed legacy pane still resolves in its old session.
  const session = sessionOf(project)
  assertCardRunSelection(project, [card.id], 'builder')
  assertPromptAllowed(project)
  // Experimental hooks fail open natively. Explicit requests remain unavailable;
  // ordinary dispatch neither registers them nor claims restricted execution.
  if (restrictedBuilder) assertRestrictedRuntimeVerified()
  const prepared = prepareCardWorktree({ projectPath, tasksDir, card, gitSettings })
  const saved = readWorkflow(tasksDir)[card.id]
  const prior = saved?.correction?.category === 'implementation' ? saved.builder : null
  // A bare (legacy) pane id resolves in the project's old session and a qualified
  // `id@default` one in the shared session; agentList(session) returns both forms.
  const resume = prior && (await agentList(session, { ensureSession: false })).find(a => a.pane_id === prior.pane_id && ['done', 'idle'].includes(a.agent_status))
  // The prior Builder is gone or busy: a fresh Builder continues in the same card
  // worktree (prepareCardWorktree reuses it) with the correction in its prompt.
  const correctionNote = prior && !resume
    ? ` Implementation correction: the previous Builder session (${prior.pane_id}) is unavailable, so you are its replacement. Continue from the existing commits and files in this workspace; do not restart or discard them. Correction to make: ${String(saved.correction.note || 'see the card Current feedback section').replace(/\s+/g, ' ').trim()}`
    : ''
  if (correctionNote) activityLog({ tasksDir, project, cardId: card.id, event: 'builder-replaced', message: `prior Builder ${prior.pane_id} missing or busy; starting a fresh Builder in ${prepared.workspacePath} for the implementation correction`, level: 'warn' })
  let created
  try {
    const workspace = await agentWorkspaceOr(projectPath, session)
    // How many cards are waiting on this one, so the tab strip says which build
    // matters. Read here rather than passed in: every caller would have to compute
    // the same thing, and the board is already on disk.
    const holdsUp = Object.values(readBoard(tasksDir)).flat()
      .filter((c) => (c.blockedBy || []).includes(card.id)).length
    // Codex receives --cd separately: its actual working context must be isolated,
    // while the parent shell stays stable for Windows worktree cleanup.
    const codex = (typeof engine === 'string' ? engine : engine?.kind) === 'codex'
    created = resume ? { root_pane: resume, tab: { tab_id: resume.tab_id } } : await tabCreate({ cwd: codex ? projectPath : prepared.workspacePath, label: paneLabel(card, holdsUp), focus: false, workspace, session })
  } catch (err) {
    cleanupPreparedWorktree({ tasksDir, prepared })
    throw new Error(`tab create failed: ${err.message}`)
  }

  const paneId = created?.root_pane?.pane_id
  const tabId = created?.tab?.tab_id ?? created?.root_pane?.tab_id
  if (!paneId) {
    cleanupPreparedWorktree({ tasksDir, prepared })
    throw new Error(`tab create returned no pane id: ${JSON.stringify(created)}`)
  }

  // Claim the pane before the agent boots. Booting can take minutes, and without
  // a binding the card would sit in Working looking identical to one whose agent
  // died — which is the state the board exists to make obvious.
  let name = resume ? resume.name : agentName('builder', card.id)
  const worktree = prepared.entry ? {
    worktree_path: prepared.entry.worktreePath,
    workspace_path: prepared.entry.workspacePath,
    branch: prepared.entry.branch,
    base_commit: prepared.entry.baseCommit,
  } : {}
  onPane?.({ pane_id: paneId, tab_id: tabId, model, name, spawning: true, ...worktree })
  bindCardRunAssignment(project, [card.id], 'builder', paneId)

  // The shell must be at its prompt before the agent can be started into it.
  try {
    if (!resume) await waitForPrompt(paneId, { session })
  } catch (err) {
    await paneClose(paneId, session).catch(() => {})
    cleanupPreparedWorktree({ tasksDir, prepared })
    throw err
  }

  try {
    if (!resume) name = (await agentStart({ name, paneId, model, engine, workspacePath: prepared.workspacePath, timeoutMs: startTimeoutMs, session }))?.name ?? name
    const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
    if (agent) onPane?.({ pane_id: paneId, tab_id: tabId, model, name, spawning: true, agent_session: agent.agent_session, ...worktree })
  } catch (err) {
    if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
    if (!err.preservePane) cleanupPreparedWorktree({ tasksDir, prepared })
    throw Object.assign(new Error(`agent start failed: ${err.message}`), { preservePane: err.preservePane, startFailed: startFailed(err).startFailed })
  }

  // Submission is keystrokes, so it can silently land in the input box without
  // being sent. --wait makes herdr confirm the agent actually started working.
  try {
    const environment = gitSettings?.envFile
      ? ` Authorized project dev environment: ${gitSettings.envFile}. If the card requires a local Next server, run node --env-file="${gitSettings.envFile}" node_modules/next/dist/bin/next dev -p <card-port> from the isolated checkout. Check the port belongs to that checkout and HTTP succeeds before browser validation. Never print or copy environment values. Do not run npm install/ci through a node_modules junction; detach only the junction and install locally when dependencies need changing.`
      : ''
    await deliver(paneId, workerPrompt({ card, projectPath, boardRoot, tasksDir, workspacePath: prepared.workspacePath }) + correctionNote + environment, session)
  } catch (err) {
    if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
    if (!err.preservePane) cleanupPreparedWorktree({ tasksDir, prepared })
    throw err
  }

  const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
  return { pane_id: paneId, tab_id: tabId, model, name, agent_session: agent?.agent_session, ...worktree }
}

export async function stopCard({ tasksDir, paneId, cardId, project }) {
  const binding = cardId ? readBindings(tasksDir)[String(cardId).toUpperCase()] : null
  try { await recordUsageFinish({ tasksDir, paneId, binding, status: 'interrupted' }) } catch {}
  if (paneId) await paneClose(paneId, sessionOf(project)).catch(() => {})
  unbind(tasksDir, cardId)
}
