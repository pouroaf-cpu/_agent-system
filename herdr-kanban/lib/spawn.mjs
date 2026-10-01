// Spawn a herdr agent for one card: new tab -> agent start -> prompt.
// A half-spawned tab is worse than no tab, so any failure closes the pane it made.

import { tabCreate, agentStart, agentPrompt, paneClose, agentWorkspaceOr, waitForPrompt, sessionOf, paneRead, paneSendKeys, agentList } from './herdr.mjs'
import { workerPrompt, paneLabel, agentName, isCodex } from './prompt.mjs'
import { readBindings, unbind } from './bindings.mjs'
import { readBoard, findCard, moveCard, columnByKey, needsBrowser } from './cards.mjs'
import { appendHistory, writeCurrentFeedback } from './card-history.mjs'
import { recordUsageFinish } from './request-usage.mjs'
import { cleanupPreparedWorktree, prepareCardWorktree } from './worktrees.mjs'
import { assertPromptAllowed } from './project-control.mjs'
import { assertCardRunSelection, cardRunContext, bindCardRunAssignment } from './card-run.mjs'
import { readWorkflow, updateWorkflow } from './workflow-state.mjs'
import { deliveryKey, readDelivery, saveDelivery, pendingDeliveries, promptPath } from './delivery-state.mjs'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { assertGuardActive, assertRestrictedRuntimeVerified } from './builder-guard.mjs'
import { activityLog } from './activity.mjs'
import { isTransient, nextRetry, retryHold } from './transient.mjs'

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

