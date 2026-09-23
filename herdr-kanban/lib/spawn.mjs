// Spawn a herdr agent for one card: new tab -> agent start -> prompt.
// A half-spawned tab is worse than no tab, so any failure closes the pane it made.

import { tabCreate, agentStart, agentPrompt, paneClose, agentWorkspaceOr, waitForPrompt, sessionOf, paneRead, paneSendKeys, agentList } from './herdr.mjs'
import { workerPrompt, paneLabel, agentName } from './prompt.mjs'
import { readBindings, unbind } from './bindings.mjs'
import { readBoard } from './cards.mjs'
import { recordUsageFinish } from './request-usage.mjs'
import { cleanupPreparedWorktree, prepareCardWorktree } from './worktrees.mjs'
import { assertPromptAllowed } from './project-control.mjs'
import { assertCardRunSelection, cardRunContext, bindCardRunAssignment } from './card-run.mjs'
import { readWorkflow } from './workflow-state.mjs'
import { deliveryKey, readDelivery, saveDelivery, pendingDeliveries } from './delivery-state.mjs'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { assertGuardActive, assertRestrictedRuntimeVerified } from './builder-guard.mjs'

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
  } catch (first) {
    if (first.paused) throw first
    if ((await list(session).catch(() => [])).some(a => a.pane_id === paneId && a.agent_status === 'working')) return
    const pane = String(await read(paneId, session).catch(() => ''))
    if (/Pasted Content/i.test(pane)) {
      await sendKeys(paneId, ['enter'], session).catch(err => { if (err.paused) throw Object.assign(err, { staged: true }) })
      if (await waitPaneWorking(paneId, session, { list, timeoutMs: confirmMs })) return
      throw preservePane(`agent prompt is staged as Pasted Content; press Enter in ${paneId} to submit it, do not resend the full task`)
    }
    throw preservePane(`Delivery unconfirmed: ${first.message}; inspect the existing session before retrying`)
  }
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
      const pane = String(await paneRead(pending.paneId, session))
      if (!/Pasted Content/i.test(pane)) continue
      await paneSendKeys(pending.paneId, ['enter'], session)
      if (await waitPaneWorking(pending.paneId, session)) saveDelivery(session, pending.paneId, { ...pending, status: 'confirmed' })
      else saveDelivery(session, pending.paneId, { ...pending, status: 'uncertain' })
      continue
    }
    await deliver(pending.paneId, pending.text, session, pending.builderGuard)
  }
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
  // Every herdr call for this card goes to the project's own session, so a Tradeflow
  // builder opens inside the Tradeflow window and not whichever session happens to be
  // the default one.
  const session = sessionOf(project)
  assertCardRunSelection(project, [card.id], 'builder')
  assertPromptAllowed(project)
  // Experimental hooks fail open natively. Explicit requests remain unavailable;
  // ordinary dispatch neither registers them nor claims restricted execution.
  if (restrictedBuilder) assertRestrictedRuntimeVerified()
  const prepared = prepareCardWorktree({ projectPath, tasksDir, card, gitSettings })
  const saved = readWorkflow(tasksDir)[card.id]
  const prior = saved?.correction?.category === 'implementation' ? saved.builder : null
  const resume = prior && (await agentList(session, { ensureSession: false })).find(a => a.pane_id === prior.pane_id && ['done', 'idle'].includes(a.agent_status))
  if (prior && !resume) throw Object.assign(new Error('Responsible Builder session is missing or busy; recover that session before correction'), { preservePane: true })
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
  const name = agentName(card, project, paneId)
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
    if (!resume) await agentStart({ name, paneId, model, engine, workspacePath: prepared.workspacePath, timeoutMs: startTimeoutMs, session })
    const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
    if (agent) onPane?.({ pane_id: paneId, tab_id: tabId, model, name, spawning: true, agent_session: agent.agent_session, ...worktree })
  } catch (err) {
    if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
    if (!err.preservePane) cleanupPreparedWorktree({ tasksDir, prepared })
    throw Object.assign(new Error(`agent start failed: ${err.message}`), { preservePane: err.preservePane })
  }

  // Submission is keystrokes, so it can silently land in the input box without
  // being sent. --wait makes herdr confirm the agent actually started working.
  try {
    const environment = gitSettings?.envFile
      ? ` Authorized project dev environment: ${gitSettings.envFile}. If the card requires a local Next server, run node --env-file="${gitSettings.envFile}" node_modules/next/dist/bin/next dev -p <card-port> from the isolated checkout. Check the port belongs to that checkout and HTTP succeeds before browser validation. Never print or copy environment values. Do not run npm install/ci through a node_modules junction; detach only the junction and install locally when dependencies need changing.`
      : ''
    await deliver(paneId, workerPrompt({ card, projectPath, boardRoot, tasksDir, workspacePath: prepared.workspacePath }) + environment, session)
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