// A slow start under load marks a real delivery "unconfirmed" and holds its card; once the
// pane is seen working, it was delivered (all 8 flagged on 2026-09-25 were running).
export function confirmLateDeliveries({ tasksDir, session, agents }) {
  const cleared = []
  for (const agent of agents) {
    if (agent.agent_status !== 'working') continue
    const delivery = readDelivery(session, agent.pane_id)
    if (delivery?.status !== 'uncertain') continue
    saveDelivery(session, agent.pane_id, { ...delivery, status: 'confirmed', confirmedLate: true })
    const bare = String(agent.pane_id).split('@')[0]
    for (const [id, saved] of Object.entries(readWorkflow(tasksDir))) {
      const reason = saved.operational?.reason || ''
      if (reason.includes('Delivery unconfirmed') && reason.includes(`prompt ${bare} `)) { updateWorkflow(tasksDir, id, { operational: null }); cleared.push(id) }
    }
  }
  return cleared
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
    // herdr's own stall check gives up after 5s, but Codex can take longer to start
    // working; one immediate look marked real deliveries unconfirmed (Injectbuddy I157).
    if (!first.stillStaged && await waitPaneWorking(paneId, session, { list, timeoutMs: confirmMs })) return
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
// placeholder or the prompt's own text on the input line (Codex `›`, Claude `❯`).
export function stagedPrompt(pane, text = '') {
  const tail = String(pane).trimEnd().split(/\r?\n/).slice(-15)
  if (tail.some(line => /Pasted Content/i.test(line))) return true
  return typedOnInput(inputText(tail), text)
}
// Stricter: only the current (last) input line counts, so a prompt that was
// submitted and still shows in the scrollback is never read as staged.
export function stagedInput(pane, text = '') {
  const input = inputText(String(pane).split(/\r?\n/))
  return input != null && (/Pasted Content/i.test(input) || typedOnInput(input, text))
}
// A pane whose input line still holds the board's delivery pointer: the task was typed but
// never submitted (Injectbuddy I401, 2026-09-28: Codex idle as "done", no tool work).
export function unsubmittedDelivery(pane) {
  return /\.deliveries[\\/]/.test(inputText(String(pane).split(/\r?\n/)) ?? '')
}
// The last input line plus the indented lines it wraps onto, up to a blank line or
// the box rule. Claude wraps a long prompt (Injectbuddy I213: `❯ Read` then the path),
// breaking mid-word or at a space, so the match ignores whitespace.
const INPUT = /^[\s│|]*[›❯]/
function inputText(lines) {
  const at = lines.findLastIndex(line => INPUT.test(line))
  if (at < 0) return null
  const strip = line => line.replace(/^[\s│|]*[›❯]?/, '').replace(/[\s│|]+$/, '')
  const wrapped = []
  for (const line of lines.slice(at + 1)) {
    if (!/^[\s│|]/.test(line) || !strip(line) || /^[─━╭╮╰╯]/.test(strip(line))) break
    wrapped.push(strip(line))
  }
  return [strip(lines[at]), ...wrapped].join(' ')
}
function typedOnInput(input, text) {
  const typed = String(input ?? '').replace(/\s+/g, '')
  return typed.length >= 8 && text.replace(/\s+/g, '').includes(typed.slice(0, 60))
}
// Press Enter up to three times, rechecking after each. 'working', 'staged' (never
// submitted) or 'unknown' (no longer staged, not working either).
export async function submitStaged(paneId, text, session, { read, sendKeys, list, confirmMs }) {
  for (let i = 0; i < 3; i++) {
    // Codex takes an Enter that arrives while it is still absorbing the paste as a
    // newline inside it; a late Enter submits (Tradeflow TF56). Let the paste settle.
    await new Promise(resolve => setTimeout(resolve, Math.min(3000, confirmMs)))
    await sendKeys(paneId, ['enter'], session).catch(err => { if (err.paused) throw Object.assign(err, { staged: true }) })
    if (await waitPaneWorking(paneId, session, { list, timeoutMs: confirmMs })) return 'working'
    if (!stagedPrompt(await read(paneId, session).catch(() => ''), text)) return 'unknown'
  }
  return 'staged'
}

// Codex takes a long prompt as a paste and intermittently swallows its Enter
// (Injectbuddy I149, Tradeflow TF56/T-36): the full task goes in a file and only a
// short one-line pointer is typed. Its revision lets resumeDeliveries see a change.
export const MAX_TYPED = 500
// This read runs before the agent has seen the prompt's shell rule, so a Codex agent
// is told login:false here or its profile prints errors (builder audit F10).
export function typedPrompt(text, file, engine) {
  if (text.length < MAX_TYPED) return { text }
  return { text: `Read ${file} (revision ${createHash('sha256').update(text).digest('hex')})${isCodex(engine) ? ' (use the PowerShell tool with login:false)' : ''} and follow it exactly; it is your complete task.`, file, full: text }
}

export async function deliver(paneId, fullText, session, builderGuard = null, { engine } = {}) {
  const runId = cardRunContext()?.runId
  const { text, file, full } = typedPrompt(fullText, promptPath(session, paneId), engine)
  const key = deliveryKey(text)
  const prior = readDelivery(session, paneId)
  if (prior?.key === key && prior.status === 'confirmed') return
  if (prior?.status === 'uncertain') throw preservePane('Previous delivery is uncertain; verify the existing session before redispatch')
  if (full) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, full) }
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
  // Paused deliveries wait for Start. Throwing here aborted every poll before integration, so a
  // release drain never integrated its finished card (Injectbuddy I553, 2026-10-01).
  for (const pending of pendingDeliveries(session)) {
    try { assertPromptAllowed(session) } catch (err) { if (err.paused) return; throw err }
    const pairs = text => [...String(text).matchAll(/((?:[A-Za-z]:[\\/]|\/)[^()\r\n]*?\.md) \(revision ([a-f0-9]{64})\)/g)]
    // One level down too: the typed pointer names the prompt file, which names the briefs.
    const briefs = pairs(pending.text).flatMap(pair => { try { return [pair, ...pairs(readFileSync(pair[1], 'utf8'))] } catch { return [pair] } })
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
// A transient failure (start timeout or unsubmitted prompt under load, I157/TF50) does not
// count: it backs off (1, 5, 15, 60 min) and asks Owner only once the 3-hour budget is spent.
export function recordStartFailure(tasksDir, cardId, role, reason, now = Date.now()) {
  const card = findCard(tasksDir, cardId)
  const prior = readWorkflow(tasksDir)[card.id]?.startFailure
  const same = prior?.role === role
  const retry = isTransient(reason) && nextRetry(same && prior.since ? prior : null, now)
  const count = retry ? (same ? prior.count : 0) : same ? prior.count + 1 : 1
  appendHistory(tasksDir, card.id, { event: 'start-failed', stage: card.column, role, reason, count, ...(retry && { nextAt: new Date(retry.nextAt).toISOString() }) })
  updateWorkflow(tasksDir, card.id, { startFailure: { role, count, reason, at: new Date(now).toISOString(), ...(retry && { since: retry.since, tries: retry.tries, nextAt: retry.nextAt }) } })
  if ((retry ? !retry.exhausted : count < 2) || ['pou', 'owner'].includes(card.column)) return null
  const lane = columnByKey(card.column).label
  const moved = moveCard(tasksDir, card.id, 'owner')
  const who = `The ${role[0].toUpperCase() + role.slice(1)} for ${card.id}`, last = String(reason).replace(/\s+/g, ' ').slice(0, 300)
  writeCurrentFeedback(tasksDir, moved, 'Needs you', `${retry ? `${who} kept failing to start for 3 hours (${retry.tries} tries; last error: ${last})` : `${who} failed to start twice in a row (last error: ${last})`}. All work is preserved. Should the board try again? Drag it back to ${lane} to retry.`)
  return moved
}
// The visible hold while a role's start backs off, or null when it may start now.
export function startRetryHold(saved, role, now = Date.now()) {
  const failure = saved?.startFailure
  if (failure?.role !== role || !(failure.nextAt > now)) return null
  return retryHold(`${role[0].toUpperCase() + role.slice(1)} start failed (${String(failure.reason).replace(/\s+/g, ' ').slice(0, 200)})`, failure.nextAt)
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
    const codex = isCodex(engine)
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
    if (!resume) name = (await agentStart({ name, paneId, model, engine, workspacePath: prepared.workspacePath, timeoutMs: startTimeoutMs, session, browser: needsBrowser(card) }))?.name ?? name
    const agent = (await agentList(session).catch(() => [])).find((a) => a.pane_id === paneId)
    if (agent) onPane?.({ pane_id: paneId, tab_id: tabId, model, name, spawning: true, agent_session: agent.agent_session, ...worktree })
  } catch (err) {
    if (!err.preservePane) await paneClose(paneId, session).catch(() => {})
    if (!err.preservePane) cleanupPreparedWorktree({ tasksDir, prepared })
    throw Object.assign(new Error(`agent start failed: ${err.message}`), { preservePane: err.preservePane, startFailed: startFailed(err).startFailed })
  }

  // Booting takes minutes; a person or project chat may move the card meanwhile. A Builder
  // handed a card no longer in Working reads a missing brief and kicks it back (I398, 2026-09-28).
  let column
  try { column = findCard(tasksDir, card.id).column } catch {}
  if (column !== 'working') {
    await paneClose(paneId, session).catch(() => {})
    throw Object.assign(new Error(`${card.id} left Working (now ${column || 'gone'}) before its Builder got the task`), { movedAway: true })
  }

  // Submission is keystrokes, so it can silently land in the input box without
  // being sent. --wait makes herdr confirm the agent actually started working.
  try {
    const environment = gitSettings?.envFile
      ? ` Authorized project dev environment: ${gitSettings.envFile}. If the card requires a local Next server, run node --env-file="${gitSettings.envFile}" node_modules/next/dist/bin/next dev -p <card-port> from the isolated checkout. Check the port belongs to that checkout and HTTP succeeds before browser validation. Never print or copy environment values. Signed-in check scripts (DEVTOOLS_TEST_EMAIL) load only .env.devtools.local from the project folder, never together with this envFile: both define the test account and the last --env-file wins. Do not run npm install/ci through a node_modules junction; detach only the junction and install locally when dependencies need changing.`
      : ''
    await deliver(paneId, workerPrompt({ card, projectPath, boardRoot, tasksDir, workspacePath: prepared.workspacePath, engine }) + correctionNote + environment, session, null, { engine })
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
